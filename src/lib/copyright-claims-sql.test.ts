// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACTOR,
  createAtomicTestDatabase,
  type TestDatabase,
} from "./community-atomic-save-test-db";

// COPY-1 fase 2A: SQL REAL (PGlite) de la migración PROPUESTA 20261107120000 (reclamaciones de copyright) sobre la cadena vigente,
// y de su rollback. No se aplica en ningún entorno remoto. Una reclamación NO oculta, retira ni toca nada del circuito ordinario.

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const migration = (n: string) => read(`supabase/migrations/${n}`);
const MIG = migration("20261107120000_copyright_claims.sql");
const ROLLBACK = read("supabase/rollbacks/20261107120000_copyright_claims.rollback.sql");
const REVOKE_MIG = migration("20261108120000_copyright_events_immutable_revoke.sql");
const REVOKE_ROLLBACK = read(
  "supabase/rollbacks/20261108120000_copyright_events_immutable_revoke.rollback.sql",
);
const USERNAME_MIGRATION = migration("20261003120000_community_username_foundation.sql");
const REAL_USERNAME_CHECK = USERNAME_MIGRATION.match(
  /add constraint profiles_username_format check \(([\s\S]*?)\n {2}\);/,
)![1];
const uid = (n: number) => `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MOD = uid(1);
const PENDING_USER = uid(2);
const hex = (label: string | number) =>
  createHash("sha256").update(`copyright-test:${label}`).digest("hex");
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
  // Supabase concede EXECUTE por defecto a los roles de API sobre las funciones nuevas de public: se reproduce para que los
  // REVOKE de la migración se ejerciten de verdad (sin esto un REVOKE incompleto pasaría desapercibido).
  await db.exec(
    "alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;",
  );
  await db.exec(MIG);
  await db.exec(REVOKE_MIG);
}, 120000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec("begin");
  await db.query("insert into admin_roles values($1,'moderator')", [MOD]);
  await db.query("insert into auth.users(id,email_confirmed_at) values($1,now())", [MOD]);
  await db.query("insert into auth.users(id,email_confirmed_at) values($1,now())", [
    PENDING_USER,
  ]);
});
afterEach(async () => {
  try {
    await db.exec("reset role");
  } catch {
    /* transacción abortada */
  }
  await db.exec("rollback");
});

/** Un error SQL aborta la transacción del test: se aísla en un savepoint para poder seguir consultando. */
async function fails(run: () => Promise<unknown>, pattern: RegExp) {
  await db.exec("savepoint expected_failure");
  await expect(run()).rejects.toThrow(pattern);
  await db.exec("rollback to savepoint expected_failure");
}
async function newPost(text = "texto original de la publicación") {
  const post = uid(1000 + ++seq);
  await db.query(
    "insert into community_posts(id,author_user_id,text,version) values($1,$2,$3,2)",
    [post, ACTOR, text],
  );
  return post;
}
const input = (over: Obj = {}): Obj => ({
  claimantName: "  Ana Titular ",
  claimantEmail: "  Ana.Titular@Example.COM ",
  organization: "Estudio Ejemplo",
  relationship: "owner",
  workDescription: "Ilustración original publicada en mi portafolio en 2025",
  infringementDescription: "La publicación reutiliza mi ilustración sin mi permiso",
  evidenceUrls: ["https://example.com/portafolio/obra-1"],
  postUrl: "https://upmina.test/community/ejemplo",
  postId: null,
  signature: "Ana Titular",
  statementVersion: "v1",
  statementsAccepted: true,
  ...over,
});
let keyN = 0;
const create = (over: Obj = {}, keys?: { ip?: string; net?: string; email?: string }) =>
  one<Obj>("select copyright_claim_create($1,$2,$3,$4::jsonb) r", [
    keys?.ip ?? hex(`ip${++keyN}`),
    keys?.net ?? hex(`net${keyN}`),
    keys?.email ?? hex(`mail${keyN}`),
    JSON.stringify(input(over)),
  ]);
const claimId = async (reference: string) =>
  (
    await db.query<{ id: string }>("select id from copyright_claims where reference=$1", [
      reference,
    ])
  ).rows[0]!.id;
const review = (
  claim: string,
  action: string,
  version: number,
  note: string | null = null,
  actor = MOD,
) =>
  one<Obj>("select copyright_claim_review($1,$2,$3,$4,$5) r", [
    actor,
    claim,
    action,
    version,
    note,
  ]);
const ordinaryState = async () =>
  (
    await db.query<Obj>(
      `select (select count(*) from community_posts)::int posts,
              (select string_agg(id::text||status||version::text, ',' order by id) from community_posts) post_state,
              (select count(*) from community_post_reports)::int reports,
              (select count(*) from community_moderation_cases)::int cases,
              (select count(*) from community_moderation_decisions)::int decisions,
              (select count(*) from moderation_audit_log where target_type <> 'copyright_claim')::int audit`,
    )
  ).rows[0]!;

describe("creación pública", () => {
  it("guarda el expediente normalizado, con referencia CPY-AAAA-NNNNNN y evento «received»", async () => {
    const result = await create();
    expect(result.status).toBe("received");
    expect(result.reference).toMatch(/^CPY-\d{4}-\d{6}$/);
    const row = (
      await db.query<Obj>("select * from copyright_claims where reference=$1", [
        result.reference,
      ])
    ).rows[0]!;
    expect(row).toMatchObject({
      status: "received",
      version: 1,
      claimant_name: "Ana Titular",
      claimant_email: "ana.titular@example.com",
      relationship: "owner",
      post_found: false,
      post_id: null,
      statements_accepted: true,
    });
    const events = (
      await db.query<Obj>(
        "select kind, actor_kind, actor_user_id, to_status from copyright_claim_events where claim_id=$1",
        [row.id],
      )
    ).rows;
    expect(events).toEqual([
      {
        kind: "received",
        actor_kind: "claimant",
        actor_user_id: null,
        to_status: "received",
      },
    ]);
  });

  it("congela el texto y el número de medios de la publicación reclamada si existe", async () => {
    const post = await newPost("Texto que podría borrarse después");
    const result = await create({ postId: post });
    const row = (
      await db.query<Obj>("select * from copyright_claims where reference=$1", [
        result.reference,
      ])
    ).rows[0]!;
    expect(row).toMatchObject({
      post_found: true,
      post_id: post,
      post_author_user_id: ACTOR,
      post_text_snapshot: "Texto que podría borrarse después",
      post_media_count: 0,
    });
    // Borrar la publicación no destruye el expediente (sin FK).
    await db.query("delete from community_posts where id=$1", [post]);
    const after = (
      await db.query<Obj>(
        "select post_text_snapshot, post_found from copyright_claims where reference=$1",
        [result.reference],
      )
    ).rows[0]!;
    expect(after).toEqual({
      post_text_snapshot: "Texto que podría borrarse después",
      post_found: true,
    });
  });

  it("una publicación inexistente se registra igual (post_found=false) y no revela nada al reclamante", async () => {
    const result = await create({ postId: uid(9999) });
    expect(Object.keys(result).sort()).toEqual(["reference", "status"]);
    const row = (
      await db.query<Obj>(
        "select post_found, post_id, post_text_snapshot from copyright_claims where reference=$1",
        [result.reference],
      )
    ).rows[0]!;
    expect(row).toEqual({ post_found: false, post_id: null, post_text_snapshot: null });
  });

  it("NO toca publicaciones, reportes, casos, decisiones ni el historial ordinario", async () => {
    const post = await newPost();
    const before = await ordinaryState();
    await create({ postId: post });
    expect(await ordinaryState()).toEqual(before);
  });

  it.each<[string, Obj]>([
    ["clave desconocida", { extra: "x" }],
    ["declaraciones sin aceptar", { statementsAccepted: false }],
    ["declaraciones como texto", { statementsAccepted: "true" }],
    ["relación inválida", { relationship: "friend" }],
    ["correo sin dominio", { claimantEmail: "ana@" }],
    ["correo con espacios", { claimantEmail: "a na@example.com" }],
    ["nombre demasiado corto", { claimantName: "A" }],
    ["descripción de la obra corta", { workDescription: "corta" }],
    [
      "descripción con carácter de control",
      { infringementDescription: "texto\u0007malo largo" },
    ],
    ["sin enlaces de prueba", { evidenceUrls: [] }],
    [
      "seis enlaces",
      { evidenceUrls: Array.from({ length: 6 }, (_, i) => `https://e.test/${i}`) },
    ],
    ["enlace javascript:", { evidenceUrls: ["javascript:alert(1)"] }],
    ["enlace ftp", { evidenceUrls: ["ftp://example.com/archivo"] }],
    ["enlace con espacio", { evidenceUrls: ["https://example.com/a b"] }],
    ["enlace que no es texto", { evidenceUrls: [123] }],
    ["postId malformado", { postId: "no-es-uuid" }],
    ["versión de declaraciones inválida", { statementVersion: "V 1" }],
    ["firma vacía", { signature: " " }],
    ["URL de la publicación con salto de línea", { postUrl: "https://x.test/\nfoo" }],
  ])("rechaza %s con invalid_input", async (_label, over) => {
    await fails(() => create(over), /invalid_input/);
  });

  it("rechaza argumentos de clave inválidos (digests mal formados)", async () => {
    await fails(() => create({}, { ip: "1.2.3.4" }), /invalid_argument/);
    await fails(() => create({}, { net: "x".repeat(64) }), /invalid_argument/);
    await fails(() => create({}, { email: "unknown" }), /invalid_argument/);
    await fails(
      () =>
        one("select copyright_claim_create(null,$1,$2,$3::jsonb) r", [
          hex("n"),
          hex("e"),
          "{}",
        ]),
      /invalid_argument/,
    );
  });

  it("admite la IP y la red «unknown» con su propio bucket", async () => {
    expect((await create({}, { ip: "unknown", net: "unknown" })).status).toBe("received");
  });
});

