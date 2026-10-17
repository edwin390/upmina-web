# Community shadow persistence — F4-A

Local migration only: `20261122120000_community_shadow_persistence.sql`. No provider integration,
HTTP endpoint, SDK, scheduler, R2 operation or human moderation action is added.

## Capture and identity

Initially deferred constraint triggers observe final posts, post media, pending edits and pending
edit media. Each invocation reads final state; the UNIQUE constraint collapses repeated events.
Events and jobs inside reverted subtransactions disappear together. In particular, the provisional
save performed by `community_post_pending_edit_submit` does not capture a published edit.
Several saves in one transaction produce only the last committed state, not intermediate versions.

Identity: `(environment, target_kind, post_id, edit_id, version, snapshot_hash, config_revision)` with
NULLS NOT DISTINCT. Pending edits use their unique edit ID and base version. DEV is intentionally
hardcoded; this migration is not a Production configuration. `shadow-v1` and `community-webp-v1`
identify the initial configuration. A future reviewed migration can revise capture configuration
to re-evaluate; no unrestricted client can choose configuration or environment.

The SHA-256 fingerprint covers NFC/trimmed text, ordered asset IDs/kinds/positions and preprocessing
version. It is a descriptor fingerprint, NOT a digest of physical image bytes. No global cross-user
cache exists. SQL never stores URLs, capabilities, credentials or binary content.

## Failure and recovery

Capture and asset-status invalidation use exception subtransactions, NOWAIT row invalidation,
a nonblocking per-target capture advisory lock, a 100ms lock-timeout fallback and sanitized
SQLSTATE-only warnings. A visible existing identity is checked before attempting a UNIQUE insert.
They never hide errors from the original content RPC. Content
can commit without a job after a shadow failure. Warnings are technical server events, not human
audit entries. No third persistence table is introduced just to log failure of persistence itself.

`community_shadow_reconcile(limit)` attempts at most 100 valid current snapshots from the last 24 hours.
It cannot recover vanished intermediate versions. Old expired text is not resurrected. Recovery
requires an explicit internal caller; no periodic execution is installed. Invalid/stale proposals
are filtered before the batch limit; identity checks include the actual fingerprint. The limit bounds
capture attempts, not every database row the selection query may examine.

Fail-open is not zero contention: relation locks, constraint/FK checks, CPU work and repeated deferred
events can still consume time. NOWAIT avoids waiting for busy queue rows; the fallback lock timeout
is per lock wait, not a whole-transaction deadline. PostgreSQL OTHERS intentionally does not swallow
query cancellation or assertion failure; client cancellation/statement timeout may still abort the
parent transaction. No unbounded wait or suppression of the original write error is promised.

## Queue boundary

Only service_role can execute `community_shadow_claim`, `community_shadow_finish`,
`community_shadow_maintain`, and `community_shadow_reconcile`. Direct table privileges and all
helper/schema privileges are revoked from every API role; both tables have forced RLS and no
policies. PostgreSQL-owner administration is not an API role.

Claims use SKIP LOCKED, independent claim tokens, a 10–300 second lease and at most three attempts.
The consumer must commit the claim transaction BEFORE doing external I/O (F4-B). Finishing requires
an unexpired lease/token, a live target and matching version/fingerprint. No result is applied to
content: finishing writes only observations. Retried attempts clear their result set atomically;
repeated completion returns stale_claim. Invalid result sets roll back as one operation.

Finalization locks the parent post FOR SHARE NOWAIT before locking the job FOR UPDATE NOWAIT,
then validates the live snapshot. This serializes result insertion against post updates and human
edit decisions, rather than relying on an MVCC read that can go stale mid-call. If either lock is
busy, the subtransaction releases acquired locks and returns `busy` without consuming the lease.
The caller may retry within that lease. Successful SQL transactions must be committed promptly:
the short parent lock can briefly delay content writes/deletion; never hold it during external I/O.
At REPEATABLE READ, a stale parent version can raise PostgreSQL serialization_failure (40001)
rather than return a normal queue outcome. The caller must roll back/retry its transaction;
the RPC does not suppress that error or persist results from the stale transaction snapshot.

