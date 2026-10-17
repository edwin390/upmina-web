# F4-B — local simulated executor

This phase adds no provider HTTP client, API key, migration, scheduler or automatic moderation.
No remote deployment/configuration is performed. F4-A and the separate retry-delay migration are
required dependencies. The five previous local retry-correction files are preserved.

## Execution

`content-shadow-executor.ts` is independent of HTTP. It claims exactly one job at a time using
`community_shadow_claim(p_limit: 1, p_lease_seconds: 120)` and processes at most two jobs in a batch.
Each RPC is a separate committed request: no transaction spans storage or simulated provider I/O.
The per-component timeout is at most two seconds; the batch processing deadline is 45 seconds,
with a final bounded persistence request. There is no detached work after the HTTP response.
This is concurrency one per batch, not a cross-instance global mutex. The HTTP handler also rejects
an overlapping batch with 409 while a batch is running in the same module instance. It releases that
local guard in finally, including failed executions. Different Vercel instances remain independent;
there is no deployment-wide parallelism cap. PostgreSQL leases isolate
multiple instances; the integration tests exercise independent backends and overlapping executors.
Leases and claim tokens fence persisted results, not every possible stale computation: after lease
expiry a former executor may still have non-cooperative I/O in flight. Only the current token can
finish. No exactly-once guarantee for external I/O is claimed, and the real provider is absent.

The claimed snapshot must identify DEV, the expected config/preprocessing revisions, a live lease,
an author, post/edit, version and ordered unique asset IDs. A trusted read rechecks current post
author/version/status/text and exact media membership, including pending-edit status/base version.
Each image read repeats that association check. The final SQL token/version/hash guard is the
authority when content changes between reads. A cancellation/deletion/version change can still
occur during simulated I/O; this may waste an evaluation, but cannot persist it as a current result.
No new SQL contract or direct shadow-table privilege is needed.

The executor calls only claim/finish. Reconciliation and maintenance remain separate internal
operations; claim already invokes bounded maintenance as specified by F4-A. There is no new
reconciliation loop or scheduler. The executor never writes Community, human audit, strikes,
notices or copyright state. It does not publish, retain, reject, hide or approve content.

## Fake transport and validation

`content-shadow-provider.ts` defines a request shaped as `model: omni-moderation-latest` plus a
single text or image_url input. Images use an in-memory data:image/webp;base64 representation.
Only `FakeModerationTransport` is accepted by this executor; the default returns canned safe
fixture responses with `fixture_shadow_response` / `fixture-omni-shadow`, never actual provider
evaluations. It is intentionally not a content classifier. Tests inject flagged/error fixtures.
No configuration value can switch this implementation to a real transport.

Before persistence, response identity/model, one result, flagged, category names, score range,
matching category maps and modality applicability are validated against the existing F4-A
contract. Additional response metadata is not persisted. Errors use only the SQL error-code
allowlist. Malformed/unknown failures never become safe evaluations or successful completions.
At least one category must actually apply to the submitted modality: an all-empty applicability
map cannot become complete coverage. Coverage of an image component does not imply that every
policy category supports images; text-only categories retain their unsupported applicability.
The compatibility shape is based on the existing approved local contract; no remote documentation
or provider connection was required for this implementation.

Text is evaluated only when nonempty. Every unique image is evaluated separately and sequentially.
No combined category score is invented. Video/audio/frames are never sent. Coverage is computed
separately from job state and SQL derives the authoritative persisted coverage. Video plus successful
text/images remains partial; a video-only observation is unsupported_video, not complete.

## Canonical image reads

`content-shadow-storage.ts` resolves asset/variant metadata through the trusted server client.
It verifies Community domain, owner, image kind, ready status and declared image/webp. It chooses
1600 first, otherwise 960/480, from variants with a canonical `community/<asset>/w<variant>.webp`
key and an internal four-MiB budget. It never reads the 2560 variant, original, arbitrary URL,
browser capability or user-supplied bucket/key. At most one object GET is performed per image.

The existing pipeline stores processed variants in the delivery bucket, including protected media;
the Worker controls delivery access. The reader uses authenticated S3 access directly to the exact
`upmina-media-dev-public` bucket through `getR2DevConfig`, which rejects Production. No public URL,
signed URL or capability is created. There is no public-delivery fallback if S3 denies the read.

