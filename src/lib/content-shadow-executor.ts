// Server-side executor: no HTTP dependency, transactions, Community writes or logging.
import type {
  ShadowJob,
  ShadowFinishInput,
  ShadowFinishOutcome,
  ShadowResultInput,
  ShadowCoverage,
} from "./content-shadow-contract.js";
import {
  SHADOW_CONFIG_REVISION,
  SHADOW_PREPROCESSING_VERSION,
} from "./content-shadow-contract.js";
import {
  bounded,
  FakeModerationTransport,
  ShadowFault,
  SHADOW_MODEL,
  retryDelay,
  validateModerationResponse,
} from "./content-shadow-provider.js";

export interface ShadowRepository {
  claim(signal: AbortSignal): Promise<ShadowJob[]>;
  finish(input: ShadowFinishInput, signal: AbortSignal): Promise<ShadowFinishOutcome>;
}
export interface ShadowMediaReader {
  verify(job: ShadowJob, signal: AbortSignal): Promise<void>;
  read(job: ShadowJob, assetId: string, signal: AbortSignal): Promise<Buffer>;
}
/** Replace with a durable cross-instance reservation before ANY real provider is introduced. */
export interface ShadowBudget {
  readonly mode: "simulated";
  reserve(): Promise<boolean>;
}
export interface ShadowSummary {
  mode: "simulated";
  claimed: number;
  attemptedEvaluations: number;
  finished: number;
  completed: number;
  partial: number;
  failed: number;
  retryWait: number;
  rejected: number;
  persistenceErrors: number;
}
export const simulatedBudget: ShadowBudget = {
  mode: "simulated",
  reserve: async () => true,
};
const uuid = (s: unknown): s is string =>
  typeof s === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export function validateClaim(job: ShadowJob): void {
  if (
    !job ||
    !uuid(job.id) ||
    !uuid(job.post_id) ||
    !uuid(job.author_user_id) ||
    !uuid(job.claim_token) ||
    job.state !== "processing" ||
    job.environment !== "dev" ||
    job.config_revision !== SHADOW_CONFIG_REVISION ||
    job.preprocessing_version !== SHADOW_PREPROCESSING_VERSION ||
    !Number.isInteger(job.version) ||
    job.version < 1 ||
    !Number.isInteger(job.attempts) ||
    job.attempts < 1 ||
    job.attempts > 3 ||
    !/^[0-9a-f]{64}$/.test(job.snapshot_hash) ||
    job.obsolete_at !== null ||
    !(
      (job.target_kind === "post" && job.edit_id === null && job.base_version === null) ||
      (job.target_kind === "pending_edit" &&
        uuid(job.edit_id) &&
        job.base_version === job.version)
    ) ||
    !(
      job.snapshot_text === null ||
      (typeof job.snapshot_text === "string" &&
        job.snapshot_text.length > 0 &&
        job.snapshot_text.length <= 5000)
    ) ||
    ![job.lease_until, job.snapshot_expires_at, job.retain_until].every(
      (x) => typeof x === "string" && Number.isFinite(Date.parse(x)),
    ) ||
    !Array.isArray(job.assets) ||
    job.assets.length > 10 ||
    new Set(job.assets.map((a) => a.asset_id)).size !== job.assets.length ||
    job.assets.some(
      (a, i) =>
        !uuid(a.asset_id) ||
        !["image", "video"].includes(a.kind) ||
        !Number.isInteger(a.position) ||
        a.position < 0 ||
        (i > 0 && a.position <= job.assets[i - 1].position),
    )
  )
    throw new ShadowFault("invalid_input");
}
export function coverage(job: ShadowJob, results: ShadowResultInput[]): ShadowCoverage {
  const text = job.snapshot_text ? 1 : 0,
    images = job.assets.filter((a) => a.kind === "image").length;
  const video = job.assets.some((a) => a.kind === "video");
  const okText = results.filter(
    (r) => r.component_kind === "text" && r.state === "succeeded",
  ).length;
  const okImages = results.filter(
    (r) => r.component_kind === "image" && r.state === "succeeded",
  ).length;
  return {
    overall:
      text + images === 0
        ? video
          ? "unsupported_video"
          : "not_applicable"
        : okText === text && okImages === images && !video
          ? "complete"
          : okText + okImages > 0
            ? "partial"
            : "failed",
    text: !text ? "not_applicable" : okText ? "complete" : "failed",
    images: !images
      ? "not_applicable"
      : okImages === images
        ? "complete"
        : okImages
          ? "partial"
          : "failed",
    video: video ? "unsupported_video" : "not_applicable",
  };
}
export async function runShadowBatch(
  deps: {
    repository: ShadowRepository;
    media: ShadowMediaReader;
    transport: FakeModerationTransport;
    budget?: ShadowBudget;
    now?: () => number;
    random?: () => number;
    componentTimeoutMs?: number;
  },
  limit = 1,
): Promise<ShadowSummary> {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 2 ||
    !(deps.transport instanceof FakeModerationTransport)
  )
    throw new ShadowFault("invalid_input");
  const budget = deps.budget ?? simulatedBudget;
  if (budget.mode !== "simulated") throw new ShadowFault("invalid_input");
  const now = deps.now ?? Date.now,
    random = deps.random ?? Math.random;
  const end = now() + 45000,
    componentMs = Math.min(2000, Math.max(1, deps.componentTimeoutMs ?? 2000));
  const summary: ShadowSummary = {
    mode: "simulated",
    claimed: 0,
    attemptedEvaluations: 0,
    finished: 0,
    completed: 0,
    partial: 0,
    failed: 0,
    retryWait: 0,
    rejected: 0,
    persistenceErrors: 0,
  };
  const repositoryCall = <T>(op: (s: AbortSignal) => Promise<T>) =>
    bounded(op, Math.min(3000, end - now()), new ShadowFault("internal_failure"));
  for (let n = 0; n < limit && now() < end; n++) {
    let jobs: ShadowJob[];
    try {
      jobs = await repositoryCall((s) => deps.repository.claim(s));
    } catch {
      summary.persistenceErrors++;
      break;
    }
    if (!Array.isArray(jobs) || jobs.length > 1) {
      summary.persistenceErrors++;
      break;
    }
    if (!jobs.length) break;
    const job = jobs[0];
    summary.claimed++;
    try {
      validateClaim(job);
    } catch {
      summary.rejected++;
      continue;
    }
    const expires = Math.min(
      Date.parse(job.lease_until!),
      Date.parse(job.snapshot_expires_at),
      Date.parse(job.retain_until),
      end,
    );
    const alive = () => {
      if (now() + 100 >= expires) throw new ShadowFault("internal_failure");
    };
    const results: ShadowResultInput[] = [],
      faults: ShadowFault[] = [];
    let stopped = false;
    try {
      alive();
      await bounded(
        (s) => deps.media.verify(job, s),
        Math.min(componentMs, expires - now() - 100),
        new ShadowFault("asset_unavailable", true),
      );
      const components = [
        ...(job.snapshot_text
          ? [{ component_kind: "text" as const, asset_id: null }]
          : []),
        ...job.assets
          .filter((a) => a.kind === "image")
          .map((a) => ({ component_kind: "image" as const, asset_id: a.asset_id })),
      ];
      for (const component of components) {
        let bytes: Buffer | undefined;
        try {
          alive();
          if (component.component_kind === "image")
            bytes = await bounded(
              (s) => deps.media.read(job, component.asset_id!, s),
              Math.min(componentMs, expires - now() - 100),
              new ShadowFault("asset_unavailable", true),
            );
          if (
            !(await bounded(
              () => budget.reserve(),
              Math.min(componentMs, expires - now() - 100),
              new ShadowFault("internal_failure"),
            ))
          )
            throw new ShadowFault("internal_failure");
          alive();
          summary.attemptedEvaluations++;
          const start = now();
          const response = await bounded(
            (s) =>
              deps.transport.evaluate(
                {
                  model: SHADOW_MODEL,
                  input: [
                    bytes
                      ? {
                          type: "image_url",
                          image_url: {
                            url: `data:image/webp;base64,${bytes.toString("base64")}`,
                          },
                        }
                      : { type: "text", text: job.snapshot_text! },
                  ],
                },
                s,
              ),
            Math.min(componentMs, expires - now() - 100),
            new ShadowFault("provider_timeout", true),
          );
          alive();
          results.push({
            ...component,
            ...validateModerationResponse(response, component.component_kind),
            latency_ms: Math.max(0, Math.min(300000, now() - start)),
          } as ShadowResultInput);
        } catch (e) {
          const fault =
            e instanceof ShadowFault ? e : new ShadowFault("internal_failure");
          faults.push(fault);
          results.push({
            ...component,
            state: "failed",
            model_requested: SHADOW_MODEL,
            error_code: fault.code,
          } as ShadowResultInput);
          if (fault.retryable) break; // Respect provider backoff before attempting any other component.
        } finally {
          bytes?.fill(0);
          bytes = undefined;
        }
      }
    } catch (e) {
      faults.push(e instanceof ShadowFault ? e : new ShadowFault("internal_failure"));
      stopped = true;
    }
    if (now() + 100 >= expires) {
      summary.rejected++;
      continue;
    }
    const cov = coverage(job, results);
    let state: ShadowFinishInput["p_state"] = stopped
      ? "failed"
      : cov.overall === "complete" || cov.overall === "not_applicable"
        ? "completed"
        : cov.overall === "partial" || cov.overall === "unsupported_video"
          ? "partial"
          : "failed";
    let delay: number | undefined;
    const transient = faults.filter((f) => f.retryable);
    if (transient.length && job.attempts < 3) {
      delay = Math.max(
        ...transient.map((f) => retryDelay(job.attempts, f.retryAfter, now(), random())),
      );
      if (
        delay <= 3600 &&
        now() + delay * 1000 <
          Math.min(Date.parse(job.snapshot_expires_at), Date.parse(job.retain_until))
      )
        state = "retry_wait";
      else {
        state = "failed";
        delay = undefined;
      } // Never clamp a valid long Retry-After down.
    }
    try {
      const outcome = await repositoryCall((s) =>
        deps.repository.finish(
          {
            p_job_id: job.id,
            p_claim_token: job.claim_token!,
            p_state: state,
            p_results: results,
            p_error_code: faults[0]?.code ?? null,
            p_retry_delay_seconds: state === "retry_wait" ? delay : null,
          },
          s,
        ),
      );
      if (outcome === "finished") {
        summary.finished++;
        summary[state === "retry_wait" ? "retryWait" : state]++;
      } else if (["busy", "not_found", "stale_claim", "obsolete"].includes(outcome))
        summary.rejected++;
      else summary.persistenceErrors++;
    } catch {
      summary.persistenceErrors++;
    } // Unknown commit outcome is never reported as success.
    if (summary.persistenceErrors || transient.length) break; // No further work during a known backoff/outage.
  }
  return summary;
}
