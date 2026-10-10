import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AdminAuthError, authErrorBody, requireCapability } from "./admin-auth.js";
import {
  decodeFeedCursor,
  encodeFeedCursor,
  mapFeedMediaRow,
} from "./community-feed-domain.js";
import {
  communityPublicMediaUrl,
  loadMediaUrlContext,
  moderatorMediaUrls,
} from "./media-delivery-url.js";
import type { ModerationCaseItem } from "./moderation-case-contract.js";
import { resolveModerationMedia } from "./moderation-case-media.js";
import { projectStrikeStateRead } from "./moderation-strike-contract.js";

import {
  parseModerationCase,
  timestamp,
  uuid,
  parseRawModerationMedia,
  parseModerationId,
} from "./moderation-case-parser.js";
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Invalid projection");
  return v as Record<string, unknown>;
};
const array = (v: unknown, max: number): unknown[] => {
  if (!Array.isArray(v) || v.length > max) throw new Error("Invalid bound");
  return v;
};
export function normalizeModerationCase(
  value: unknown,
  buildUrl: (storageKey: string) => string = communityPublicMediaUrl,
): ModerationCaseItem {
  const r = record(value);
  const media = array(r.media, 10)
    .map((v) => mapFeedMediaRow(parseRawModerationMedia(v), buildUrl))
    .filter((v) => v !== null);
  return parseModerationCase({ ...r, media });
}

export const QUEUE_REASONS = [
  "spam",
  "harassment",
  "hate_speech",
  "sexual_content",
  "other",
] as const;

/** R5-G: validación estricta de los filtros de la cola. `null` = solicitud inválida. Cada filtro
 *  debe ser UNA cadena (no listas); el rango es de fechas UTC (`to` inclusivo → límite exclusivo). */
export function parseQueueFilters(
  query: Record<string, unknown>,
): { rpc: Record<string, unknown> } | null {
  const rpc: Record<string, unknown> = {};
  const one = (k: string): string | undefined | null => {
    const v = query[k];
    if (v === undefined) return undefined;
    return typeof v === "string" ? v : null;
  };
  const day = (v: string): number | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const ms = Date.parse(`${v}T00:00:00Z`);
    return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(v) ? ms : null;
  };
  const reason = one("reason");
  if (
    reason === null ||
    (reason !== undefined && !QUEUE_REASONS.includes(reason as never))
  )
    return null;
  if (reason) rpc.p_reason = reason;
  const hidden = one("hiddenOnly");
  if (hidden === null || (hidden !== undefined && hidden !== "1")) return null;
  if (hidden) rpc.p_hidden_only = true;
  const author = one("author");
  if (author === null) return null;
  if (author !== undefined) {
    const normalized = author.toLowerCase();
    if (!/^[a-z0-9_]{2,20}$/.test(normalized)) return null;
    rpc.p_author = normalized;
  }
  const from = one("from");
  const to = one("to");
  if (from === null || to === null) return null;
  const fromMs = from === undefined ? null : day(from);
  const toMs = to === undefined ? null : day(to);
  if ((from !== undefined && fromMs === null) || (to !== undefined && toMs === null))
    return null;
  if (fromMs !== null && toMs !== null && fromMs > toMs) return null;
  if (fromMs !== null) rpc.p_from = new Date(fromMs).toISOString();
  if (toMs !== null) rpc.p_to = new Date(toMs + 86_400_000).toISOString();
  return { rpc };
}

