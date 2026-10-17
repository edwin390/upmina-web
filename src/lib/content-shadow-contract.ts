// F4-A persistence contract only. No HTTP client, provider SDK, scheduler or moderation actions.
export const SHADOW_CONFIG_REVISION = "shadow-v1";
export const SHADOW_PREPROCESSING_VERSION = "community-webp-v1";
export const SHADOW_SNAPSHOT_TTL_HOURS = 24;
export const SHADOW_RETENTION_DAYS = 30;
export const SHADOW_MAX_ATTEMPTS = 3;

export type ShadowJobState =
  | "queued"
  | "processing"
  | "retry_wait"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "expired";
export type ShadowCoverageStatus =
  "complete" | "partial" | "unsupported_video" | "failed" | "not_applicable";
export interface ShadowCoverage {
  overall: ShadowCoverageStatus | null;
  text: "complete" | "failed" | "not_applicable" | null;
  images: "complete" | "partial" | "failed" | "not_applicable" | null;
  video: "unsupported_video" | "not_applicable" | null;
}
export interface ShadowAsset {
  asset_id: string;
  kind: "image" | "video";
  position: number;
}
export type ShadowErrorCode =
  | "provider_timeout"
  | "provider_rate_limit"
  | "provider_unavailable"
  | "invalid_input"
  | "auth_unavailable"
  | "asset_unavailable"
  | "internal_failure";
export type ShadowCategory =
  | "harassment"
  | "harassment/threatening"
  | "hate"
  | "hate/threatening"
  | "illicit"
  | "illicit/violent"
  | "self-harm"
  | "self-harm/intent"
  | "self-harm/instructions"
  | "sexual"
  | "sexual/minors"
  | "violence"
  | "violence/graphic";

interface ShadowJobBase {
  id: string;
  environment: "dev";
  post_id: string;
  author_user_id: string;
  version: number;
  snapshot_text: string | null;
  assets: ShadowAsset[];
  /** Descriptor hash, not an image-byte hash. Never a public identifier. */
  snapshot_hash: string;
  preprocessing_version: typeof SHADOW_PREPROCESSING_VERSION;
  config_revision: string;
  state: ShadowJobState;
  attempts: number;
  next_attempt_at: string;
  lease_until: string | null;
  claim_token: string | null;
  coverage: ShadowCoverage;
  last_error_code: ShadowErrorCode | "attempts_exhausted" | null;
  created_at: string;
  updated_at: string;
  snapshot_expires_at: string;
  retain_until: string;
  obsolete_at: string | null;
  obsolete_reason: "version_changed" | "edit_closed" | "asset_unavailable" | null;
}
export type ShadowJob = ShadowJobBase &
  (
    | { target_kind: "post"; edit_id: null; base_version: null }
    | { target_kind: "pending_edit"; edit_id: string; base_version: number }
  );

type TextOnlyCategory =
  | "harassment"
  | "harassment/threatening"
  | "hate"
  | "hate/threatening"
  | "illicit"
  | "illicit/violent"
  | "sexual/minors";
export type ShadowAppliedInputTypes = Partial<{
  [K in ShadowCategory]: K extends TextOnlyCategory ? "text"[] : ("text" | "image")[];
}>;

type ComponentIdentity =
  | { component_kind: "text"; asset_id?: null }
  | { component_kind: "image"; asset_id: string };
type ResultPayload = {
  model_requested: string;
  latency_ms?: number;
} & (
  | {
      state: "succeeded";
      model_returned: string;
      provider_response_id: string;
      flagged: boolean;
      categories: Partial<Record<ShadowCategory, boolean | null>>;
      category_scores: Partial<Record<ShadowCategory, number>>;
      category_applied_input_types: ShadowAppliedInputTypes;
      error_code?: null;
    }
  | { state: "failed"; error_code: ShadowErrorCode; flagged?: null }
);
export type ShadowResultInput = ComponentIdentity & ResultPayload;
export interface ShadowFinishInput {
  p_job_id: string;
  p_claim_token: string;
  p_state: "completed" | "partial" | "failed" | "retry_wait";
  p_results?: ShadowResultInput[];
  p_error_code?: ShadowErrorCode | null;
  /** retry_wait only: exponential minimum through 3600s, strictly before snapshot expiry. */
  p_retry_delay_seconds?: number | null;
}
/** busy is non-terminal: the caller may retry within the same lease; it is not a moderation decision. */
export type ShadowFinishOutcome =
  "finished" | "not_found" | "stale_claim" | "obsolete" | "busy";
