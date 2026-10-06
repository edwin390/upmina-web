import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AdminAuthError, authErrorBody, requireCapability } from "./admin-auth.js";
import {
  parseGroupedDecisionInput,
  parseGroupedDecisionResult,
} from "./moderation-decision-contract.js";

const errors: Record<string, number> = {
  invalid_argument: 400,
  resolution_message_required: 400,
  actor_not_moderator: 403,
  case_not_found: 404,
  post_not_found: 404,
  case_version_conflict: 409,
  post_version_conflict: 409,
  cycle_state_conflict: 409,
  post_state_conflict: 409,
  decision_already_exists: 409,
};
export async function handleModerationCaseDecision(
  req: VercelRequest,
  res: VercelResponse,
) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }
  let actor: string;
  try {
    actor = (await requireCapability(req, "moderation")).userId;
  } catch (error) {
    return error instanceof AdminAuthError
      ? res.status(error.status).json(authErrorBody(error))
      : res.status(500).json({ error: "Error interno", code: "internal_failure" });
  }
  let input;
  try {
    // originalPostState is request consistency context only, never DB authority or authorization.
    // The unchanged RPC checks actual state and versions under locks; no speculative second read.
    input = parseGroupedDecisionInput(
      typeof req.body === "string" ? JSON.parse(req.body) : req.body,
    );
  } catch (error) {
    return res.status(400).json({
      error: "Solicitud inválida",
      code:
        error instanceof Error && error.message === "resolution_message_required"
          ? error.message
          : "validation",
    });
  }
  try {
    const url = process.env.VITE_SUPABASE_URL?.trim();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!url || !key) throw new Error("Configuration unavailable");
    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.rpc("community_moderation_case_decide", {
      p_actor_user_id: actor,
      p_case_id: input.caseId,
      p_cycle_id: input.cycleId,
      p_expected_case_version: input.expectedCaseVersion,
      p_expected_post_version: input.expectedPostVersion,
      p_decision: input.decision,
      p_resolution_message: input.resolutionMessage,
    });
    if (error) {
      if (
        error.code === "P0001" &&
        Object.prototype.hasOwnProperty.call(errors, error.message)
      )
        return res
          .status(errors[error.message]!)
          .json({ error: "No se pudo completar la moderación", code: error.message });
      throw new Error("Decision failed");
    }
    let result;
    try {
      result = parseGroupedDecisionResult(data, input);
    } catch {
      return res
        .status(500)
        .json({ error: "Respuesta inválida", code: "invalid_response" });
    }
    return res.status(200).json(result);
  } catch {
    return res.status(500).json({ error: "Error interno", code: "internal_failure" });
  }
}
