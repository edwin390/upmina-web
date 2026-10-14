import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHmac, timingSafeEqual } from "node:crypto";

// DEL-2: ejecutor de la limpieza de cuentas. NO es una segunda máquina de estados: solo recorre las etapas persistidas por DEL-1
// (account_deletion_claim / step_start / step_finish / release) y ejecuta el trabajo de cada una. Todo el estado (lease, intentos,
// backoff, alertas, barrera) vive en la base de datos; este módulo no guarda nada entre invocaciones, así que un reinicio, un timeout
// o dos ejecutores simultáneos son seguros (la BD serializa por lease y cada etapa es idempotente).
//
// La cuenta permanece BLOQUEADA en todos los estados: nada de aquí toca account_deletion_blocks y ningún error de limpieza la reabre.

export const DELETION_STAGES = [
  "auth_block",
  "copyright_claims",
  "community_content",
  "profile",
  "media_gc",
  "auth_delete",
] as const;
export type DeletionStage = (typeof DELETION_STAGES)[number];

/** Códigos cerrados que acepta account_deletion_step_finish. */
export type DeletionErrorCode =
  | "r2_unavailable"
  | "auth_unavailable"
  | "db_error"
  | "media_gc_pending"
  | "last_admin_protected"
  | "avatar_not_supported"
  | "timeout"
  | "unexpected";

type RpcResult = { data: unknown; error: { message?: string; code?: string } | null };
export interface DeletionDb {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult>;
}

export type AuthAdminOutcome =
  | { outcome: "ok" }
  | { outcome: "not_found" }
  | { outcome: "error"; lastAdminProtected?: boolean };
export interface AuthAdmin {
  /** Bloquea nuevos inicios de sesión y la renovación de tokens (no revoca el JWT de acceso ya emitido: eso lo hace la barrera). */
  banUser(userId: string): Promise<AuthAdminOutcome>;
  /** Borrado DURO de la identidad (nunca soft delete). */
  deleteUser(userId: string): Promise<AuthAdminOutcome>;
}

const BAN_DURATION = "876000h"; // ~100 años: equivale a permanente; la identidad se elimina al final

function classifyAuthError(error: unknown): AuthAdminOutcome {
  const e = error as { status?: unknown; code?: unknown; message?: unknown } | null;
  const message = typeof e?.message === "string" ? e.message : "";
  if (e?.status === 404 || e?.code === "user_not_found") return { outcome: "not_found" };
  return {
    outcome: "error",
    ...(message.includes("last_admin_protected") ? { lastAdminProtected: true } : {}),
  };
}

export function createAuthAdmin(client: SupabaseClient): AuthAdmin {
  return {
    async banUser(userId) {
      try {
        const { error } = await client.auth.admin.updateUserById(userId, {
          ban_duration: BAN_DURATION,
        });
        return error ? classifyAuthError(error) : { outcome: "ok" };
      } catch (error) {
        return classifyAuthError(error);
      }
    },
    async deleteUser(userId) {
      try {
        const { error } = await client.auth.admin.deleteUser(userId, false);
        return error ? classifyAuthError(error) : { outcome: "ok" };
      } catch (error) {
        return classifyAuthError(error);
      }
    },
  };
}

export interface WorkerDeps {
  db: DeletionDb;
  authAdmin: AuthAdmin;
  workerId: string;
  /** Reloj inyectable (solo para presupuestos de tiempo; los plazos los decide siempre la BD). */
  now?: () => number;
}

export function defaultWorkerDeps(env: NodeJS.ProcessEnv = process.env): WorkerDeps {
  const url = env.VITE_SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("deletion_not_configured");
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    db: client as unknown as DeletionDb,
    authAdmin: createAuthAdmin(client),
    workerId: `w-${Math.random().toString(36).slice(2, 10)}`,
  };
}

interface StageOutcome {
  ok: boolean;
  code?: DeletionErrorCode;
  retryAfter?: number;
}
const OK: StageOutcome = { ok: true };
const fail = (code: DeletionErrorCode, retryAfter?: number): StageOutcome => ({
  ok: false,
  code,
  ...(retryAfter ? { retryAfter } : {}),
});

