// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACTOR,
  createAtomicTestDatabase,
  type TestDatabase,
} from "./community-atomic-save-test-db";

// REP-1: SQL REAL (PGlite) de la migración PROPUESTA 20261102120000 (motivos ordinarios violence,
// off_topic, ai_generated) sobre la cadena vigente CON el wrapper de AUTH-2, y de su rollback. No se
// aplica en ningún entorno remoto. Copyright NO es un motivo ordinario.

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const migration = (n: string) => read(`supabase/migrations/${n}`);
const MIG = migration("20261102120000_community_report_reasons.sql");
const ROLLBACK = read(
  "supabase/rollbacks/20261102120000_community_report_reasons.rollback.sql",
);
const USERNAME_MIGRATION = migration("20261003120000_community_username_foundation.sql");
const REAL_USERNAME_CHECK = USERNAME_MIGRATION.match(
  /add constraint profiles_username_format check \(([\s\S]*?)\n {2}\);/,
)![1];
const uid = (n: number) => `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MOD = uid(1);
const UNVERIFIED = uid(2);
const REPORTERS = [11, 12, 13, 14].map(uid);
const NEW_REASONS = ["violence", "off_topic", "ai_generated"] as const;
const OLD_REASONS = [
  "spam",
  "harassment",
  "hate_speech",
  "sexual_content",
  "other",
] as const;
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
    "20261029120000_moderation_audit_strike_events.sql",
    "20261030120000_moderation_queue_filters.sql",
    "20261031120000_moderation_pending_count.sql",
  ])
    await db.exec(migration(n));
  await db.exec(
    "update profiles set username = 'actor_user' where username is null; alter table profiles alter column username set not null;",
  );
  await db.exec(
    `alter table profiles add constraint profiles_username_format check (${REAL_USERNAME_CHECK});`,
  );
  await db.exec(MIG);
}, 120000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec("begin");
  await db.query("insert into admin_roles values($1,'moderator')", [MOD]);
  await db.query("insert into auth.users(id,email_confirmed_at) values($1,now())", [MOD]);
  await db.query("insert into auth.users(id,email_confirmed_at) values($1,null)", [
    UNVERIFIED,
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

async function newPost() {
  const post = uid(1000 + ++seq);
  await db.query(
    "insert into community_posts(id,author_user_id,text,version) values($1,$2,'t',2)",
    [post, ACTOR],
  );
  return post;
}
const report = (reporter: string, post: string, reason: string) =>
  one<Obj>("select community_post_report_submit($1,$2,$3,null) r", [
    reporter,
    post,
    reason,
  ]);
/** Un error SQL aborta la transacción del test: se aísla en un savepoint para poder seguir consultando. */
async function fails(run: () => Promise<unknown>, pattern: RegExp) {
  await db.exec("savepoint expected_failure");
  await expect(run()).rejects.toThrow(pattern);
  await db.exec("rollback to savepoint expected_failure");
}
const counts = async () =>
  (
    await db.query<{ r: number; p: number }>(
      "select (select count(*) from community_post_reports)::int r, (select count(*) from profiles)::int p",
    )
  ).rows[0];

describe("motivos ordinarios nuevos (SQL real, cadena con AUTH-2)", () => {
  it.each([...NEW_REASONS, ...OLD_REASONS])(
    "acepta %s por el wrapper público",
    async (reason) => {
      const post = await newPost();
      const result = await report(REPORTERS[0]!, post, reason);
      expect(result.alreadyReported).toBe(false);
      const stored = await db.query<{ reason: string }>(
        "select reason from community_post_reports where post_id = $1",
        [post],
      );
      expect(stored.rows[0]!.reason).toBe(reason);
    },
  );

  it.each(["copyright", "Violence", "", "AI", "off-topic", "other "])(
    "rechaza %j: copyright y cualquier otro valor no es un motivo ordinario",
    async (reason) => {
      const post = await newPost();
      await fails(() => report(REPORTERS[0]!, post, reason), /invalid_reason/);
      expect(
        (
          await db.query("select 1 from community_post_reports where post_id = $1", [
            post,
          ])
        ).rows,
      ).toHaveLength(0);
    },
  );

  it("el CHECK impide insertar directamente un motivo no permitido (incluida 'copyright')", async () => {
    const post = await newPost();
    const first = await report(REPORTERS[0]!, post, "spam");
    await expect(
      db.query("update community_post_reports set reason = 'copyright' where id = $1", [
        first.reportId,
      ]),
    ).rejects.toThrow(/community_post_reports_reason_check/);
  });

  it("AUTH-2 se mantiene: una cuenta sin verificar no puede reportar con un motivo nuevo", async () => {
    const post = await newPost();
    await fails(() => report(UNVERIFIED, post, "violence"), /account_/);
    expect((await counts()).r).toBe(0);
  });

  it("umbral de ocultamiento SIN cambios: 3 reporteros distintos (cualquier mezcla de motivos); los duplicados no cuentan", async () => {
    const post = await newPost();
    const a = await report(REPORTERS[0]!, post, "violence");
    expect(a.distinctReporterCount).toBe(1);
    const dup = await report(REPORTERS[0]!, post, "ai_generated");
    expect(dup.alreadyReported).toBe(true);
    expect(dup.distinctReporterCount).toBe(1);
    const b = await report(REPORTERS[1]!, post, "off_topic");
    expect(b.postStatus).toBe("published");
    const c = await report(REPORTERS[2]!, post, "spam");
    expect(c.distinctReporterCount).toBe(3);
    expect(c.postStatus).toBe("hidden_pending_review");
    expect(c.visibilityChanged).toBe(true);
  });

  it("el autor no puede reportar su propia publicación con un motivo nuevo", async () => {
    const post = await newPost();
    await expect(report(ACTOR, post, "ai_generated")).rejects.toThrow(/self_report/);
  });

  it("la cola filtra por los motivos nuevos y rechaza otros", async () => {
    const post = await newPost();
    await report(REPORTERS[0]!, post, "violence");
    const other = await newPost();
    await report(REPORTERS[0]!, other, "spam");
    const page = await one<{
      cases: { cycleId: string; reasons: { reason: string }[] }[];
    }>(
      "select community_moderation_cases_read($1,'active',null,null,null,'violence',false,null,null,null) r",
      [MOD],
    );
    expect(page.cases).toHaveLength(1);
    expect(page.cases[0]!.reasons.map((r) => r.reason)).toEqual(["violence"]);
    for (const reason of NEW_REASONS)
      await expect(
        one(
          "select community_moderation_cases_read($1,'active',null,null,null,$2,false,null,null,null) r",
          [MOD, reason],
        ),
      ).resolves.toBeTruthy();
    await expect(
      one(
        "select community_moderation_cases_read($1,'active',null,null,null,'copyright',false,null,null,null) r",
        [MOD],
      ),
    ).rejects.toThrow(/invalid_argument/);
  });

  it("ACL sin ampliar: el core no es ejecutable por nadie; wrapper y lectura solo por service_role", async () => {
    const acl = async (sig: string) =>
      (
        await db.query<{ role: string; ok: boolean }>(
          `select r as role, has_function_privilege(r, '${sig}', 'execute') ok
             from unnest(array['anon','authenticated','service_role']) r`,
        )
      ).rows;
    const core = await acl(
      "public.community_post_report_submit_core(uuid,uuid,text,text)",
    );
    expect(core.every((r) => !r.ok)).toBe(true);
    for (const sig of [
      "public.community_post_report_submit(uuid,uuid,text,text)",
      "public.community_moderation_cases_read(uuid,text,timestamptz,uuid,uuid,text,boolean,text,timestamptz,timestamptz)",
    ]) {
      const rows = await acl(sig);
      expect(rows.filter((r) => r.ok).map((r) => r.role)).toEqual(["service_role"]);
    }
  });

  it("no toca perfiles ni reportes existentes (sin backfill)", async () => {
    const before = await counts();
    await db.exec(MIG); // idempotente: create or replace + constraint recreado
    expect(await counts()).toEqual(before);
  });
});

describe("la migración solo cambia la lista de motivos (comparación estática con las definiciones vigentes)", () => {
  const OLD_SPACED = "('spam', 'harassment', 'hate_speech', 'sexual_content', 'other')";
  const NEW_SPACED =
    "('spam', 'harassment', 'hate_speech', 'sexual_content', 'violence', 'off_topic', 'ai_generated', 'other')";
  const OLD_TIGHT = "('spam','harassment','hate_speech','sexual_content','other')";
  const NEW_TIGHT =
    "('spam','harassment','hate_speech','sexual_content','violence','off_topic','ai_generated','other')";
  const grab = (src: string, start: RegExp) => src.match(start)![0];

  it("core == definición de 20261012 (renombrada) con la lista ampliada", () => {
    const race = migration(
      "20261012120000_community_report_submission_account_race_fix.sql",
    );
    const original = grab(
      race,
      /create or replace function public\.community_post_report_submit\(.*?\n\$\$;\n/s,
    ).replace("community_post_report_submit(", "community_post_report_submit_core(");
    const expected = original.replace(OLD_SPACED, NEW_SPACED);
    expect(MIG).toContain(expected);
    expect(expected).not.toBe(original);
  });

  it("lectura de la cola == definición de 20261030 con el filtro ampliado", () => {
    const filters = migration("20261030120000_moderation_queue_filters.sql");
    const original = grab(
      filters,
      /create function public\.community_moderation_cases_read\(.*?\n\$\$;\n/s,
    ).replace("create function", "create or replace function");
    expect(MIG).toContain(original.replace(OLD_TIGHT, NEW_TIGHT));
  });

  it("no toca R7, media, cron, strikes, roles, perfiles ni usuarios", () => {
    const code = MIG.split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(code).not.toMatch(
      /media_|abandon|cron\.|strike|r7|truncate|(insert into|update|delete from)\s+(public\.)?(admin_roles|profiles)|(insert into|update|delete from)\s+auth\./i,
    );
    expect(code.match(/create or replace function public\.(\w+)/g)).toEqual([
      "create or replace function public.community_post_report_submit_core",
      "create or replace function public.community_moderation_cases_read",
    ]);
  });

  it("el rollback no está en supabase/migrations", async () => {
    const { readdirSync } = await import("node:fs");
    expect(readdirSync("supabase/migrations").some((f) => f.includes("rollback"))).toBe(
      false,
    );
  });
});

describe("rollback (solo local)", () => {
  it("sin reportes de motivos nuevos: restaura CHECK y funciones; los motivos nuevos vuelven a rechazarse", async () => {
    const post = await newPost();
    await report(REPORTERS[0]!, post, "spam");
    const before = await counts();
    await db.exec(ROLLBACK);
    expect(await counts()).toEqual(before);
    for (const reason of NEW_REASONS) {
      const p = await newPost();
      await fails(() => report(REPORTERS[1]!, p, reason), /invalid_reason/);
    }
    const p2 = await newPost();
    expect((await report(REPORTERS[1]!, p2, "harassment")).alreadyReported).toBe(false);
    await fails(
      () =>
        one(
          "select community_moderation_cases_read($1,'active',null,null,null,'violence',false,null,null,null) r",
          [MOD],
        ),
      /invalid_argument/,
    );
    // ACL intacta tras el rollback
    const grants = await db.query<{ ok: boolean }>(
      "select has_function_privilege('service_role','public.community_post_report_submit(uuid,uuid,text,text)','execute') ok",
    );
    expect(grants.rows[0]!.ok).toBe(true);
  });

  it("con reportes de motivos nuevos existentes se niega y no cambia nada", async () => {
    const post = await newPost();
    await report(REPORTERS[0]!, post, "ai_generated");
    await expect(db.exec(ROLLBACK)).rejects.toThrow(
      /rollback_blocked_new_reasons_in_use/,
    );
  });

  it("el script no escribe datos ni toca R7/media/cron/auth/roles/perfiles", () => {
    const code = ROLLBACK.split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(code).not.toMatch(
      /media_|abandon|cron\.|strike|r7|truncate|(insert into|update|delete from)\s+(public\.)?(admin_roles|profiles)|(insert into|update|delete from)\s+auth\./i,
    );
  });
});
