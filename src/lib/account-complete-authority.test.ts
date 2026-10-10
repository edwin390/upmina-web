// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACTOR,
  createAtomicTestDatabase,
  type TestDatabase,
} from "./community-atomic-save-test-db";

// AUTH-2: CUENTA COMPLETA = email verificado (auth.users.email_confirmed_at) + username (profiles).
// SQL real (migraciones hasta 20261025) sobre PGlite. Se ejercitan las RPC DIRECTAMENTE (sin pasar
// por HTTP) para demostrar que el guard de la BD no se puede saltar. PGlite es de una sola
// conexión: la concurrencia real queda para el smoke de Testing; aquí se fija el ORDEN DE LOCKS de
// forma estructural y que el nuevo enforcement no toma ningún lock propio.

const migration = (n: string) =>
  readFileSync(`supabase/migrations/${n}`, "utf8").replace(/\r\n/g, "\n");
const AUTH2 = migration("20261025120000_account_complete_authority.sql");
const PROFILES_DDL = migration("20260924120000_profiles.sql");
const USERNAME_MIGRATION = migration("20261003120000_community_username_foundation.sql");
const REAL_USERNAME_CHECK = USERNAME_MIGRATION.match(
  /add constraint profiles_username_format check \(([\s\S]*?)\n {2}\);/,
)![1];
const uid = (n: number) => `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const COMPLETE = ACTOR; // verificado + perfil (creado por el harness)
const UNVERIFIED = uid(1); // sin verificar, sin perfil
const VERIFIED_NO_PROFILE = uid(2); // verificado, sin username
const LEGACY_UNVERIFIED = uid(3); // perfil previo + email NO verificado (datos heredados)
const REPORTERS = [11, 12, 13, 14].map(uid); // completos
let db: TestDatabase;
let seq = 0;

interface Obj {
  [key: string]: unknown;
}
const one = async <T = Obj>(sql: string, params: unknown[] = []) =>
  (await db.query<{ r: T }>(sql, params)).rows[0].r;

beforeAll(async () => {
  db = await createAtomicTestDatabase();
  await db.exec(`create table admin_roles(user_id uuid primary key,role text);
 alter table profiles add column username text,add column display_name text;
 alter table media_assets add column storage_key text,add column width int,add column height int,
   add column duration_seconds numeric,add column private_original_key text;
 create table media_asset_variants(id uuid primary key default gen_random_uuid(),
   asset_id uuid not null references media_assets(id) on delete cascade,
   variant int, storage_key text not null);`);
  // El harness base ya trae community_posts.like_count (y su índice): se carga la migración REAL de
  // likes sin esas dos sentencias para no duplicarlas.
  await db.exec(
    migration("20261005120000_community_post_likes.sql")
      .replace(/alter table public\.community_posts add column like_count[\s\S]*?;\n/, "")
      .replace(/create index community_posts_popular[\s\S]*?;\n/, ""),
  );
  for (const n of [
    "20261007120000_moderation_foundation.sql",
    "20261009120000_moderation_workflow_core.sql",
    "20261010120000_moderation_case_foundation.sql",
    "20261011120000_community_report_submission.sql",
    "20261012120000_community_report_submission_account_race_fix.sql",
    "20261013120000_moderation_case_read_model.sql",
    "20261014120000_moderation_case_media_references.sql",
    "20261015120000_moderation_grouped_decision_core.sql",
    "20261016120000_community_controlled_write_boundary.sql",
    "20261017120000_community_author_moderation_access.sql",
    "20261018120000_community_author_resolved_notice_flag.sql",
    "20261019120000_community_media_delivery_state.sql",
    "20261020120000_community_media_purge_lifecycle.sql",
    "20261022120000_moderation_purged_history_read.sql",
    "20261023120000_community_strikes_foundation.sql",
    "20261024120000_community_strike_write_enforcement.sql",
    "20261025120000_account_complete_authority.sql",
  ])
    await db.exec(migration(n));
  // El harness base declara profiles.username como columna libre. Aquí se aplican las MISMAS
  // restricciones que las migraciones reales (NOT NULL de 20260924 + profiles_username_format de
  // 20261003, extraída del archivo) para que "perfil existe" implique "username válido".
  await db.exec(
    "update profiles set username = 'actor_user' where username is null; alter table profiles alter column username set not null;",
  );
  await db.exec(
    `alter table profiles add constraint profiles_username_format check (${REAL_USERNAME_CHECK});`,
  );
  // community_post_delete real (20261004); el resto de la cadena (incluidos likes y AUTH-2) ya cargó.
  await db.exec(
    migration("20261004120000_community_posts_media.sql").match(
      /create or replace function public\.community_post_delete\([\s\S]*?\n\$\$;/,
    )![0],
  );
}, 90000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec("begin");
  // Usuarios del escenario (dentro de la transacción de cada test).
  await db.query("insert into auth.users(id,email_confirmed_at) values($1,null)", [
    UNVERIFIED,
  ]);
  await db.query("insert into auth.users(id,email_confirmed_at) values($1,now())", [
    VERIFIED_NO_PROFILE,
  ]);
  await db.query("insert into auth.users(id,email_confirmed_at) values($1,now())", [
    LEGACY_UNVERIFIED,
  ]);
  await db.query("insert into profiles(user_id,username) values($1,'legacy_user')", [
    LEGACY_UNVERIFIED,
  ]);
  await db.query("update auth.users set email_confirmed_at = null where id = $1", [
    LEGACY_UNVERIFIED,
  ]);
  for (const id of REPORTERS) {
    await db.query("insert into auth.users(id,email_confirmed_at) values($1,now())", [
      id,
    ]);
    await db.query("insert into profiles(user_id,username) values($1,$2)", [
      id,
      `rep_${id.slice(-2)}`,
    ]);
  }
});
afterEach(async () => {
  try {
    await db.exec("reset role");
  } catch {
    /* transacción abortada */
  }
  await db.exec("rollback");
});

async function fails(sql: string, params: unknown[], code: string | RegExp) {
  await db.exec("savepoint s");
  let message = "";
  try {
    await db.query(sql, params);
  } catch (e) {
    message = String((e as Error).message);
  }
  await db.exec("rollback to savepoint s");
  expect(message).not.toBe("");
  expect(message).toMatch(code);
  return message;
}
const newPost = async (author: string) => {
  const id = uid(1000 + ++seq);
  await db.query(
    "insert into community_posts(id,author_user_id,text,version) values($1,$2,'t',2)",
    [id, author],
  );
  return id;
};
describe("community_account_state — una sola fuente de verdad", () => {
  it.each([
    [COMPLETE, "complete"],
    [VERIFIED_NO_PROFILE, "username_missing"],
    [UNVERIFIED, "email_unverified"],
    [LEGACY_UNVERIFIED, "email_unverified"],
    [uid(999), "email_unverified"], // usuario inexistente: falla cerrado, no revela existencia
  ])("%s → %s", async (user, expected) => {
    expect(await one<string>("select community_account_state($1) r", [user])).toBe(
      expected,
    );
  });
  it("argumento nulo no concede nada", async () => {
    await fails("select community_account_state(null)", [], /invalid_argument/);
  });
  it("no está disponible para anon/authenticated; solo service_role puede ejecutarla", async () => {
    const priv = async (role: string, fn: string) =>
      (
        await db.query<{ ok: boolean }>(
          "select has_function_privilege($1, $2, 'execute') ok",
          [role, fn],
        )
      ).rows[0].ok;
    for (const role of ["anon", "authenticated"])
      expect(await priv(role, "public.community_account_state(uuid)")).toBe(false);
    expect(await priv("service_role", "public.community_account_state(uuid)")).toBe(true);
    for (const fn of [
      "public.community_assert_account_complete(uuid)",
      "public.community_post_set_like_core(uuid,uuid,boolean)",
      "public.community_post_report_submit_core(uuid,uuid,text,text)",
    ])
      for (const role of ["anon", "authenticated", "service_role"])
        expect(await priv(role, fn), `${role} ${fn}`).toBe(false);
    for (const fn of [
      "public.community_post_set_like(uuid,uuid,boolean)",
      "public.community_post_report_submit(uuid,uuid,text,text)",
    ]) {
      expect(await priv("service_role", fn)).toBe(true);
      for (const role of ["anon", "authenticated"])
        expect(await priv(role, fn)).toBe(false);
    }
  });
});

describe("username: no se crea ni se cambia antes de verificar (escritura directa incluida)", () => {
  it("INSERT de perfil con email sin verificar falla en la BD", async () => {
    await fails(
      "insert into profiles(user_id,username) values($1,'nuevo_user')",
      [UNVERIFIED],
      /account_email_unverified/,
    );
  });
  it("INSERT de perfil con email verificado funciona", async () => {
    await db.query("insert into profiles(user_id,username) values($1,'nuevo_user')", [
      VERIFIED_NO_PROFILE,
    ]);
    expect(
      await one<string>("select community_account_state($1) r", [VERIFIED_NO_PROFILE]),
    ).toBe("complete");
  });
  it("cambiar username con email sin verificar falla; display_name no está afectado", async () => {
    await fails(
      "update profiles set username='otro_user' where user_id=$1",
      [LEGACY_UNVERIFIED],
      /account_email_unverified/,
    );
    await db.query("update profiles set display_name='Nombre' where user_id=$1", [
      LEGACY_UNVERIFIED,
    ]);
  });
  it("cambiar username con email verificado funciona; re-escribir el MISMO username no consulta nada", async () => {
    await db.query("update profiles set username='otro_user' where user_id=$1", [
      REPORTERS[0],
    ]);
    await db.query("update profiles set username=username where user_id=$1", [
      LEGACY_UNVERIFIED,
    ]);
  });
});

describe("crear/editar publicación (post_save y save_atomic) — RPC directa", () => {
  it("sin verificar → account_email_unverified (nada se escribe)", async () => {
    await fails(
      "select community_post_save($1,null,null,'Nuevo','[]'::jsonb)",
      [UNVERIFIED],
      /account_email_unverified/,
    );
    await fails(
      "select community_post_save_atomic($1,null,null,'n','[]'::jsonb,'{}'::uuid[])",
      [UNVERIFIED],
      /account_email_unverified/,
    );
    expect(
      (
        await db.query(
          "select count(*)::int n from community_posts where author_user_id=$1",
          [UNVERIFIED],
        )
      ).rows[0],
    ).toEqual({ n: 0 });
  });
  it("verificado sin username → account_username_missing (ya no no_profile)", async () => {
    await fails(
      "select community_post_save($1,null,null,'Nuevo','[]'::jsonb)",
      [VERIFIED_NO_PROFILE],
      /account_username_missing/,
    );
    await fails(
      "select community_post_save_atomic($1,null,null,'n','[]'::jsonb,'{}'::uuid[])",
      [VERIFIED_NO_PROFILE],
      /account_username_missing/,
    );
  });
  it("editar con la cuenta heredada sin verificar también se bloquea", async () => {
    const post = await newPost(LEGACY_UNVERIFIED);
    await fails(
      "select community_post_save($1,$2,2,'Editado','[]'::jsonb)",
      [LEGACY_UNVERIFIED, post],
      /account_email_unverified/,
    );
    expect(
      (await db.query("select text from community_posts where id=$1", [post])).rows[0],
    ).toEqual({ text: "t" });
  });
  it("cuenta completa: el flujo normal sigue funcionando", async () => {
    const r = await one<{ post: { id: string } }>(
      "select community_post_save($1,null,null,'Hola','[]'::jsonb) r",
      [COMPLETE],
    );
    expect(r.post.id).toBeTruthy();
  });
});

describe("reordenar / desvincular media — RPC directa", () => {
  it("cuenta incompleta: bloqueado antes de tocar el post", async () => {
    const post = await newPost(LEGACY_UNVERIFIED);
    await fails(
      "select community_post_reorder_media($1,$2,2,'[]'::jsonb)",
      [LEGACY_UNVERIFIED, post],
      /account_email_unverified/,
    );
    await fails(
      "select community_post_detach_media($1,$2,2,$3)",
      [LEGACY_UNVERIFIED, post, uid(77)],
      /account_email_unverified/,
    );
  });
});

describe("like / unlike — RPC directa", () => {
  it.each([
    ["sin verificar", UNVERIFIED, /account_email_unverified/],
    ["verificado sin username", VERIFIED_NO_PROFILE, /account_username_missing/],
    ["heredado sin verificar", LEGACY_UNVERIFIED, /account_email_unverified/],
  ])("%s no puede dar ni quitar like", async (_n, user, code) => {
    const post = await newPost(COMPLETE);
    for (const liked of [true, false])
      await fails("select community_post_set_like($1,$2,$3)", [user, post, liked], code);
    expect(
      (await db.query("select count(*)::int n from community_post_likes")).rows[0],
    ).toEqual({ n: 0 });
  });
  it("el núcleo no es invocable directamente por ningún rol de API", async () => {
    const post = await newPost(COMPLETE);
    await db.exec("set local role service_role");
    await fails(
      "select community_post_set_like_core($1,$2,true)",
      [UNVERIFIED, post],
      /permission denied/,
    );
    await db.exec("reset role");
  });
  it("cuenta completa: like y unlike funcionan e incrementan/decrementan el contador", async () => {
    const post = await newPost(COMPLETE);
    const liked = await one<{ likeCount: number; likedByMe: boolean }>(
      "select community_post_set_like($1,$2,true) r",
      [REPORTERS[0], post],
    );
    expect(liked).toMatchObject({ likeCount: 1, likedByMe: true });
    const unliked = await one<{ likeCount: number }>(
      "select community_post_set_like($1,$2,false) r",
      [REPORTERS[0], post],
    );
    expect(unliked.likeCount).toBe(0);
  });
});

describe("reportar — RPC directa y umbral de moderación", () => {
  const report = (user: string, post: string) =>
    db.query("select community_post_report_submit($1,$2,'spam',null) r", [user, post]);
  it.each([
    ["sin verificar", UNVERIFIED, /account_email_unverified/],
    ["verificado sin username", VERIFIED_NO_PROFILE, /account_username_missing/],
    ["heredado sin verificar", LEGACY_UNVERIFIED, /account_email_unverified/],
  ])("%s no puede crear un reporte", async (_n, user, code) => {
    const post = await newPost(COMPLETE);
    await fails(
      "select community_post_report_submit($1,$2,'spam',null)",
      [user, post],
      code,
    );
    expect(
      (await db.query("select count(*)::int n from community_post_reports")).rows[0],
    ).toEqual({ n: 0 });
  });
  it("las cuentas incompletas NO cuentan para el umbral de 3 reportantes distintos", async () => {
    const post = await newPost(COMPLETE);
    await report(REPORTERS[0], post);
    await report(REPORTERS[1], post);
    for (const user of [UNVERIFIED, VERIFIED_NO_PROFILE, LEGACY_UNVERIFIED])
      await fails(
        "select community_post_report_submit($1,$2,'spam',null)",
        [user, post],
        /account_/,
      );
    expect(
      (await db.query("select status from community_posts where id=$1", [post])).rows[0],
    ).toEqual({ status: "published" });
    const third = await one<{ distinctReporterCount: number; postStatus: string }>(
      "select community_post_report_submit($1,$2,'spam',null) r",
      [REPORTERS[2], post],
    );
    expect(third).toMatchObject({
      distinctReporterCount: 3,
      postStatus: "hidden_pending_review",
    });
  });
  it("el núcleo no es invocable directamente", async () => {
    const post = await newPost(COMPLETE);
    await db.exec("set local role service_role");
    await fails(
      "select community_post_report_submit_core($1,$2,'spam',null)",
      [UNVERIFIED, post],
      /permission denied/,
    );
    await db.exec("reset role");
  });
});

describe("eliminar publicación propia: NO se bloquea por cuenta incompleta", () => {
  it("la cuenta heredada sin verificar puede borrar su propia publicación", async () => {
    const post = await newPost(LEGACY_UNVERIFIED);
    await db.query("select community_post_delete($1,$2,2)", [LEGACY_UNVERIFIED, post]);
    expect(
      (await db.query("select count(*)::int n from community_posts where id=$1", [post]))
        .rows[0],
    ).toEqual({ n: 0 });
  });
});

describe("account_incomplete vs author_restricted (dominios distintos)", () => {
  async function stubRestriction(restrictedFor: string) {
    await db.exec(`create or replace function public.community_author_restriction(p_user_id uuid)
      returns jsonb language sql stable as $$ select jsonb_build_object(
        'restricted', p_user_id = '${restrictedFor}'::uuid) $$;`);
  }
  it("cuenta completa con strike → author_restricted (comportamiento R5 intacto)", async () => {
    await stubRestriction(COMPLETE);
    await fails(
      "select community_post_save($1,null,null,'Nuevo','[]'::jsonb)",
      [COMPLETE],
      /author_restricted/,
    );
  });
  it("cuenta incompleta NUNCA se reporta como sancionada: gana account_*", async () => {
    await stubRestriction(UNVERIFIED);
    const msg = await fails(
      "select community_post_save($1,null,null,'Nuevo','[]'::jsonb)",
      [UNVERIFIED],
      /account_email_unverified/,
    );
    expect(msg).not.toMatch(/author_restricted/);
  });
});

describe("username realmente válido: 'complete' no puede salir de un perfil sin username utilizable", () => {
  it("las migraciones reales garantizan NOT NULL + formato (validado, no NOT VALID)", () => {
    expect(PROFILES_DDL).toMatch(/username\s+text not null/);
    expect(USERNAME_MIGRATION).toMatch(/add constraint profiles_username_format check/);
    expect(USERNAME_MIGRATION).not.toMatch(/not valid/i);
    expect(REAL_USERNAME_CHECK).toContain("^[a-z0-9_.]{3,24}$");
  });
  it.each([
    ["nulo", null],
    ["vacío", ""],
    ["solo espacios", "   "],
    ["demasiado corto", "ab"],
    ["mayúsculas", "UPPER"],
    ["con espacios", "has space"],
    ["punto inicial", ".punto"],
    ["puntos consecutivos", "a..b"],
    ["demasiado largo", "x".repeat(25)],
  ])(
    "perfil con username %s: la BD lo rechaza y el estado NO es complete",
    async (_n, value) => {
      await fails(
        "insert into profiles(user_id,username) values($1,$2)",
        [VERIFIED_NO_PROFILE, value],
        /null value|violates check constraint|not-null/i,
      );
      expect(
        await one<string>("select community_account_state($1) r", [VERIFIED_NO_PROFILE]),
      ).toBe("username_missing");
    },
  );
  it("cambiar un username válido a uno inválido también lo rechaza la BD", async () => {
    for (const bad of [null, "", "ab"])
      await fails(
        "update profiles set username = $1 where user_id = $2",
        [bad, REPORTERS[0]],
        /null value|violates check constraint|not-null/i,
      );
    expect(
      await one<string>("select community_account_state($1) r", [REPORTERS[0]]),
    ).toBe("complete");
  });
  it("username válido en el límite (3 y 24 caracteres) sí produce complete", async () => {
    await db.query("update profiles set username = $1 where user_id = $2", [
      "abc",
      REPORTERS[0],
    ]);
    await db.query("update profiles set username = $1 where user_id = $2", [
      "a".repeat(24),
      REPORTERS[1],
    ]);
    for (const i of [0, 1])
      expect(
        await one<string>("select community_account_state($1) r", [REPORTERS[i]]),
      ).toBe("complete");
  });
});

describe("auditoría de wrappers RPC: sin bypass para clientes normales", () => {
  const WRAPPERS = [
    "community_post_set_like(uuid,uuid,boolean)",
    "community_post_report_submit(uuid,uuid,text,text)",
  ];
  const CORES = [
    "community_post_set_like_core(uuid,uuid,boolean)",
    "community_post_report_submit_core(uuid,uuid,text,text)",
  ];
  const INTERNALS = [
    "community_account_state(uuid)",
    "community_assert_account_complete(uuid)",
    "community_assert_author_may_write(uuid)",
    "profiles_require_verified_email()",
  ];
  const all = [...WRAPPERS, ...CORES, ...INTERNALS];
  const priv = async (role: string, fn: string) =>
    (
      await db.query<{ ok: boolean }>(
        "select has_function_privilege($1, 'public.' || $2, 'execute') ok",
        [role, fn],
      )
    ).rows[0].ok;

  it("SECURITY DEFINER, dueño postgres y search_path fijo en TODAS las funciones nuevas o reemplazadas", async () => {
    for (const fn of all) {
      const row = (
        await db.query<{ definer: boolean; owner: string; config: string[] | null }>(
          `select p.prosecdef definer, r.rolname owner, p.proconfig config
             from pg_proc p join pg_roles r on r.oid = p.proowner
            where p.oid = ('public.' || $1)::regprocedure`,
          [fn],
        )
      ).rows[0];
      expect(row.definer, fn).toBe(true);
      expect(row.owner, fn).toBe("postgres");
      expect(row.config?.join(","), fn).toMatch(/search_path=pg_catalog, public/);
    }
  });
  it("PUBLIC, anon y authenticated no pueden ejecutar NINGUNA de ellas", async () => {
    for (const fn of all) {
      for (const role of ["anon", "authenticated"])
        expect(await priv(role, fn), `${role} ${fn}`).toBe(false);
      expect(
        (
          await db.query<{ n: number }>(
            `select count(*)::int n from pg_proc p, aclexplode(p.proacl) a
              where p.oid = ('public.' || $1)::regprocedure and a.grantee = 0`,
            [fn],
          )
        ).rows[0].n,
        `PUBLIC ${fn}`,
      ).toBe(0);
    }
  });
  it("service_role: solo los wrappers y la lectura de estado; nunca los núcleos ni los internos", async () => {
    for (const fn of [...WRAPPERS, "community_account_state(uuid)"])
      expect(await priv("service_role", fn), fn).toBe(true);
    for (const fn of [
      ...CORES,
      "community_assert_account_complete(uuid)",
      "community_assert_author_may_write(uuid)",
      "profiles_require_verified_email()",
    ])
      expect(await priv("service_role", fn), fn).toBe(false);
  });
  it("invocación real bajo anon/authenticated: 'permission denied for function'", async () => {
    const post = await newPost(COMPLETE);
    await db.exec("grant usage on schema public to anon, authenticated, service_role");
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set local role ${role}`);
      for (const [sql, params] of [
        ["select community_post_set_like($1,$2,true)", [REPORTERS[0], post]],
        ["select community_post_set_like_core($1,$2,true)", [REPORTERS[0], post]],
        ["select community_post_report_submit($1,$2,'spam',null)", [REPORTERS[0], post]],
        [
          "select community_post_report_submit_core($1,$2,'spam',null)",
          [REPORTERS[0], post],
        ],
        ["select community_account_state($1)", [REPORTERS[0]]],
        ["select community_assert_account_complete($1)", [REPORTERS[0]]],
      ] as const)
        await fails(sql, [...params], /permission denied for function/);
      await db.exec("reset role");
    }
  });
  it("service_role no puede saltarse el wrapper llamando al núcleo (cuenta incompleta)", async () => {
    const post = await newPost(COMPLETE);
    await db.exec("grant usage on schema public to service_role");
    await db.exec("set local role service_role");
    await fails(
      "select community_post_set_like_core($1,$2,true)",
      [UNVERIFIED, post],
      /permission denied for function/,
    );
    await fails(
      "select community_post_report_submit_core($1,$2,'spam',null)",
      [UNVERIFIED, post],
      /permission denied for function/,
    );
    await fails(
      "select community_post_set_like($1,$2,true)",
      [UNVERIFIED, post],
      /account_email_unverified/,
    );
    await db.exec("reset role");
  });
  it("tablas de likes y reports: anon/authenticated sin ningún privilegio; RLS activa y forzada", async () => {
    for (const table of ["community_post_likes", "community_post_reports"]) {
      for (const role of ["anon", "authenticated"])
        for (const kind of ["select", "insert", "update", "delete"])
          expect(
            (
              await db.query<{ ok: boolean }>(
                "select has_table_privilege($1, 'public.' || $2, $3) ok",
                [role, table, kind],
              )
            ).rows[0].ok,
            `${role} ${kind} ${table}`,
          ).toBe(false);
      const rls = (
        await db.query<{ enabled: boolean; forced: boolean }>(
          "select relrowsecurity enabled, relforcerowsecurity forced from pg_class where oid = ('public.' || $1)::regclass",
          [table],
        )
      ).rows[0];
      expect(rls, table).toEqual({ enabled: true, forced: true });
    }
  });
  it("service_role NO puede escribir directamente likes ni reports (solo leer): el wrapper es el único camino", async () => {
    const can = async (table: string, kind: string) =>
      (
        await db.query<{ ok: boolean }>(
          "select has_table_privilege('service_role', 'public.' || $1, $2) ok",
          [table, kind],
        )
      ).rows[0].ok;
    for (const table of ["community_post_likes", "community_post_reports"]) {
      expect(await can(table, "select"), `select ${table}`).toBe(true);
      for (const kind of ["insert", "update", "delete"])
        expect(await can(table, kind), `${kind} ${table}`).toBe(false);
    }
    const post = await newPost(COMPLETE);
    await db.exec("grant usage on schema public to service_role");
    await db.exec("set local role service_role");
    await fails(
      "insert into community_post_likes(post_id,user_id) values($1,$2)",
      [post, UNVERIFIED],
      /permission denied for table/,
    );
    await db.exec("reset role");
  });
  it("el flujo legítimo sigue funcionando por el wrapper aunque service_role no escriba la tabla", async () => {
    const post = await newPost(COMPLETE);
    await db.exec("grant usage on schema public to service_role");
    await db.exec("set local role service_role");
    const r = await one<{ likeCount: number }>(
      "select community_post_set_like($1,$2,true) r",
      [REPORTERS[0], post],
    );
    expect(r.likeCount).toBe(1);
    await db.exec("reset role");
  });
  it("orden de locks preservado: el wrapper afirma la cuenta ANTES del núcleo y no toma locks propios", () => {
    for (const name of ["community_post_set_like", "community_post_report_submit"]) {
      const body = AUTH2.replace(/--.*$/gm, "").match(
        new RegExp(`create function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`),
      )![0];
      const assertAt = body.indexOf("community_assert_account_complete");
      expect(assertAt).toBeGreaterThan(0);
      expect(body.indexOf(`${name}_core`)).toBeGreaterThan(assertAt);
      expect(body).not.toMatch(/for update|for share|lock table/i);
    }
  });
});