Result input fields, category names, score ranges, modality values and sanitized error codes are
allowlisted. Provider fields are structures for future use, not manufactured OpenAI responses.
The local tests use explicitly named `fixture-model` / `fixture_response` values.

## Coverage

Job processing state is separate from coverage (`overall`, `text`, `images`, `video`). Null coverage
means not assessed yet. Complete/partial/unsupported_video/failed/not_applicable describe coverage.
SQL derives coverage from actually supplied successful text/image components. A video has
unsupported_video coverage; successful accompanying text can only yield partial overall coverage.
There is no video extraction or processing. Text-only categories cannot claim image support.

## Lifecycle

Snapshot expiry is at most 24h from the source version timestamp (and never later than 24h from
capture). Claims/completions enforce expiry even before maintenance. Terminal completion clears
text immediately. `community_shadow_maintain(limit)` physically scrubs expired text and removes
jobs/results after their 30-day retention deadline in bounded batches, skipping locked rows.
Without an authorized future caller/scheduler, physical scrubbing is NOT guaranteed at the exact
deadline. Logically expired text is not returned by the claim RPC.
Maintenance scrub and retention deletion are atomic within the caller's transaction: an uncaught
failure rolls both back, and a retry is idempotent. A worker that already received text cannot have
its in-memory copy revoked by SQL; a future executor must enforce its own memory/logging lifecycle.

Post, pending-edit and Auth-user deletion cascade shadow jobs/results. Account-deletion's existing
community-post removal stage therefore also erases these observations without changing that worker.
Closing/cancelling an edit or changing the public version invalidates old jobs/tokens. Making an
asset unavailable cancels active jobs; physically deleting an asset erases affected observations
and results, rather than retaining dangling identifiers or preventing GC through a snapshot FK.
The asset-delete trigger is fail-closed for erasure (bounded lock wait); a failed deletion can be
retried by the existing lifecycle. Mandatory human audit tables/triggers are unchanged.

Deletion may briefly wait for an in-flight SQL finalization. If finalization wins, it records a
historical result and the subsequent delete cascades it away. If deletion wins, finalization returns
`busy` while the parent deletion is uncommitted and `not_found` after commit. No old token can recreate
the erased job/results. These guarantees cover the content-removal and Auth FK boundaries; the full
irreversible account-deletion worker is inspected, not invoked by the isolated tests.

Historical `completed` results keep their original version/edit identity and become obsolete when
the target changes; active observations are cancelled. `stale_claim` includes expired/replaced tokens,
cancelled jobs and repeat completion; `obsolete` means a still-live claim no longer matches its target.
The obsolete flag is a best-effort hint under fail-open capture failures, never a substitute for the
live version/hash guard. Trusted SQL callers must preserve initially deferred trigger execution:
explicit SET CONSTRAINTS IMMEDIATE can observe intermediate states and is outside this capture contract.

## Local verification

`node scripts/test-content-shadow-postgres.mjs [PostgreSQL-bin-directory]` creates a unique local
cluster/database listening only on loopback, loads the existing isolated Auth/copyright fixture
and real content/decision migrations, then applies F4-A transactionally. Tests run in rollback
transactions except isolated concurrency fixtures, which are erased before dropping the database.
Two independent backends hold overlapping claim transactions. A third connection verifies both
transactions and that SKIP LOCKED returns disjoint jobs (or no job), not a serialized simulation.
Finally it drops the database, stops the cluster and removes cluster files. Only a temporary
technical JSON report remains outside Git. No existing PostgreSQL service is used or modified.

Set `UPMINA_SHADOW_TEST_FILTER` to a name regex for targeted runs (for example `audit:`). The audit
cases cover starvation by stale proposals, atomic maintenance failure/retry, late cached tokens,
historical edit identity and actual independent-backend races for version changes and both orders
of post/Auth-user deletion. A test-only copy of the original waiting asset invalidation reproduces
the statement-timeout failure, then restores the corrected function before verifying NOWAIT.
No helper replacement is made outside the isolated test database.

