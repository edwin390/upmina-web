#!/usr/bin/env node
// ENSAYO AISLADO: restaura los DATOS de un respaldo de Production en una base desechable en memoria (PGlite) construida con las
// 21 migraciones aplicadas en Production, y aplica encima las 42 pendientes. No toca ninguna base real; no imprime datos.
// Uso:  UPMINA_TEST_PGLITE_MODULE=<ruta a pglite/dist/index.js> node scripts/rehearse-restore-and-migrations.mjs --dump <prod.dump>
// Requiere pg_restore en PATH. LIMITACIONES: roles, `auth` (solo users/identities/mfa_factors), `vault`, `pg_cron` y `pg_net` son STUBS;
// storage y supabase_migrations solo se comparan por recuento. No equivale a Supabase administrado.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const argDump = process.argv[process.argv.indexOf("--dump") + 1];
if (!argDump || !process.env.UPMINA_TEST_PGLITE_MODULE) {
  console.error(
    "Uso: UPMINA_TEST_PGLITE_MODULE=... node scripts/rehearse-restore-and-migrations.mjs --dump <prod.dump>",
  );
  process.exit(2);
}
const { PGlite } = await import(process.env.UPMINA_TEST_PGLITE_MODULE);
const dir = resolve("supabase/migrations");
const APPLIED = new Set(
  "20260920120000 20260920180000 20260921120000 20260921180000 20260922120000 20260923120000 20260924120000 20260924130000 20260925120000 20260926120000 20260927120000 20260928120000 20260929120000 20260930120000 20261001120000 20261002120000 20261003120000 20261004120000 20261005120000 20261006120000 20261008120000".split(
    " ",
  ),
);
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const baseline = files.filter((f) => APPLIED.has(f.split("_")[0]));
const pending = files.filter((f) => !APPLIED.has(f.split("_")[0]));

// 1. Datos del dump → texto plano (en un directorio temporal que se borra al final).
const tmp = mkdtempSync(join(tmpdir(), "upmina-rehearse-"));
const sqlPath = join(tmp, "data.sql");
execFileSync(
  "pg_restore",
  ["--no-owner", "--no-privileges", "-a", "-f", sqlPath, argDump],
  { stdio: "ignore" },
);
const unescape = (s) =>
  s.replace(
    /\\(.)/g,
    (_, c) =>
      ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "\\": "\\" })[c] ?? c,
  );
const blocks = [];
{
  const lines = readFileSync(sqlPath, "utf8").split("\n");
  let cur = null;
  for (const line of lines) {
    const m = !cur && line.match(/^COPY (\S+) \((.*)\) FROM stdin;$/);
    if (m)
      cur = {
        table: m[1],
        cols: m[2].split(",").map((c) => c.trim().replace(/^"|"$/g, "")),
        rows: [],
      };
    else if (cur && line === "\\.") {
      blocks.push(cur);
      cur = null;
    } else if (cur)
      cur.rows.push(line.split("\t").map((v) => (v === "\\N" ? null : unescape(v))));
  }
}
rmSync(tmp, { recursive: true, force: true });
const dumpCounts = Object.fromEntries(blocks.map((b) => [b.table, b.rows.length]));

// 2. Base desechable: stubs de plataforma + 21 migraciones.
const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role; create role supabase_admin; create role supabase_auth_admin;
  create schema if not exists auth; create schema if not exists extensions; create schema if not exists vault;
  create schema if not exists cron; create schema if not exists net;
  create table auth.users(id uuid primary key default gen_random_uuid(), email text, encrypted_password text,
    email_confirmed_at timestamptz, raw_user_meta_data jsonb default '{}', raw_app_meta_data jsonb default '{}',
    banned_until timestamptz, created_at timestamptz default now(), updated_at timestamptz default now(),
    last_sign_in_at timestamptz, is_anonymous boolean default false, deleted_at timestamptz);
  create table auth.identities(id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete cascade, provider text, identity_data jsonb);
  create table auth.sessions(id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete cascade, aal text);
  create table auth.refresh_tokens(id bigserial primary key, user_id text, session_id uuid);
  create table auth.mfa_factors(id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete cascade, factor_type text, status text);
  create table auth.mfa_challenges(id uuid primary key default gen_random_uuid(), factor_id uuid references auth.mfa_factors(id) on delete cascade);
  create table auth.mfa_amr_claims(id uuid primary key default gen_random_uuid(), session_id uuid references auth.sessions(id) on delete cascade);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
  create function auth.role() returns text language sql stable as $$ select 'anon'::text $$;
  create table vault.secrets(id uuid primary key default gen_random_uuid(), name text unique, secret text);
  create view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;
  create function vault.create_secret(s text, n text) returns uuid language sql as $$ insert into vault.secrets(name,secret) values (n,s) returning id $$;
  create table cron.job(jobid serial primary key, jobname text unique, schedule text, command text, active boolean default true);
  create function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job(jobname,schedule,command) values (n,s,c) on conflict (jobname) do update set schedule=excluded.schedule, command=excluded.command returning jobid::bigint $$;
  create function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname=n returning true $$;
  create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;
