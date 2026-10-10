import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AdminAuthError, authErrorBody, requireCapability } from "./admin-auth.js";
import {
  parseStrikeApplyInput,
  parseStrikeRevokeInput,
  projectStrikeApplyResult,
  projectStrikeRevokeResult,
} from "./moderation-strike-contract.js";

// R5-D: frontera privilegiada de strikes (aplicar / revocar). Mismo patrón que
// moderation-case-decision (moderation-decision-handlers.ts), sin sistema de auth paralelo:
//   1. método  2. requireCapability(req, "moderation")  = autenticación → rol ACTUAL en admin_roles
//   → capacidad → MFA reciente (aal2 + TOTP reciente)  3. (solo revocar) rol developer/admin
//   4. validación estricta del cuerpo  5. RPC de BD (R5-B, que revalida el rol y es la autoridad)
//   6. proyección explícita de la respuesta.
// Nada llega a la BD antes de que pasen autenticación, rol, capacidad y MFA. Este módulo NO escribe
// auditoría (la RPC ya escribe exactamente una fila por operación), NO reintenta nunca y NO
// registra cabeceras, JWT, TOTP ni el texto de los motivos. Procede y Strike son acciones
// separadas: moderation-case-decision no aplica strikes.

const NO_STORE = "no-store";
const INTERNAL = { error: "Error interno", code: "internal_failure" };

interface Mapped {
  status: number;
  code: string;
}
const APPLY_ERRORS: Readonly<Record<string, number>> = {
  invalid_argument: 400,
  reason_required: 400,
  actor_not_moderator: 403,
  self_strike_forbidden: 403,
  decision_not_found: 404,
  decision_not_content_actioned: 409,
  case_not_closed: 409,
  author_unavailable: 409,
  strike_already_issued: 409,
  level_changed: 409,
};
const REVOKE_ERRORS: Readonly<Record<string, number>> = {
  invalid_argument: 400,
  reason_required: 400,
  actor_not_moderator: 403,
  revoker_role_insufficient: 403,
  self_revoke_forbidden: 403,
  strike_not_found: 404,
  strike_already_revoked: 409,
};

function mapRpcError(
  error: unknown,
  table: Readonly<Record<string, number>>,
): Mapped | null {
  if (!error || typeof error !== "object") return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code !== "P0001" || typeof message !== "string") return null;
  return Object.prototype.hasOwnProperty.call(table, message)
    ? { status: table[message]!, code: message }
    : null;
}

function serviceClient(): SupabaseClient {
  const url = process.env.VITE_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Configuration unavailable");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function parseBody(req: VercelRequest): unknown {
  try {
    return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return undefined;
  }
}

type Authorized = { userId: string; role: string } | { done: true };
async function authorize(req: VercelRequest, res: VercelResponse): Promise<Authorized> {
  try {
    const identity = await requireCapability(req, "moderation");
    return { userId: identity.userId, role: identity.role };
  } catch (error) {
    if (error instanceof AdminAuthError) {
      res.status(error.status).json(authErrorBody(error));
    } else {
      res.status(500).json(INTERNAL);
    }
    return { done: true };
  }
}

export async function handleModerationStrikeApply(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  res.setHeader("Cache-Control", NO_STORE);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }
  const auth = await authorize(req, res);
  if ("done" in auth) return res;

  const input = parseStrikeApplyInput(parseBody(req));
  if ("code" in input)
    return res.status(400).json({ error: "Solicitud inválida", code: input.code });

  try {
    const { data, error } = await serviceClient().rpc("community_strike_apply", {
      p_actor_user_id: auth.userId, // always the verified session, never the body
      p_decision_id: input.value.decisionId,
      p_reason: input.value.reason,
      p_expected_level: input.value.expectedLevel,
    });
    if (error) {
      const mapped = mapRpcError(error, APPLY_ERRORS);
      if (mapped)
        return res
          .status(mapped.status)
          .json({ error: "No se pudo aplicar el strike", code: mapped.code });
      throw new Error("Strike apply failed");
    }
    let body;
    try {
      body = projectStrikeApplyResult(data, input.value.reason);
    } catch {
      return res
        .status(500)
        .json({ error: "Respuesta inválida", code: "invalid_response" });
    }
    return res.status(201).json(body);
  } catch {
    return res.status(500).json(INTERNAL);
  }
}

export async function handleModerationStrikeRevoke(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  res.setHeader("Cache-Control", NO_STORE);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }
  const auth = await authorize(req, res);
  if ("done" in auth) return res;

  // Frontera HTTP: un moderador autenticado y con MFA reciente NO llega a la BD. La BD sigue
  // siendo la autoridad final (revalida el rol actual y el "quien aplicó no revoca").
  if (auth.role !== "developer" && auth.role !== "admin")
    return res
      .status(403)
      .json({ error: "Acceso no autorizado", code: "revoker_role_insufficient" });

  const input = parseStrikeRevokeInput(parseBody(req));
  if ("code" in input)
    return res.status(400).json({ error: "Solicitud inválida", code: input.code });

  try {
    const { data, error } = await serviceClient().rpc("community_strike_revoke", {
      p_actor_user_id: auth.userId,
      p_strike_id: input.value.strikeId,
      p_reason: input.value.reason,
    });
    if (error) {
      const mapped = mapRpcError(error, REVOKE_ERRORS);
      if (mapped)
        return res
          .status(mapped.status)
          .json({ error: "No se pudo revocar el strike", code: mapped.code });
      throw new Error("Strike revoke failed");
    }
    let body;
    try {
      body = projectStrikeRevokeResult(data);
    } catch {
      return res
        .status(500)
        .json({ error: "Respuesta inválida", code: "invalid_response" });
    }
    return res.status(200).json(body);
  } catch {
    return res.status(500).json(INTERNAL);
  }
}
