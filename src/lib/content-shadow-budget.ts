// Server-only budget authority. No provider transport or process-local quota counters.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ShadowJob } from "./content-shadow-contract.js";
import { ShadowFault } from "./content-shadow-provider.js";

export type BudgetDenied = {
  status: "quota_exhausted" | "cooldown_active";
  retry_at: string;
};
export type BudgetRejected = {
  status: "not_found" | "stale_claim" | "obsolete" | "busy" | "invalid_scope";
};
export type BudgetReservation =
  | { status: "reserved"; reservation_id: string; units: number }
  | BudgetDenied
  | BudgetRejected;
export interface PersistentShadowBudget {
  readonly mode: "persistent_dev";
  reserve(job: ShadowJob, units: number, signal: AbortSignal): Promise<BudgetReservation>;
  check(
    job: ShadowJob,
    reservationId: string,
    signal: AbortSignal,
  ): Promise<{ status: "allowed" } | BudgetDenied | BudgetRejected>;
  cooldown(seconds: number, signal: AbortSignal): Promise<void>;
}
const uuid = (x: unknown): x is string =>
  typeof x === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
function decision(
  raw: unknown,
):
  | BudgetDenied
  | BudgetRejected
  | { status: "allowed" }
  | { status: "reserved"; reservation_id: string; units: number } {
  if (!raw || typeof raw !== "object") throw new ShadowFault("internal_failure");
  const d = raw as Record<string, unknown>;
  if (d.status === "quota_exhausted" || d.status === "cooldown_active") {
    if (typeof d.retry_at !== "string" || !Number.isFinite(Date.parse(d.retry_at)))
      throw new ShadowFault("internal_failure");
    return { status: d.status, retry_at: d.retry_at };
  }
  if (
    d.status === "reserved" &&
    uuid(d.reservation_id) &&
    Number.isInteger(d.units) &&
    (d.units as number) >= 1 &&
    (d.units as number) <= 11
  )
    return {
      status: "reserved",
      reservation_id: d.reservation_id,
      units: d.units as number,
    };
  if (d.status === "allowed") return { status: "allowed" };
  if (
    ["not_found", "stale_claim", "obsolete", "busy", "invalid_scope"].includes(
      d.status as string,
    )
  )
    return { status: d.status as BudgetRejected["status"] };
  throw new ShadowFault("internal_failure");
}
export function shadowSqlBudget(client: SupabaseClient): PersistentShadowBudget {
  async function rpc(name: string, input: Record<string, unknown>, signal: AbortSignal) {
    try {
      const { data, error } = await client.rpc(name, input).abortSignal(signal);
      if (error) throw new ShadowFault("internal_failure");
      return data;
    } catch {
      throw new ShadowFault("internal_failure");
    }
  }
  return {
    mode: "persistent_dev",
    async reserve(job, units, signal) {
      const result = decision(
        await rpc(
          "community_shadow_budget_reserve",
          {
            p_job_id: job.id,
            p_claim_token: job.claim_token,
            p_units: units,
          },
          signal,
        ),
      );
      if (
        result.status === "allowed" ||
        (result.status === "reserved" && result.units !== units)
      )
        throw new ShadowFault("internal_failure");
      return result;
    },
    async check(job, reservationId, signal) {
      const result = decision(
        await rpc(
          "community_shadow_budget_check",
          {
            p_job_id: job.id,
            p_claim_token: job.claim_token,
            p_reservation_id: reservationId,
          },
          signal,
        ),
      );
      if (result.status === "reserved") throw new ShadowFault("internal_failure");
      return result;
    },
    async cooldown(seconds, signal) {
      if (!Number.isSafeInteger(seconds) || seconds < 1)
        throw new ShadowFault("internal_failure");
      const data = await rpc(
        "community_shadow_budget_cooldown",
        { p_retry_after_seconds: seconds },
        signal,
      );
      if (
        !data ||
        data.status !== "cooldown_active" ||
        typeof data.halted !== "boolean" ||
        (!data.halted &&
          (typeof data.retry_at !== "string" ||
            !Number.isFinite(Date.parse(data.retry_at))))
      )
        throw new ShadowFault("internal_failure");
    },
  };
}