describe("límites del canal público", () => {
  it("4 envíos por IP y hora: el 5.º se limita con retryAfterSeconds y no crea expediente", async () => {
    const ip = hex("fixed-ip");
    for (let i = 0; i < 4; i++)
      expect((await create({}, { ip })).status).toBe("received");
    const before = (await db.query("select 1 from copyright_claims")).rows.length;
    const limited = await create({}, { ip });
    expect(limited.status).toBe("rate_limited");
    expect(limited.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(limited.retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect((await db.query("select 1 from copyright_claims")).rows.length).toBe(before);
    expect((await create({}, { ip: hex("other-ip") })).status).toBe("received");
  });

  it("5 envíos por correo y día, aunque cambien la IP y la red", async () => {
    const email = hex("same-email");
    for (let i = 0; i < 5; i++)
      expect((await create({}, { email })).status).toBe("received");
    expect((await create({}, { email })).status).toBe("rate_limited");
    expect((await create({}, { email: hex("another") })).status).toBe("received");
  });

  it("20 envíos por red y hora aunque cada IP sea distinta", async () => {
    const net = hex("same-net");
    for (let i = 0; i < 20; i++)
      expect((await create({}, { net })).status).toBe("received");
    expect((await create({}, { net })).status).toBe("rate_limited");
  });

  it("un envío inválido NO consume cuota", async () => {
    const ip = hex("invalid-ip");
    for (let i = 0; i < 6; i++)
      await fails(() => create({ relationship: "x" }, { ip }), /invalid_input/);
    for (let i = 0; i < 4; i++)
      expect((await create({}, { ip })).status).toBe("received");
  });

  it("solo guarda digests: ninguna fila contiene correo ni IP en claro", async () => {
    await create({}, { ip: hex("a"), net: hex("b"), email: hex("c") });
    const rows = (
      await db.query<{ key_digest: string }>(
        "select key_digest from copyright_claim_limits",
      )
    ).rows;
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const r of rows) expect(r.key_digest).toMatch(/^([0-9a-f]{64}|unknown)$/);
  });

  it("purga hasta 100 ventanas de más de 3 días en cada llamada", async () => {
    await db.exec(`insert into copyright_claim_limits(scope,key_digest,window_start,hits)
      select 'ip_hour', encode(sha256(convert_to(g::text,'utf8')),'hex'), now() - interval '4 days', 1
        from generate_series(1,130) g;`);
    await create();
    const left = (
      await db.query<{ n: number }>(
        "select count(*)::int n from copyright_claim_limits where window_start < now() - interval '3 days'",
      )
    ).rows[0]!.n;
    expect(left).toBe(30);
  });
});

describe("lectura para moderación", () => {
  it("solo un moderador, developer o admin puede leer; un usuario sin rol no", async () => {
    await create();
    await fails(
      () => one("select copyright_claims_read($1) r", [PENDING_USER]),
      /actor_not_moderator/,
    );
    await fails(
      () => one("select copyright_claims_read($1) r", [uid(777)]),
      /actor_not_moderator/,
    );
    const result = await one<{ items: unknown[] }>("select copyright_claims_read($1) r", [
      MOD,
    ]);
    expect(result.items).toHaveLength(1);
  });

  it("la cola abierta va de más antigua a más reciente y pagina por cursor sin repetir", async () => {
    const created: string[] = [];
    for (let i = 0; i < 27; i++) created.push((await create()).reference as string);
    type Page = {
      items: { reference: string }[];
      next: { createdAt: string; id: string } | null;
    };
    const p1 = await one<Page>("select copyright_claims_read($1,'open') r", [MOD]);
    expect(p1.items).toHaveLength(25);
    expect(p1.next).not.toBeNull();
    const p2 = await one<Page>("select copyright_claims_read($1,'open',$2,$3) r", [
      MOD,
      p1.next!.createdAt,
      p1.next!.id,
    ]);
    expect(p2.items).toHaveLength(2);
    expect(p2.next).toBeNull();
    const all = [...p1.items, ...p2.items].map((i) => i.reference);
    expect(new Set(all).size).toBe(27);
    expect(all).toEqual(created);
  });

  it("separa abiertas y cerradas, y las cerradas van de más reciente a más antigua", async () => {
    const a = await create();
    const b = await create();
    const idA = await claimId(a.reference as string);
    const idB = await claimId(b.reference as string);
    await review(idA, "dismiss", 1, "sin fundamento");
    await review(idB, "withdraw", 1, "retirada por el titular");
    const open = await one<{ items: unknown[] }>(
      "select copyright_claims_read($1,'open') r",
      [MOD],
    );
    const closed = await one<{ items: { reference: string }[] }>(
      "select copyright_claims_read($1,'closed') r",
      [MOD],
    );
    expect(open.items).toHaveLength(0);
    expect(closed.items.map((i) => i.reference)).toEqual([b.reference, a.reference]);
  });

  it("el detalle incluye los datos del expediente, el estado actual de la publicación y los eventos", async () => {
    const post = await newPost();
    const claim = await create({ postId: post });
    const id = await claimId(claim.reference as string);
    await review(id, "start_review", 1);
    const detail = await one<{ item: Obj }>(
      "select copyright_claims_read($1,'open',null,null,$2) r",
      [MOD, id],
    );
    expect(detail.item).toMatchObject({
      reference: claim.reference,
      status: "in_review",
      version: 2,
      claimantEmail: "ana.titular@example.com",
      postFound: true,
      postId: post,
      currentPostStatus: "published",
      evidenceUrls: ["https://example.com/portafolio/obra-1"],
    });
    expect((detail.item.events as Obj[]).map((e) => e.kind)).toEqual([
      "received",
      "review_started",
    ]);
    await fails(
      () =>
        one("select copyright_claims_read($1,'open',null,null,$2) r", [MOD, uid(5555)]),
      /claim_not_found/,
    );
  });

  it("rechaza ámbito o cursor inválidos", async () => {
    await fails(
      () => one("select copyright_claims_read($1,'todo') r", [MOD]),
      /invalid_argument/,
    );
    await fails(
      () => one("select copyright_claims_read($1,'open',now(),null) r", [MOD]),
      /invalid_argument/,
    );
  });
});

describe("revisión humana", () => {
  it("recorre received → in_review → needs_info → in_review → dismissed con versiones y eventos", async () => {
    const claim = await create();
    const id = await claimId(claim.reference as string);
    expect(await review(id, "start_review", 1)).toMatchObject({
      status: "in_review",
      version: 2,
    });
    expect(
      await review(id, "request_info", 2, "Falta la prueba de titularidad"),
    ).toMatchObject({
      status: "needs_info",
      version: 3,
    });
    expect(await review(id, "resume_review", 3)).toMatchObject({
      status: "in_review",
      version: 4,
    });
    expect(await review(id, "add_note", 4, "Contactado por correo")).toMatchObject({
      status: "in_review",
      version: 5,
    });
    expect(await review(id, "dismiss", 5, "Sin fundamento tras revisar")).toMatchObject({
      status: "dismissed",
      version: 6,
    });
    const events = (
      await db.query<Obj>(
        "select kind, from_status, to_status, actor_kind from copyright_claim_events where claim_id=$1 order by created_at,id",
        [id],
      )
    ).rows;
    expect(events.map((e) => [e.kind, e.from_status, e.to_status])).toEqual([
      ["received", null, "received"],
      ["review_started", "received", "in_review"],
      ["info_requested", "in_review", "needs_info"],
      ["review_resumed", "needs_info", "in_review"],
      ["note", "in_review", "in_review"],
      ["dismissed", "in_review", "dismissed"],
    ]);
  });

  it("el reclamante puede retirar su reclamación (withdraw) y queda cerrada", async () => {
    const id = await claimId((await create()).reference as string);
    expect(
      await review(id, "withdraw", 1, "El titular retiró la reclamación"),
    ).toMatchObject({
      status: "withdrawn",
    });
  });

  it("una reclamación cerrada es inmutable", async () => {
    const id = await claimId((await create()).reference as string);
    await review(id, "dismiss", 1, "sin fundamento");
    for (const action of ["start_review", "add_note", "withdraw", "dismiss"])
      await fails(() => review(id, action, 2, "x"), /invalid_transition/);
  });

  it.each([
    ["request_info", 1],
    ["resume_review", 1],
  ])("transición inválida desde received: %s", async (action, version) => {
    const id = await claimId((await create()).reference as string);
    await fails(() => review(id, action, version, "nota"), /invalid_transition/);
  });

  it("exige nota para pedir información, descartar, retirar y anotar", async () => {
    const id = await claimId((await create()).reference as string);
    await review(id, "start_review", 1);
    for (const action of ["request_info", "dismiss", "withdraw", "add_note"]) {
      await fails(() => review(id, action, 2, null), /note_required/);
      await fails(() => review(id, action, 2, "   "), /note_required/);
    }
  });

  it("rechaza versión obsoleta, acción desconocida, nota con control y reclamación inexistente", async () => {
    const id = await claimId((await create()).reference as string);
    await fails(() => review(id, "start_review", 7), /version_conflict/);
    await fails(() => review(id, "approve", 1), /invalid_argument/);
    await fails(() => review(id, "withdraw", 0, "x"), /invalid_argument/);
    await fails(() => review(id, "add_note", 1, "texto\u0007"), /invalid_argument/);
    await fails(() => review(id, "add_note", 1, "x".repeat(1001)), /invalid_argument/);
    await fails(() => review(uid(4040), "start_review", 1), /claim_not_found/);
  });

  it("solo moderadores, developers y admins pueden revisar", async () => {
    const id = await claimId((await create()).reference as string);
    await fails(
      () => review(id, "start_review", 1, null, PENDING_USER),
      /actor_not_moderator/,
    );
    await db.query("insert into admin_roles values($1,'developer')", [uid(31)]);
    await db.query("insert into admin_roles values($1,'admin')", [uid(32)]);
    expect((await review(id, "start_review", 1, null, uid(31))).status).toBe("in_review");
    expect((await review(id, "add_note", 2, "nota", uid(32))).status).toBe("in_review");
  });

  it("registra cada decisión en el historial GENERAL de moderación, sin datos personales ni la nota", async () => {
    const id = await claimId((await create()).reference as string);
    await review(id, "start_review", 1);
    await review(id, "request_info", 2, "Necesitamos la URL original de tu obra");
    await review(id, "dismiss", 3, "Sin fundamento");
    const audit = (
      await db.query<Obj>(
        "select actor_kind, actor_user_id, target_type, target_id, action, metadata from moderation_audit_log where target_type='copyright_claim' order by created_at,id",
      )
    ).rows;
    expect(audit.map((a) => a.action)).toEqual([
      "copyright_claim_review_started",
      "copyright_claim_info_requested",
      "copyright_claim_dismissed",
    ]);
    for (const a of audit) {
      expect(a).toMatchObject({ actor_kind: "human", actor_user_id: MOD, target_id: id });
      const text = JSON.stringify(a.metadata);
      expect(text).not.toMatch(/example\.com|Ana|Necesitamos|Sin fundamento|http/i);
      expect(Object.keys(a.metadata as Obj).sort()).toEqual([
        "claim_version",
        "reference",
        "to_status",
      ]);
    }
  });

  it("NO modifica publicaciones, reportes, casos, decisiones ni el historial de reportes ordinarios", async () => {
    const post = await newPost();
    const id = await claimId((await create({ postId: post })).reference as string);
    const before = await ordinaryState();
    await review(id, "start_review", 1);
    await review(id, "dismiss", 2, "sin fundamento");
    expect(await ordinaryState()).toEqual(before);
  });

  it("serializa por fila: la revisión bloquea la reclamación (FOR UPDATE) y la función no contiene retirada ni purga", () => {
    const body = MIG.match(
      /create function public\.copyright_claim_review[\s\S]*?\n\$\$;/,
    )![0];
    expect(body).toMatch(
      /from public\.copyright_claims where id = p_claim_id for update/,
    );
    expect(body).not.toMatch(
      /community_posts|media_assets|purge|removed_pending_purge|strike/i,
    );
  });
});

describe("historial append-only y restricciones de auditoría", () => {
  it("los eventos no se pueden modificar ni borrar", async () => {
    const id = await claimId((await create()).reference as string);
    await fails(
      () =>
        db.query("update copyright_claim_events set note='x' where claim_id=$1", [id]),
      /copyright_claim_events_immutable/,
    );
    await fails(
      () => db.query("delete from copyright_claim_events where claim_id=$1", [id]),
      /copyright_claim_events_immutable/,
    );
    await fails(
      () => db.exec("truncate copyright_claim_events"),
      /copyright_claim_events_immutable|truncate/i,
    );
  });

  it("el historial general mantiene sus reglas: el sistema no puede escribir acciones de copyright y siguen cerradas las acciones desconocidas", async () => {
    await fails(
      () =>
        db.query(
          "insert into moderation_audit_log(actor_kind,actor_user_id,target_type,target_id,action) values('system',null,'copyright_claim',$1,'copyright_claim_dismissed')",
          [uid(1)],
        ),
      /moderation_audit_log_system_action_check|violates check/,
    );
    await fails(
      () =>
        db.query(
          "insert into moderation_audit_log(actor_kind,actor_user_id,target_type,target_id,action) values('human',$1,'copyright_claim',$2,'copyright_claim_removed')",
          [MOD, uid(1)],
        ),
      /moderation_audit_log_action_check|violates check/,
    );
    await fails(
      () =>
        db.query(
          "insert into moderation_audit_log(actor_kind,actor_user_id,target_type,target_id,action) values('human',$1,'other_thing',$2,'copyright_claim_dismissed')",
          [MOD, uid(1)],
        ),
      /moderation_audit_log_target_type_check|violates check/,
    );
  });
});

describe("permisos y exposición", () => {
  const FUNCS = [
    "public.copyright_claim_create(text,text,text,jsonb)",
    "public.copyright_claims_read(uuid,text,timestamptz,uuid,uuid)",
    "public.copyright_claim_review(uuid,uuid,text,integer,text)",
  ];
  const PRIVATE_FUNCS = [
    "public.copyright_claim_hit_(text,text,interval,integer,timestamptz)",
    "public.copyright_text_ok(text,integer,integer)",
    "public.copyright_urls_ok(text[])",
    "public.copyright_claim_events_immutable()",
  ];
  it("solo service_role ejecuta las tres RPC; anon, authenticated y public no", async () => {
    for (const sig of FUNCS) {
      const rows = (
        await db.query<{ r: string; ok: boolean }>(
          `select r, has_function_privilege(r, '${sig}', 'execute') ok from unnest(array['anon','authenticated','service_role']) r`,
        )
      ).rows;
      expect(Object.fromEntries(rows.map((x) => [x.r, x.ok]))).toEqual({
        anon: false,
        authenticated: false,
        service_role: true,
      });
      expect(
        (
          await db.query<{ ok: boolean }>(
            `select has_function_privilege('public','${sig}','execute') ok`,
          )
        ).rows[0]!.ok,
      ).toBe(false);
    }
  });

  it("el ayudante y las funciones de validación no son ejecutables por ningún rol de API", async () => {
    for (const sig of PRIVATE_FUNCS) {
      const rows = (
        await db.query<{ r: string; ok: boolean }>(
          `select r, has_function_privilege(r, '${sig}', 'execute') ok from unnest(array['anon','authenticated','service_role']) r`,
        )
      ).rows;
      expect(rows.every((x) => !x.ok)).toBe(true);
    }
  });

  it("la migración incremental revoca el EXECUTE de la función del disparador y el detector lo habría visto antes", async () => {
    const anyExecute = async () =>
      (
        await db.query<{ n: number }>(
          `select count(*)::int n from unnest(array['public','anon','authenticated','service_role']) r
            where has_function_privilege(r, 'public.copyright_claim_events_immutable()', 'execute')`,
        )
      ).rows[0]!.n;
    expect(await anyExecute()).toBe(0);
    // Estado previo a la corrección (se reproduce dentro de la transacción del test): el detector lo marca.
    await db.exec(
      "grant execute on function public.copyright_claim_events_immutable() to public",
    );
    expect(await anyExecute()).toBeGreaterThan(0);
    await db.exec(REVOKE_MIG);
    expect(await anyExecute()).toBe(0);
    // El REVOKE no toca el cuerpo ni los disparadores.
    expect(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from pg_trigger where tgrelid='public.copyright_claim_events'::regclass and tgname like 'copyright_claim_events_no_%'",
        )
      ).rows[0]!.n,
    ).toBe(2);
  });

  it("tras el REVOKE el disparador sigue funcionando: el historial se escribe y sigue siendo inmutable, también para service_role", async () => {
    const id = await claimId((await create()).reference as string);
    await review(id, "start_review", 1);
    const events = (
      await db.query<{ n: number }>(
        "select count(*)::int n from copyright_claim_events where claim_id=$1",
        [id],
      )
    ).rows[0]!.n;
    expect(events).toBe(2);
    await fails(
      () =>
        db.query("update copyright_claim_events set note='x' where claim_id=$1", [id]),
      /copyright_claim_events_immutable/,
    );
  });

  it("el rollback de la corrección solo restaura el permiso por defecto", async () => {
    await db.exec(REVOKE_ROLLBACK);
    expect(
      (
        await db.query<{ ok: boolean }>(
          "select has_function_privilege('anon','public.copyright_claim_events_immutable()','execute') ok",
        )
      ).rows[0]!.ok,
    ).toBe(true);
  });

  it("las funciones son SECURITY DEFINER con search_path fijo y propietario postgres", async () => {
    const rows = (
      await db.query<Obj>(
        `select p.proname, p.prosecdef, pg_get_userbyid(p.proowner) owner, p.proconfig::text cfg
           from pg_proc p where p.proname in ('copyright_claim_create','copyright_claims_read','copyright_claim_review','copyright_claim_hit_')`,
      )
    ).rows;
    expect(rows).toHaveLength(4);
    for (const r of rows)
      expect(r).toMatchObject({
        prosecdef: true,
        owner: "postgres",
        cfg: expect.stringContaining("search_path=pg_catalog, public"),
      });
  });

  it("las tablas y la secuencia son privadas: RLS forzada, sin policies y sin permisos para los roles de API", async () => {
    for (const table of [
      "copyright_claims",
      "copyright_claim_events",
      "copyright_claim_limits",
    ]) {
      const flags = (
        await db.query<Obj>(
          `select c.relrowsecurity rls, c.relforcerowsecurity force_rls,
                  (select count(*)::int from pg_policies p where p.tablename = c.relname) policies
             from pg_class c where c.oid = 'public.${table}'::regclass`,
        )
      ).rows[0]!;
      expect(flags).toEqual({ rls: true, force_rls: true, policies: 0 });
      for (const role of ["anon", "authenticated", "service_role"]) {
        const ok = (
          await db.query<{ ok: boolean }>(
            `select has_table_privilege('${role}','public.${table}','select,insert,update,delete,truncate') ok`,
          )
        ).rows[0]!.ok;
        expect(ok).toBe(false);
      }
    }
    for (const role of ["anon", "authenticated", "service_role"])
      expect(
        (
          await db.query<{ ok: boolean }>(
            `select has_sequence_privilege('${role}','public.copyright_claim_ref_seq','usage,select,update') ok`,
          )
        ).rows[0]!.ok,
      ).toBe(false);
  });

  it("service_role puede llamar a la RPC pero no leer ni escribir las tablas directamente", async () => {
    await db.exec("set role service_role");
    const result = await one<Obj>("select copyright_claim_create($1,$2,$3,$4::jsonb) r", [
      hex("role-ip"),
      hex("role-net"),
      hex("role-mail"),
      JSON.stringify(input()),
    ]);
    expect(result.status).toBe("received");
    await fails(() => db.query("select * from copyright_claims"), /permission denied/);
    await fails(
      () => db.query("select * from copyright_claim_limits"),
      /permission denied/,
    );
    await fails(
      () => db.query("update copyright_claims set status='in_review'"),
      /permission denied/,
    );
    await fails(
      () =>
        db.query("select copyright_claim_hit_('ip_hour',$1,interval '1 hour',1,now())", [
          hex("z"),
        ]),
      /permission denied/,
    );
    await db.exec("reset role");
  });

  it("anon y authenticated no pueden llamar a ninguna RPC", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await fails(
        () =>
          db.query("select copyright_claim_create($1,$2,$3,$4::jsonb)", [
            hex("a"),
            hex("b"),
            hex("c"),
            JSON.stringify(input()),
          ]),
        /permission denied/,
      );
      await db.exec("reset role");
    }
  });
});