/** Traduce el mensaje de una excepción de la BD a un código cerrado (nunca se propaga el texto original). */
function dbFailure(error: { message?: string } | null): StageOutcome {
  const message = error?.message ?? "";
  if (message.includes("avatar_not_supported")) return fail("avatar_not_supported");
  if (message.includes("last_admin_protected")) return fail("last_admin_protected");
  return fail("db_error");
}

const isLeaseLost = (error: { message?: string } | null) =>
  /lease_lost|request_not_found/.test(error?.message ?? "");

async function sqlStage(
  db: DeletionDb,
  fn: string,
  requestId: string,
  worker: string,
): Promise<{ outcome: StageOutcome; data?: unknown; leaseLost?: boolean }> {
  const { data, error } = await db.rpc(fn, { p_request_id: requestId, p_worker: worker });
  if (error) {
    return isLeaseLost(error)
      ? { outcome: fail("unexpected"), leaseLost: true }
      : { outcome: dbFailure(error) };
  }
  return { outcome: OK, data };
}

async function runStageWork(
  deps: WorkerDeps,
  job: { requestId: string; userId: string },
  stage: DeletionStage,
): Promise<{ outcome: StageOutcome; leaseLost?: boolean }> {
  const { db, authAdmin, workerId } = deps;
  switch (stage) {
    case "auth_block": {
      // 1) Bloqueo de nuevos inicios de sesión / renovaciones. Una identidad ya inexistente cuenta como bloqueada.
      const ban = await authAdmin.banUser(job.userId);
      if (ban.outcome === "error") return { outcome: fail("auth_unavailable") };
      // 2) Revocación de sesiones y refresh tokens (SQL sobre auth.sessions).
      const revoked = await sqlStage(
        db,
        "account_deletion_revoke_sessions",
        job.requestId,
        workerId,
      );
      return { outcome: revoked.outcome, leaseLost: revoked.leaseLost };
    }
    case "copyright_claims":
      return sqlStage(db, "account_deletion_stage_copyright", job.requestId, workerId);
    case "community_content":
      return sqlStage(db, "account_deletion_stage_content", job.requestId, workerId);
    case "profile":
      return sqlStage(db, "account_deletion_stage_profile", job.requestId, workerId);
    case "media_gc": {
      // Los archivos exclusivos ya están en 'deleting': el GC EXISTENTE de R2 los borra. La etapa solo termina cuando no queda ninguno.
      const media = await sqlStage(
        db,
        "account_deletion_stage_media",
        job.requestId,
        workerId,
      );
      if (!media.outcome.ok) return media;
      const pending = (media.data as { pending?: unknown } | null)?.pending;
      if (typeof pending !== "number") return { outcome: fail("unexpected") };
      return { outcome: pending > 0 ? fail("media_gc_pending", 300) : OK };
    }
    case "auth_delete": {
      // Solo se llega aquí con todas las etapas anteriores 'done' (lo exige step_start). Una identidad ya inexistente equivale a éxito.
      const gone = await authAdmin.deleteUser(job.userId);
      if (gone.outcome === "ok" || gone.outcome === "not_found") return { outcome: OK };
      return {
        outcome: fail(
          gone.lastAdminProtected ? "last_admin_protected" : "auth_unavailable",
        ),
      };
    }
  }
}

export interface JobSummary {
  stagesDone: number;
  completed: boolean;
  failedStage: DeletionStage | null;
  released: boolean;
}

