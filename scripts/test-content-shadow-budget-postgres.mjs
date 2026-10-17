// Only runs inside the existing exclusive loopback PostgreSQL fixture; no remote calls.
import assert from "node:assert/strict";
const file = "20261125120000_community_shadow_budget.sql";
const day = "(clock_timestamp() at time zone 'UTC')::date";
const seed = `create temporary table p on commit drop as select pg_temp.budget_post(4) id;
  set constraints all immediate; set constraints all deferred;
  create temporary table leased on commit drop as select * from community_shadow_acquire(1,120);
  select pg_temp.check_ok(count(*)=1,'one acquired fixture') from leased;
  create temporary table before_content on commit drop as select to_jsonb(p) doc from community_posts p;`;
const reserve = `community_shadow_budget_reserve(id,claim_token,4)`;
const same = `select pg_temp.check_ok(to_jsonb(p)=b.doc,'Community untouched') from community_posts p cross join before_content b;
  select pg_temp.check_ok(count(*)=0,'no human audit') from moderation_audit_log;`;
export async function runBudgetContract({ observer, Session, migration, report }) {
  const record = (name, evidence = {}) =>
    report.results.push({ name: `budget: ${name}`, status: "PASS", ...evidence });
  await observer.query(`begin; ${migration("20261123120000_community_shadow_retry_delay.sql")}
    ${migration("20261124120000_community_shadow_administrative_defer.sql")} commit;`);
  await observer.query(`begin; ${migration(file)} rollback;`);
  assert.equal(
    await observer.query(
      "select to_regclass('community_shadow_budget_control') is null and to_regprocedure('community_shadow_budget_reserve(uuid,uuid,integer)') is null;",
    ),
    "t",
  );
  record("new migration fully rolls back");
  await observer.query(`begin; ${migration(file)} commit;
    create function pg_temp.budget_post(n integer) returns uuid language plpgsql as $$declare r jsonb; begin
      r:=community_post_save_atomic('33333333-3333-4333-8333-333333333333',null,null,
        case when n=1 then null else 'Synthetic budget text' end,
        (select jsonb_agg(jsonb_build_object('asset_id',pg_temp.new_asset(),'position',i-1)) from generate_series(1,greatest(1,n-1)) i),'{}');
      return (r->'post'->>'id')::uuid;
    end $$;`);
  const cases = [
    [
      "four-unit reservation and retry idempotency",
      `${seed}
      create temporary table ticket on commit drop as select ${reserve} d from leased;
      select pg_temp.check_ok(d->>'status'='reserved' and (d->>'units')::integer=4,'all four reserved') from ticket;
      select pg_temp.check_ok(${reserve}=(select d from ticket),'same claim does not double debit') from leased;
      select pg_temp.check_ok(reserved=4,'exact debit') from community_shadow_budget_days;
      select pg_temp.check_ok(attempts=0,'reservation is not attempt start') from community_shadow_jobs; ${same}`,
    ],
    [
      "SQL verifies N from snapshot, not caller count",
      `${seed}
      select pg_temp.expect_error(format('select community_shadow_budget_reserve(%L,%L,3)',id,claim_token),'invalid_component_count') from leased;
      select pg_temp.check_ok(count(*)=0,'no debit or ticket') from community_shadow_budget_days; ${same}`,
    ],
    [
      "insufficient capacity has no partial reservation; authoritative defer consumes zero attempts",
      `${seed}
      insert into community_shadow_budget_days values(${day},98);
      create temporary table denied on commit drop as select ${reserve} d from leased;
      select pg_temp.check_ok(d->>'status'='quota_exhausted' and (d->>'retry_at')::timestamptz=(${day}+1)::timestamp at time zone 'UTC','next UTC day') from denied;
      select pg_temp.check_ok(reserved=98,'no partial debit') from community_shadow_budget_days;
      select pg_temp.check_ok(count(*)=0,'no ticket') from community_shadow_budget_reservations;
      select pg_temp.check_ok(community_shadow_defer(id,claim_token,(d->>'retry_at')::timestamptz,'quota_exhausted')='deferred','authoritative defer') from leased cross join denied;
      select pg_temp.check_ok(attempts=0 and state='retry_wait','no attempt consumed') from community_shadow_jobs; ${same}`,
    ],
    [
      "cooldown is shared and cannot be reduced",
      `${seed}
      create temporary table previous on commit drop as select community_shadow_budget_cooldown(120) d;
      select community_shadow_budget_cooldown(60);
      select pg_temp.check_ok(cooldown_until=(d->>'retry_at')::timestamptz,'not shortened') from community_shadow_budget_control cross join previous;
      select pg_temp.check_ok(${reserve}->>'status'='cooldown_active','reservation denied') from leased;
      select pg_temp.check_ok(count(*)=0,'no debit during cooldown') from community_shadow_budget_days; ${same}`,
    ],
    [
      "expired cooldown permits reservation",
      `${seed}
      update community_shadow_budget_control set cooldown_until=clock_timestamp()-interval '1 second';
      select pg_temp.check_ok(${reserve}->>'status'='reserved','cooldown expired') from leased; ${same}`,
    ],
    [
      "cross-day UTC ledger is separate and older budget is never reset",
      `${seed}
      set local time zone 'Pacific/Auckland';
      insert into community_shadow_budget_days values(${day}-1,100);
      select pg_temp.check_ok(${reserve}->>'status'='reserved','new UTC day has fresh units') from leased;
      select pg_temp.check_ok(reserved=100,'old date immutable') from community_shadow_budget_days where utc_day=${day}-1;
      select pg_temp.check_ok(reserved=4,'new date separate') from community_shadow_budget_days where utc_day=${day};
      set local time zone default; ${same}`,
    ],
    [
      "lost lease or token after reservation never refunds units",
      `${seed}
      select ${reserve} from leased;
      update community_shadow_jobs set lease_until=clock_timestamp()-interval '1 second';
      select pg_temp.check_ok(community_shadow_attempt_start(id,claim_token)='stale_claim','start rejected') from leased;
      select pg_temp.check_ok(community_shadow_budget_reserve(id,gen_random_uuid(),4)->>'status'='stale_claim','token rejected') from leased;
      select pg_temp.check_ok(reserved=4,'no refund') from community_shadow_budget_days; ${same}`,
    ],
    [
      "authorized wait beyond snapshot TTL expires without retaining text",
      `${seed}
      update community_shadow_jobs set snapshot_expires_at=clock_timestamp()+interval '30 seconds';
      select community_shadow_budget_cooldown(120);
      create temporary table denied on commit drop as select ${reserve} d from leased;
      select pg_temp.check_ok(community_shadow_defer(j.id,j.claim_token,least((d->>'retry_at')::timestamptz,j.snapshot_expires_at),'cooldown_active')='expired','expire instead of extend') from community_shadow_jobs j cross join denied;
      select pg_temp.check_ok(state='expired' and snapshot_text is null and attempts=0,'safe terminal expiry') from community_shadow_jobs; ${same}`,
    ],
    [
      "deleted target removes ticket without refunding date ledger",
      `${seed}
      select ${reserve} from leased;
      select community_post_delete('33333333-3333-4333-8333-333333333333',id,1) from p;
      select pg_temp.check_ok(count(*)=0,'ticket cascaded') from community_shadow_budget_reservations;
      select pg_temp.check_ok(reserved=4,'historical counter not refunded') from community_shadow_budget_days;`,
    ],
    [
      "excessive Retry-After halts instead of shortening provider wait",
      `${seed}
      select community_shadow_budget_cooldown(604801); select community_shadow_budget_cooldown(1);
      select pg_temp.check_ok(halted,'no RPC clears halt') from community_shadow_budget_control;
      select pg_temp.check_ok(${reserve}->>'status'='cooldown_active','no sends after halt') from leased;
      select pg_temp.check_ok((${reserve}->>'retry_at')::timestamptz=snapshot_expires_at,'authoritative expiry deadline') from leased; ${same}`,
    ],
    [
      "invalid cooldown rejected without write",
      `${seed}
      select pg_temp.expect_error('select community_shadow_budget_cooldown(0)','invalid_cooldown');
      select pg_temp.expect_error('select community_shadow_budget_cooldown(-1)','invalid_cooldown');
      select pg_temp.check_ok(cooldown_until is null and not halted,'no invalid mutation') from community_shadow_budget_control; ${same}`,
    ],
    [
      "RLS forced, service-only RPC, no direct grants or arbitrary scope",
      `
      select pg_temp.check_ok(bool_and(relrowsecurity and relforcerowsecurity),'forced RLS') from pg_class
        where oid in ('community_shadow_budget_control'::regclass,'community_shadow_budget_days'::regclass,'community_shadow_budget_reservations'::regclass);
      do $$declare r text; t text; f text; begin foreach r in array array['anon','authenticated','service_role'] loop
        foreach t in array array['community_shadow_budget_control','community_shadow_budget_days','community_shadow_budget_reservations'] loop
          perform pg_temp.check_ok(not has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),'no table access'); end loop;
        foreach f in array array['community_shadow_budget_reserve(uuid,uuid,integer)','community_shadow_budget_check(uuid,uuid,uuid)','community_shadow_budget_cooldown(bigint)'] loop
          perform pg_temp.check_ok(has_function_privilege(r,f,'EXECUTE')=(r='service_role'),'service only'); end loop;
      end loop; end $$;
      select pg_temp.check_ok(bool_and(prosecdef and proowner='postgres'::regrole and proconfig @> array['search_path=pg_catalog, public']),'safe definer')
        from pg_proc where pronamespace='public'::regnamespace and proname in ('community_shadow_budget_reserve','community_shadow_budget_check','community_shadow_budget_cooldown');
      set local role anon; select pg_temp.expect_error('select community_shadow_budget_cooldown(1)','42501'); reset role;
      set local role authenticated; select pg_temp.expect_error('select community_shadow_budget_reserve(null,null,1)','42501'); reset role;
      set local role service_role; select pg_temp.expect_error('update community_shadow_budget_days set reserved=0','42501'); reset role;
    `,
    ],
  ];
  for (const [name, sql] of cases) {
    try {
      await observer.query(`begin; ${sql} rollback;`);
      record(name);
    } catch (error) {
      report.results.push({
        name: `budget: ${name}`,
        status: "FAIL",
        error: error.message,
      });
      throw error;
    }
  }
  const a = await new Session("budget_a").setup(),
    b = await new Session("budget_b").setup();
  const clear = () =>
    observer.query(
      "delete from community_posts; delete from community_shadow_budget_days; update community_shadow_budget_control set cooldown_until=null,halted=false;",
    );
  async function blocked(promise, expectedPid) {
    let evidence;
    for (let i = 0; i < 40; i++) {
      evidence = await observer.json(
        `select json_agg(json_build_object('pid',pid,'state',state,'wait',wait_event_type,'transaction',xact_start)) from pg_stat_activity where pid in (${a.pid},${b.pid});`,
      );
      if (evidence.some((r) => r.pid === expectedPid && r.wait === "Lock"))
        return evidence;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("No overlapping row-lock wait observed");
  }
  try {
    await observer.query("select pg_temp.budget_post(1) from generate_series(1,101);");
    await a.query("set role service_role; begin;");
    await b.query("set role service_role;");
    const x = (
      await a.json("select json_agg(j) from community_shadow_acquire(1,120) j;")
    )[0];
    assert.equal(
      (
        await a.json(
          `select community_shadow_budget_reserve('${x.id}','${x.claim_token}',1);`,
        )
      ).status,
      "reserved",
    );
    const y = (
      await b.json("select json_agg(j) from community_shadow_acquire(1,120) j;")
    )[0];
    const waiting = b.json(
      `select community_shadow_budget_reserve('${y.id}','${y.claim_token}',1);`,
    );
    const overlap = await blocked(waiting, b.pid);
    await a.query("commit;");
    assert.equal((await waiting).status, "reserved");
    const call = (s) =>
      s.json(
        "select community_shadow_budget_reserve(id,claim_token,1) from community_shadow_acquire(1,120);",
      );
    const runs = await Promise.all(
      [a, b].map(async (s) => {
        const out = [];
        for (let i = 0; i < 49; i++) out.push(await call(s));
        return out;
      }),
    );
    assert(runs.flat().every((r) => r.status === "reserved"));
    assert.equal((await call(a)).status, "quota_exhausted");
    assert.equal(
      await observer.query("select reserved from community_shadow_budget_days;"),
      "100",
    );
    assert.equal(
      await observer.query(
        "select sum(units) from community_shadow_budget_reservations;",
      ),
      "100",
    );
    record(
      "100 reserved units across independent overlapping connections; request 101 denied",
      { overlap },
    );
    const restarted = await new Session("budget_restarted").setup();
    try {
      await restarted.query("set role service_role;");
      assert.notEqual(restarted.pid, a.pid);
      assert.equal(
        (
          await restarted.json(
            `select community_shadow_budget_reserve('${x.id}','${x.claim_token}',1);`,
          )
        ).status,
        "reserved",
      );
      assert.equal(
        await observer.query("select reserved from community_shadow_budget_days;"),
        "100",
      );
      record(
        "fresh process replays a committed reservation without double debit or refund",
      );
    } finally {
      await restarted.close();
    }
    await clear();
    await a.query("begin;");
    const first = await a.json("select community_shadow_budget_cooldown(120);");
    const waitCooldown = b.json("select community_shadow_budget_cooldown(300);");
    const cooldownOverlap = await blocked(waitCooldown, b.pid);
    await a.query("commit;");
    const next = await waitCooldown;
    assert(Date.parse(next.retry_at) > Date.parse(first.retry_at));
    assert.equal(
      (await a.json("select community_shadow_budget_cooldown(60);")).retry_at,
      next.retry_at,
    );
    record("concurrent cooldown shares reservation lock and is never reduced", {
      overlap: cooldownOverlap,
    });
    await clear();
    await observer.query("select pg_temp.budget_post(1);");
    const z = (
      await b.json("select json_agg(j) from community_shadow_acquire(1,120) j;")
    )[0];
    await a.query("begin; select community_shadow_budget_cooldown(120);");
    const pendingReserve = b.json(
      `select community_shadow_budget_reserve('${z.id}','${z.claim_token}',1);`,
    );
    const crossOverlap = await blocked(pendingReserve, b.pid);
    await a.query("commit;");
    assert.equal((await pendingReserve).status, "cooldown_active");
    assert.equal(
      await observer.query("select count(*) from community_shadow_budget_days;"),
      "0",
    );
    record("cooldown and reservation serialize on the same row without consuming units", {
      overlap: crossOverlap,
    });
    await clear();
    await observer.query("select pg_temp.budget_post(1);");
    const expiring = (
      await b.json("select json_agg(j) from community_shadow_acquire(1,120) j;")
    )[0];
    await observer.query(
      `update community_shadow_jobs set lease_until=clock_timestamp()+interval '1 second' where id='${expiring.id}';`,
    );
    await a.query("begin; select community_shadow_budget_cooldown(1);");
    const expiringReserve = b.json(
      `select community_shadow_budget_reserve('${expiring.id}','${expiring.claim_token}',1);`,
    );
    await blocked(expiringReserve, b.pid);
    await observer.query("select pg_sleep(1.2);");
    await a.query("commit;");
    assert.equal((await expiringReserve).status, "stale_claim");
    assert.equal(
      await observer.query("select count(*) from community_shadow_budget_days;"),
      "0",
    );
    record("lease expiring during budget lock wait is rechecked before debit");
    await clear();
  } finally {
    await Promise.all([a.close(), b.close()]);
    await clear();
  }
}
