// Compile-only negative tests. Not imported by the app or executed against any provider.
import type {
  ShadowAppliedInputTypes,
  ShadowCoverage,
  ShadowFinishOutcome,
  ShadowJob,
  ShadowResultInput,
} from "./content-shadow-contract";

const invalidModalities: ShadowAppliedInputTypes = {
  // @ts-expect-error This category supports text only; image score 0 is not evidence of coverage.
  "sexual/minors": ["image"],
};
const invalidCoverage: ShadowCoverage = {
  overall: "partial",
  text: "complete",
  images: "not_applicable",
  // @ts-expect-error Evaluating accompanying text never completes video coverage.
  video: "complete",
};
// @ts-expect-error An image component requires an asset identifier.
const missingAsset: ShadowResultInput = {
  component_kind: "image",
  state: "failed",
  model_requested: "fixture-model",
  error_code: "provider_timeout",
};
// @ts-expect-error A publication observation cannot be identified as a pending edit.
const wrongTarget: Pick<ShadowJob, "target_kind"> = { target_kind: "moderation_case" };
void [invalidModalities, invalidCoverage, missingAsset, wrongTarget];
const retryableContention: ShadowFinishOutcome = "busy";
// @ts-expect-error Queue outcomes never authorize Community publication.
const notAModerationDecision: ShadowFinishOutcome = "publish";
void [retryableContention, notAModerationDecision];