describe("rollback", () => {
  it("elimina todo lo creado y restaura el historial general a sus definiciones previas", async () => {
    await db.exec(ROLLBACK);
    const left = (
      await db.query<{ n: number }>(
        `select count(*)::int n from pg_proc where proname like 'copyright\\_%'`,
      )
    ).rows[0]!.n;
    expect(left).toBe(0);
    const tables = (
      await db.query<{ n: number }>(
        "select count(*)::int n from pg_class where relname like 'copyright\\_%'",
      )
    ).rows[0]!.n;
    expect(tables).toBe(0);
    await fails(
      () =>
        db.query(
          "insert into moderation_audit_log(actor_kind,actor_user_id,target_type,target_id,action) values('human',$1,'copyright_claim',$2,'copyright_claim_dismissed')",
          [MOD, uid(1)],
        ),
      /violates check|moderation_audit_log_/,
    );
  });

  it("se niega si ya hay reclamaciones o filas de auditoría de copyright", async () => {
    const id = await claimId((await create()).reference as string);
    await fails(() => db.exec(ROLLBACK), /rollback_blocked_claims_exist/);
    await review(id, "start_review", 1);
    await fails(
      () => db.exec(ROLLBACK),
      /rollback_blocked_copyright_audit_rows|rollback_blocked_claims_exist/,
    );
  });
});
