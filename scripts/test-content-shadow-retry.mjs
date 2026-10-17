// Invoked by the existing isolated PostgreSQL harness with UPMINA_SHADOW_RETRY_TESTS=1.
// No remote connections, executor, provider transport or real credentials.
import assert from 'node:assert/strict';

const file = '20261123120000_community_shadow_retry_delay.sql';
const oldSignature = 'public.community_shadow_finish(uuid,uuid,text,jsonb,text)';
const newSignature = 'public.community_shadow_finish(uuid,uuid,text,jsonb,text,integer)';
const flush = 'set constraints all immediate; set constraints all deferred;';
const seed = `
  create temporary table retry_post on commit drop as select pg_temp.make_post() id;
  ${flush}
  create temporary table retry_job on commit drop as select * from community_shadow_claim(1,60);
  create temporary table retry_content_before on commit drop as
    select to_jsonb(p) doc from community_posts p join retry_post r using(id);
`;
const call = (delay = '120', token = 'claim_token') =>
  `community_shadow_finish(id,${token},'retry_wait','[]','provider_rate_limit',${delay})`;
const finish = (delay = '120') => `select pg_temp.check_ok(${call(delay)}='finished','finish retry') from retry_job;`;
const unchanged = `select pg_temp.check_ok(to_jsonb(p)=b.doc,'Community unchanged')
  from community_posts p join retry_post r using(id) cross join retry_content_before b;`;
const reject = (delay, expected = 'invalid_retry_delay') => `
  select pg_temp.expect_error(format('select community_shadow_finish(%L,%L,%L,%L::jsonb,%L,%L::integer)',
    id,claim_token,'retry_wait','[]','provider_rate_limit',${delay}), '${expected}') from retry_job;
  select pg_temp.check_ok(j.state='processing' and j.claim_token=c.claim_token,'failure preserves lease')
    from community_shadow_jobs j join retry_job c using(id);
  select pg_temp.check_ok(count(*)=0,'no results on failure') from community_shadow_results;
`;

