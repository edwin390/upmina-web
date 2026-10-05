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
  const scope = req.query.scope ?? "active";
  const raw = req.query.cursor;
  const cycle = req.query.cycleId;
  const cursor =
    typeof raw === "string" && raw.length <= 256 ? decodeFeedCursor(raw) : null;
  if (
    !(["active", "closed"] as unknown[]).includes(scope) ||
    (raw !== undefined &&
      (!cursor ||
        !uuid(cursor.id) ||
        !/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(cursor.createdAt))) ||
    (cycle !== undefined && (!uuid(cycle) || raw !== undefined))
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
      return res.status(200).json({
        item: normalizeModerationCase({ ...item, media: visible }, (key) =>
          urls.get(key)!,
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