The record size, GET MIME and Content-Length must match. A range cap and streaming byte checks
bound consumption, detect truncation/extra bytes and abort/destroy the stream. The reader allocates
one buffer of the verified record size, retaining no array of fragments; at most 65,536 fragments
(including empty ones) are accepted. This prevents unbounded object retention and microtask loops
from empty/tiny fragments. Four MiB bounds image payload, not the whole process heap/RSS: the SDK,
native parser and temporary Base64 representation also use memory. RIFF/WEBP magic and
sharp metadata verify the actual format, dimensions and single-frame property. Abort paths scrub
the owned buffer; the executor zeros the image buffer after its component. References to the
data URL are released after the call; JavaScript immutable strings, native SDK allocations and
already-returned memory cannot be guaranteed to be physically erased. Nothing logs or persists
those strings/bytes, and no global image cache is added.

## Retry and persistence outcomes

Retry-After accepts nonnegative integer seconds or validated HTTP dates (IMF-fixdate and the two
legacy HTTP-date forms), ceiling-rounded
against the local clock. Invalid, negative and past values add no wait beyond the SQL exponential
floor. Valid excessive values are never clamped down. Delay is the greater of Retry-After and the
10/20-second backoff plus zero-to-five seconds of jitter, limited by the SQL contract to 3600 seconds
and strictly before snapshot/retention expiry. The executor submits p_retry_delay_seconds and does
not sleep in memory. Transient failures stop the remaining components immediately; the transport
does not retry. At three attempts, excessive Retry-After or insufficient snapshot lifetime, the
job is finalized failed with a sanitized technical code, requiring operational review if appropriate.

Permanent component failures may coexist with successful components as partial observations.
retry_wait replaces component results according to SQL's existing rules. Expired local leases stop
evaluation/finalization; a later SQL stale_claim, obsolete, not_found or busy response is counted as
rejected, never success. busy is not spun on: the current claim remains for normal lease recovery.
This may consume another attempt. An RPC error/timeout has an unknown commit outcome and is counted
as persistenceErrors; no blind repeated finalization is attempted. A transient failure or persistence
error ends the batch, rather than trying another job during a known backoff/outage. These counters require operator
review and do not imply every job was persisted. No result is used as a moderation decision.

## Endpoint and isolation

`POST /api/admin/content-shadow-run` is a closed dispatcher action. It uses the existing
requireCapability(developer_panel) guard: verified session, current role/capability and recent MFA.
It requires CONTENT_SHADOW_RUN_ENABLED to equal exactly `true` (no trimming/coercion). Absent or
other values deny execution. No remote variable or .env.example is changed. The strict body is
`{ "limit": 1 }` or `{ "limit": 2 }`, defaulting to one for `{}`; extra keys/query parameters fail.
All responses are private, no-store. Only fixed operational counters are returned, including
mode=simulated, with no IDs, personal data, tokens, text, media, scores or raw technical errors.

The default runner rejects VERCEL_ENV=production, any Supabase URL other than the exact DEV URL,
and a mismatched VERCEL_PROJECT_ID when supplied by the runtime. It does not decode or independently
prove credential provenance; secrets are not inspected. This is a local implementation, not a
verification of remote configuration. No human-panel controls are added.
The environment identity check also runs before the shared Auth guard, preventing that guard from
contacting an incorrectly configured foreign project.

## Budget and future dependencies

The replaceable ShadowBudget interface reserves a component attempt; the default is explicitly
simulated and does not assert a daily quota. attemptedEvaluations counts provider-fixture attempts,
including errors/timeouts, independently of storage reads. The planned 100 real external requests/day
must use atomic persistent reservations across instances before any future real provider transport.
Provider-wide cooldowns across different jobs/instances also need a durable provider-level mechanism;
the implemented SQL retry deadline is per job, not a global rate-limit lock.
F4-B adds no durable quota infrastructure and cannot enable a real provider accidentally. F4-C,
credentials, provider policy/pricing validation and deployment all require further authorization.

## Local verification

Run the focused Vitest executor/reader/endpoint tests with `--no-cache` to avoid writing through the
existing node_modules junction to the protected checkout. Shared admin-auth/MFA tests verify the
actual guard; endpoint tests use legitimate negative guard outcomes, not fabricated sessions.
All storage/provider/network dependencies are fake. A global fetch trap rejects external calls.

Set UPMINA_SHADOW_EXECUTOR_TESTS=1 and run `node scripts/test-content-shadow-postgres.mjs` for real
PostgreSQL integration. The existing harness creates a unique loopback cluster/database and applies
the real two shadow migrations locally. Test modules are transpiled only into that run's temporary
directory and removed afterward. It proves persisted component results/coverage, durable Retry-After,
late-version rejection, and two independent executors with a controlled provider gate. The observer
checks there is no transaction open during simulated external I/O. No R2/OpenAI/Supabase remote call
is made; the isolated synthetic database and cluster are removed even on test failure.
