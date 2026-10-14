#!/usr/bin/env node
// ENSAYO LOCAL de las migraciones pendientes de Production (PGlite en memoria; no toca ninguna base real).
// Uso:  UPMINA_TEST_PGLITE_MODULE=<ruta a pglite/dist/index.js> node scripts/rehearse-pending-migrations.mjs
// Baseline = migraciones aplicadas en Production a 2026-10-14 (21, hasta 20261008120000). Siembra datos con la forma
// de los reales (1 usuario confirmado + MFA, 1 perfil, 1 admin, 1 publicación con 3 medios, 12 assets `ready`),
// aplica el resto en orden y comprueba que los datos se conservan. LIMITACIONES: roles, `auth`, `vault`, `pg_cron`
// y `pg_net` son STUBS; no es equivalente a Supabase administrado. Sin datos personales en la salida.
// Ensayo (PGlite, en memoria): baseline = 21 migraciones de Production + datos con la forma de los reales; luego las 42 pendientes.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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
console.log(`baseline=${baseline.length} pending=${pending.length}`);

const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role; create role supabase_admin; create role supabase_auth_admin;
  create role postgres_stub;
  create schema if not exists auth; create schema if not exists extensions; create schema if not exists vault;
  create schema if not exists cron; create schema if not exists net;
  create table auth.users(id uuid primary key default gen_random_uuid(), email text, encrypted_password text,
    email_confirmed_at timestamptz, raw_user_meta_data jsonb default '{}', raw_app_meta_data jsonb default '{}',
    banned_until timestamptz, created_at timestamptz default now(), updated_at timestamptz default now(),
    last_sign_in_at timestamptz, is_anonymous boolean default false, deleted_at timestamptz, phone text, confirmed_at timestamptz, email_change text, recovery_token text, confirmation_token text);
  create table auth.identities(id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete cascade, provider text, provider_id text, identity_data jsonb);
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

// Las migraciones usan CREATE EXTENSION: se neutraliza (pgcrypto/pg_cron/pg_net no existen en PGlite como en Supabase).
const prep = (sql) =>
  sql
    .replace(/create extension if not exists pgcrypto[^;]*;/gi, "-- stubbed pgcrypto;")
    .replace(/create extension if not exists pg_cron[^;]*;/gi, "-- stubbed pg_cron;")
    .replace(/create extension if not exists pg_net[^;]*;/gi, "-- stubbed pg_net;");

const results = { baseline: [], pending: [] };
async function run(list, bucket) {
  for (const f of list) {
    try {
      await db.exec(prep(readFileSync(resolve(dir, f), "utf8")));
      results[bucket].push({ f, ok: true });
    } catch (e) {
      results[bucket].push({
        f,
        ok: false,
        err: String(e.message).split("\n")[0].slice(0, 200),
      });
      console.log(
        `FAIL [${bucket}] ${f}: ${String(e.message).split("\n")[0].slice(0, 200)}`,
      );
      return false;
    }
  }
  return true;
}

if (!(await run(baseline, "baseline"))) {
  console.log("BASELINE_FAILED");
  process.exit(3);
}
console.log("baseline ok");

// Datos con la forma de Production: 1 usuario confirmado, 1 perfil, 1 publicación con medios, 12 assets ready.
const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const seed = [
  `insert into auth.users(id,email,email_confirmed_at) values ('${U}','prod-admin@example.invalid', now())`,
  `insert into auth.mfa_factors(user_id,factor_type,status) values ('${U}','totp','verified')`,
  `insert into public.profiles(user_id, username) values ('${U}','edwin')`,
  `insert into public.admin_roles(user_id, role) values ('${U}','admin')`,
];
for (const s of seed) {
  try {
    await db.exec(s);
  } catch (e) {
    console.log("SEED_FAIL", s.slice(0, 60), String(e.message).split("\n")[0]);
  }
}

