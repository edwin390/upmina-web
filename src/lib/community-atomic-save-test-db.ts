// PostgreSQL embebido SOLO para tests. Instalar PGlite en un directorio temporal y definir
// UPMINA_TEST_PGLITE_MODULE con la ruta de su dist/index.js; no es dependencia de producción.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const ATOMIC_MIGRATION = "20261008120000_community_atomic_media_removals.sql";
export const ACTOR = "33333333-3333-4333-8333-333333333333";
export const POST = "24655b41-1bc7-487c-834e-d1715a596e9e";
export const ASSETS = [1, 2, 3, 4].map(
  (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
);
export const ATTACHMENTS = [1, 2, 3].map(
  (n) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`,
);

export interface TestDatabase {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

function migration(name: string) {
  return readFileSync(resolve("supabase/migrations", name), "utf8");
}

export async function createAtomicTestDatabase(): Promise<TestDatabase> {
  const modulePath = process.env.UPMINA_TEST_PGLITE_MODULE;
  if (!modulePath)
    throw new Error("Set UPMINA_TEST_PGLITE_MODULE to temporary PGlite dist/index.js");
  const { PGlite } = await import(/* @vite-ignore */ modulePath);
  const db: TestDatabase = new PGlite();
  const foundation = migration("20261004120000_community_posts_media.sql");
  const table = (name: string) =>
    foundation.match(new RegExp(`create table public.${name} \\([\\s\\S]*?\\n\\);`))![0];
  const latest = migration("20261006120000_community_video_media.sql");
  const save = latest.match(
    /create or replace function public\.community_post_save\([\s\S]*?\n\$\$;/i,
  )![0];
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create table public.profiles(user_id uuid primary key references auth.users);
    create table public.media_assets(id uuid primary key, domain text, status text, kind text,
      created_by uuid, updated_at timestamptz default now());
    create table public.cosplay_post_images(asset_id uuid references public.media_assets);
    ${table("community_posts")}
    alter table public.community_posts add column like_count integer default 0;
    ${table("community_post_media")}
    ${save}
    ${migration(ATOMIC_MIGRATION)}
  `);
  await db.query("insert into auth.users values ($1);", [ACTOR]);
  await db.query("insert into profiles values ($1);", [ACTOR]);
  await db.query(
    "insert into community_posts(id,author_user_id,text,version) values ($1,$2,'Original',2)",
    [POST, ACTOR],
  );
  for (let index = 0; index < ASSETS.length; index++) {
    await db.query(
      "insert into media_assets(id,domain,status,kind,created_by) values ($1,'community','ready','image',$2)",
      [ASSETS[index], ACTOR],
    );
    if (index < ATTACHMENTS.length) {
      await db.query(
        "insert into community_post_media(id,post_id,asset_id,position) values ($1,$2,$3,$4)",
        [ATTACHMENTS[index], POST, ASSETS[index], index],
      );
    }
  }
  return db;
}

export async function atomicSave(
  db: TestDatabase,
  order: number[],
  removed: string[] = [],
  version = 2,
  text = "Editado",
  actor = ACTOR,
  post: string | null = POST,
) {
  const { rows } = await db.query<{
    result: {
      post: { id: string; version: number; text: string };
      media: { id: string; asset_id: string; position: number }[];
      cleanup_asset_ids: string[];
    };
  }>(
    "select public.community_post_save_atomic($1::uuid,$2::uuid,$3::integer,$4::text,$5::jsonb,$6::uuid[]) result",
    [
      actor,
      post,
      post ? version : null,
      text,
      JSON.stringify(order.map((n, position) => ({ asset_id: ASSETS[n], position }))),
      removed,
    ],
  );
  return rows[0].result;
}

export async function snapshot(db: TestDatabase) {
  return (
    await db.query(`select jsonb_build_object(
    'post', (select to_jsonb(p) from community_posts p where id='${POST}'),
    'media', (select jsonb_agg(to_jsonb(m) order by position) from community_post_media m where post_id='${POST}'),
    'assets', (select jsonb_agg(to_jsonb(a) order by id) from media_assets a)
  ) result`)
  ).rows[0];
}
