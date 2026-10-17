// Only called inside the existing unique, isolated loopback PostgreSQL harness.
import assert from "node:assert/strict";
const file = "20261124120000_community_shadow_administrative_defer.sql";
const author = "33333333-3333-4333-8333-333333333333";
const flush = "set constraints all immediate; set constraints all deferred;";
const seed = `create temporary table defer_post on commit drop as select pg_temp.make_post() id;
  ${flush}
  create temporary table leased on commit drop as select * from community_shadow_acquire(1,60);
  select pg_temp.check_ok(count(*)=1,'exactly one synthetic acquisition') from leased;
  create temporary table content_before on commit drop as select to_jsonb(p) doc from community_posts p join defer_post r using(id);`;
const start = `select pg_temp.check_ok(community_shadow_attempt_start(id,claim_token)='started','start') from leased;`;
const postpone = (when = "clock_timestamp()+interval '2 hours'", expected = "deferred") =>
  `select pg_temp.check_ok(community_shadow_defer(id,claim_token,${when},'quota_exhausted')='${expected}','defer') from leased;`;
const unchanged = `select pg_temp.check_ok(to_jsonb(p)=b.doc,'Community unchanged') from community_posts p
  join defer_post r using(id) cross join content_before b;`;
const reclaim = `update community_shadow_jobs set next_attempt_at=clock_timestamp()-interval '1 second';
  truncate leased; insert into leased select * from community_shadow_acquire(1,60);`;
const rejectDate = (
  when,
  code = "invalid_deferral",
) => `select pg_temp.expect_error(format(
  'select community_shadow_defer(%L,%L,${when.replaceAll("'", "''")},%L)',id,claim_token,'quota_exhausted'),'${code}') from leased;`;
const liveSame = `select pg_temp.check_ok(j.attempts=c.attempts and j.claim_token=c.claim_token and j.state='processing',
  'invalid defer has no writes') from community_shadow_jobs j join leased c using(id);`;

