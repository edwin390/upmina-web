// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- los resultados jsonb de PGlite no tienen tipo estático */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACTOR,
  ASSETS,
  ATTACHMENTS,
  POST,
  createAtomicTestDatabase,
  type TestDatabase,
} from "./community-atomic-save-test-db";

// PHASE-3: PostgreSQL real (PGlite). Cadena: base de guardado atómico + migración de Fase 2 + migración NUEVA de la cola.
const MOD = "55555555-5555-4555-8555-555555555551";
const OTHER = "55555555-5555-4555-8555-555555555552";
const fresh = (n: number) => `00000000-0000-4000-8000-${String(300 + n).padStart(12, "0")}`;
const postId = (n: number) => `77777777-7777-4777-8777-${String(n).padStart(12, "0")}`;

let db: TestDatabase;
beforeEach(async () => {
  db = await createAtomicTestDatabase();
  await db.exec(`
    create function public.community_assert_author_may_write(uuid) returns void language sql as $$ select $$;
    create function public.copyright_post_protected(uuid) returns boolean language sql stable as $$ select false $$;
    create table public.admin_roles(user_id uuid primary key, role text not null);
    alter table public.community_posts add column if not exists purge_after timestamptz;
    alter table public.media_assets add column if not exists failure_code text;
    alter table public.profiles add column if not exists username text, add column if not exists display_name text;
    create table public.moderation_audit_log (
      id uuid primary key default gen_random_uuid(),
      actor_kind text not null default 'human',
      actor_user_id uuid, target_type text not null, target_id uuid not null,
      action text not null, metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      constraint moderation_audit_log_action_check check (action in ('report_status_changed','post_hidden')),
      constraint moderation_audit_log_actor_check check (
        (actor_kind = 'human' and actor_user_id is not null) or (actor_kind = 'system' and actor_user_id is null)),
      constraint moderation_audit_log_system_action_check check (
        (actor_kind = 'system' and target_type = 'community_post' and action in ('post_quarantined','post_purged'))
        or (actor_kind = 'human' and action not in ('post_quarantined','post_purged'))),
      constraint moderation_audit_log_target_type_check check (target_type in (
        'community_post_report','community_post','community_moderation_case','community_user_strike','copyright_claim'))
    );
  `);
  await db.query("insert into auth.users values ($1), ($2);", [MOD, OTHER]);
  await db.query("insert into admin_roles values ($1, 'moderator');", [MOD]);
  await db.query("insert into profiles(user_id, username, display_name) values ($1,'otra','Otra Persona');", [OTHER]);
  await db.query("update profiles set username='autora', display_name='Autora Test' where user_id=$1", [ACTOR]);
  for (const f of ["20261120120000_held_for_review_pending_edits.sql", "20261121120000_content_review_queue.sql"])
    await db.exec(readFileSync(resolve("supabase/migrations", f), "utf8"));
}, 30000);
afterEach(async () => {
  await db?.close();
});

