// Local PostgreSQL only. No packages, credentials, shared services or remote databases.
// Run: node scripts/test-content-shadow-postgres.mjs <PostgreSQL bin directory>
// Isolated harness follows Phase 3, with its fixture Auth/copyright stubs; no existing test file changed.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';

const bin = resolve(process.argv[2] ?? 'C:/Program Files/PostgreSQL/18/bin');
const root = mkdtempSync(join(tmpdir(), 'upmina-shadow-postgres-'));
const data = join(root, 'cluster');
const database = `review_${randomUUID().replaceAll('-', '')}`;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^PG/i.test(k)));
const sessions = new Set();
const report = { database, root, results: [], cleanup: {} };
let started = false;
let created = false;
const port = await new Promise((accept, reject) => {
  const server = createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const value = server.address().port;
    server.close(() => accept(value));
  });
});
function command(name, args) {
  const result = spawnSync(join(bin, `${name}.exe`), args, {
    env, encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(result.status, 0, `${name}: ${result.error ?? result.stderr ?? result.stdout}`);
  return result.stdout.trim();
}
function removeClusterFiles() {
  try {
    rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
    // Windows may refuse Node's directory removal after initdb. Native PowerShell
    // removes only this verified, stopped cluster; no path enumeration or shell interpolation.
    const result = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', `
        $ErrorActionPreference = 'Stop'
        $target = [IO.Path]::GetFullPath($env:UPMINA_TEST_CLUSTER)
        $root = [IO.Path]::GetFullPath($env:UPMINA_TEST_ROOT)
        if ($target -ne (Join-Path $root 'cluster')) { throw 'Unsafe cleanup path' }
        if (Test-Path -LiteralPath (Join-Path $target 'postmaster.pid')) { throw 'Cluster may be running' }
        Remove-Item -LiteralPath $target -Recurse -Force
        if (Test-Path -LiteralPath $target) { throw 'Cluster directory remains' }
      `], { env: { ...env, UPMINA_TEST_CLUSTER: data, UPMINA_TEST_ROOT: root },
        encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 0, `native cleanup: ${result.error ?? result.stderr}`);
  }
}
const connectArgs = ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres'];
class Session {
  constructor(label) {
    this.label = label;
    this.buffer = '';
    this.errors = '';
    this.child = spawn(join(bin, 'psql.exe'), [...connectArgs, '-d', database,
      '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
    { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    sessions.add(this);
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk.toString();
      if (this.pending && this.buffer.includes(this.pending.marker)) {
        const value = this.buffer.slice(0, this.buffer.indexOf(this.pending.marker)).trim();
        this.buffer = this.buffer.slice(this.buffer.indexOf(this.pending.marker) + this.pending.marker.length).trim();
        clearTimeout(this.pending.timer);
        this.pending.accept(value);
        this.pending = null;
      }
    });
    this.child.stderr.on('data', chunk => { this.errors += chunk.toString(); });
    this.child.on('error', error => this.fail(error));
    this.child.on('close', code => {
      this.closed = true;
      sessions.delete(this);
      this.fail(new Error(`${label}: exit ${code}: ${this.errors}`));
    });
  }
  fail(error) {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = null;
    }
  }
  query(sql) {
    assert(!this.pending && !this.closed, `session unavailable: ${this.label}`);
    return new Promise((accept, reject) => {
      const marker = `END_${randomUUID()}`;
      this.pending = { marker, accept, reject, timer: setTimeout(() => {
        this.child.kill();
        this.fail(new Error(`${this.label}: client timeout`));
      }, 12000) };
      this.child.stdin.write(`${sql}\n\\echo ${marker}\n`);
    });
  }
  async json(sql) { return JSON.parse(await this.query(sql)); }
  async setup() {
    await this.query(`set application_name='${this.label}'; set statement_timeout='8s';
      set lock_timeout='6s'; set idle_in_transaction_session_timeout='15s';`);
    this.pid = Number(await this.query('select pg_backend_pid();'));
    return this;
  }
  async close() {
    if (this.closed) return;
    await new Promise(accept => {
      const timer = setTimeout(() => { this.child.kill(); }, 2000);
      this.child.once('close', () => { clearTimeout(timer); accept(); });
      this.child.stdin.end('ROLLBACK;\n\\q\n');
    });
  }
}
const migration = name => readFileSync(resolve('supabase/migrations', name), 'utf8');
const author = '33333333-3333-4333-8333-333333333333';
const moderators = ['55555555-5555-4555-8555-555555555551', '55555555-5555-4555-8555-555555555552'];
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
async function fixture(observer) {
  // Reuse the existing isolated SQL fixture, including its explicit Auth/copyright stubs.
  // Production decision functions below are loaded verbatim, never patched.
  const foundation = migration('20261004120000_community_posts_media.sql');
  const table = name => {
    const match = foundation.match(new RegExp(`create table public.${name} \\([\\s\\S]*?\\n\\);`));
    assert(match, `missing fixture table ${name}`);
    return match[0];
  };
  const save = migration('20261006120000_community_video_media.sql').match(
    /create or replace function public\.community_post_save\([\s\S]*?\n\$\$;/i)[0];
  const scaffold = readFileSync(resolve('src/lib/community-content-review-sql.test.ts'), 'utf8')
    .match(/await db\.exec\(`([\s\S]*?)`\);/)[1];
  assert(!scaffold.includes('${'), 'fixture must remain literal SQL');
  await observer.query(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key, email_confirmed_at timestamptz default now());
    create table public.profiles(user_id uuid primary key references auth.users);
    create table public.media_assets(id uuid primary key, domain text, status text, kind text,
      created_by uuid, updated_at timestamptz default now());
    create table public.cosplay_post_images(asset_id uuid references public.media_assets);
    ${table('community_posts')}
    alter table public.community_posts add column like_count integer default 0;
    ${table('community_post_media')}
    ${save}
    ${migration('20261008120000_community_atomic_media_removals.sql')}
    ${scaffold}
    insert into auth.users(id) values (${literal(author)}),${moderators.map(m => `(${literal(m)})`).join(',')};
    insert into profiles(user_id) values (${literal(author)});
    insert into admin_roles values ${moderators.map(m => `(${literal(m)},'moderator')`).join(',')};
    ${migration('20261120120000_held_for_review_pending_edits.sql')}
    ${migration('20261121120000_content_review_queue.sql')}`);
}

import { cases, helpers } from './test-content-shadow-cases.mjs';
const auditFilter = new RegExp(process.env.UPMINA_SHADOW_TEST_FILTER ?? '.*');

async function concurrentClaims(observer, single) {
  await observer.query('begin; select pg_temp.make_post();' + (single ? '' : 'select pg_temp.make_post();') + 'commit;');
  const a = await new Session('shadow_claim_a').setup();
  const b = await new Session('shadow_claim_b').setup();
  let evidence;
  try {
    await a.query('begin; set local role service_role;');
    const first = await a.json("select coalesce(json_agg(j),'[]') from community_shadow_claim(1,60) j;");
    assert.equal(first.length, 1);
    await b.query('begin; set local role service_role;');
    const start = Date.now();
    const second = await b.json("select coalesce(json_agg(j),'[]') from community_shadow_claim(1,60) j;");
    assert.equal(second.length, single ? 0 : 1);
    if (!single) assert.notEqual(first[0].id, second[0].id);
    evidence = await observer.json(`select json_agg(json_build_object('pid',pid,'state',state,
      'transactionStarted',xact_start,'transactionId',backend_xid)) from pg_stat_activity where pid in (${a.pid},${b.pid});`);
    assert.equal(evidence.length, 2);
    assert.notEqual(a.pid, b.pid);
    assert(evidence.every(row => row.state === 'idle in transaction' && row.transactionStarted));
    assert(evidence.some(row => row.pid === a.pid && row.transactionId));
    assert(Date.now() - start < 3000, 'SKIP LOCKED must not wait for the first transaction');
    assert.equal(await observer.query(`select count(*) from community_shadow_jobs where state='processing';`), '0');
    await a.query('commit;');
    await b.query('commit;');
    assert.equal(await observer.query('select count(*) from community_shadow_jobs where state=\'processing\';'), single ? '1' : '2');
    report.results.push({ name: single ? 'one job: second concurrent claim skips locked row' : 'two jobs: concurrent claims are disjoint',
      status: 'PASS', firstJob: first[0].id, secondJob: second[0]?.id ?? null, overlap: evidence });
  } finally {
    await Promise.all([a.close(),b.close()]);
    assert.equal(await observer.query(`select count(*) from pg_stat_activity where pid in (${a.pid},${b.pid});`), '0');
    assert.equal(await observer.query(`select count(*) from pg_locks where pid in (${a.pid},${b.pid});`), '0');
    await observer.query('delete from community_posts;');
  }
}
async function failOpenUnderContention(observer) {
  const p = await observer.query('select pg_temp.make_post();');
  const worker = await new Session('shadow_capture_contention').setup();
  try {
    await worker.query('begin; set local role service_role;');
    const [job] = await worker.json("select json_agg(j) from community_shadow_claim(1,60) j;");
    // Keep the job lock open, just as an overlapping queue transaction would.
    const saved = await observer.json(`select community_post_save_atomic(${literal(author)},${literal(p)},1,'Commit survives shadow lock',
      (select jsonb_agg(jsonb_build_object('asset_id',asset_id,'position',position)) from community_post_media where post_id=${literal(p)}),'{}');`);
    assert.equal(saved.post.version,2);
    assert(observer.errors.includes('community_shadow_capture_failed sqlstate=55P03'));
    await worker.query('commit;');
    assert.equal(await observer.query(`select community_shadow_finish(${literal(job.id)},${literal(job.claim_token)},'completed','[]');`),'obsolete');
    assert.equal(await observer.query('select community_shadow_reconcile(10);'),'1');
    assert.equal(await observer.query(`select count(*) from community_shadow_jobs where post_id=${literal(p)} and version=2 and obsolete_at is null;`),'1');
    report.results.push({name:'content save commits under real job-lock contention; reconciliation recovers',status:'PASS',workerPid:worker.pid});
  } finally {
    await worker.close();
    await observer.query('delete from community_posts;');
  }
}
async function captureBudget(observer) {
  const p = await observer.query('select pg_temp.make_post();');
  const newAsset = await observer.query("select pg_temp.new_asset();");
  const oldAttachment = await observer.query(`select id from community_post_media where post_id=${literal(p)};`);
  const worker = await new Session('shadow_audit_locked_job').setup();
  let writer = await new Session('shadow_audit_content_writer').setup();
  const fixedDefinition = (await observer.query("select pg_get_functiondef('community_shadow_private.asset_lifecycle()'::regprocedure);")) + ';';
  let baseline;
  try {
    await worker.query('begin; set local role service_role;');
    const [lockedJob] = await worker.json("select json_agg(j) from community_shadow_claim(1,60) j;");
    assert.equal(await observer.query(`select community_shadow_finish(${literal(lockedJob.id)},${literal(lockedJob.claim_token)},'completed','[]');`),'busy');
    // Reproduce the original 100ms-waiting status-invalidation algorithm, in this temporary DB only.
    await observer.query(`create or replace function community_shadow_private.asset_lifecycle() returns trigger
      language plpgsql security definer set search_path=pg_catalog,public set lock_timeout='100ms' as $$
      begin if tg_op='UPDATE' and old.status='ready' and new.status<>'ready' then
        begin update community_shadow_jobs set obsolete_at=clock_timestamp(),obsolete_reason='asset_unavailable',
          state=case when state in ('queued','processing','retry_wait') then 'cancelled' else state end,
          snapshot_text=null,claim_token=null,lease_until=null
          where obsolete_at is null and assets @> jsonb_build_array(jsonb_build_object('asset_id',new.id));
        exception when others then raise warning 'audit_baseline_status sqlstate=%',sqlstate; end;
      end if; return new; end $$;`);
    const save = `select community_post_save_atomic(${literal(author)},${literal(p)},1,'Budgeted save',
      ${literal(JSON.stringify([{asset_id:newAsset,position:0}]))}::jsonb,ARRAY[${literal(oldAttachment)}]::uuid[]);`;
    await writer.query("set statement_timeout='50ms';");
    baseline = await writer.json(save).then(() => 'unexpected_success',error => error.message);
    assert(baseline.includes('statement timeout'), 'original wait must reproduce query cancellation');
    assert.equal(await observer.query(`select version from community_posts where id=${literal(p)};`),'1');
    await observer.query(fixedDefinition);
    await writer.close();
    writer = await new Session('shadow_audit_fixed_writer').setup();
    await writer.query("set statement_timeout='50ms';");
    const result = await writer.json(save);
    assert.equal(result.post.version,2);
    await worker.query('commit;');
    assert.equal(await observer.query(`select version from community_posts where id=${literal(p)};`),'2');
    assert.equal(await observer.query('select community_shadow_reconcile(10);'),'1');
    report.results.push({name:'audit: capture budget survives locked queue row',status:'PASS',baseline:'statement_timeout reproduced; main save rolled back',
      writerPid:writer.pid,workerPid:worker.pid});
  } catch (error) {
    report.results.push({name:'audit: capture budget survives locked queue row',status:'FAIL',error:error.message});
    throw error;
  } finally {
    await Promise.all([worker.close(),writer.close()]);
    await observer.query(fixedDefinition);
    await observer.query('delete from community_posts;');
  }
}
async function waitForLock(observer, waiter, blocker) {
  const deadline=Date.now()+3500;
  while(Date.now()<deadline) {
    const row=await observer.json(`select json_build_object('pid',pid,'state',state,'waitType',wait_event_type,
      'waitEvent',wait_event,'blockers',pg_blocking_pids(pid)) from pg_stat_activity where pid=${waiter};`);
    if(row.waitType==='Lock' && row.blockers.includes(blocker)) return row;
    await new Promise(accept=>setTimeout(accept,10));
  }
  throw new Error('Expected independent backend lock overlap');
}
async function finishVersionRace(observer) {
  const p=await observer.query('select pg_temp.make_post();');
  const worker=await new Session('shadow_audit_finish').setup();
  const writer=await new Session('shadow_audit_version').setup();
  const gate=await new Session('shadow_audit_gate').setup();
  let pendingFinish, pendingWrite;
  try {
    const [job]=await worker.json("select json_agg(j) from community_shadow_claim(1,60) j;");
    const payload=await observer.query(`select pg_temp.success_results(${literal(job.id)});`);
    await observer.query(`create function pg_temp.audit_pause_result() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(7643101); return new; end $$;
      create trigger audit_pause_result before insert on community_shadow_results
        for each row execute function pg_temp.audit_pause_result();`);
    await gate.query('begin; select pg_advisory_xact_lock(7643101);');
    pendingFinish=worker.query(`select community_shadow_finish(${literal(job.id)},${literal(job.claim_token)},'completed',${literal(payload)}::jsonb);`)
      .then(value=>({value}),error=>({error:error.message}));
    const finishOverlap=await waitForLock(observer,worker.pid,gate.pid);
    let writeSettled=false;
    pendingWrite=writer.json(`select community_post_save_atomic(${literal(author)},${literal(p)},1,'Concurrent version',
      (select jsonb_agg(jsonb_build_object('asset_id',asset_id,'position',position)) from community_post_media where post_id=${literal(p)}),'{}');`)
      .then(value=>{writeSettled=true; return {value};},error=>{writeSettled=true; return {error:error.message};});
    let writeOverlap;
    const deadline=Date.now()+3500;
    while(!writeSettled && Date.now()<deadline) {
      const row=await observer.json(`select json_build_object('pid',pid,'waitType',wait_event_type,'blockers',pg_blocking_pids(pid))
        from pg_stat_activity where pid=${writer.pid};`);
      if(row.waitType==='Lock' && row.blockers.includes(worker.pid)) {writeOverlap=row;break;}
      await new Promise(accept=>setTimeout(accept,10));
    }
    assert(writeOverlap || writeSettled,'writer must either be serialized or commit before finish');
    await gate.query('commit;');
    const completed=await pendingFinish;
    const changed=await pendingWrite;
    assert(!completed.error,completed.error); assert(!changed.error,changed.error);
    assert.equal(changed.value.post.version,2);
    const state=await observer.json(`select json_build_object('version',version,'state',state,'obsolete',obsolete_at is not null,
      'current',community_shadow_private.is_current(j)) from community_shadow_jobs j where id=${literal(job.id)};`);
    if(completed.value==='finished') {
      assert.equal(state.version,1);
      assert.equal(state.obsolete,true,'late result cannot remain labelled current after concurrent version commit');
      assert.equal(state.current,false);
    } else assert.equal(completed.value,'obsolete');
    report.results.push({name:'audit: finish and public version update serialize or reject stale results',status:'PASS',
      outcome:completed.value,finishOverlap,writeOverlap,state});
  } catch(error) {
    report.results.push({name:'audit: finish and public version update serialize or reject stale results',status:'FAIL',error:error.message});
    throw error;
  } finally {
    await gate.close();
    if(pendingFinish) await pendingFinish;
    if(pendingWrite) await pendingWrite;
    await Promise.all([worker.close(),writer.close()]);
    await observer.query('drop trigger if exists audit_pause_result on community_shadow_results;');
    await observer.query(`delete from community_posts where id=${literal(p)};`);
  }
}
async function deleteRace(observer,target,finishFirst) {
  const owner=target==='account' ? randomUUID() : author;
  if(target==='account') await observer.query(`insert into auth.users(id) values(${literal(owner)});
    insert into profiles(user_id) values(${literal(owner)});`);
  const asset=await observer.query(`select pg_temp.new_asset('image',${literal(owner)});`);
  const saved=await observer.json(`select community_post_save_atomic(${literal(owner)},null,null,'Audit deletion race',
    ${literal(JSON.stringify([{asset_id:asset,position:0}]))}::jsonb,'{}');`);
  const p=saved.post.id;
  const worker=await new Session('shadow_audit_delete_finish').setup();
  const deleter=await new Session('shadow_audit_delete_parent').setup();
  const gate=await new Session('shadow_audit_delete_gate').setup();
  let pendingFinish,pendingDelete;
  const name=`audit: ${target} deletion race ${finishFirst ? 'finish-first' : 'delete-first'}`;
  try {
    const [job]=await worker.json("select json_agg(j) from community_shadow_claim(1,60) j;");
    const payload=await observer.query(`select pg_temp.success_results(${literal(job.id)});`);
    const finish=`select community_shadow_finish(${literal(job.id)},${literal(job.claim_token)},'completed',${literal(payload)}::jsonb);`;
    const remove=target==='account' ? `delete from auth.users where id=${literal(owner)};`
      : `select community_post_delete(${literal(owner)},${literal(p)},1);`;
    let overlap;
    if(finishFirst) {
      await observer.query(`create or replace function pg_temp.audit_pause_delete() returns trigger language plpgsql as $$
        begin perform pg_advisory_xact_lock(7643102); return new; end $$;
        create trigger audit_pause_delete before insert on community_shadow_results
          for each row execute function pg_temp.audit_pause_delete();`);
      await gate.query('begin; select pg_advisory_xact_lock(7643102);');
      pendingFinish=worker.query(finish).then(value=>({value}),error=>({error:error.message}));
      await waitForLock(observer,worker.pid,gate.pid);
      pendingDelete=deleter.query(remove).then(value=>({value}),error=>({error:error.message}));
      overlap=await waitForLock(observer,deleter.pid,worker.pid);
      await gate.query('commit;');
      const result=await pendingFinish;
      assert(!result.error,result.error); assert.equal(result.value,'finished');
      const deleted=await pendingDelete;
      assert(!deleted.error,deleted.error);
    } else {
      await deleter.query(`begin; ${remove}`);
      assert.equal(await observer.query(`select count(*) from community_posts where id=${literal(p)};`),'1',
        'other connection still sees the uncommitted deletion');
      assert.equal(await worker.query(finish),'busy');
      overlap=await observer.json(`select json_build_object('pid',pid,'state',state,'xid',backend_xid)
        from pg_stat_activity where pid=${deleter.pid};`);
      assert.equal(overlap.state,'idle in transaction'); assert(overlap.xid);
      await deleter.query('commit;');
    }
    assert.equal(await worker.query(finish),'not_found');
    assert.equal(await observer.query(`select count(*) from community_shadow_jobs where post_id=${literal(p)};`),'0');
    assert.equal(await observer.query('select count(*) from community_shadow_results;'),'0');
    if(target==='account') assert.equal(await observer.query(`select count(*) from community_shadow_jobs where author_user_id=${literal(owner)};`),'0');
    report.results.push({name,status:'PASS',overlap,workerPid:worker.pid,deleterPid:deleter.pid});
  } catch(error) {
    report.results.push({name,status:'FAIL',error:error.message}); throw error;
  } finally {
    await gate.close();
    if(pendingFinish) await pendingFinish;
    if(pendingDelete) await pendingDelete;
    await Promise.all([worker.close(),deleter.close()]);
    await observer.query('drop trigger if exists audit_pause_delete on community_shadow_results;');
    await observer.query(`delete from community_posts where id=${literal(p)};`);
    if(target==='account') await observer.query(`delete from auth.users where id=${literal(owner)};`);
  }
}
async function repeatableReadGuard(observer) {
  const p=await observer.query('select pg_temp.make_post();');
  const worker=await new Session('shadow_audit_repeatable_read').setup();
  try {
    const [job]=await worker.json("select json_agg(j) from community_shadow_claim(1,60) j;");
    await worker.query(`begin isolation level repeatable read; select version from community_posts where id=${literal(p)};`);
    await observer.query(`select community_post_save_atomic(${literal(author)},${literal(p)},1,'Committed new version',
      (select jsonb_agg(jsonb_build_object('asset_id',asset_id,'position',position)) from community_post_media where post_id=${literal(p)}),'{}');`);
    const result=await worker.query(`select community_shadow_finish(${literal(job.id)},${literal(job.claim_token)},'completed','[]');`)
      .then(value=>({value}),error=>({error:error.message}));
    assert(result.error?.includes('could not serialize access'), 'stale repeatable-read snapshot must abort rather than persist');
    assert.equal(await observer.query('select count(*) from community_shadow_results;'),'0');
    assert.equal(await observer.query(`select version from community_posts where id=${literal(p)};`),'2');
    report.results.push({name:'audit: repeatable-read stale snapshot safely aborts finalization',status:'PASS',outcome:'serialization_failure'});
  } catch(error) {
    report.results.push({name:'audit: repeatable-read stale snapshot safely aborts finalization',status:'FAIL',error:error.message}); throw error;
  } finally {
    await worker.close();
    await observer.query(`delete from community_posts where id=${literal(p)};`);
  }
}
try {
  report.engine = command('postgres', ['--version']);
  command('initdb', ['-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=trust', '--encoding=UTF8', '--locale=C']);
  command('pg_ctl', ['-D', data, '-l', join(root, 'postgres.log'), '-o',
    `-h 127.0.0.1 -p ${port} -c max_connections=10`, '-w', '-t', '15', 'start']);
  started = true;
  command('createdb', [...connectArgs, database]);
  created = true;
  const observer = await new Session('shadow_observer').setup();
  report.port = port;
  await fixture(observer);
  const deletionFoundation = migration('20261110120000_copyright_removal_appeals.sql');
  const auditFoundation = migration('20261007120000_moderation_foundation.sql');
  await observer.query(`
    alter table profiles drop constraint profiles_user_id_fkey;
    alter table profiles add foreign key(user_id) references auth.users(id) on delete cascade;
    ${deletionFoundation.match(/create or replace function public\.community_post_delete\([\s\S]*?\n\$\$;/i)[0]}
    ${auditFoundation.match(/create or replace function public\.moderation_audit_log_immutable\([\s\S]*?\n\$\$;/i)[0]}
    create trigger moderation_audit_log_no_update_delete before update or delete on moderation_audit_log
      for each row execute function moderation_audit_log_immutable();
  `);
  const definitions = () => observer.json(`select json_object_agg(proname,md5(pg_get_functiondef(oid))) from pg_proc
    where pronamespace='public'::regnamespace and proname in ('community_post_save_atomic','community_post_create_held',
      'community_post_pending_edit_submit','community_post_pending_edit_cancel','community_content_review_decide','community_post_delete');`);
  const before = await definitions();
  await observer.query(`begin; ${migration('20261122120000_community_shadow_persistence.sql')} commit;`);
  assert.deepEqual(await definitions(),before);
  report.results.push({ name:'existing content, human decision and deletion functions unchanged',status:'PASS' });
  await observer.query(helpers);
  for (const [name, sql] of cases) {
    if (!auditFilter.test(name)) continue;
    try {
      await observer.query(`begin; ${sql} rollback;`);
      report.results.push({ name,status:'PASS' });
    } catch (error) {
      report.results.push({ name,status:'FAIL',error:error.message });
      throw error;
    }
  }
  if (auditFilter.test('two jobs: concurrent claims are disjoint')) await concurrentClaims(observer,false);
  if (auditFilter.test('one job: second concurrent claim skips locked row')) await concurrentClaims(observer,true);
  if (auditFilter.test('content save commits under real job-lock contention; reconciliation recovers')) await failOpenUnderContention(observer);
  if (auditFilter.test('audit: capture budget survives locked queue row')) await captureBudget(observer);
  if (auditFilter.test('audit: finish and public version update serialize or reject stale results')) await finishVersionRace(observer);
  for(const target of ['post','account']) for(const finishFirst of [false,true]) {
    if(auditFilter.test(`audit: ${target} deletion race ${finishFirst ? 'finish-first' : 'delete-first'}`))
      await deleteRace(observer,target,finishFirst);
  }
  if(auditFilter.test('audit: repeatable-read stale snapshot safely aborts finalization')) await repeatableReadGuard(observer);
  const shadowSql = migration('20261122120000_community_shadow_persistence.sql');
  assert(!/\b(?:net\.http|dblink|http_post|http_get)\b/i.test(shadowSql));
  assert(!/\b(?:fetch\s*\(|from\s+["']openai["']|https?:\/\/)/i.test(readFileSync(resolve('src/lib/content-shadow-contract.ts'),'utf8')));
  assert(!/\b(?:community_content_review_decide|community_post_hold_release|community_post_hold_reject|community_post_pending_edit_approve)\s*\(/i.test(shadowSql));
  report.results.push({ name:'no external HTTP/provider calls or moderation decision invocations',status:'PASS' });
  report.openTransactions = Number(await observer.query(`select count(*) from pg_stat_activity
    where datname=current_database() and pid<>pg_backend_pid() and xact_start is not null;`));
  assert.equal(report.openTransactions,0);
  report.status='PASS';

} catch (error) {
  report.status = 'FAIL';
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  try {
    await Promise.all([...sessions].map(session => session.close()));
    if (created) {
      command('dropdb', [...connectArgs, database]);
      report.cleanup.databaseDropped = true;
      const remaining = command('psql', [...connectArgs, '-d', 'postgres', '-X', '-A', '-t', '-c',
        `select count(*) from pg_database where datname=${literal(database)}`]);
      assert.equal(remaining, '0');
      report.cleanup.databaseAbsent = true;
    }
    if (started) {
      command('pg_ctl', ['-D', data, '-m', 'fast', '-w', '-t', '15', 'stop']);
      report.cleanup.clusterStopped = true;
    }
    assert(resolve(data).startsWith(resolve(tmpdir()) + sep));
    assert.equal(resolve(data), join(resolve(root), 'cluster'));
    if (!started || report.cleanup.clusterStopped) {
      removeClusterFiles();
      report.cleanup.clusterFilesRemoved = true;
    }
  } catch (error) {
    report.cleanup.error = error.stack;
    report.status = 'FAIL';
    process.exitCode = 1;
  }
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