export async function runRetryContract({ observer, Session, migration, report }) {
  const record = (name, evidence) => report.results.push({ name: `retry: ${name}`, status: 'PASS', ...evidence });
  const metadata = () => observer.json(`select json_build_object('oid',oid,'definition',pg_get_functiondef(oid),
    'acl',proacl::text,'owner',proowner,'config',proconfig) from pg_proc where oid='${oldSignature}'::regprocedure;`);
  const before = await metadata();
  // CREATE OR REPLACE with a sixth argument creates a distinct function (verified, rolled back).
  await observer.query(`begin;
    create or replace function public.community_shadow_finish(uuid,uuid,text,jsonb,text,integer)
      returns text language sql as $$select 'fixture_only'::text$$;
    select pg_temp.check_ok(count(*)=2,'sixth argument creates overload') from pg_proc
      where pronamespace='public'::regnamespace and proname='community_shadow_finish';
    rollback;`);
  record('PostgreSQL function identity changes with sixth argument');
  await observer.query(`begin; ${migration(file)} rollback;`);
  assert.deepEqual(await metadata(), before);
  assert.equal(await observer.query(`select to_regprocedure('${newSignature}') is null;`), 't');
  record('migration rollback restores original OID, definition, grants and owner');
  await observer.query(`begin;
    create temporary view retry_dependency as select public.community_shadow_finish(null,null,'failed') outcome;
    select pg_temp.expect_error('drop function ${oldSignature} restrict','2BP01');
    rollback;`);
  record('RESTRICT protects unexpected dependent objects');
  await observer.query(`begin; ${migration(file)} commit;`);

  const cases = [
    ['single secure signature and unchanged table ACLs', `
      select pg_temp.check_ok(to_regprocedure('${oldSignature}') is null,'old signature gone');
      select pg_temp.check_ok(count(*)=1,'no overload') from pg_proc
        where pronamespace='public'::regnamespace and proname='community_shadow_finish';
      select pg_temp.check_ok(prosecdef and proowner='postgres'::regrole
        and proconfig @> array['search_path=pg_catalog, public'] and pronargdefaults=3,'definer configuration')
        from pg_proc where oid='${newSignature}'::regprocedure;
      select pg_temp.check_ok(not exists(select 1 from pg_proc p, lateral aclexplode(p.proacl) a
        where p.oid='${newSignature}'::regprocedure and a.grantee=0),'no PUBLIC grant');
      do $$declare r text; t text; begin
        foreach r in array array['anon','authenticated','service_role'] loop
          perform pg_temp.check_ok(has_function_privilege(r,'${newSignature}','EXECUTE')=(r='service_role'),'RPC grant');
          foreach t in array array['community_shadow_jobs','community_shadow_results'] loop
            perform pg_temp.check_ok(not has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),'no table access');
          end loop;
        end loop;
      end $$;
      set local role anon;
      select pg_temp.expect_error('select community_shadow_finish(null,null,''failed'')','42501');
      reset role;
      set local role authenticated;
      select pg_temp.expect_error('select community_shadow_finish(null,null,''failed'')','42501');
      reset role;
      set local role service_role;
      select pg_temp.expect_error('update community_shadow_jobs set next_attempt_at=now()','42501');
      reset role;
    `],
    ['Retry-After 120 persists, does not extend TTL and prevents early claim', `${seed}
      create temporary table retry_clock on commit drop as select clock_timestamp() ts;
      ${finish()}
      select pg_temp.check_ok(j.next_attempt_at>=t.ts+interval '120 seconds'
        and j.next_attempt_at<=clock_timestamp()+interval '120 seconds'
        and j.snapshot_expires_at=c.snapshot_expires_at and j.retain_until=c.retain_until
        and j.state='retry_wait' and j.claim_token is null,'persistent 120s and unchanged TTL')
        from community_shadow_jobs j join retry_job c using(id) cross join retry_clock t;
      select pg_temp.check_ok(count(*)=0,'not claimable early') from community_shadow_claim(2,60);
      ${unchanged}
    `],
    ['valid exponential backoff plus bounded jitter', `${seed} ${finish('17')}
      select pg_temp.check_ok(next_attempt_at>=clock_timestamp()+interval '16 seconds','10s floor + 7s jitter')
        from community_shadow_jobs;
      ${unchanged}
    `],
    ['zero, negative and below-floor delays rejected without writes', `${seed}
      ${reject('0')} ${reject('-10')} ${reject('9')} ${unchanged}
    `],
    ['delay above 3600s and timestamp input rejected', `${seed}
      ${reject('3601')}
      select pg_temp.expect_error(format('select community_shadow_finish(%L,%L,%L,%L::jsonb,%L,now())',
        id,claim_token,'retry_wait','[]','provider_timeout'),'42883') from retry_job;
      ${unchanged}
    `],
    ['delay cannot reach or extend snapshot expiry', `${seed}
      update community_shadow_jobs set snapshot_expires_at=clock_timestamp()+interval '60 seconds';
      ${reject('120', 'retry_after_expiry')} ${unchanged}
    `],
    ['delay forbidden for terminal outcomes', `${seed}
      select pg_temp.expect_error(format('select community_shadow_finish(%L,%L,%L,%L::jsonb,%L,120)',
        id,claim_token,'failed','[]','provider_timeout'),'invalid_retry_delay') from retry_job;
      ${unchanged}
    `],
    ['legacy positional and named calls retain minimum schedule and terminal semantics', `${seed}
      select pg_temp.check_ok(community_shadow_finish(p_job_id=>id,p_claim_token=>claim_token,
        p_state=>'retry_wait',p_results=>'[]',p_error_code=>'provider_timeout')='finished','named five args') from retry_job;
      select pg_temp.check_ok(next_attempt_at>=clock_timestamp()+interval '9 seconds','default 10s floor') from community_shadow_jobs;
      update community_shadow_jobs set next_attempt_at=clock_timestamp()-interval '1 second';
      truncate retry_job;
      insert into retry_job select * from community_shadow_claim(1,60);
      select pg_temp.check_ok(community_shadow_finish(id,claim_token,'completed',pg_temp.success_results(id))='finished',
        'positional four args') from retry_job;
      ${unchanged}
    `],
    ['legacy three-argument terminal call remains valid', `${seed}
      select pg_temp.check_ok(community_shadow_finish(id,claim_token,'failed')='finished','three default args') from retry_job;
      select pg_temp.check_ok(j.state='failed' and j.next_attempt_at=c.next_attempt_at,'terminal does not schedule')
        from community_shadow_jobs j join retry_job c using(id);
      ${unchanged}
    `],
    ['claim after due time and maximum three attempts', `${seed}
      ${finish('10')}
      update community_shadow_jobs set next_attempt_at=clock_timestamp()-interval '1 second';
      truncate retry_job;
      insert into retry_job select * from community_shadow_claim(1,60);
      select pg_temp.check_ok(attempts=2,'second attempt') from retry_job;
      ${reject('19')} ${finish('27')}
      update community_shadow_jobs set next_attempt_at=clock_timestamp()-interval '1 second';
      truncate retry_job;
      insert into retry_job select * from community_shadow_claim(1,60);
      select pg_temp.check_ok(attempts=3,'third attempt') from retry_job;
      ${finish('120')}
      select pg_temp.check_ok(state='failed' and attempts=3 and snapshot_text is null,'terminal exhausted') from community_shadow_jobs;
      select pg_temp.check_ok(count(*)=0,'no fourth claim') from community_shadow_claim(1,60);
      ${unchanged}
    `],
    ['invalid token and expired lease reject scheduling', `${seed}
      select pg_temp.check_ok(${call('120', 'gen_random_uuid()')}='stale_claim','wrong token') from retry_job;
      update community_shadow_jobs set lease_until=clock_timestamp()-interval '1 second';
      select pg_temp.check_ok(${call()}='stale_claim','expired lease') from retry_job;
      select pg_temp.check_ok(count(*)=0,'no results') from community_shadow_results;
      ${unchanged}
    `],
    ['obsolete snapshot rejects scheduling', `${seed}
      update community_shadow_jobs set snapshot_hash=repeat('0',64);
      select pg_temp.check_ok(${call()}='obsolete','live snapshot guard') from retry_job;
      select pg_temp.check_ok(state='processing','no rescheduling') from community_shadow_jobs;
      ${unchanged}
    `],
    ['deleted target cannot be recreated with cached token', `${seed}
      select community_post_delete('33333333-3333-4333-8333-333333333333',id,1) from retry_post;
      select pg_temp.check_ok(${call()}='not_found','deleted target') from retry_job;
      select pg_temp.check_ok(count(*)=0,'no ghost jobs') from community_shadow_jobs;
      select pg_temp.check_ok(count(*)=0,'no ghost results') from community_shadow_results;
    `],
  ];
  for (const [name, sql] of cases) {
    try {
      await observer.query(`begin; ${sql} rollback;`);
      record(name);
    } catch (error) {
      report.results.push({ name: `retry: ${name}`, status: 'FAIL', error: error.message });
      throw error;
    }
  }

  const a = await new Session('retry_worker_a').setup();
  const b = await new Session('retry_worker_b').setup();
  let post;
  try {
    post = await observer.query('select pg_temp.make_post();');
    const job = (await a.json('select json_agg(j) from community_shadow_claim(1,60) j;'))[0];
    const args = `'${job.id}','${job.claim_token}','retry_wait','[]','provider_rate_limit',120`;
    await a.query('begin; set local role service_role;');
    assert.equal(await a.query(`select community_shadow_finish(${args});`), 'finished');
    await b.query('begin; set local role service_role;');
    assert.equal(await b.query(`select community_shadow_finish(${args});`), 'busy');
    assert.equal(await b.query('select count(*) from community_shadow_claim(1,60);'), '0');
    const overlap = await observer.json(`select json_agg(json_build_object('pid',pid,'state',state,'xact_start',xact_start))
      from pg_stat_activity where pid in (${a.pid},${b.pid});`);
    assert.notEqual(a.pid, b.pid);
    assert.equal(overlap.length, 2);
    assert(overlap.every(s => s.state === 'idle in transaction' && s.xact_start));
    await b.query('commit;');
    await a.query('commit;');
    await b.query('set role service_role;');
    assert.equal(await b.query(`select community_shadow_finish(${args});`), 'stale_claim');
    assert.equal(await b.query('select count(*) from community_shadow_claim(1,60);'), '0');
    const persisted = await observer.json(`select json_build_object('state',state,'attempts',attempts,
      'remaining_seconds',extract(epoch from next_attempt_at-clock_timestamp())) from community_shadow_jobs where id='${job.id}';`);
    assert.equal(persisted.state, 'retry_wait');
    assert.equal(persisted.attempts, 1);
    assert(persisted.remaining_seconds > 110 && persisted.remaining_seconds <= 120);
    assert.equal(await observer.query('select count(*) from community_shadow_results;'), '0');
    assert.equal(await observer.query('select count(*) from moderation_audit_log;'), '0');
    record('two independent workers overlap; only one finish and neither claims before Retry-After', { overlap, persisted });
  } catch (error) {
    report.results.push({ name: 'retry: concurrent finish', status: 'FAIL', error: error.message });
    throw error;
  } finally {
    await Promise.all([a.close(), b.close()]);
    if (post) await observer.query(`delete from community_posts where id='${post}';`);
  }
}