describe("estructura: locks y alcance de la migración", () => {
  const code = AUTH2.replace(/--.*$/gm, "");
  it("el guard conserva el orden profiles(FOR SHARE) → cuenta → sanción", () => {
    const guard = code.match(
      /create or replace function public\.community_assert_author_may_write[\s\S]*?\n\$\$;/,
    )![0];
    const lock = guard.indexOf("for share");
    const account = guard.indexOf("community_assert_account_complete");
    const restriction = guard.indexOf("community_author_restriction");
    expect(lock).toBeGreaterThan(0);
    expect(account).toBeGreaterThan(lock);
    expect(restriction).toBeGreaterThan(account);
  });
  it("los wrappers y las lecturas de cuenta no toman locks propios", () => {
    for (const name of [
      "community_account_state",
      "community_assert_account_complete",
      "community_post_set_like",
      "community_post_report_submit",
      "profiles_require_verified_email",
    ]) {
      const body = code.match(
        new RegExp(`create function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`),
      )![0];
      expect(body, name).not.toMatch(/for update|for share|lock table/i);
    }
  });
  it("no toca delete propio, moderación (casos/ciclos/decisiones/strikes), R2 ni GC", () => {
    for (const forbidden of [
      "community_post_delete",
      "community_moderation_case_decide",
      "community_strike_apply",
      "community_strike_revoke",
      "community_purge_due_posts",
      "community_asset_gc",
      "media_assets",
    ])
      expect(code).not.toContain(forbidden);
  });
});