The audit corrected three consistency/reliability defects in this pending migration: invalid
proposals consuming the reconciliation limit; queue-row waits cancelling a short-budget content
save; and an MVCC freshness check racing a committed public-version change during finalization.
A still-pending proposal with a changed base version is now labelled version_changed, not edit_closed.
There is still no scheduler or automatic provider evaluation. Physical deadlines require a future
authorized maintenance caller, and the irreversible account-deletion workflow is not run end to end.

## Local retry contract extension (before F4-B)

`20261123120000_community_shadow_retry_delay.sql` supersedes only the finish RPC. It must be
applied transactionally after F4-A. The original migration is unchanged. The sole installed signature is:

```sql
community_shadow_finish(
  p_job_id uuid, p_claim_token uuid, p_state text,
  p_results jsonb default '[]', p_error_code text default null,
  p_retry_delay_seconds integer default null
) returns text
```

Adding an input argument creates a different PostgreSQL function identity, even with CREATE OR REPLACE.
The extension uses DROP FUNCTION RESTRICT for the old five-argument signature, then CREATE, explicit
owner postgres, SECURITY DEFINER, search_path pg_catalog/public, REVOKE PUBLIC/anon/authenticated/service_role
and GRANT EXECUTE only to service_role. Unexpected catalog dependencies abort the migration; no CASCADE
is used. There are no table grants, overloads or alternate unvalidated scheduling entry points.
Existing positional three/four/five-argument and named calls resolve using defaults. Inspected callers
are the local F4-A test scripts; tests that assert the old regprocedure identity apply to F4-A alone.
The retry-specific harness checks the new identity after applying both migrations.

For retry_wait, attempts 1 and 2 have minimum delays of 10 and 20 seconds (the existing exponential
floor). An omitted/null delay preserves that floor. An explicit integer delay may increase it up to
3600 seconds, accommodating bounded jitter and Retry-After. The future executor must convert either
Retry-After header form into ceiling-rounded seconds, then request at least the maximum of that value
and its exponential-backoff-plus-jitter value. SQL receives only a bounded delay, not a timestamp or
raw header; it cannot independently verify the provider header. A 120-second delay persists at least
120 seconds from the finish call and blocks other instances from claiming early.

Zero/negative/below-floor/over-3600 delays raise invalid_retry_delay; a delay supplied for a terminal
state also raises invalid_retry_delay. A scheduled retry reaching snapshot expiry or retain_until
raises retry_after_expiry. Neither deadline is extended. Retry-After above 3600 or beyond remaining
snapshot lifetime cannot be silently clamped down: the future executor must decline that retry and
record an appropriate terminal technical failure instead. The third attempt still converts retry_wait
to failed, clears text/token/lease, and does not schedule another attempt; a structurally valid delay
is ignored in this exhausted case. Non-retry outcomes preserve next_attempt_at without using it.

The existing token, lease, target/version/hash and NOWAIT guards remain unchanged. Delay validation
occurs before component inserts, and failed calls have no partial writes. No Community or human-audit
operation is added. The daily persistent request budget remains a separate, unimplemented design task.

Run only the retry checks with PowerShell:

```powershell
$env:UPMINA_SHADOW_RETRY_TESTS='1'
node scripts/test-content-shadow-postgres.mjs
Remove-Item Env:UPMINA_SHADOW_RETRY_TESTS
```

This reuses the isolated loopback PostgreSQL fixture, includes migration rollback and RESTRICT tests,
and uses independent psql connections with overlapping transactions to test scheduling visibility.
After proving the 120-second deadline and early-claim rejection, the due-time compatibility test moves
only a synthetic job's next_attempt_at using the local fixture owner, avoiding a two-minute sleep.
No privileged scheduling bypass is exposed to API roles. The temporary database/cluster is removed.
