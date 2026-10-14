// DEL-2: lectura de la barrera de cuenta en eliminación (account_deletion_gate). Módulo aparte para que requireAuthenticated dependa de
// UNA función sustituible en las pruebas de los demás handlers (setupTests la fija en «activa»); admin-auth.test.ts usa la real.

export type AccountGate = "active" | "blocked";

export class AccountGateUnavailableError extends Error {
  constructor(readonly code?: string) {
    super("account_gate_unavailable");
    this.name = "AccountGateUnavailableError";
  }
}

interface GateClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { code?: unknown } | null }>;
}

/** Fail-closed: cualquier fallo o respuesta inesperada lanza AccountGateUnavailableError (nunca devuelve «active» por defecto). */
export async function readAccountGate(
  client: () => GateClient,
  userId: string,
): Promise<AccountGate> {
  let result: Awaited<ReturnType<GateClient["rpc"]>>;
  try {
    result = await client().rpc("account_deletion_gate", { p_user_id: userId });
  } catch {
    throw new AccountGateUnavailableError();
  }
  if (result.error) {
    const code = result.error.code;
    throw new AccountGateUnavailableError(
      typeof code === "string" && /^[a-z0-9_.-]{1,64}$/i.test(code) ? code : undefined,
    );
  }
  const data = result.data as { blocked?: unknown } | null;
  if (!data || typeof data !== "object" || typeof data.blocked !== "boolean")
    throw new AccountGateUnavailableError();
  return data.blocked ? "blocked" : "active";
}
