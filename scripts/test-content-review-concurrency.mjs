// Local PostgreSQL only. No packages, credentials, shared services or remote databases.
// Run: node scripts/test-content-review-concurrency.mjs <PostgreSQL bin directory>
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';

const bin = resolve(process.argv[2] ?? 'C:/Program Files/PostgreSQL/18/bin');
const root = mkdtempSync(join(tmpdir(), 'upmina-review-concurrency-'));
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
const id = () => randomUUID();
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
async function race(observer, name, kind, first, second, stale = false) {
  const post = id(), original = id(), proposed = id(), attachment = id();
  await observer.query(`insert into media_assets(id,domain,status,kind,created_by)
    values (${literal(original)},'community','ready','image',${literal(author)}),
    (${literal(proposed)},'community','ready','image',${literal(author)});
    insert into community_posts(id,author_user_id,text,status,version) values
    (${literal(post)},${literal(author)},'Original','${kind === 'held_post' ? 'held_for_review' : 'published'}',2);
    insert into community_post_media(id,post_id,asset_id,position) values (${literal(attachment)},${literal(post)},${literal(original)},0);`);
  let target = post;
  if (kind === 'pending_edit') {
    const result = await observer.json(`select public.community_post_pending_edit_submit(${literal(author)},
      ${literal(post)},2,'Propuesta',${literal(JSON.stringify([{ asset_id: proposed, position: 0 }]))}::jsonb,ARRAY[${literal(attachment)}]::uuid[]);`);
    target = result.edit.id;
  }
  const winner = await new Session(`${name}_winner`).setup();
  const loser = await new Session(`${name}_loser`).setup();
  assert.notEqual(winner.pid, loser.pid);
  const call = (actor, decision, version) => `select public.community_content_review_decide(
    ${literal(actor)},${literal(kind)},${literal(target)},${version},${literal(decision)});`;
  try {
    // Winner has decided but has NOT committed. Loser must overlap this transaction
    // and visibly wait on its real backend PID before the controller releases it.
    await winner.query('begin; set local role service_role;');
    await winner.json(call(moderators[0], first, 2));
    await loser.query('begin; set local role service_role;');
    const outcome = loser.query(call(moderators[1], second, stale ? 1 : 2))
      .then(value => ({ ok: true, value }), error => ({ ok: false, error: error.message }));
    let overlap;
    const deadline = Date.now() + 3500;
    while (Date.now() < deadline) {
      const evidence = await observer.json(`select json_build_object('winnerPid',${winner.pid},
        'loserPid',pid,'state',state,'waitType',wait_event_type,'waitEvent',wait_event,
        'blockers',pg_blocking_pids(pid),'transactionStarted',xact_start is not null)
        from pg_stat_activity where pid=${loser.pid};`);
      if (evidence.waitType === 'Lock' && evidence.blockers.includes(winner.pid)) {
        overlap = evidence;
        break;
      }
      await new Promise(accept => setTimeout(accept, 25));
    }
    assert(overlap, 'No independent backend lock overlap observed');
    await winner.query('commit;');
    const rejected = await outcome;
    assert.equal(rejected.ok, false, 'second decision must fail');
    const expectedError = kind === 'pending_edit' ? 'edit_not_pending'
      : first === 'reject' ? 'post_not_found' : 'post_not_held';
    assert(rejected.error.includes(expectedError), rejected.error);
    const state = await observer.json(`select json_build_object(
      'post',(select to_jsonb(p) from community_posts p where id=${literal(post)}),
      'media',(select coalesce(json_agg(asset_id order by position),'[]') from community_post_media where post_id=${literal(post)}),
      'assets',(select json_object_agg(id,status) from media_assets where id in (${literal(original)},${literal(proposed)})),
      'edit',(select to_jsonb(e) from community_post_pending_edits e where id=${literal(target)}),
      'pendingMedia',(select count(*)::int from community_post_pending_edit_media where edit_id=${literal(target)}),
      'audits',(select coalesce(json_agg(a),'[]') from moderation_audit_log a where target_id=${literal(post)}));`);
    assert.equal(state.audits.length, 1);
    assert.equal(state.audits[0].actor_user_id, moderators[0]);
    const action = kind === 'held_post' ? (first === 'approve' ? 'content_hold_released' : 'content_hold_rejected')
      : (first === 'approve' ? 'content_edit_approved' : 'content_edit_rejected');
    assert.equal(state.audits[0].action, action);
    assert.equal(state.audits[0].metadata.from_version ?? 2, 2);
    if (kind === 'held_post') {
      assert.equal(state.edit, null);
      if (first === 'approve') {
        assert.equal(state.post.status, 'published');
        assert.equal(state.post.version, 3);
        assert.equal(state.post.text, 'Original');
        assert.deepEqual(state.media, [original]);
      } else {
        assert.equal(state.post, null);
        assert.deepEqual(state.media, []);
      }
      assert.equal(state.assets[original], first === 'approve' ? 'ready' : 'deleting');
      assert.equal(state.assets[proposed], 'ready');
    } else {
      assert.equal(state.edit.status, first === 'approve' ? 'approved' : 'rejected');
      assert.equal(state.edit.decided_by, moderators[0]);
      assert.equal(state.pendingMedia, 0);
      assert.equal(state.post.status, 'published');
      assert.equal(state.post.version, first === 'approve' ? 3 : 2);
      assert.equal(state.post.text, first === 'approve' ? 'Propuesta' : 'Original');
      assert.deepEqual(state.media, [first === 'approve' ? proposed : original]);
      assert.equal(state.assets[proposed], first === 'approve' ? 'ready' : 'deleting');
      assert.equal(state.assets[original], first === 'approve' ? 'deleting' : 'ready');
    }
    report.results.push({ name, kind, first, second, expectedVersions: [2, stale ? 1 : 2],
      status: 'PASS', overlap, rejected: expectedError, auditCount: state.audits.length,
      version: state.post?.version ?? null, assets: state.assets });
  } finally {
    await Promise.all([winner.close(), loser.close()]);
    assert.equal(await observer.query(`select count(*) from pg_stat_activity where pid in (${winner.pid},${loser.pid});`), '0');
    assert.equal(await observer.query(`select count(*) from pg_locks where pid in (${winner.pid},${loser.pid});`), '0');
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
  const observer = await new Session('review_observer').setup();
  report.port = port;
  await fixture(observer);
  // Both winner orders are covered for mixed decisions, not merely approve-first.
  for (const args of [
    ['A', 'held_post', 'approve', 'approve'],
    ['B1', 'held_post', 'approve', 'reject'], ['B2', 'held_post', 'reject', 'approve'],
    ['C', 'pending_edit', 'approve', 'approve'],
    ['D1', 'pending_edit', 'approve', 'reject'], ['D2', 'pending_edit', 'reject', 'approve'],
    ['E', 'held_post', 'approve', 'approve'],
    ['E_stale', 'held_post', 'approve', 'approve', true],
  ]) await race(observer, ...args);
  report.openTransactions = Number(await observer.query(`select count(*) from pg_stat_activity
    where datname=current_database() and pid<>pg_backend_pid() and xact_start is not null;`));
  assert.equal(report.openTransactions, 0);
  report.status = 'PASS';
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