export async function runAdministrativeProtocol({
  observer,
  Session,
  migration,
  report,
}) {
  const record = (name, evidence = {}) =>
    report.results.push({ name: `defer: ${name}`, status: "PASS", ...evidence });
  await observer.query(
    `begin; ${migration("20261123120000_community_shadow_retry_delay.sql")} commit;`,
  );
  // Migrate an actual pre-extension in-flight legacy claim; rollback must preserve its exact state.
  const post = await observer.query(
    "select pg_temp.make_post('Synthetic migration compatibility');",
  );
  const legacy = (
    await observer.json("select json_agg(j) from community_shadow_claim(1,60) j;")
  )[0];
  const oldDef = await observer.query(
    "select pg_get_functiondef('community_shadow_claim(integer,integer)'::regprocedure);",
  );
  await observer.query(`begin; ${migration(file)} rollback;`);
  assert.equal(
    await observer.query(
      "select pg_get_functiondef('community_shadow_claim(integer,integer)'::regprocedure);",
    ),
    oldDef,
  );
  assert.equal(
    await observer.query(
      "select count(*) from information_schema.columns where table_name='community_shadow_jobs' and column_name='attempt_claim_token';",
    ),
    "0",
  );
  assert.equal(
    await observer.query(
      "select to_regprocedure('community_shadow_defer(uuid,uuid,timestamptz,text)') is null;",
    ),
    "t",
  );
  assert.equal(
    await observer.query(
      `select claim_token from community_shadow_jobs where id='${legacy.id}';`,
    ),
    legacy.claim_token,
  );
  record("migration rollback restores function, table shape and live claim");
  await observer.query(`begin; ${migration(file)} commit;`);
  assert.equal(
    await observer.query(
      `select attempt_claim_token from community_shadow_jobs where id='${legacy.id}';`,
    ),
    legacy.claim_token,
  );
  assert.equal(
    await observer.query(
      `select community_shadow_attempt_start('${legacy.id}','${legacy.claim_token}');`,
    ),
    "already_started",
  );
  assert.equal(
    await observer.query(
      `select community_shadow_finish('${legacy.id}','${legacy.claim_token}','completed',pg_temp.success_results('${legacy.id}'));`,
    ),
    "finished",
  );
  assert.equal(
    await observer.query(
      `select attempts from community_shadow_jobs where id='${legacy.id}';`,
    ),
    "1",
  );
  await observer.query(`delete from community_posts where id='${post}';`);
  record("existing F4-B in-flight claim remains started; no refund or extra increment");

  const cases = [
    [
      "acquire and future defer preserve count, identity, TTL and invalidate lease",
      `${seed}
      select pg_temp.check_ok(attempts=0 and attempt_claim_token is null,'acquisition consumes no attempt') from leased;
      ${postpone()}
      select pg_temp.check_ok(j.state='retry_wait' and j.attempts=0 and j.claim_token is null and j.lease_until is null
        and j.attempt_claim_token is null and j.administrative_defer_reason='quota_exhausted'
        and j.snapshot_hash=c.snapshot_hash and j.version=c.version and j.snapshot_expires_at=c.snapshot_expires_at
        and j.retain_until=c.retain_until,'identity and TTL unchanged') from community_shadow_jobs j join leased c using(id);
      select pg_temp.check_ok(count(*)=0,'no early claim') from community_shadow_acquire(1,60);
      select pg_temp.check_ok(count(*)=0,'legacy claim cannot bypass schedule') from community_shadow_claim(1,60);
      ${unchanged}`,
    ],
    [
      "reclaim after fixture-clock advance retains count and replaces token",
      `${seed}
      create temporary table old_lease on commit drop as select * from leased;
      ${postpone()} ${reclaim}
      select pg_temp.check_ok(c.attempts=0 and c.claim_token<>o.claim_token,'new ownership without consumption') from leased c cross join old_lease o;
      select pg_temp.check_ok(community_shadow_attempt_start(id,claim_token)='stale_claim','old start') from old_lease;
      select pg_temp.check_ok(community_shadow_finish(id,claim_token,'failed')='stale_claim','late result') from old_lease;
      select pg_temp.check_ok(community_shadow_defer(id,claim_token,clock_timestamp()+interval '2 hours','cooldown_active')='stale_claim','old defer') from old_lease;
      ${unchanged}`,
    ],
    [
      "repeated administrative deferrals never consume or reset attempts",
      `${seed}
      ${Array.from(
        { length: 5 },
        () => `${postpone()} ${reclaim}
        select pg_temp.check_ok(attempts=0,'no effective attempt') from community_shadow_jobs;`,
      ).join("\n")}
      ${unchanged}`,
    ],
    [
      "start is idempotent for the same live token",
      `${seed} ${start}
      select pg_temp.check_ok(community_shadow_attempt_start(id,claim_token)='already_started','idempotent start') from leased;
      select pg_temp.check_ok(attempts=1 and attempt_claim_token=claim_token,'one authorization') from community_shadow_jobs;
      ${unchanged}`,
    ],
    [
      "unstarted claims cannot finalize through old finish route",
      `${seed}
      select pg_temp.check_ok(community_shadow_finish(id,claim_token,'completed',pg_temp.success_results(id))='attempt_not_started','no uncounted results') from leased;
      select pg_temp.check_ok(count(*)=0,'no result rows') from community_shadow_results;
      select pg_temp.check_ok(attempts=0 and state='processing','no implicit start') from community_shadow_jobs;
      ${unchanged}`,
    ],
    [
      "defer after a legitimate start never refunds its consumed attempt",
      `${seed} ${start}
      ${postpone()} ${reclaim}
      select pg_temp.check_ok(attempts=1 and attempt_claim_token is null,'consumed attempt preserved') from leased;
      ${postpone()} ${reclaim}
      select pg_temp.check_ok(attempts=1,'repeated defer cannot refund') from leased;
      ${start} select pg_temp.check_ok(attempts=2,'new real authorization increments') from community_shadow_jobs;
      ${unchanged}`,
    ],
    [
      "three effective starts; no fourth via administrative or legacy RPC",
      `${seed}
      ${start} ${postpone()} ${reclaim}
      ${start} ${postpone()} ${reclaim}
      ${start}
      select pg_temp.check_ok(attempts=3,'three starts') from community_shadow_jobs;
      ${postpone("clock_timestamp()+interval '1 hour'", "attempts_exhausted")}
      select pg_temp.check_ok(state='failed' and attempts=3 and snapshot_text is null,'terminal exhausted') from community_shadow_jobs;
      select pg_temp.check_ok(count(*)=0,'no fourth acquisition') from community_shadow_acquire(1,60);
      select pg_temp.check_ok(count(*)=0,'no fourth legacy claim') from community_shadow_claim(1,60);
      select pg_temp.check_ok(community_shadow_attempt_start(id,claim_token)='stale_claim','no reset/start after terminal') from leased;
      ${unchanged}`,
    ],
    [
      "third started attempt can finish normally; retry_wait remains terminal at three",
      `${seed}
      ${start} ${postpone()} ${reclaim} ${start} ${postpone()} ${reclaim} ${start}
      select pg_temp.check_ok(community_shadow_finish(id,claim_token,'retry_wait','[]','provider_timeout',120)='finished','existing finish contract') from leased;
      select pg_temp.check_ok(state='failed' and attempts=3 and attempt_claim_token is null,'no fourth attempt') from community_shadow_jobs;
      ${unchanged}`,
    ],
    [
      "invalid token cannot start, postpone or finalize",
      `${seed}
      select pg_temp.check_ok(community_shadow_attempt_start(id,gen_random_uuid())='stale_claim','wrong start token') from leased;
      select pg_temp.check_ok(community_shadow_defer(id,gen_random_uuid(),clock_timestamp()+interval '2 hours','quota_exhausted')='stale_claim','wrong defer token') from leased;
      select pg_temp.check_ok(community_shadow_finish(id,gen_random_uuid(),'failed')='stale_claim','wrong finish token') from leased;
      ${liveSame} ${unchanged}`,
    ],
    [
      "expired lease rejects cached token and does not consume an attempt",
      `${seed}
      update community_shadow_jobs set lease_until=clock_timestamp()-interval '1 second';
      select pg_temp.check_ok(community_shadow_attempt_start(id,claim_token)='stale_claim','expired start') from leased;
      select pg_temp.check_ok(community_shadow_defer(id,claim_token,clock_timestamp()+interval '2 hours','cooldown_active')='stale_claim','expired defer') from leased;
      select pg_temp.check_ok(community_shadow_finish(id,claim_token,'failed')='stale_claim','expired finish') from leased;
      select pg_temp.check_ok(attempts=0,'not consumed') from community_shadow_jobs; ${unchanged}`,
    ],
    [
      "reclaimed started lease preserves consumed attempt and rejects late results",
      `${seed} ${start}
      create temporary table old_lease on commit drop as select * from leased;
      update community_shadow_jobs set lease_until=clock_timestamp()-interval '1 second';
      truncate leased; insert into leased select * from community_shadow_acquire(1,60);
      select pg_temp.check_ok(attempts=1 and attempt_claim_token is null,'no authorization on reclaim') from leased;
      select pg_temp.check_ok(community_shadow_finish(id,claim_token,'failed')='stale_claim','old result') from old_lease;
      ${start}
      select pg_temp.check_ok(community_shadow_finish(id,claim_token,'completed',pg_temp.success_results(id))='finished','new token result') from leased;
      select pg_temp.check_ok(attempts=2,'no refund') from community_shadow_jobs; ${unchanged}`,
    ],
    [
      "obsolete fingerprint cannot start, defer or finish",
      `${seed}
      update community_shadow_jobs set snapshot_hash=repeat('0',64);
      select pg_temp.check_ok(community_shadow_attempt_start(id,claim_token)='obsolete','obsolete start') from leased;
      select pg_temp.check_ok(community_shadow_defer(id,claim_token,clock_timestamp()+interval '2 hours','quota_exhausted')='obsolete','obsolete defer') from leased;
      select pg_temp.check_ok(community_shadow_finish(id,claim_token,'failed')='obsolete','obsolete result') from leased;
      ${unchanged}`,
    ],
    [
      "deleted post cannot be recreated with a cached claim",
      `${seed} ${start}
      select community_post_delete('${author}',id,1) from defer_post;
      select pg_temp.check_ok(community_shadow_attempt_start(id,claim_token)='not_found','deleted start') from leased;
      select pg_temp.check_ok(community_shadow_defer(id,claim_token,clock_timestamp()+interval '2 hours','quota_exhausted')='not_found','deleted defer') from leased;
      select pg_temp.check_ok(community_shadow_finish(id,claim_token,'failed')='not_found','deleted finish') from leased;
      select pg_temp.check_ok(count(*)=0,'no jobs') from community_shadow_jobs;`,
    ],
    [
      "cancelled edit invalidates authorization marker and cached operations",
      `
      create temporary table defer_post on commit drop as select pg_temp.make_post() id; ${flush}
      create temporary table proposal on commit drop as select pg_temp.submit_edit(id) id from defer_post; ${flush}
      create temporary table leased on commit drop as select * from community_shadow_acquire(10,60) where target_kind='pending_edit';
      select pg_temp.check_ok(count(*)=1,'exactly one synthetic pending edit acquisition') from leased;
      ${start}
      select community_post_pending_edit_cancel('${author}',id) from defer_post; ${flush}
      select pg_temp.check_ok(community_shadow_attempt_start(id,claim_token)='stale_claim','cancelled start') from leased;
      select pg_temp.check_ok(community_shadow_defer(id,claim_token,clock_timestamp()+interval '2 hours','cooldown_active')='stale_claim','cancelled defer') from leased;
      select pg_temp.check_ok(community_shadow_finish(id,claim_token,'failed')='stale_claim','cancelled finish') from leased;
      select pg_temp.check_ok(attempt_claim_token is null,'marker cleared by existing lifecycle') from community_shadow_jobs where target_kind='pending_edit';`,
    ],
    [
      "expired snapshot uses existing expiry transition without new attempt",
      `${seed}
      update community_shadow_jobs set snapshot_expires_at=clock_timestamp()-interval '1 second';
      select pg_temp.check_ok(community_shadow_attempt_start(id,claim_token)='stale_claim','expired snapshot start') from leased;
      select pg_temp.check_ok(community_shadow_defer(id,claim_token,clock_timestamp()+interval '2 hours','quota_exhausted')='stale_claim','expired snapshot defer') from leased;
      select community_shadow_maintain(100);
      select pg_temp.check_ok(state='expired' and snapshot_text is null and attempts=0 and attempt_claim_token is null,'expired without extension') from community_shadow_jobs;
      ${unchanged}`,
    ],
    [
      "two-hour administrative wait is persisted exactly",
      `${seed}
      create temporary table resume on commit drop as select clock_timestamp()+interval '2 hours' ts;
      ${postpone("(select ts from resume)")}
      select pg_temp.check_ok(next_attempt_at=(select ts from resume) and attempts=0,'two hours without provider retry limit') from community_shadow_jobs;
      ${unchanged}`,
    ],
    [
      "next UTC day is a valid administrative deadline",
      `${seed}
      create temporary table resume on commit drop as select (date_trunc('day',clock_timestamp() at time zone 'UTC')+interval '1 day') at time zone 'UTC' ts;
      ${postpone("(select ts from resume)")}
      select pg_temp.check_ok(next_attempt_at=(select ts from resume) and attempts=0,'UTC midnight persisted') from community_shadow_jobs;
      ${unchanged}`,
    ],
    [
      "next availability beyond snapshot lifetime safely expires the job",
      `${seed}
      update community_shadow_jobs set snapshot_expires_at=clock_timestamp()+interval '1 hour';
      ${postpone("clock_timestamp()+interval '2 hours'", "expired")}
      select pg_temp.check_ok(state='expired' and snapshot_text is null and attempts=0 and claim_token is null,'no stale resurrection') from community_shadow_jobs;
      ${unchanged}`,
    ],
    ...[
      ["'not-a-date'::timestamptz", "22007"],
      ["'infinity'::timestamptz", "invalid_deferral"],
      ["'-infinity'::timestamptz", "invalid_deferral"],
      ["null::timestamptz", "invalid_deferral"],
      ["clock_timestamp()-interval '1 second'", "invalid_deferral"],
      ["clock_timestamp()+interval '26 hours'", "invalid_deferral"],
    ].map(([value, code]) => [
      `invalid deadline ${value}`,
      `${seed} ${rejectDate(value, code)} ${liveSame} ${unchanged}`,
    ]),
    [
      "caller cannot select arbitrary reasons or reset the counter",
      `${seed} ${start}
      select pg_temp.expect_error(format('select community_shadow_defer(%L,%L,clock_timestamp()+interval ''2 hours'',%L)',id,claim_token,'reset_attempts'),'invalid_deferral') from leased;
      select pg_temp.check_ok(attempts=1,'no reset') from community_shadow_jobs; ${unchanged}`,
    ],
    [
      "privileges, forced RLS, exact signatures and no public HTTP path",
      `
      select pg_temp.check_ok(bool_and(relrowsecurity and relforcerowsecurity),'RLS forced') from pg_class where oid in ('community_shadow_jobs'::regclass,'community_shadow_results'::regclass);
      select pg_temp.check_ok(count(*)=1,'no unsafe finish overload') from pg_proc where pronamespace='public'::regnamespace and proname='community_shadow_finish';
      do $$declare r text; f text; begin
        foreach r in array array['anon','authenticated','service_role'] loop
          perform pg_temp.check_ok(not has_table_privilege(r,'community_shadow_jobs','SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),'no table access');
          perform pg_temp.check_ok(not has_column_privilege(r,'community_shadow_jobs','attempts','UPDATE'),'no counter access');
          foreach f in array array['community_shadow_acquire(integer,integer)','community_shadow_claim(integer,integer)',
            'community_shadow_attempt_start(uuid,uuid)','community_shadow_defer(uuid,uuid,timestamptz,text)',
            'community_shadow_finish(uuid,uuid,text,jsonb,text,integer)'] loop
            perform pg_temp.check_ok(has_function_privilege(r,f,'EXECUTE')=(r='service_role'),'RPC ACL');
          end loop;
          perform pg_temp.check_ok(not has_schema_privilege(r,'community_shadow_private','USAGE'),'no helper access');
        end loop;
      end $$;
      select pg_temp.check_ok(bool_and(prosecdef and proowner='postgres'::regrole and proconfig @> array['search_path=pg_catalog, public']),'definer config')
        from pg_proc where oid in ('community_shadow_acquire(integer,integer)'::regprocedure,'community_shadow_attempt_start(uuid,uuid)'::regprocedure,'community_shadow_defer(uuid,uuid,timestamptz,text)'::regprocedure);
      set local role anon; select pg_temp.expect_error('select community_shadow_acquire(1,60)','42501'); reset role;
      set local role authenticated; select pg_temp.expect_error('select community_shadow_attempt_start(null,null)','42501'); reset role;
      set local role service_role; select pg_temp.expect_error('update community_shadow_jobs set attempts=0','42501'); reset role;
    `,
    ],
  ];
  for (const [name, sql] of cases) {
    try {
      await observer.query(`begin; ${sql} rollback;`);
      record(name);
    } catch (error) {
      report.results.push({
        name: `defer: ${name}`,
        status: "FAIL",
        error: error.message,
      });
      throw error;
    }
  }

  const a = await new Session("defer_a").setup(),
    b = await new Session("defer_b").setup();
  let synthetic;
  try {
    synthetic = await observer.query(
      "select pg_temp.make_post('Synthetic concurrent acquisition');",
    );
    await a.query("begin; set local role service_role;");
    const first = (
      await a.json("select json_agg(j) from community_shadow_acquire(1,60) j;")
    )[0];
    await b.query("begin; set local role service_role;");
    assert.equal(
      await b.query("select count(*) from community_shadow_acquire(1,60);"),
      "0",
    );
    const overlap = await observer.json(
      `select json_agg(json_build_object('pid',pid,'state',state,'xact_start',xact_start)) from pg_stat_activity where pid in (${a.pid},${b.pid});`,
    );
    assert.equal(overlap.length, 2);
    assert.notEqual(a.pid, b.pid);
    assert(overlap.every((x) => x.state === "idle in transaction" && x.xact_start));
    await a.query("commit;");
    await b.query("commit;");
    assert.equal(first.attempts, 0);
    record(
      "independent concurrent acquisitions skip locked job without consuming an attempt",
      { overlap },
    );
    await a.query("begin; set local role service_role;");
    const args = `'${first.id}','${first.claim_token}'`;
    assert.equal(
      await a.query(`select community_shadow_attempt_start(${args});`),
      "started",
    );
    await b.query("begin; set local role service_role;");
    assert.equal(
      await b.query(`select community_shadow_attempt_start(${args});`),
      "busy",
    );
    assert.equal(
      await b.query(
        `select community_shadow_defer(${args},clock_timestamp()+interval '2 hours','quota_exhausted');`,
      ),
      "busy",
    );
    const startOverlap = await observer.json(
      `select json_agg(json_build_object('pid',pid,'state',state,'xact_start',xact_start)) from pg_stat_activity where pid in (${a.pid},${b.pid});`,
    );
    assert(startOverlap.every((x) => x.state === "idle in transaction" && x.xact_start));
    await a.query("commit;");
    assert.equal(
      await b.query(`select community_shadow_attempt_start(${args});`),
      "already_started",
    );
    assert.equal(
      await b.query(
        `select community_shadow_defer(${args},clock_timestamp()+interval '2 hours','cooldown_active');`,
      ),
      "deferred",
    );
    await b.query("commit;");
    assert.equal(
      await a.query(`select community_shadow_finish(${args},'failed');`),
      "stale_claim",
    );
    assert.equal(
      await observer.query(
        `select attempts from community_shadow_jobs where id='${first.id}';`,
      ),
      "1",
    );
    assert.equal(
      await b.query("select count(*) from community_shadow_acquire(1,60);"),
      "0",
    );
    assert.equal(
      await observer.query("select count(*) from community_shadow_results;"),
      "0",
    );
    assert.equal(await observer.query("select count(*) from moderation_audit_log;"), "0");
    record(
      "concurrent start/defer is fenced, idempotent and monotonic without deadlock",
      { overlap: startOverlap },
    );
    await observer.query(`delete from community_posts where id='${synthetic}';`);
    synthetic = await observer.query(
      "select pg_temp.make_post('Synthetic real-clock deadline');",
    );
    const timed = (
      await a.json("select json_agg(j) from community_shadow_acquire(1,60) j;")
    )[0];
    assert.equal(
      await a.query(`select community_shadow_defer('${timed.id}','${timed.claim_token}',
        clock_timestamp()+interval '2 seconds','cooldown_active');`),
      "deferred",
    );
    assert.equal(
      await b.query("select count(*) from community_shadow_acquire(1,60);"),
      "0",
    );
    await observer.query("select pg_sleep(2.1);");
    const afterDeadline = (
      await b.json("select json_agg(j) from community_shadow_acquire(1,60) j;")
    )[0];
    assert.equal(afterDeadline.id, timed.id);
    assert.equal(afterDeadline.attempts, 0);
    assert.notEqual(afterDeadline.claim_token, timed.claim_token);
    record(
      "real-clock deadline prevents early acquisition and permits a new token after expiry",
    );
  } catch (error) {
    report.results.push({
      name: "defer: concurrency",
      status: "FAIL",
      error: error.message,
    });
    throw error;
  } finally {
    await Promise.all([a.close(), b.close()]);
    if (synthetic)
      await observer.query(`delete from community_posts where id='${synthetic}';`);
  }
}