export async function handleModerationCases(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }
  let actor: string;
  try {
    actor = (await requireCapability(req, "moderation")).userId;
  } catch (err) {
    return err instanceof AdminAuthError
      ? res.status(err.status).json(authErrorBody(err))
      : res.status(500).json({ error: "Error interno" });
  }
  if (req.query.summary !== undefined) {
    // R5-H: contador agregado de casos pendientes (definición en docs/9K-R5H-MODERATION-UX.md).
    // Misma autenticación/capacidad/MFA que la cola; devuelve un único entero.
    if (
      req.query.summary !== "pending" ||
      Object.keys(req.query).some((k) => k !== "summary" && k !== "action")
    )
      return res.status(400).json({ error: "Solicitud inválida" });
    try {
      const url = process.env.VITE_SUPABASE_URL?.trim();
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
      if (!url || !key) throw new Error("Missing configuration");
      const client = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await client.rpc("community_moderation_pending_count", {
        p_actor_user_id: actor,
      });
      if (error) {
        if (error.code === "P0001" && error.message === "actor_not_moderator")
          return res
            .status(403)
            .json({ error: "Acceso no autorizado", code: error.message });
        throw new Error("Read failed");
      }
      if (!Number.isInteger(data) || (data as number) < 0)
        throw new Error("Invalid count");
      return res.status(200).json({ pending: data });
    } catch {
      return res.status(500).json({ error: "Error interno" });
    }
  }
  const scope = req.query.scope ?? "active";
  const raw = req.query.cursor;
  const cycle = req.query.cycleId;
  const cursor =
    typeof raw === "string" && raw.length <= 256 ? decodeFeedCursor(raw) : null;
  const filters = parseQueueFilters(req.query);
  if (
    !(["active", "closed"] as unknown[]).includes(scope) ||
    (raw !== undefined &&
      (!cursor ||
        !uuid(cursor.id) ||
        !/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(cursor.createdAt))) ||
    (cycle !== undefined && (!uuid(cycle) || raw !== undefined)) ||
    !filters ||
    (cycle !== undefined && Object.keys(filters.rpc).length > 0)
  )
    return res.status(400).json({ error: "Solicitud inválida" });
  try {
    const url = process.env.VITE_SUPABASE_URL?.trim();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!url || !key) throw new Error("Missing configuration");
    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.rpc("community_moderation_cases_read", {
      p_actor_user_id: actor,
      p_scope: scope,
      p_before_activity: cursor?.createdAt ?? null,
      p_before_cycle: cursor?.id ?? null,
      p_cycle_id: cycle ?? null,
      // Solo se envían los filtros activos: sin filtros la llamada es idéntica a la anterior.
      ...filters.rpc,
    });
    if (error) {
      if (error.code === "P0001" && error.message === "actor_not_moderator")
        return res
          .status(403)
          .json({ error: "Acceso no autorizado", code: error.message });
      if (error.code === "P0001" && error.message === "case_not_found")
        return res.status(404).json({ error: "Caso no encontrado", code: error.message });
      throw new Error("Read failed");
    }
    const body = record(data);
    if (cycle) {
      const item = record(body.item);
      const media = await resolveModerationMedia(item.media, async (ids) => {
        const result = await client
          .from("media_assets")
          .select("id,domain,status,kind,storage_key,width,height,duration_seconds")
          .in("id", ids);
        if (result.error) throw new Error("Media lookup failed");
        return result.data;
      });
      // R4-D2: la URL de cada medio depende del estado real del post y se decide aquí, DESPUÉS de
      // requireCapability("moderation") (JWT + capacidad + MFA). Sin URL disponible → se omite.
      const post = item.post === null ? null : record(item.post);
      const purgeAfter =
        post && typeof post.purgeAfter === "string" ? Date.parse(post.purgeAfter) : null;
      const urls = post
        ? await moderatorMediaUrls(await loadMediaUrlContext(), {
            status: String(post.status),
            purgeAfterMs:
              purgeAfter !== null && Number.isFinite(purgeAfter) ? purgeAfter : null,
            nowMs: Date.now(),
            storageKeys: media.flatMap((m) =>
              m.media_assets?.storage_key ? [m.media_assets.storage_key] : [],
            ),
          })
        : new Map<string, string>();
      const visible = media.filter(
        (m) => m.media_assets?.storage_key && urls.has(m.media_assets.storage_key),
      );
      // R5-D: estado de strike por RPC SEPARADA (la lectura de caso de E4/E5 no cambia) y fusión
      // explícita. Es un enriquecimiento no crítico: el detalle del caso NUNCA falla por esto.
      //   · RPC inexistente (BD sin strikes, PGRST202 / 42883)  → sin bloque (función no instalada).
      //   · cualquier otro error, excepción o forma inesperada → `strikeUnavailable: true` (R5-F),
      //     para que la UI diga «no se pudo consultar» en vez de omitir la sección sin explicación.
      //   Nunca se reenvía el mensaje ni el código del error.
      let strike;
      let strikeUnavailable = false;
      try {
        const state = await client.rpc("community_strike_state_read", {
          p_actor_user_id: actor,
          p_case_id: item.caseId,
        });
        if (state.error) {
          const code = (state.error as { code?: unknown }).code;
          if (code !== "PGRST202" && code !== "42883") strikeUnavailable = true;
        } else {
          strike = projectStrikeStateRead(state.data);
        }
      } catch {
        strike = undefined;
        strikeUnavailable = true;
      }
      return res.status(200).json({
        item: normalizeModerationCase(
          {
            ...item,
            media: visible,
            ...(strike ? { strike } : {}),
            ...(strikeUnavailable ? { strikeUnavailable: true } : {}),
          },
          (key) => urls.get(key)!,
        ),
      });
    }
    const next = body.next === null ? null : record(body.next);
    return res.status(200).json({
      cases: array(body.cases, 20).map((c) => normalizeModerationCase(c)),
      nextCursor: next
        ? encodeFeedCursor(timestamp(next.activityAt), parseModerationId(next.cycleId))
        : null,
    });
  } catch {
    return res.status(500).json({ error: "Error interno" });
  }
}
