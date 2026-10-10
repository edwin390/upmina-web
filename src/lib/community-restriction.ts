import type { SupabaseClient } from "@supabase/supabase-js";
import type { VercelResponse } from "@vercel/node";

// R5-C: contrato estable de respuesta cuando una sanción (strike) impide publicar en Community.
//
// La AUTORIDAD es la base de datos: los escritores (community_post_save, ..._save_atomic,
// ..._reorder_media, ..._detach_media) lanzan el código de negocio `author_restricted` SIN datos.
// Este módulo solo EXPLICA el rechazo: tras recibirlo vuelve a leer la restricción vigente con la
// primitiva autoritativa de R5-B (community_author_restriction) y proyecta SOLO campos de producto.
// Nunca confía en datos del error de SQL, nunca reintenta la escritura y nunca expone identidad del
// moderador, ids de caso/ciclo/decisión, reportantes ni metadata de auditoría.

export const AUTHOR_RESTRICTED_CODE = "author_restricted";
export const AUTHOR_RESTRICTION_CHANGED_CODE = "author_restriction_changed";
const RESTRICTED_MESSAGE = "Tu cuenta tiene una restricción de publicación";
const CHANGED_MESSAGE =
  "La restricción de publicación cambió mientras se procesaba la solicitud. Vuelve a intentarlo.";

export interface AuthorRestriction {
  level: number;
  permanent: boolean;
  endsAt: string | null;
  reason: string;
}
export type RestrictionRead =
  { ok: true; restriction: AuthorRestriction | null } | { ok: false };

/** Proyección estricta: cualquier forma inesperada se trata como lectura fallida (no se reenvía). */
function project(data: unknown): RestrictionRead {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false };
  const r = data as Record<string, unknown>;
  if (r.restricted === false) return { ok: true, restriction: null };
  if (
    r.restricted !== true ||
    !Number.isInteger(r.level) ||
    Number(r.level) < 1 ||
    Number(r.level) > 3 ||
    typeof r.permanent !== "boolean" ||
    (r.endsAt !== null && typeof r.endsAt !== "string") ||
    r.permanent !== (r.endsAt === null) ||
    typeof r.reason !== "string"
  )
    return { ok: false };
  return {
    ok: true,
    restriction: {
      level: Number(r.level),
      permanent: r.permanent,
      endsAt: r.endsAt as string | null,
      reason: r.reason,
    },
  };
}

/** Lectura autoritativa de la restricción vigente (reloj de servidor, función de R5-B). */
export async function readAuthorRestriction(
  client: Pick<SupabaseClient, "rpc">,
  userId: string,
): Promise<RestrictionRead> {
  try {
    const { data, error } = await client.rpc("community_author_restriction", {
      p_user_id: userId,
    });
    if (error) return { ok: false };
    return project(data);
  } catch {
    return { ok: false };
  }
}

/**
 * Responde al rechazo `author_restricted` de un escritor de la BD.
 *  - restricción vigente → 403 {code, restriction:{level, permanent, endsAt, reason}}
 *  - ya no existe (revocada/expirada entre el rechazo y la lectura) → 409 determinista; el cliente
 *    decide si reintenta: NUNCA se reintenta la escritura automáticamente
 *  - lectura fallida → 403 con el código, sin detalle
 */
export async function respondAuthorRestricted(
  res: VercelResponse,
  client: Pick<SupabaseClient, "rpc">,
  userId: string,
): Promise<VercelResponse> {
  res.setHeader("Cache-Control", "no-store");
  const read = await readAuthorRestriction(client, userId);
  if (!read.ok) {
    return res
      .status(403)
      .json({ error: RESTRICTED_MESSAGE, code: AUTHOR_RESTRICTED_CODE });
  }
  if (!read.restriction) {
    return res
      .status(409)
      .json({ error: CHANGED_MESSAGE, code: AUTHOR_RESTRICTION_CHANGED_CODE });
  }
  return res.status(403).json({
    error: RESTRICTED_MESSAGE,
    code: AUTHOR_RESTRICTED_CODE,
    restriction: read.restriction,
  });
}
