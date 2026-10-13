import { describe, expect, it } from "vitest";
import {
  evaluateMfaActivationGate,
  readPendingMfaReset,
  runMfaResetCleanup,
  type MfaAdminClient,
} from "./admin-mfa-reset";

// Limpieza de MFA tras retirar el último rol: orden, idempotencia, fallos parciales y carreras con un
// factor NUEVO. Supabase Auth es un doble en memoria (no se prueba aquí el servicio real).

const USER = "11111111-1111-4111-8111-111111111111";
const RESET = "99999999-9999-4999-8999-999999999999";
const OLD1 = "aaaaaaaa-0000-4000-8000-000000000001";
const OLD2 = "aaaaaaaa-0000-4000-8000-000000000002";
const NEW1 = "bbbbbbbb-0000-4000-8000-000000000009";

/** Auth en memoria: factores vivos, fallos programables y registro de llamadas. */
function makeClient(
  initial: string[],
  opts: { failDeleteOf?: string[]; failList?: boolean } = {},
) {
  const alive = new Set(initial);
  const failDelete = new Set(opts.failDeleteOf ?? []);
  const calls = { deleted: [] as string[], records: [] as Record<string, unknown>[] };
  const client = {
    auth: {
      admin: {
        mfa: {
          deleteFactor: async ({ id, userId }: { id: string; userId: string }) => {
            expect(userId).toBe(USER);
            if (failDelete.has(id)) return { error: { status: 500, message: "interno" } };
            if (!alive.has(id))
              return { error: { status: 404, code: "mfa_factor_not_found" } };
            alive.delete(id);
            calls.deleted.push(id);
            return { error: null };
          },
          listFactors: async () =>
            opts.failList
              ? { data: null, error: { status: 500 } }
              : { data: { factors: [...alive].map((id) => ({ id })) }, error: null },
        },
      },
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "admin_mfa_reset_record") {
        calls.records.push(args);
        return { data: args.p_ok ? "completed" : "pending", error: null };
      }
      return { data: null, error: { message: "inesperado" } };
    },
  } as unknown as MfaAdminClient;
  return { client, alive, calls, failDelete };
}

describe("runMfaResetCleanup", () => {
  it("borra exactamente los ids de la instantánea y registra el éxito", async () => {
    const { client, alive, calls } = makeClient([OLD1, OLD2]);
    const out = await runMfaResetCleanup(client, USER, {
      resetId: RESET,
      factorIds: [OLD1, OLD2],
    });
    expect(out).toEqual({ status: "completed", factorsDeleted: 2 });
    expect(alive.size).toBe(0);
    expect(calls.records).toEqual([
      { p_reset_id: RESET, p_ok: true, p_factors_deleted: 2, p_error_class: null },
    ]);
  });

  it("CARRERA: un reintento tardío NO toca el factor configurado después de la retirada", async () => {
    // La retirada guardó [OLD1]. Después la persona enroló NEW1. El reintento solo conoce OLD1.
    const { client, alive, calls } = makeClient([OLD1, NEW1]);
    const out = await runMfaResetCleanup(client, USER, {
      resetId: RESET,
      factorIds: [OLD1],
    });
    expect(out.status).toBe("completed");
    expect(calls.deleted).toEqual([OLD1]);
    expect(alive.has(NEW1)).toBe(true);
    // y repetirlo (otro reintento tardío) tampoco lo toca
    const again = await runMfaResetCleanup(client, USER, {
      resetId: RESET,
      factorIds: [OLD1],
    });
    expect(again).toEqual({ status: "completed", factorsDeleted: 0 });
    expect(alive.has(NEW1)).toBe(true);
  });

  it("fallo parcial: el primero se borra, el segundo falla → pendiente; el reintento termina el resto (el primero ya no existe)", async () => {
    const { client, alive, failDelete } = makeClient([OLD1, OLD2], {
      failDeleteOf: [OLD2],
    });
    const first = await runMfaResetCleanup(client, USER, {
      resetId: RESET,
      factorIds: [OLD1, OLD2],
    });
    expect(first).toEqual({ status: "pending", errorClass: "auth_delete_failed" });
    expect([...alive]).toEqual([OLD2]);
    failDelete.clear();
    const retry = await runMfaResetCleanup(client, USER, {
      resetId: RESET,
      factorIds: [OLD1, OLD2],
    });
    expect(retry).toEqual({ status: "completed", factorsDeleted: 1 });
    expect(alive.size).toBe(0);
  });

  it("dos limpiezas simultáneas son idempotentes (ninguna falla ni borra de más)", async () => {
    const { client, alive } = makeClient([OLD1, NEW1]);
    const reset = { resetId: RESET, factorIds: [OLD1] };
    const [a, b] = await Promise.all([
      runMfaResetCleanup(client, USER, reset),
      runMfaResetCleanup(client, USER, reset),
    ]);
    expect(a.status).toBe("completed");
    expect(b.status).toBe("completed");
    expect([...alive]).toEqual([NEW1]);
  });

  it("si no se puede confirmar con la lista de factores → pendiente (nunca se da por hecho)", async () => {
    const { client } = makeClient([OLD1], { failList: true });
    expect(
      await runMfaResetCleanup(client, USER, { resetId: RESET, factorIds: [OLD1] }),
    ).toEqual({
      status: "pending",
      errorClass: "auth_list_failed",
    });
  });

  it("los errores solo se registran como clase, sin el texto de Auth", async () => {
    const { client, calls } = makeClient([OLD1], { failDeleteOf: [OLD1] });
    await runMfaResetCleanup(client, USER, { resetId: RESET, factorIds: [OLD1] });
    expect(JSON.stringify(calls.records)).not.toMatch(/interno/);
    expect(calls.records[0]).toMatchObject({
      p_ok: false,
      p_error_class: "auth_delete_failed",
    });
  });
});

