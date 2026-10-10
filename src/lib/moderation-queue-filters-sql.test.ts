// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACTOR,
  createAtomicTestDatabase,
  type TestDatabase,
} from "./community-atomic-save-test-db";

// R5-G: SQL REAL (PGlite) de la migración PROPUESTA 20261030: filtros de la cola aplicados ANTES de
// paginar (motivo, ocultas preventivamente, autor, rango de fechas), combinables, con la paginación
// por cursor intacta (sin OFFSET), validación estricta y ACL sin ampliar.

const migration = (n: string) =>
  readFileSync(`supabase/migrations/${n}`, "utf8").replace(/\r\n/g, "\n");
const uid = (n: number) => `0e000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MOD = uid(1);
const reporters = [11, 12, 13].map(uid);
const AUTHORS: Record<string, string> = {
  alice: uid(21),
  alicia: uid(22),
  bob: uid(23),
  bob_2: uid(24),
  bobx: uid(25),
  pager: uid(26),
};
let db: TestDatabase;
let seq = 0;
interface Obj {
  [key: string]: unknown;
}
interface Page {
  cases: { cycleId: string; caseId: string; reasons: { reason: string }[] }[];
  next: { activityAt: string; cycleId: string } | null;
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
    "20261030120000_moderation_queue_filters.sql",
  ])
    await db.exec(migration(n));
  await db.query("insert into admin_roles values($1,'moderator')", [MOD]);
  for (const id of [MOD, ...reporters])
    await db.query("insert into auth.users values($1) on conflict do nothing", [id]);
  for (const [name, id] of Object.entries(AUTHORS)) {
    await db.query("insert into auth.users values($1) on conflict do nothing", [id]);
    await db.query("insert into profiles(user_id,username) values($1,$2)", [id, name]);
  }
}, 90000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec("begin");
});
afterEach(async () => {
  try {
    await db.exec("reset role");
  } catch {
    /* transacción abortada: el rollback la limpia */
  }
  await db.exec("rollback");
});

/** Caso con un reporte por motivo (3 reportantes ⇒ cuarentena preventiva) y actividad en `at`. */
async function make(author: string, reasons: string[], at: string) {
  const post = uid(1000 + ++seq);
  await db.query(
    "insert into community_posts(id,author_user_id,text,version) values($1,$2,'t',2)",
    [post, AUTHORS[author]],
  );
  let ctx!: Obj;
  for (const [i, reason] of reasons.entries())
    ctx = await one<Obj>("select community_post_report_submit($1,$2,$3,null) r", [
      reporters[i],
      post,
      reason,
    ]);
  const cycleId = ctx.cycleId as string;
  await db.query(
    "update community_post_reports set created_at=$2::timestamptz, updated_at=$2::timestamptz where cycle_id=$1",
    [cycleId, at],
  );
  // Solo en la BD de prueba: se retrocede opened_at saltando el trigger de inmutabilidad.
  await db.exec("set local session_replication_role = replica");
  await db.query(
    "update community_moderation_cycles set opened_at=$2::timestamptz where id=$1",
    [cycleId, at],
  );
  await db.exec("set local session_replication_role = default");
  return { post, cycleId, caseId: ctx.caseId as string, ctx };
}
const read = (args: Obj = {}, scope = "active", before?: Page["next"]) =>
  one<Page>(`select community_moderation_cases_read($1,$2,$3,$4,null,$5,$6,$7,$8,$9) r`, [
    MOD,
    scope,
    before?.activityAt ?? null,
    before?.cycleId ?? null,
    args.reason ?? null,
    args.hiddenOnly ?? false,
    args.author ?? null,
    args.from ?? null,
    args.to ?? null,
  ]);
const ids = (p: Page) => p.cases.map((c) => c.cycleId);

async function seed() {
  const p1 = await make("alice", ["spam", "spam", "spam"], "2026-09-01T10:00:00Z"); // oculta
  const p2 = await make("alice", ["harassment"], "2026-09-10T10:00:00Z");
  const p3 = await make(
    "bob",
    ["harassment", "harassment", "harassment"],
    "2026-09-20T10:00:00Z",
  ); // oculta
  const p4 = await make("alicia", ["spam"], "2026-10-01T10:00:00Z");
  const p5 = await make("bob_2", ["other"], "2026-10-02T10:00:00Z");
  const p6 = await make("bobx", ["other"], "2026-10-03T10:00:00Z");
  return { p1, p2, p3, p4, p5, p6 };
}

describe("filtros de la cola (SQL real)", () => {
  it("sin filtros devuelve todo, igual que la función anterior (compatibilidad)", async () => {
    const s = await seed();
    const all = await read();
    expect(ids(all)).toEqual([s.p6, s.p5, s.p4, s.p3, s.p2, s.p1].map((c) => c.cycleId));
    // Llamada posicional antigua de 5 argumentos: sigue siendo válida (los nuevos son DEFAULT).
    const legacy = await one<Page>(
      "select community_moderation_cases_read($1,'active',null,null,null) r",
      [MOD],
    );
    expect(ids(legacy)).toEqual(ids(all));
  });

  it("motivo: solo los ciclos con al menos un reporte de ese motivo", async () => {
    const s = await seed();
    expect(ids(await read({ reason: "spam" }))).toEqual([s.p4.cycleId, s.p1.cycleId]);
    expect(ids(await read({ reason: "harassment" }))).toEqual([
      s.p3.cycleId,
      s.p2.cycleId,
    ]);
    expect(ids(await read({ reason: "hate_speech" }))).toEqual([]);
  });

  it("solo ocultas preventivamente: únicamente posts en hidden_pending_review", async () => {
    const s = await seed();
    expect(ids(await read({ hiddenOnly: true }))).toEqual([s.p3.cycleId, s.p1.cycleId]);
  });

  it("autor: prefijo exacto sin comodines (el «_» del username no es un comodín)", async () => {
    const s = await seed();
    expect(ids(await read({ author: "alice" }))).toEqual([s.p2.cycleId, s.p1.cycleId]);
    expect(ids(await read({ author: "ali" }))).toEqual(
      [s.p4, s.p2, s.p1].map((c) => c.cycleId),
    );
    // «bob_» debe encontrar bob_2 pero NO bobx (con LIKE «_» coincidiría con «x»).
    expect(ids(await read({ author: "bob_" }))).toEqual([s.p5.cycleId]);
    expect(ids(await read({ author: "zz" }))).toEqual([]);
  });

  it("rango de fechas: desde inclusivo, hasta exclusivo (el límite lo calcula el servidor)", async () => {
    const s = await seed();
    expect(
      ids(await read({ from: "2026-09-10T00:00:00Z", to: "2026-10-02T00:00:00Z" })),
    ).toEqual([s.p4.cycleId, s.p3.cycleId, s.p2.cycleId]);
    expect(ids(await read({ from: "2026-10-02T10:00:00Z" }))).toEqual(
      [s.p6, s.p5].map((c) => c.cycleId),
    );
    expect(ids(await read({ to: "2026-09-10T10:00:00Z" }))).toEqual([s.p1.cycleId]);
  });

  it("combinaciones: motivo + oculta + autor + fechas se aplican a la vez (AND)", async () => {
    const s = await seed();
    expect(ids(await read({ reason: "spam", hiddenOnly: true }))).toEqual([s.p1.cycleId]);
    expect(ids(await read({ reason: "spam", author: "ali" }))).toEqual(
      [s.p4, s.p1].map((c) => c.cycleId),
    );
    expect(
      ids(
        await read({
          reason: "spam",
          author: "ali",
          from: "2026-09-15T00:00:00Z",
          to: "2026-12-01T00:00:00Z",
        }),
      ),
    ).toEqual([s.p4.cycleId]);
    expect(ids(await read({ reason: "other", hiddenOnly: true }))).toEqual([]);
  });

  it("el filtro actúa en el Historial (ciclos cerrados) y no mezcla ámbitos", async () => {
    const s = await seed();
    await db.query(
      "select community_moderation_case_decide($1,$2,$3,$4,$5,'content_actioned','mensaje')",
      [MOD, s.p1.caseId, s.p1.cycleId, s.p1.ctx.caseVersion, s.p1.ctx.postVersion],
    );
    expect(ids(await read({ reason: "spam" }, "closed"))).toEqual([s.p1.cycleId]);
    expect(ids(await read({ author: "bob" }, "closed"))).toEqual([]);
    expect(ids(await read({ reason: "spam" }, "active"))).toEqual([s.p4.cycleId]);
  });

  it("devuelve solo proyecciones de lista (sin reportantes ni texto completo)", async () => {
    await seed();
    const dump = JSON.stringify(await read({ reason: "spam" }));
    for (const r of reporters) expect(dump).not.toContain(r);
    expect(dump).not.toContain('"detail"');
  });
});

describe("paginación por cursor con filtros", () => {
  async function seedPager(n: number) {
    const made: string[] = [];
    for (let i = 0; i < n; i++) {
      const day = String(1 + i).padStart(2, "0");
      made.push((await make("pager", ["spam"], `2026-09-${day}T08:00:00Z`)).cycleId);
    }
    await make("alice", ["spam"], "2026-09-15T08:00:00Z"); // ruido de otro autor
    return made;
  }

  it("recorre todo el conjunto filtrado sin duplicados ni saltos y termina con next=null", async () => {
    const made = await seedPager(25);
    const first = await read({ author: "pager", reason: "spam" });
    expect(first.cases).toHaveLength(20);
    expect(first.next).not.toBeNull();
    const second = await read({ author: "pager", reason: "spam" }, "active", first.next);
    expect(second.cases).toHaveLength(5);
    expect(second.next).toBeNull();
    const seen = [...ids(first), ...ids(second)];
    expect(new Set(seen).size).toBe(25);
    expect(seen).toEqual([...made].reverse()); // más reciente primero, sin saltos
  });

  it("«página anterior»: releer con el cursor previo reproduce exactamente la misma página", async () => {
    await seedPager(25);
    const filters = { author: "pager" };
    const first = await read(filters);
    const second = await read(filters, "active", first.next);
    const again = await read(filters);
    expect(ids(again)).toEqual(ids(first));
    expect(await read(filters, "active", first.next)).toEqual(second);
  });

  it("un cursor usado con OTROS filtros no repite ni salta: se aplica el filtro nuevo", async () => {
    await seedPager(25);
    const first = await read({ author: "pager" });
    const other = await read({ author: "alice" }, "active", first.next);
    // El cursor solo fija la posición (actividad, id); el conjunto sale del filtro vigente.
    for (const c of other.cases)
      expect(first.cases.map((x) => x.cycleId)).not.toContain(c.cycleId);
  });

  it("un cursor tras el final devuelve página vacía sin next (caducado/obsoleto)", async () => {
    await seedPager(3);
    const empty = await read({ author: "pager" }, "active", {
      activityAt: "2000-01-01T00:00:00Z",
      cycleId: uid(999999),
    });
    expect(empty).toEqual({ cases: [], next: null });
  });

  it("sigue sin OFFSET: la función no lo usa", () => {
    const sql = migration("20261030120000_moderation_queue_filters.sql");
    expect(sql.replace(/--.*$/gm, "")).not.toMatch(/\boffset\b/i);
  });
});

describe("validación estricta y permisos", () => {
  const bad: [string, Obj][] = [
    ["motivo desconocido", { reason: "bogus" }],
    ["motivo con inyección", { reason: "spam' or '1'='1" }],
    ["autor con símbolos", { author: "a%" }],
    ["autor de 1 carácter", { author: "a" }],
    ["autor demasiado largo", { author: "a".repeat(21) }],
    ["autor en mayúsculas", { author: "Alice" }],
    ["rango invertido", { from: "2026-10-02T00:00:00Z", to: "2026-10-01T00:00:00Z" }],
    ["rango vacío", { from: "2026-10-02T00:00:00Z", to: "2026-10-02T00:00:00Z" }],
  ];
  it.each(bad)("rechaza %s con invalid_argument", async (_n, args) => {
    await expect(read(args)).rejects.toThrow(/invalid_argument/);
  });
  it("hidden_only nulo se rechaza", async () => {
    await expect(
      one(
        "select community_moderation_cases_read($1,'active',null,null,null,null,null) r",
        [MOD],
      ),
    ).rejects.toThrow(/invalid_argument/);
  });
  it("un actor sin rol de moderación no puede leer, con o sin filtros", async () => {
    await expect(
      one("select community_moderation_cases_read($1,'active',null,null,null,'spam') r", [
        ACTOR,
      ]),
    ).rejects.toThrow(/actor_not_moderator/);
  });
  it("solo existe la firma nueva y solo service_role puede ejecutarla", async () => {
    const sig =
      "public.community_moderation_cases_read(uuid,text,timestamp with time zone,uuid,uuid,text,boolean,text,timestamp with time zone,timestamp with time zone)";
    const rows = (
      await db.query<{ n: number }>(
        "select count(*)::int n from pg_proc where proname='community_moderation_cases_read'",
      )
    ).rows;
    expect(rows[0].n).toBe(1);
    const priv = await db.query<Record<string, boolean>>(
      `select has_function_privilege('anon','${sig}','EXECUTE') anon,
              has_function_privilege('authenticated','${sig}','EXECUTE') authenticated,
              has_function_privilege('service_role','${sig}','EXECUTE') service_role`,
    );
    expect(priv.rows[0]).toEqual({
      anon: false,
      authenticated: false,
      service_role: true,
    });
  });
});