`);
const prep = (sql) =>
  sql
    .replace(/create extension if not exists pgcrypto[^;]*;/gi, "-- stubbed pgcrypto;")
    .replace(/create extension if not exists pg_cron[^;]*;/gi, "-- stubbed pg_cron;")
    .replace(/create extension if not exists pg_net[^;]*;/gi, "-- stubbed pg_net;");
const fail = (stage, f, e) => {
  console.log(`FAIL [${stage}] ${f}: ${String(e.message).split("\n")[0].slice(0, 220)}`);
  process.exit(4);
};
for (const f of baseline) {
  try {
    await db.exec(prep(readFileSync(resolve(dir, f), "utf8")));
  } catch (e) {
    fail("baseline", f, e);
  }
}
console.log(`baseline: ${baseline.length} migraciones aplicadas`);

// 3. Restauración de datos (public completo + auth.users/identities/mfa_factors). Triggers y FK desactivados durante la carga.
const q = async (sql, p) => (await db.query(sql, p)).rows;
await db.exec("set session_replication_role = replica");
const restored = {};
const skipped = [];
const drift = [];
const RESTORE = (t) =>
  t.startsWith("public.") ||
  ["auth.users", "auth.identities", "auth.mfa_factors"].includes(t);
for (const b of blocks) {
  if (!RESTORE(b.table)) {
    skipped.push(b.table);
    continue;
  }
  const [schema, name] = b.table.split(".");
  const have = new Set(
    (
      await q(
        "select column_name from information_schema.columns where table_schema=$1 and table_name=$2",
        [schema, name],
      )
    ).map((r) => r.column_name),
  );
  if (have.size === 0) {
    drift.push(`${b.table}: tabla ausente tras las 21 migraciones`);
    continue;
  }
  for (const c of b.cols)
    if (!have.has(c)) {
      if (schema === "auth")
        await db.exec(`alter table ${b.table} add column "${c}" text`); // stub: columnas reales de Supabase
      else drift.push(`${b.table}: columna ${c} no existe en el esquema construido`);
    }
  const cols = b.cols.filter((c) => have.has(c) || schema === "auth");
  const idx = cols.map((c) => b.cols.indexOf(c));
  const lit = (v) => (v === null ? "null" : `'${v.replace(/'/g, "''")}'`);
  for (const row of b.rows) {
    try {
      await db.exec(
        `insert into ${b.table} (${cols.map((c) => `"${c}"`).join(",")}) values (${idx.map((i) => lit(row[i])).join(",")})`,
      );
    } catch (e) {
      drift.push(`${b.table}: ${String(e.message).split("\n")[0].slice(0, 120)}`);
      break;
    }
  }
  restored[b.table] = {
    cols,
    n: (await q(`select count(*)::int n from ${b.table}`))[0].n,
  };
}
await db.exec("set session_replication_role = origin");
const chk = async (t, cols) =>
  (
    await q(
      `select md5(coalesce(string_agg(x, '|' order by x),'')) h from (select (${cols.map((c) => `coalesce("${c}"::text,'∅')`).join(" || ',' || ")}) x from ${t}) s`,
    )
  )[0].h;
const before = {};
for (const [t, r] of Object.entries(restored))
  before[t] = { n: r.n, h: await chk(t, r.cols) };
const countMatch = Object.entries(restored).filter(
  ([t, r]) => r.n === dumpCounts[t],
).length;
console.log(
  `restauración: ${Object.keys(restored).length} tablas, filas totales=${Object.values(restored).reduce((a, r) => a + r.n, 0)}, recuentos = dump en ${countMatch}/${Object.keys(restored).length}; omitidas (solo recuento): ${skipped.length}`,
);
console.log(`deriva de esquema detectada: ${drift.length}`);
for (const d of drift) console.log("  DRIFT", d);

// 4. Las 42 migraciones pendientes sobre los datos restaurados.
let applied = 0;
for (const f of pending) {
  try {
    await db.exec(prep(readFileSync(resolve(dir, f), "utf8")));
    applied++;
  } catch (e) {
    fail("pending", f, e);
  }
}
console.log(`pendientes aplicadas: ${applied}/${pending.length}`);
let kept = 0;
const changed = [];
for (const [t, r] of Object.entries(before)) {
  const n = (await q(`select count(*)::int n from ${t}`))[0].n;
  const h = await chk(t, restored[t].cols);
  if (n === r.n && h === r.h) kept++;
  else changed.push(`${t}: filas ${r.n}→${n}${h === r.h ? "" : " (contenido distinto)"}`);
}
console.log(
  `datos conservados tras las 42: ${kept}/${Object.keys(before).length} tablas idénticas (columnas originales)`,
);
for (const c of changed) console.log("  CAMBIO", c);
const one = async (sql) => (await q(sql))[0];
console.log(
  "sin RLS:",
  JSON.stringify(
    (
      await q(
        "select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity order by 1",
      )
    ).map((r) => r.relname),
  ),
);
console.log(
  "FIDELIDAD:",
  JSON.stringify(
    await one(
      "select (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r') tablas, (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public') funciones, (select count(*)::int from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal) triggers, (select count(*)::int from pg_policies where schemaname='public') politicas",
    ),
  ),
);
console.log(
  "cron:",
  JSON.stringify(
    (await q("select jobname, schedule from cron.job")).map(
      (r) => `${r.jobname} ${r.schedule}`,
    ),
  ),
);
console.log(
  "huella del ensayo:",
  createHash("sha256").update(JSON.stringify(before)).digest("hex").slice(0, 16),
);
process.exit(0);