describe("readPendingMfaReset", () => {
  const client = (result: { data: unknown; error: unknown }) =>
    ({ rpc: async () => result }) as unknown as MfaAdminClient;

  it("sin fila pendiente → null; con fila → ids validados", async () => {
    expect(await readPendingMfaReset(client({ data: [], error: null }), USER)).toBeNull();
    expect(
      await readPendingMfaReset(
        client({ data: [{ out_reset_id: RESET, out_factor_ids: [OLD1] }], error: null }),
        USER,
      ),
    ).toEqual({ resetId: RESET, factorIds: [OLD1] });
  });

  it("un fallo de lectura o una forma inesperada LANZA: nunca equivale a «no hay nada pendiente»", async () => {
    await expect(
      readPendingMfaReset(client({ data: null, error: { message: "x" } }), USER),
    ).rejects.toThrow();
    await expect(
      readPendingMfaReset(
        client({ data: [{ out_reset_id: "x", out_factor_ids: [] }], error: null }),
        USER,
      ),
    ).rejects.toThrow();
    await expect(
      readPendingMfaReset(
        client({
          data: [{ out_reset_id: RESET, out_factor_ids: ["no-uuid"] }],
          error: null,
        }),
        USER,
      ),
    ).rejects.toThrow();
  });
});

describe("evaluateMfaActivationGate", () => {
  const gateClient = (checks: unknown[]) => {
    let i = 0;
    return {
      auth: {
        admin: {
          mfa: {
            deleteFactor: async () => ({ error: null }),
            listFactors: async () => ({ data: { factors: [] }, error: null }),
          },
        },
      },
      rpc: async (name: string) => {
        if (name === "admin_mfa_activation_check")
          return { data: checks[Math.min(i++, checks.length - 1)], error: null };
        if (name === "admin_mfa_pending_reset") return { data: [], error: null };
        return { data: "completed", error: null };
      },
    } as unknown as MfaAdminClient;
  };

  it("sin antecedentes → ok; reenrolar → 403; limpieza que no se puede resolver → 503", async () => {
    expect(
      await evaluateMfaActivationGate(
        gateClient([{ allowed: true, reason: "no_reset_history" }]),
        USER,
        undefined,
      ),
    ).toEqual({ ok: true });
    expect(
      await evaluateMfaActivationGate(
        gateClient([{ allowed: false, reason: "mfa_reenroll_required" }]),
        USER,
        undefined,
      ),
    ).toEqual({
      ok: false,
      status: 403,
      code: "mfa_reenroll_required",
    });
  });

  it("limpieza resuelta en el momento (ya no hay pendiente) → se vuelve a comprobar", async () => {
    const out = await evaluateMfaActivationGate(
      gateClient([
        { allowed: false, reason: "mfa_cleanup_pending" },
        { allowed: false, reason: "mfa_reenroll_required" },
      ]),
      USER,
      undefined,
    );
    expect(out).toMatchObject({ ok: false, status: 403 });
  });

  it("cualquier forma inesperada falla cerrado (500)", async () => {
    for (const bad of [
      null,
      "x",
      { allowed: "sí", reason: 1 },
      { allowed: false, reason: "otra" },
    ]) {
      expect(
        await evaluateMfaActivationGate(gateClient([bad]), USER, undefined),
      ).toMatchObject({ ok: false, status: 500 });
    }
  });
});