const q = async (sql) => (await db.query(sql)).rows;
// 12 assets ready (4 cosplay imágenes, 6 imágenes y 2 vídeos de Community) y 1 publicación con 3 medios.
const assets = [];
for (let n = 1; n <= 12; n++) {
  const id = `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, "0")}`;
  const domain = n <= 4 ? "cosplay" : "community";
  const kind = n >= 11 ? "video" : "image";
  assets.push(id);
  await db.query(
    `insert into public.media_assets(id,domain,kind,status,is_public,mime,storage_key,pipeline_version,created_by,width,height,bytes)
     values ($1,$2,$3,'ready',$4,$5,$6,$7,$8,640,480,12345)`,
    [
      id,
      domain,
      kind,
      domain === "cosplay",
      kind === "video" ? "video/mp4" : "image/webp",
      `${domain}/${id}/${kind === "video" ? "original.mp4" : "w480.webp"}`,
      kind === "video" ? "video-v1" : "image-v1",
      U,
    ],
  );
}
const POST = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
await db.query(
  "insert into public.community_posts(id,author_user_id,text) values ($1,$2,'seed')",
  [POST, U],
);
for (let i = 0; i < 3; i++)
  await db.query(
    "insert into public.community_post_media(post_id,asset_id,position) values ($1,$2,$3)",
    [POST, assets[4 + i], i],
  );

const snap = async () => ({
  users: (await q("select count(*)::int n from auth.users"))[0].n,
  profiles: await q("select user_id, username from public.profiles"),
  roles: await q("select user_id, role from public.admin_roles"),
  posts: await q(
    "select id, author_user_id, text, status, version from public.community_posts",
  ),
  media: await q(
    "select post_id, asset_id, position from public.community_post_media order by position",
  ),
  assets: await q(
    "select id, domain, kind, status, storage_key, created_by from public.media_assets order by id",
  ),
});
const before = await snap();
console.log(
  "seeded:",
  before.users,
  "user,",
  before.assets.length,
  "assets,",
  before.posts.length,
  "post",
);

const ok = await run(pending, "pending");
const failed = results.pending.find((r) => !r.ok);
console.log(
  `pending applied: ${results.pending.filter((r) => r.ok).length}/${pending.length}`,
);
if (failed) {
  console.log("FAILED_AT", failed.f, failed.err);
}
const after = await snap();
console.log(
  "data preserved:",
  JSON.stringify({
    users: after.users === before.users,
    profiles: JSON.stringify(after.profiles) === JSON.stringify(before.profiles),
    roles: JSON.stringify(after.roles) === JSON.stringify(before.roles),
    posts:
      JSON.stringify(after.posts.map(({ status, ...r }) => r)) ===
      JSON.stringify(before.posts.map(({ status, ...r }) => r)),
    postStatus: after.posts.map((p) => p.status),
    media: JSON.stringify(after.media) === JSON.stringify(before.media),
    assets: JSON.stringify(after.assets) === JSON.stringify(before.assets),
  }),
);
console.log(
  "cron jobs:",
  JSON.stringify(await q("select jobname, schedule from cron.job")),
);
console.log(
  "tables w/o RLS:",
  JSON.stringify(
    await q(
      "select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity order by 1",
    ),
  ),
);
console.log(
  "public tables:",
  (
    await q(
      "select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'",
    )
  )[0].n,
);
console.log(
  "anon/authenticated table grants (public):",
  JSON.stringify(
    await q(
      "select grantee, count(*)::int n from information_schema.role_table_grants where table_schema='public' and grantee in ('anon','authenticated') group by 1",
    ),
  ),
);
console.log(
  "triggers on profiles:",
  JSON.stringify(
    await q(
      "select string_agg(tgname,',' order by tgname) t from pg_trigger where tgrelid='public.profiles'::regclass and not tgisinternal",
    ),
  ),
);
console.log(
  "FIDELITY:",
  JSON.stringify(
    (
      await q(
        "select (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r') tables, (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public') functions, (select count(*)::int from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal) triggers, (select count(*)::int from pg_policies where schemaname='public') policies",
      )
    )[0],
  ),
);
process.exit(failed ? 4 : 0);