type Res = { ok: true; rows: Record<string, any>[] } | { ok: false; error: string };
async function q(sql: string, params: unknown[] = []): Promise<Res> {
  try {
    return { ok: true, rows: (await db.query(sql, params)).rows as Record<string, any>[] };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
const val = async (sql: string, params: unknown[] = []) => {
  const r = await q(sql, params);
  if (!r.ok) throw new Error(r.error);
  return Object.values(r.rows[0] ?? {})[0] as any;
};
const read = (actor: string, scope: string, opts: { before?: [string, string]; limit?: number; item?: string } = {}) =>
  q("select public.community_content_review_read($1,$2,$3::timestamptz,$4::uuid,$5,$6::uuid) r", [
    actor, scope, opts.before?.[0] ?? null, opts.before?.[1] ?? null, opts.limit ?? 20, opts.item ?? null,
  ]);
const decide = (actor: string, kind: string, id: string, version: number | null, decision: string) =>
  q("select public.community_content_review_decide($1,$2,$3,$4,$5) r", [actor, kind, id, version, decision]);
async function asset(id: string, owner = ACTOR) {
  await db.query("insert into media_assets(id,domain,status,kind,created_by) values ($1,'community','ready','image',$2)", [id, owner]);
}
async function held(n: number, createdAt: string, text = `retenida ${n}`) {
  await asset(fresh(n));
  await db.query("insert into community_posts(id,author_user_id,text,status,version,created_at) values ($1,$2,$3,'held_for_review',1,$4)", [postId(n), ACTOR, text, createdAt]);
  await db.query("insert into community_post_media(post_id,asset_id,position) values ($1,$2,0)", [postId(n), fresh(n)]);
}
const mediaJson = (ids: string[]) => JSON.stringify(ids.map((id, position) => ({ asset_id: id, position })));
async function pendingEdit(text: string, ids: string[]) {
  const r = await q("select public.community_post_pending_edit_submit($1,$2,2,$3,$4::jsonb,'{}'::uuid[]) r", [ACTOR, POST, text, mediaJson(ids)]);
  if (!r.ok) throw new Error(r.error);
  return r.rows[0].r.edit.id as string;
}
const audit = async () => (await db.query("select actor_kind, actor_user_id, target_type, target_id, action, metadata from moderation_audit_log order by created_at, id")).rows as any[];

// Snapshot of every state the decision RPC may mutate, including attachment cleanup and audit.
const decisionState = () => val(`select jsonb_build_object(
  'posts', (select jsonb_agg(to_jsonb(p) order by id) from community_posts p),
  'media', (select jsonb_agg(to_jsonb(m) order by id) from community_post_media m),
  'assets', (select jsonb_agg(to_jsonb(a) order by id) from media_assets a),
  'edits', (select jsonb_agg(to_jsonb(e) order by id) from community_post_pending_edits e),
  'editMedia', (select jsonb_agg(to_jsonb(m) order by id) from community_post_pending_edit_media m),
  'audit', (select jsonb_agg(to_jsonb(a) order by id) from moderation_audit_log a))`);

describe("transiciones entre dos moderadores (secuenciales, NO concurrencia)", () => {
  beforeEach(async () => {
    await db.query("insert into admin_roles(user_id, role) values ($1, 'moderator')", [OTHER]);
  });

  it.each([
    ["approve", "reject", "post_not_held", "content_hold_released"],
    ["reject", "approve", "post_not_found", "content_hold_rejected"],
  ])("retenida: %s y después %s conserva solo la primera decisión", async (first, second, error, action) => {
    await held(1, "2026-10-01T10:00:00Z");
    expect((await decide(MOD, "held_post", postId(1), 1, first)).ok).toBe(true);
    const beforeSecond = await decisionState();
    expect(await decide(OTHER, "held_post", postId(1), first === "approve" ? 2 : 1, second))
      .toMatchObject({ ok: false, error });
    expect(await decisionState()).toEqual(beforeSecond);
    expect(await audit()).toEqual([expect.objectContaining({ actor_user_id: MOD, target_id: postId(1), action })]);
    expect((await db.query("select status, version from community_posts where id=$1", [postId(1)])).rows)
      .toEqual(first === "approve" ? [{ status: "published", version: 2 }] : []);
    expect(await val("select status from media_assets where id=$1", [fresh(1)]))
      .toBe(first === "approve" ? "ready" : "deleting");
    expect((await db.query("select text, version from community_posts where id=$1", [POST])).rows[0])
      .toEqual({ text: "Original", version: 2 });
  });

  it.each([
    ["approve", "reject", "approved", "content_edit_approved"],
    ["reject", "approve", "rejected", "content_edit_rejected"],
  ])("edición: %s y después %s no pisa la versión pública ni duplica auditoría", async (first, second, status, action) => {
    await asset(fresh(60));
    const edit = await pendingEdit("propuesta", [...ASSETS.slice(0, 3), fresh(60)]);
    expect((await decide(MOD, "pending_edit", edit, first === "approve" ? 2 : null, first)).ok).toBe(true);
    const beforeSecond = await decisionState();
    expect(await decide(OTHER, "pending_edit", edit, second === "approve" ? 2 : null, second))
      .toMatchObject({ ok: false, error: "edit_not_pending" });
    expect(await decisionState()).toEqual(beforeSecond);
    expect(await audit()).toEqual([expect.objectContaining({ actor_user_id: MOD, target_id: POST, action })]);
    expect(await val("select status from community_post_pending_edits where id=$1", [edit])).toBe(status);
    expect(await val("select count(*)::int from community_post_pending_edit_media where edit_id=$1", [edit])).toBe(0);
    expect((await db.query("select text, version from community_posts where id=$1", [POST])).rows[0])
      .toEqual(first === "approve" ? { text: "propuesta", version: 3 } : { text: "Original", version: 2 });
    expect(await val("select count(*)::int from community_post_media where post_id=$1", [POST]))
      .toBe(first === "approve" ? 4 : 3);
    expect(await val("select status from media_assets where id=$1", [fresh(60)]))
      .toBe(first === "approve" ? "ready" : "deleting");
  });

  it.each(["approve", "reject"])("una versión obsoleta no consume la retenida; otro moderador puede %s con la vigente", async (decision) => {
    await held(1, "2026-10-01T10:00:00Z");
    await db.query("update community_posts set version=2 where id=$1", [postId(1)]);
    const beforeConflict = await decisionState();
    expect(await decide(MOD, "held_post", postId(1), 1, decision))
      .toMatchObject({ ok: false, error: "version_conflict" });
    expect(await decisionState()).toEqual(beforeConflict);
    expect(await audit()).toHaveLength(0);
    expect((await decide(OTHER, "held_post", postId(1), 2, decision)).ok).toBe(true);
    expect(await audit()).toEqual([expect.objectContaining({ actor_user_id: OTHER,
      action: decision === "approve" ? "content_hold_released" : "content_hold_rejected" })]);
    expect((await db.query("select status, version from community_posts where id=$1", [postId(1)])).rows)
      .toEqual(decision === "approve" ? [{ status: "published", version: 3 }] : []);
  });

  it("dos aprobaciones con versiones distintas rechazan una edición obsoleta; solo su rechazo es válido", async () => {
    await asset(fresh(60));
    const edit = await pendingEdit("propuesta obsoleta", [...ASSETS.slice(0, 3), fresh(60)]);
    await db.query("select public.community_post_save_atomic($1,$2,2,'versión pública vigente',$3::jsonb,'{}'::uuid[])",
      [ACTOR, POST, mediaJson(ASSETS.slice(0, 3))]);
    const beforeConflicts = await decisionState();
    for (const [moderator, version] of [[MOD, 2], [OTHER, 3]] as const) {
      expect(await decide(moderator, "pending_edit", edit, version, "approve"))
        .toMatchObject({ ok: false, error: "version_conflict" });
      expect(await decisionState()).toEqual(beforeConflicts);
    }
    expect(await audit()).toHaveLength(0);
    expect((await decide(OTHER, "pending_edit", edit, null, "reject")).ok).toBe(true);
    expect((await db.query("select text, version from community_posts where id=$1", [POST])).rows[0])
      .toEqual({ text: "versión pública vigente", version: 3 });
    expect(await val("select count(*)::int from community_post_media where post_id=$1", [POST])).toBe(3);
    expect(await val("select status from media_assets where id=$1", [fresh(60)])).toBe("deleting");
    expect(await audit()).toEqual([expect.objectContaining({ actor_user_id: OTHER, action: "content_edit_rejected" })]);
  });
});

// PGlite has one exclusive connection and serializes transactions. Promise.all would not
// reproduce two independent PostgreSQL backends waiting on the same row lock. Separate
// PGlite instances have separate databases, not independent sessions over the same data.
// https://pglite.dev/docs/ (single exclusive connection); no DEV fallback is permitted.
it.skip("NO COMPROBADO: dos moderadores con transacciones PostgreSQL independientes y barrera controlada", () => {});

describe("lectura de la cola", () => {
  it("solo un moderador puede leer; usuarios normales y argumentos inválidos se rechazan", async () => {
    expect(await read(ACTOR, "held")).toMatchObject({ ok: false, error: "actor_not_moderator" });
    expect(await read(OTHER, "edits")).toMatchObject({ ok: false, error: "actor_not_moderator" });
    expect(await read(MOD, "otro")).toMatchObject({ ok: false, error: "invalid_argument" });
    expect(await read(MOD, "held", { limit: 0 })).toMatchObject({ ok: false, error: "invalid_argument" });
    expect(await read(MOD, "held", { limit: 21 })).toMatchObject({ ok: false, error: "invalid_argument" });
    expect(await q("select public.community_content_review_read($1,'held','2026-01-01T00:00:00Z'::timestamptz,null,10,null)", [MOD])).toMatchObject({ ok: false, error: "invalid_argument" });
  });

  it("lista solo retenidas en la pestaña de retenidas y solo pendientes en la de ediciones, con contadores", async () => {
    await held(1, "2026-10-01T10:00:00Z");
    await asset(fresh(50));
    await pendingEdit("texto propuesto", [...ASSETS.slice(0, 3), fresh(50)]);
    const h = (await read(MOD, "held") as any).rows[0].r;
    expect(h.items.map((i: any) => i.kind)).toEqual(["held_post"]);
    expect(h.items[0]).toMatchObject({ text: "retenida 1", version: 1, author: { username: "autora", displayName: "Autora Test" } });
    expect(h.items[0].media).toEqual([{ id: expect.any(String), assetId: fresh(1), position: 0, isNew: false }]);
    expect(h.counts).toEqual({ held: 1, edits: 1 });
    const e = (await read(MOD, "edits") as any).rows[0].r;
    expect(e.items).toHaveLength(1);
    expect(e.items[0]).toMatchObject({ kind: "pending_edit", postId: POST, version: 2, baseVersion: 2, stale: false, postStatus: "published" });
    expect(e.items[0].published.text).toBe("Original");
    expect(e.items[0].proposed.text).toBe("texto propuesto");
    expect(e.items[0].proposed.media.filter((m: any) => m.isNew).map((m: any) => m.assetId)).toEqual([fresh(50)]);
    expect(e.items[0].published.media).toHaveLength(3);
  });

  it("pagina con cursor estable (más recientes primero) y devuelve un elemento por id", async () => {
    await held(1, "2026-10-01T10:00:00Z");
    await held(2, "2026-10-02T10:00:00Z");
    await held(3, "2026-10-03T10:00:00Z");
    const p1 = (await read(MOD, "held", { limit: 2 }) as any).rows[0].r;
    expect(p1.items.map((i: any) => i.id)).toEqual([postId(3), postId(2)]);
    expect(p1.next).toEqual({ createdAt: expect.any(String), id: postId(2) });
    const p2 = (await read(MOD, "held", { limit: 2, before: [p1.next.createdAt, p1.next.id] }) as any).rows[0].r;
    expect(p2.items.map((i: any) => i.id)).toEqual([postId(1)]);
    expect(p2.next).toBeNull();
    const one = (await read(MOD, "held", { item: postId(2) }) as any).rows[0].r;
    expect(one.items.map((i: any) => i.id)).toEqual([postId(2)]);
  });

  it("una edición obsoleta se marca como tal", async () => {
    await pendingEdit("pendiente", ASSETS.slice(0, 3));
    await db.query("update community_posts set version = version + 1 where id=$1", [POST]);
    expect(((await read(MOD, "edits")) as any).rows[0].r.items[0]).toMatchObject({ stale: true, version: 3, baseVersion: 2 });
  });
});

describe("decisiones y auditoría", () => {
  it("un fallo de auditoría revierte cada una de las cuatro decisiones", async () => {
    await held(1, "2026-10-01T10:00:00Z");
    const edit = await pendingEdit("pendiente", ASSETS.slice(0, 3));
    await db.exec("alter table moderation_audit_log add constraint simulated_audit_failure check (action = 'post_hidden')");
    for (const decision of ["approve", "reject"]) {
      expect((await decide(MOD, "held_post", postId(1), 1, decision)).ok).toBe(false);
      expect((await decide(MOD, "pending_edit", edit, decision === "approve" ? 2 : null, decision)).ok).toBe(false);
      expect(await val("select status from community_posts where id=$1", [postId(1)])).toBe("held_for_review");
      expect(await val("select status from media_assets where id=$1", [fresh(1)])).toBe("ready");
      expect(await val("select status from community_post_pending_edits where id=$1", [edit])).toBe("pending");
      expect((await db.query("select text, version from community_posts where id=$1", [POST])).rows[0]).toEqual({ text: "Original", version: 2 });
    }
    expect(await audit()).toHaveLength(0);
  });
  it("aprobar una retenida la publica y audita al moderador sin datos sensibles", async () => {
    await held(1, "2026-10-01T10:00:00Z", "texto privado de la autora");
    expect((await decide(MOD, "held_post", postId(1), 1, "approve")).ok).toBe(true);
    expect(await val("select status from community_posts where id=$1", [postId(1)])).toBe("published");
    const rows = await audit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_kind: "human", actor_user_id: MOD, target_type: "community_post", target_id: postId(1), action: "content_hold_released" });
    expect(rows[0].metadata).toEqual({ kind: "held_post", decision: "approve", from_version: 1, to_version: 2 });
    expect(JSON.stringify(rows[0])).not.toContain("texto privado");
  });

  it("rechazar una retenida la elimina, marca sus archivos y audita; no hay strikes ni sanciones", async () => {
    await held(1, "2026-10-01T10:00:00Z");
    expect((await decide(MOD, "held_post", postId(1), 1, "reject")).ok).toBe(true);
    expect(await val("select count(*)::int from community_posts where id=$1", [postId(1)])).toBe(0);
    expect(await val("select status from media_assets where id=$1", [fresh(1)])).toBe("deleting");
    expect((await audit())[0]).toMatchObject({ action: "content_hold_rejected", target_id: postId(1) });
  });

  it("aprobar una edición aplica la versión propuesta una sola vez y audita con el id de edición", async () => {
    const edit = await pendingEdit("texto aprobado", ASSETS.slice(0, 3));
    expect((await decide(MOD, "pending_edit", edit, 2, "approve")).ok).toBe(true);
    expect((await db.query("select text, version from community_posts where id=$1", [POST])).rows[0]).toEqual({ text: "texto aprobado", version: 3 });
    expect(await decide(MOD, "pending_edit", edit, 3, "approve")).toMatchObject({ ok: false, error: "edit_not_pending" });
    const rows = await audit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "content_edit_approved", target_id: POST });
    expect(rows[0].metadata).toEqual({ kind: "pending_edit", decision: "approve", edit_id: edit, from_version: 2, to_version: 3 });
  });

  it("rechazar una edición conserva la publicación pública intacta y audita", async () => {
    const edit = await pendingEdit("texto rechazado", ASSETS.slice(0, 3));
    expect((await decide(MOD, "pending_edit", edit, null, "reject")).ok).toBe(true);
    expect((await db.query("select text, version from community_posts where id=$1", [POST])).rows[0]).toEqual({ text: "Original", version: 2 });
    expect((await audit())[0]).toMatchObject({ action: "content_edit_rejected", target_id: POST });
  });

  it("los conflictos y errores no dejan auditoría ni cambios", async () => {
    await held(1, "2026-10-01T10:00:00Z");
    const edit = await pendingEdit("pendiente", ASSETS.slice(0, 3));
    expect(await decide(MOD, "held_post", postId(1), 9, "approve")).toMatchObject({ ok: false, error: "version_conflict" });
    expect(await decide(MOD, "pending_edit", edit, 9, "approve")).toMatchObject({ ok: false, error: "version_conflict" });
    await db.query("update community_posts set version = version + 1 where id=$1", [POST]);
    expect(await decide(MOD, "pending_edit", edit, 3, "approve")).toMatchObject({ ok: false, error: "version_conflict" });
    expect(await decide(MOD, "pending_edit", "11111111-1111-4111-8111-999999999999", 1, "reject")).toMatchObject({ ok: false, error: "pending_edit_not_found" });
    expect(await decide(MOD, "held_post", POST, 3, "approve")).toMatchObject({ ok: false, error: "post_not_held" });
    expect(await audit()).toHaveLength(0);
    expect(await val("select status from community_post_pending_edits where id=$1", [edit])).toBe("pending");
  });

  it("permisos y argumentos: solo moderadores; tipo, decisión y versión se validan", async () => {
    await held(1, "2026-10-01T10:00:00Z");
    expect(await decide(ACTOR, "held_post", postId(1), 1, "approve")).toMatchObject({ ok: false, error: "actor_not_moderator" });
    expect(await decide(OTHER, "held_post", postId(1), 1, "reject")).toMatchObject({ ok: false, error: "actor_not_moderator" });
    expect(await decide(MOD, "otro", postId(1), 1, "approve")).toMatchObject({ ok: false, error: "invalid_argument" });
    expect(await decide(MOD, "held_post", postId(1), 1, "borrar")).toMatchObject({ ok: false, error: "invalid_argument" });
    expect(await decide(MOD, "held_post", postId(1), null, "approve")).toMatchObject({ ok: false, error: "invalid_argument" });
    expect(await audit()).toHaveLength(0);
    expect(await val("select status from community_posts where id=$1", [postId(1)])).toBe("held_for_review");
  });

  it("las funciones nuevas solo se ejecutan con service_role", async () => {
    for (const f of ["community_content_review_read(uuid,text,timestamptz,uuid,integer,uuid)", "community_content_review_decide(uuid,text,uuid,integer,text)"]) {
      expect(await val(`select has_function_privilege('service_role', 'public.${f}', 'execute')`)).toBe(true);
      for (const role of ["anon", "authenticated"])
        expect(await val(`select has_function_privilege('${role}', 'public.${f}', 'execute')`)).toBe(false);
    }
  });

  it("compatibilidad con Fases 1 y 2: archivo obligatorio y versión pública intacta con una edición pendiente", async () => {
    const edit = await pendingEdit("pendiente", ASSETS.slice(0, 3));
    expect((await db.query("select text, version, status from community_posts where id=$1", [POST])).rows[0]).toEqual({ text: "Original", version: 2, status: "published" });
    expect(await q("select public.community_post_save_atomic($1,null,null,'solo texto','[]'::jsonb,'{}'::uuid[])", [ACTOR])).toMatchObject({ ok: false, error: "media_required" });
    expect(await val("select count(*)::int from community_post_media where post_id=$1", [POST])).toBe(ATTACHMENTS.length);
    expect(edit).toBeTruthy();
  });
});
