// Local integration only: real executor + real RPCs, fake provider and image reads.
import assert from "node:assert/strict";
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  rmdirSync,
  existsSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const quote = (value) =>
  value == null ? "null" : `'${String(value).replaceAll("'", "''")}'`;
export async function runExecutorIntegration({
  observer,
  Session,
  migration,
  report,
  root,
  migrationsReady = false,
  withBudget = false,
}) {
  const dir = join(root, "executor-modules");
  assert.equal(resolve(dir), join(resolve(root), "executor-modules"));
  mkdirSync(dir);
  const files = [
    "content-shadow-contract",
    "content-shadow-provider",
    "content-shadow-executor",
    "content-shadow-budget",
  ];
  const sessions = [];
  try {
    for (const name of files) {
      const compiled = ts.transpileModule(
        readFileSync(resolve(`src/lib/${name}.ts`), "utf8"),
        {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ES2022,
          },
        },
      ).outputText;
      writeFileSync(join(dir, `${name}.mjs`), compiled.replaceAll('.js"', '.mjs"'));
    }
    const { runShadowBatch } = await import(
      pathToFileURL(join(dir, "content-shadow-executor.mjs")).href
    );
    const { FakeModerationTransport, ShadowFault } = await import(
      pathToFileURL(join(dir, "content-shadow-provider.mjs")).href
    );
    const { shadowSqlBudget } = await import(
      pathToFileURL(join(dir, "content-shadow-budget.mjs")).href
    );
    if (!migrationsReady)
      await observer.query(
        `begin; ${migration("20261123120000_community_shadow_retry_delay.sql")} commit;`,
      );
    const a = await new Session("executor_a").setup(),
      b = await new Session("executor_b").setup();
    sessions.push(a, b);
    await a.query("set role service_role;");
    await b.query("set role service_role;");
    const repository = (session) => ({
      claim: () =>
        session.json(
          "select coalesce(json_agg(j),'[]') from community_shadow_claim(1,120) j;",
        ),
      finish: (p) =>
        session.query(`select community_shadow_finish(${quote(p.p_job_id)},${quote(p.p_claim_token)},
        ${quote(p.p_state)},${quote(JSON.stringify(p.p_results))}::jsonb,${quote(p.p_error_code)},${p.p_retry_delay_seconds ?? "null"});`),
    });
    const media = {
      verify: async () => undefined,
      read: async () => Buffer.from("synthetic bytes, no R2 operation"),
    };
    const observeIdle = async () => {
      const rows =
        await observer.json(`select json_agg(json_build_object('pid',pid,'state',state,'transaction',xact_start))
        from pg_stat_activity where pid in (${a.pid},${b.pid});`);
      assert.equal(rows.length, 2);
      assert(
        rows.every((r) => r.state === "idle" && r.transaction === null),
        "no database transaction during simulated external I/O",
      );
      return rows;
    };
    const record = (name, evidence = {}) =>
      report.results.push({ name: `executor: ${name}`, status: "PASS", ...evidence });
    const clear = () => observer.query("delete from community_posts;"); // Exclusive ephemeral fixture database.
    const content = () =>
      observer.json(`select json_build_object('posts',(select json_agg(p order by id) from community_posts p),
      'media',(select json_agg(m order by post_id,position) from community_post_media m),
      'assets',(select json_agg(a order by id) from media_assets a),'audit',(select count(*) from moderation_audit_log));`);
    try {
      await observer.query(
        "select pg_temp.make_post('Synthetic image'); select pg_temp.make_post('Synthetic video',false,'video');",
      );
      const before = await content();
      const transport = new FakeModerationTransport(async (request) => {
        await observeIdle();
        return new FakeModerationTransport().evaluate(
          request,
          new AbortController().signal,
        );
      });
      const summary = await runShadowBatch(
        { repository: repository(a), media, transport },
        2,
      );
      assert.equal(summary.finished, 2);
      assert.equal(summary.completed, 1);
      assert.equal(summary.partial, 1);
      assert.equal(summary.attemptedEvaluations, 3);
      assert.equal(
        await observer.query("select count(*) from community_shadow_results;"),
        "3",
      );
      assert.equal(
        await observer.query(
          "select count(*) from community_shadow_jobs where coverage->>'video'='unsupported_video' and coverage->>'overall'='partial';",
        ),
        "1",
      );
      assert.deepEqual(await content(), before);
      record(
        "real persisted text/image results and partial video; no Community writes or open transactions",
        { summary },
      );
    } finally {
      await clear();
    }
    try {
      await observer.query("select pg_temp.make_post('Synthetic rate limit');");
      const transport = new FakeModerationTransport(async () => {
        throw new ShadowFault("provider_rate_limit", true, "120");
      });
      const summary = await runShadowBatch({
        repository: repository(a),
        media,
        transport,
        random: () => 0,
      });
      assert.equal(summary.retryWait, 1);
      assert.deepEqual(await repository(b).claim(), []);
      const persisted =
        await observer.json(`select json_build_object('state',state,'attempts',attempts,
        'seconds',extract(epoch from next_attempt_at-clock_timestamp())) from community_shadow_jobs;`);
      assert.equal(persisted.state, "retry_wait");
      assert.equal(persisted.attempts, 1);
      assert(persisted.seconds > 110 && persisted.seconds <= 120);
      assert.equal(
        await observer.query("select count(*) from community_shadow_results;"),
        "0",
      );
      record("executor Retry-After 120 persists and other instance cannot claim early", {
        persisted,
      });
    } finally {
      await clear();
    }
    try {
      const post = await observer.query(
        "select pg_temp.make_post('Synthetic old version');",
      );
      let changed = false;
      const transport = new FakeModerationTransport(async (request) => {
        if (!changed) {
          changed = true;
          await observer.query(`select community_post_save_atomic('33333333-3333-4333-8333-333333333333',${quote(post)},1,'Synthetic new version',
            (select jsonb_agg(jsonb_build_object('asset_id',asset_id,'position',position)) from community_post_media where post_id=${quote(post)}),'{}');`);
        }
        return new FakeModerationTransport().evaluate(
          request,
          new AbortController().signal,
        );
      });
      const summary = await runShadowBatch({
        repository: repository(a),
        media,
        transport,
      });
      assert.equal(summary.finished, 0);
      assert.equal(summary.rejected, 1);
      assert.equal(
        await observer.query("select count(*) from community_shadow_results;"),
        "0",
      );
      assert.equal(
        await observer.query(
          `select version from community_posts where id=${quote(post)};`,
        ),
        "2",
      );
      record("public version changed during transport rejects old result and token", {
        summary,
      });
    } finally {
      await clear();
    }
    let release;
    let pending;
    try {
      await observer.query(
        "select pg_temp.make_post('Synthetic overlapping executors');",
      );
      let entered;
      const reached = new Promise((r) => {
        entered = r;
      });
      const gate = new Promise((r) => {
        release = r;
      });
      const transport = new FakeModerationTransport(async (request) => {
        entered();
        await gate;
        return new FakeModerationTransport().evaluate(
          request,
          new AbortController().signal,
        );
      });
      pending = runShadowBatch({ repository: repository(a), media, transport });
      await reached;
      const second = await runShadowBatch({
        repository: repository(b),
        media,
        transport: new FakeModerationTransport(),
      });
      assert.equal(second.claimed, 0);
      const overlap = await observeIdle();
      assert.notEqual(a.pid, b.pid);
      release();
      const first = await pending;
      assert.equal(first.finished, 1);
      assert.equal(first.attemptedEvaluations, 2);
      assert.equal(
        await observer.query("select count(*) from community_shadow_results;"),
        "2",
      );
      assert.equal(
        await observer.query("select attempts from community_shadow_jobs;"),
        "1",
      );
      assert.equal(
        await observer.query("select count(*) from moderation_audit_log;"),
        "0",
      );
      record("two independent executors overlap, one owns lease, no duplicate results", {
        overlap,
        first,
        second,
      });
    } finally {
      release?.();
      await pending;
      await clear();
    }
    if (withBudget) {
      const reset = async () => {
        await clear();
        await observer.query(
          "delete from community_shadow_budget_days; update community_shadow_budget_control set cooldown_until=null,halted=false;",
        );
      };
      const advanced = (session) => ({
        ...repository(session),
        acquire: () =>
          session.json(
            "select coalesce(json_agg(j),'[]') from community_shadow_acquire(1,120) j;",
          ),
        start: (j) =>
          session.query(
            `select community_shadow_attempt_start(${quote(j.id)},${quote(j.claim_token)});`,
          ),
        defer: (p) =>
          session.query(
            `select community_shadow_defer(${quote(p.p_job_id)},${quote(p.p_claim_token)},${quote(p.p_resume_at)},${quote(p.p_reason)});`,
          ),
      });
      const sqlBudget = (session) =>
        shadowSqlBudget({
          rpc(name, p) {
            const args =
              name === "community_shadow_budget_reserve"
                ? [quote(p.p_job_id), quote(p.p_claim_token), p.p_units]
                : name === "community_shadow_budget_check"
                  ? [quote(p.p_job_id), quote(p.p_claim_token), quote(p.p_reservation_id)]
                  : name === "community_shadow_budget_cooldown"
                    ? [p.p_retry_after_seconds]
                    : null;
            assert(args, "unexpected budget RPC");
            return {
              abortSignal: async () => ({
                data: await session.json(`select ${name}(${args.join(",")});`),
                error: null,
              }),
            };
          },
        });
      const run = (repo = advanced(a), transport = new FakeModerationTransport()) =>
        runShadowBatch({ repository: repo, media, transport, budget: sqlBudget(a) });
      try {
        await observer.query(
          "select pg_temp.make_post('Synthetic persistent executor');",
        );
        const before = await content();
        const summary = await run();
        assert.equal(summary.completed, 1);
        assert.equal(summary.attemptedEvaluations, 2);
        assert.equal(
          await observer.query("select reserved from community_shadow_budget_days;"),
          "2",
        );
        assert.equal(
          await observer.query("select attempts from community_shadow_jobs;"),
          "1",
        );
        assert.deepEqual(await content(), before);
        record(
          "persistent budget executor reserves exact text/image batch and preserves Community",
          { summary },
        );
      } finally {
        await reset();
      }
      try {
        await observer.query(
          "select pg_temp.make_post('Synthetic quota denial'); insert into community_shadow_budget_days values((clock_timestamp() at time zone 'UTC')::date,100);",
        );
        const summary = await run();
        assert.equal(summary.deferred, 1);
        assert.equal(summary.attemptedEvaluations, 0);
        assert.equal(
          await observer.query("select attempts from community_shadow_jobs;"),
          "0",
        );
        assert.equal(
          await observer.query("select reserved from community_shadow_budget_days;"),
          "100",
        );
        assert.equal(
          await b.query("select count(*) from community_shadow_acquire(1,120);"),
          "0",
        );
        record("persistent quota denial defers without attempts or early reclamation", {
          summary,
        });
      } finally {
        await reset();
      }
      try {
        await observer.query(
          "select pg_temp.make_post('Synthetic lease loss after reservation');",
        );
        const repo = advanced(a),
          original = repo.start;
        repo.start = async (j) => {
          await observer.query(
            `update community_shadow_jobs set lease_until=clock_timestamp()-interval '1 second' where id=${quote(j.id)};`,
          );
          return original(j);
        };
        const summary = await run(repo);
        assert.equal(summary.rejected, 1);
        assert.equal(summary.attemptedEvaluations, 0);
        assert.equal(
          await observer.query("select reserved from community_shadow_budget_days;"),
          "2",
        );
        assert.equal(
          await observer.query("select attempts from community_shadow_jobs;"),
          "0",
        );
        record("lease lost after committed reservation is rejected without refund", {
          summary,
        });
      } finally {
        await reset();
      }
      try {
        await observer.query(
          "select pg_temp.make_post('Synthetic timeout reservation');",
        );
        const transport = new FakeModerationTransport(async () => {
          throw new ShadowFault("provider_timeout", true);
        });
        const summary = await run(advanced(a), transport);
        assert.equal(summary.retryWait, 1);
        assert.equal(summary.completed, 0);
        assert.equal(
          await observer.query("select reserved from community_shadow_budget_days;"),
          "2",
        );
        record("transport timeout never refunds committed component reservation", {
          summary,
        });
      } finally {
        await reset();
      }
      try {
        await observer.query(
          "select pg_temp.make_post('Synthetic mid-job global cooldown');",
        );
        let sent = 0;
        const transport = new FakeModerationTransport(async (request) => {
          sent++;
          await observeIdle();
          await b.query("select community_shadow_budget_cooldown(120);");
          return new FakeModerationTransport().evaluate(
            request,
            new AbortController().signal,
          );
        });
        const summary = await run(advanced(a), transport);
        assert.equal(sent, 1);
        assert.equal(summary.partial, 1);
        assert.equal(summary.completed, 0);
        assert.equal(
          await observer.query("select reserved from community_shadow_budget_days;"),
          "2",
        );
        assert.equal(
          await observer.query("select coverage->>'overall' from community_shadow_jobs;"),
          "partial",
        );
        record(
          "another instance cooldown stops remaining sends with persisted partial coverage",
          { summary },
        );
      } finally {
        await reset();
      }
    }
  } catch (error) {
    report.results.push({
      name: "executor: integration",
      status: "FAIL",
      error: error.message,
    });
    throw error;
  } finally {
    await Promise.all(sessions.map((s) => s.close()));
    for (const name of files) {
      const file = join(dir, `${name}.mjs`);
      if (existsSync(file)) unlinkSync(file);
    }
    rmdirSync(dir);
  }
}
