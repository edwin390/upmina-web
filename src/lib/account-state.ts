import type { SupabaseClient } from "@supabase/supabase-js";
import type { VercelResponse } from "@vercel/node";

// AUTH-2: estado de la cuenta para Community. Código de servidor (lo importan handlers de api/).
//
// CUENTA COMPLETA = email verificado (Supabase Auth) + username configurado (fila en profiles).
// Una cuenta incompleta NO está sancionada: su error (`account_incomplete`) es distinto de
// `author_restricted` (strikes) y nunca reutiliza conceptos de moderación.
//
// La autoridad se lee DENTRO de la base de datos (community_account_state, SECURITY DEFINER), la
// misma función que usan los guards de las RPC: así HTTP y BD no pueden discrepar. Nada de esto
// viene del navegador y service_role nunca sale del servidor.

export const ACCOUNT_INCOMPLETE = "account_incomplete";

export type AccountState = "complete" | "email_unverified" | "username_missing";
export type AccountIncompleteReason = Exclude<AccountState, "complete">;

const DB_ERROR_TO_REASON: Readonly<Record<string, AccountIncompleteReason>> = {
  account_email_unverified: "email_unverified",
  account_username_missing: "username_missing",
  // Contrato anterior de las RPC de guardado/reserva; hoy equivale a "username pendiente".
  no_profile: "username_missing",
};

/** Lee el estado autoritativo. `null` = la lectura falló o devolvió algo inesperado: el llamador
 *  debe FALLAR CERRADO (nunca conceder la acción). */
export async function readAccountState(
  client: SupabaseClient,
  userId: string,
): Promise<AccountState | null> {
  try {
    const { data, error } = await client.rpc("community_account_state", {
      p_user_id: userId,
    });
    if (error) return null;
    return data === "complete" ||
      data === "email_unverified" ||
      data === "username_missing"
      ? data
      : null;
  } catch {
    return null;
  }
}

/** Traduce el mensaje de un RAISE EXCEPTION de los guards de BD, o null si no es de cuenta. */
export function accountIncompleteReasonFromDbMessage(
  message: unknown,
): AccountIncompleteReason | null {
  return typeof message === "string" &&
    Object.prototype.hasOwnProperty.call(DB_ERROR_TO_REASON, message)
    ? DB_ERROR_TO_REASON[message]!
    : null;
}

export function accountIncompleteBody(reason: AccountIncompleteReason): {
  error: string;
  code: typeof ACCOUNT_INCOMPLETE;
  reason: AccountIncompleteReason;
} {
  return { error: "Cuenta incompleta", code: ACCOUNT_INCOMPLETE, reason };
}

export function respondAccountIncomplete(
  res: VercelResponse,
  reason: AccountIncompleteReason,
): VercelResponse {
  res.setHeader("Cache-Control", "no-store");
  return res.status(403).json(accountIncompleteBody(reason));
}