/** Recorre las etapas de UNA solicitud ya reclamada (lease del `workerId`). */
export async function runDeletionJob(
  deps: WorkerDeps,
  job: { requestId: string; userId: string },
  deadlineMs?: number,
): Promise<JobSummary> {
  const now = deps.now ?? Date.now;
  const summary: JobSummary = {
    stagesDone: 0,
    completed: false,
    failedStage: null,
    released: false,
  };
  for (const stage of DELETION_STAGES) {
    if (deadlineMs !== undefined && now() >= deadlineMs) {
      // Sin tiempo: se devuelve a la cola SIN contar fallo (la barrera sigue activa).
      const { error } = await deps.db.rpc("account_deletion_release", {
        p_request_id: job.requestId,
        p_worker: deps.workerId,
      });
      summary.released = !error;
      return summary;
    }
    const started = await deps.db.rpc("account_deletion_step_start", {
      p_request_id: job.requestId,
      p_worker: deps.workerId,
      p_stage: stage,
    });
    if (started.error) return summary; // lease perdido o fuera de orden: otro ejecutor / reintento posterior
    if ((started.data as { alreadyDone?: unknown } | null)?.alreadyDone === true) {
      summary.stagesDone += 1;
      continue;
    }
    let result: { outcome: StageOutcome; leaseLost?: boolean };
    try {
      result = await runStageWork(deps, job, stage);
    } catch {
      result = { outcome: fail("unexpected") };
    }
    if (result.leaseLost) return summary;
    const finished = await deps.db.rpc("account_deletion_step_finish", {
      p_request_id: job.requestId,
      p_worker: deps.workerId,
      p_stage: stage,
      p_ok: result.outcome.ok,
      p_error_code: result.outcome.ok ? null : (result.outcome.code ?? "unexpected"),
      p_retry_after_seconds: result.outcome.retryAfter ?? null,
    });
    if (finished.error) return summary; // el lease caducará y otro ejecutor reanudará (idempotente)
    if (!result.outcome.ok) {
      summary.failedStage = stage;
      return summary; // la BD ya programó el reintento o la intervención manual
    }
    summary.stagesDone += 1;
    if ((finished.data as { completed?: unknown } | null)?.completed === true) {
      summary.completed = true;
      return summary;
    }
  }
  return summary;
}

export interface BatchSummary {
  claimed: number;
  completed: number;
  failed: number;
  released: number;
}

export async function runAccountDeletionBatch(
  deps: WorkerDeps,
  options: { limit?: number; budgetMs?: number; leaseSeconds?: number } = {},
): Promise<BatchSummary> {
  const now = deps.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? 45_000);
  const claimed = await deps.db.rpc("account_deletion_claim", {
    p_worker: deps.workerId,
    p_lease_seconds: options.leaseSeconds ?? 300,
    p_limit: options.limit ?? 3,
  });
  const summary: BatchSummary = { claimed: 0, completed: 0, failed: 0, released: 0 };
  if (claimed.error || !Array.isArray(claimed.data)) return summary;
  for (const raw of claimed.data as Array<{ requestId?: unknown; userId?: unknown }>) {
    if (typeof raw.requestId !== "string" || typeof raw.userId !== "string") continue;
    summary.claimed += 1;
    const job = await runDeletionJob(
      deps,
      { requestId: raw.requestId, userId: raw.userId },
      deadline,
    );
    if (job.completed) summary.completed += 1;
    else if (job.failedStage) summary.failed += 1;
    else if (job.released) summary.released += 1;
  }
  return summary;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Petición firmada del despertador de la BD (account_deletion_tick) → backend. Dominio propio, secreto propio, cuerpo vacío.

export const RUN_REQUEST_PATH = "/api/admin/account-deletion-run";
export const RUN_TIMESTAMP_HEADER = "x-deletion-timestamp";
export const RUN_SIGNATURE_HEADER = "x-deletion-signature";
export const RUN_TOLERANCE_SECONDS = 30;

export function signRunRequest(secret: string, timestampSeconds: number): string {
  return createHmac("sha256", secret)
    .update(
      [
        "UPMINA-ACCOUNT-DELETION-V1",
        "POST",
        RUN_REQUEST_PATH,
        String(timestampSeconds),
      ].join("\n"),
    )
    .digest("base64url");
}

export function verifyRunRequest(
  secret: string,
  input: {
    timestamp: string | undefined;
    signature: string | undefined;
    nowSeconds: number;
  },
): boolean {
  if (!input.timestamp || !input.signature || !/^\d{1,12}$/.test(input.timestamp))
    return false;
  if (Math.abs(input.nowSeconds - Number(input.timestamp)) > RUN_TOLERANCE_SECONDS)
    return false;
  const expected = Buffer.from(signRunRequest(secret, Number(input.timestamp)));
  const given = Buffer.from(input.signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
