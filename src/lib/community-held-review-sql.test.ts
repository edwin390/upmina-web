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

// PHASE-2: PostgreSQL real (PGlite). Base: la de pruebas del guardado atómico + la migración NUEVA. Se sustituyen por
// stubs lo que otras migraciones aportan y aquí no se ejercita (guardia de restricciones/cuenta, copyright, admin_roles).
const MOD = "55555555-5555-4555-8555-555555555551";
const OTHER = "55555555-5555-4555-8555-555555555552";
const HISTORIC = "66666666-6666-4666-8666-666666666666";
const fresh = (n: number) => `00000000-0000-4000-8000-${String(200 + n).padStart(12, "0")}`;

let db: TestDatabase;
beforeEach(async () => {
  db = await createAtomicTestDatabase();
  await db.exec(`
    create function public.community_assert_author_may_write(uuid) returns void language sql as $$ select $$;
    create function public.copyright_post_protected(uuid) returns boolean language sql stable
      as $$ select coalesce(current_setting('test.copyright', true), 'off') = 'on' $$;
    create table public.admin_roles(user_id uuid primary key, role text not null);
    alter table public.community_posts add column if not exists purge_after timestamptz;
    alter table public.media_assets add column if not exists failure_code text;
  `);
  await db.query("insert into auth.users values ($1), ($2);", [MOD, OTHER]);
  await db.query("insert into admin_roles values ($1, 'moderator');", [MOD]);
  await db.query("insert into profiles values ($1);", [OTHER]);
  await db.exec(
    readFileSync(resolve("supabase/migrations/20261120120000_held_for_review_pending_edits.sql"), "utf8"),
  );
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
async function asset(id: string, kind = "image", owner = ACTOR, status = "ready") {
  await db.query("insert into media_assets(id,domain,status,kind,created_by) values ($1,'community',$2,$3,$4)", [
    id,
    status,
    kind,
    owner,
  ]);
}
const mediaJson = (ids: string[]) => JSON.stringify(ids.map((id, position) => ({ asset_id: id, position })));
const submit = (post: string, version: number, text: string | null, ids: string[], removed: string[] = [], actor = ACTOR) =>
  q("select public.community_post_pending_edit_submit($1,$2,$3,$4,$5::jsonb,$6::uuid[]) r", [
    actor, post, version, text, mediaJson(ids), removed,
  ]);
const approve = (edit: string, version: number, actor = MOD) =>
  q("select public.community_post_pending_edit_approve($1,$2,$3) r", [actor, edit, version]);
const reject = (edit: string, actor = MOD) => q("select public.community_post_pending_edit_reject($1,$2) r", [actor, edit]);
const postState = async (id = POST) =>
  (await db.query("select text, version, status from community_posts where id=$1", [id])).rows[0] as Record<string, any>;
const attached = async (id = POST) =>
  (await db.query("select asset_id from community_post_media where post_id=$1 order by position", [id])).rows.map(
    (r: any) => r.asset_id,
  );
const assetStatus = (id: string) => val("select status from media_assets where id=$1", [id]);
const delivery = (id: string) => val("select public.community_media_delivery_state($1)->>'delivery'", [id]);
const pendingEditId = () => val("select id from community_post_pending_edits where post_id=$1 and status='pending'", [POST]);

describe("held_for_review", () => {
  it("el estado es válido y no cambia las restricciones de los demás", async () => {
    await db.query("update community_posts set status='held_for_review' where id=$1", [POST]);
    expect((await postState()).status).toBe("held_for_review");
    expect((await q("update community_posts set status='otro' where id=$1", [POST])).ok).toBe(false);
  });

  it("create_held reutiliza las reglas de archivo obligatorio y nace retenida, nunca visible como publicada", async () => {
    expect(await q("select public.community_post_create_held($1,'solo texto','[]'::jsonb)", [ACTOR])).toMatchObject({
      ok: false,
      error: "media_required",
    });
    expect(await q("select public.community_post_create_held($1,null,'[]'::jsonb)", [ACTOR])).toMatchObject({
      ok: false,
      error: "media_required",
    });
    await asset(fresh(1));
    const r = await q("select public.community_post_create_held($1,'hola',$2::jsonb) r", [ACTOR, mediaJson([fresh(1)])]);
    expect(r.ok).toBe(true);
    const id = (r as any).rows[0].r.post.id;
    expect((await postState(id)).status).toBe("held_for_review");
    expect(await val("select count(*)::int from community_posts where status='published' and id=$1", [id])).toBe(0);
    expect(await attached(id)).toEqual([fresh(1)]);
  });

  it("una retenida no se puede editar ni retirarle archivos; las demás guardias siguen igual", async () => {
    await db.query("update community_posts set status='held_for_review' where id=$1", [POST]);
    expect(await q("select public.community_post_save_atomic($1,$2,2,'x',$3::jsonb,'{}'::uuid[])", [ACTOR, POST, mediaJson(ASSETS.slice(0, 3))])).toMatchObject({ ok: false, error: "post_not_editable" });
    expect(await q("select public.community_post_detach_media($1,$2,2,$3)", [ACTOR, POST, ATTACHMENTS[0]])).toMatchObject({ ok: false, error: "post_not_editable" });
    expect(await q("select public.community_post_reorder_media($1,$2,2,$3::jsonb)", [ACTOR, POST, JSON.stringify([])])).toMatchObject({ ok: false, error: "post_not_editable" });
  });

  it("liberar: solo un moderador, con la versión correcta, y solo desde held_for_review", async () => {
    await db.query("update community_posts set status='held_for_review' where id=$1", [POST]);
    expect(await q("select public.community_post_hold_release($1,$2,2)", [ACTOR, POST])).toMatchObject({ ok: false, error: "actor_not_moderator" });
    expect(await q("select public.community_post_hold_release($1,$2,9)", [MOD, POST])).toMatchObject({ ok: false, error: "version_conflict" });
    expect((await q("select public.community_post_hold_release($1,$2,2)", [MOD, POST])).ok).toBe(true);
    expect(await postState()).toMatchObject({ status: "published", version: 3 });
    expect(await q("select public.community_post_hold_release($1,$2,3)", [MOD, POST])).toMatchObject({ ok: false, error: "post_not_held" });
  });

  it("rechazar elimina la publicación y marca sus archivos para el GC, sin tocar a otra persona", async () => {
    await db.query("update community_posts set status='held_for_review' where id=$1", [POST]);
    expect(await q("select public.community_post_hold_reject($1,$2,2)", [ACTOR, POST])).toMatchObject({ ok: false, error: "actor_not_moderator" });
    expect((await q("select public.community_post_hold_reject($1,$2,2)", [MOD, POST])).ok).toBe(true);
    expect(await val("select count(*)::int from community_posts where id=$1", [POST])).toBe(0);
    for (const a of ASSETS.slice(0, 3)) expect(await assetStatus(a)).toBe("deleting");
    expect(await assetStatus(ASSETS[3])).toBe("ready");
  });

  it("la autora ve solo SUS retenidas y ediciones pendientes", async () => {
    await db.query("update community_posts set status='held_for_review' where id=$1", [POST]);
    const mine = await val("select public.community_author_pending_read($1)", [ACTOR]);
    expect(mine.held).toHaveLength(1);
    expect(mine.held[0].media).toHaveLength(3);
    expect(await val("select public.community_author_pending_read($1)", [OTHER])).toEqual({ held: [], edits: [] });
  });
});

describe("entrega de medios", () => {
  it("publicada → public; retenida → private; sin adjuntar → private; eliminándose → denied", async () => {
    expect(await delivery(ASSETS[0])).toBe("public");
    await db.query("update community_posts set status='held_for_review' where id=$1", [POST]);
    expect(await delivery(ASSETS[0])).toBe("private");
    expect(await delivery(ASSETS[3])).toBe("private");
    await db.query("update media_assets set status='deleting' where id=$1", [ASSETS[0]]);
    expect(await delivery(ASSETS[0])).toBe("denied");
  });

  it("los archivos nuevos de una edición pendiente no son públicos y el barrido de abandonados los respeta", async () => {
    await asset(fresh(1));
    await asset(fresh(2)); // huérfano real
    expect((await submit(POST, 2, "pendiente", [...ASSETS.slice(0, 3), fresh(1)])).ok).toBe(true);
    expect(await delivery(fresh(1))).toBe("private");
    await db.query("update media_assets set updated_at = now() - interval '7 hours' where id in ($1,$2)", [fresh(1), fresh(2)]);
    await db.query("select public.media_abandoned_sweep(interval '6 hours', interval '2 hours', interval '6 hours', 100, false)");
    expect(await assetStatus(fresh(1))).toBe("ready");
    expect(await assetStatus(fresh(2))).toBe("deleting");
  });

  it("el descarte manual de un archivo en una edición pendiente se trata como referenciado", async () => {
    await asset(fresh(1));
    await submit(POST, 2, "pendiente", [...ASSETS.slice(0, 3), fresh(1)]);
    expect(await val("select public.community_media_asset_discard($1,$2)->>'result'", [fresh(1), ACTOR])).toBe("referenced");
  });
});

describe("ediciones pendientes", () => {
  it("crear una pendiente conserva intacta la versión pública (texto, versión y adjuntos)", async () => {
    await asset(fresh(1));
    const before = { state: await postState(), media: await attached() };
    const r = await submit(POST, 2, "texto nuevo", [fresh(1), ASSETS[0]], [ATTACHMENTS[1], ATTACHMENTS[2]]);
    expect(r.ok).toBe(true);
    expect(await postState()).toEqual(before.state);
    expect(await attached()).toEqual(before.media);
    const e = (await db.query("select text, base_version, status from community_post_pending_edits")).rows[0] as any;
    expect(e).toMatchObject({ text: "texto nuevo", base_version: 2, status: "pending" });
    const m = (await db.query("select asset_id, is_new from community_post_pending_edit_media order by position")).rows as any[];
    expect(m).toEqual([{ asset_id: fresh(1), is_new: true }, { asset_id: ASSETS[0], is_new: false }]);
  });

  it("aplica las reglas de un guardado normal y de la Fase 1", async () => {
    await asset(fresh(1), "image", OTHER);
    expect(await submit(POST, 2, "x", [])).toMatchObject({ ok: false, error: "media_required" });
    expect(await submit(POST, 2, "x", [], ATTACHMENTS)).toMatchObject({ ok: false, error: "media_required" });
    expect(await submit(POST, 2, "x", [...ASSETS.slice(0, 3), fresh(1)])).toMatchObject({ ok: false, error: "foreign_asset" });
    expect(await submit(POST, 9, "x", ASSETS.slice(0, 3))).toMatchObject({ ok: false, error: "version_conflict" });
    expect(await submit(POST, 2, "x", ASSETS.slice(0, 3), [], OTHER)).toMatchObject({ ok: false, error: "not_owner" });
    expect(await val("select count(*)::int from community_post_pending_edits")).toBe(0);
  });

  it("una publicación histórica de solo texto admite una edición pendiente solo de texto", async () => {
    await db.query("insert into community_posts(id,author_user_id,text,version) values ($1,$2,'historico',1)", [HISTORIC, ACTOR]);
    expect((await submit(HISTORIC, 1, "historico editado", [])).ok).toBe(true);
  });

  it("una edición nueva sustituye a la pendiente anterior y limpia sus archivos exclusivos", async () => {
    await asset(fresh(1));
    await asset(fresh(2));
    await submit(POST, 2, "uno", [...ASSETS.slice(0, 3), fresh(1)]);
    const r = await submit(POST, 2, "dos", [...ASSETS.slice(0, 3), fresh(2)]);
    expect(r.ok && (r as any).rows[0].r.cleanup_asset_ids).toEqual([fresh(1)]);
    expect(await assetStatus(fresh(1))).toBe("deleting");
    expect(await assetStatus(fresh(2))).toBe("ready");
    const statuses = (await db.query("select status from community_post_pending_edits order by created_at, id")).rows.map((x: any) => x.status).sort();
    expect(statuses).toEqual(["pending", "superseded"]);
  });

  it("nunca puede haber dos pendientes de la misma publicación ni un archivo nuevo en dos pendientes", async () => {
    await submit(POST, 2, "uno", ASSETS.slice(0, 3));
    const dup = await q("insert into community_post_pending_edits(post_id,author_user_id,base_version) values ($1,$2,2)", [POST, ACTOR]);
    expect(dup.ok).toBe(false);
    await asset(fresh(1));
    await db.query("insert into community_posts(id,author_user_id,text,version) values ($1,$2,'otro',1)", [HISTORIC, ACTOR]);
    await submit(POST, 2, "uno", [...ASSETS.slice(0, 3), fresh(1)]);
    expect(await submit(HISTORIC, 1, "otro", [fresh(1)])).toMatchObject({ ok: false, error: "asset_already_attached" });
  });

  it("cancelar: solo la autora, y solo si hay una pendiente", async () => {
    await asset(fresh(1));
    await submit(POST, 2, "uno", [...ASSETS.slice(0, 3), fresh(1)]);
    expect(await q("select public.community_post_pending_edit_cancel($1,$2)", [OTHER, POST])).toMatchObject({ ok: false, error: "not_owner" });
    expect((await q("select public.community_post_pending_edit_cancel($1,$2)", [ACTOR, POST])).ok).toBe(true);
    expect(await assetStatus(fresh(1))).toBe("deleting");
    expect(await q("select public.community_post_pending_edit_cancel($1,$2)", [ACTOR, POST])).toMatchObject({ ok: false, error: "pending_edit_not_found" });
    expect(await attached()).toEqual(ASSETS.slice(0, 3));
  });

  it("la lectura propia muestra solo las ediciones de esa autora y marca las obsoletas", async () => {
    await submit(POST, 2, "uno", ASSETS.slice(0, 3));
    const mine = await val("select public.community_author_pending_read($1)", [ACTOR]);
    expect(mine.edits).toHaveLength(1);
    expect(mine.edits[0]).toMatchObject({ postId: POST, baseVersion: 2, stale: false });
    expect((await val("select public.community_author_pending_read($1)", [OTHER])).edits).toEqual([]);
    await db.query("update community_posts set version = version + 1 where id=$1", [POST]);
    expect((await val("select public.community_author_pending_read($1)", [ACTOR])).edits[0].stale).toBe(true);
  });
});

describe("aprobación y rechazo", () => {
  it("aprobar sustituye texto y adjuntos de forma atómica y publica los archivos nuevos", async () => {
    await asset(fresh(1));
    await submit(POST, 2, "texto aprobado", [fresh(1), ASSETS[0]], [ATTACHMENTS[1], ATTACHMENTS[2]]);
    const edit = await pendingEditId();
    const r = await approve(edit, 2);
    expect(r.ok).toBe(true);
    const out = (r as any).rows[0].r;
    expect(out.post).toMatchObject({ text: "texto aprobado", version: 3, status: "published" });
    expect(await attached()).toEqual([fresh(1), ASSETS[0]]);
    expect([...out.cleanup_asset_ids].sort()).toEqual([ASSETS[1], ASSETS[2]].sort());
    expect(await assetStatus(ASSETS[1])).toBe("deleting");
    expect(await assetStatus(fresh(1))).toBe("ready");
    expect(await delivery(fresh(1))).toBe("public");
    expect(await val("select status from community_post_pending_edits where id=$1", [edit])).toBe("approved");
    expect(await val("select count(*)::int from community_post_pending_edit_media")).toBe(0);
    expect(await approve(edit, 3)).toMatchObject({ ok: false, error: "edit_not_pending" });
  });

  it("si algo falla la aprobación no cambia nada: la publicación sigue igual y la edición pendiente", async () => {
    await asset(fresh(1));
    await submit(POST, 2, "texto aprobado", [...ASSETS.slice(0, 3), fresh(1)]);
    const edit = await pendingEditId();
    await db.query("update media_assets set status='deleting' where id=$1", [fresh(1)]);
    const before = { state: await postState(), media: await attached() };
    expect(await approve(edit, 2)).toMatchObject({ ok: false, error: "asset_not_ready" });
    expect(await postState()).toEqual(before.state);
    expect(await attached()).toEqual(before.media);
    expect(await val("select status from community_post_pending_edits where id=$1", [edit])).toBe("pending");
  });

  it("si el GC borra un archivo citado por una pendiente, el borrado no se bloquea y aprobar falla en vez de publicar otra versión", async () => {
    await asset(fresh(1));
    await submit(POST, 2, "pendiente", [...ASSETS.slice(0, 3), fresh(1)]);
    const edit = await pendingEditId();
    expect((await q("delete from media_assets where id=$1", [fresh(1)])).ok).toBe(true);
    expect(await val("select count(*)::int from community_post_pending_edit_media where edit_id=$1", [edit])).toBe(3);
    const before = { state: await postState(), media: await attached() };
    expect(await approve(edit, 2)).toMatchObject({ ok: false, error: "asset_not_ready" });
    expect(await postState()).toEqual(before.state);
    expect(await attached()).toEqual(before.media);
    expect((await reject(edit)).ok).toBe(true);
  });

  it("una edición obsoleta no se puede aprobar (solo rechazar) y la versión pública no se pisa", async () => {
    await submit(POST, 2, "pendiente", ASSETS.slice(0, 3));
    const edit = await pendingEditId();
    await db.query("select public.community_post_save_atomic($1,$2,2,'cambio directo',$3::jsonb,'{}'::uuid[])", [ACTOR, POST, mediaJson(ASSETS.slice(0, 3))]);
    expect(await approve(edit, 3)).toMatchObject({ ok: false, error: "version_conflict" });
    expect((await postState()).text).toBe("cambio directo");
    expect((await reject(edit)).ok).toBe(true);
  });

  it("permisos: la autora no aprueba ni rechaza; hace falta un rol; las condiciones de la publicación se respetan", async () => {
    await submit(POST, 2, "pendiente", ASSETS.slice(0, 3));
    const edit = await pendingEditId();
    expect(await approve(edit, 2, ACTOR)).toMatchObject({ ok: false, error: "actor_not_moderator" });
    expect(await reject(edit, ACTOR)).toMatchObject({ ok: false, error: "actor_not_moderator" });
    expect(await approve(fresh(99), 2)).toMatchObject({ ok: false, error: "pending_edit_not_found" });
    await db.exec("select set_config('test.copyright', 'on', false)");
    expect(await approve(edit, 2)).toMatchObject({ ok: false, error: "post_copyright_protected" });
    await db.exec("select set_config('test.copyright', 'off', false)");
    await db.query("update community_posts set status='hidden' where id=$1", [POST]);
    expect(await approve(edit, 2)).toMatchObject({ ok: false, error: "post_not_editable" });
    expect(await val("select status from community_post_pending_edits where id=$1", [edit])).toBe("pending");
  });

  it("rechazar conserva la versión pública y limpia solo los archivos nuevos", async () => {
    await asset(fresh(1));
    await submit(POST, 2, "pendiente", [...ASSETS.slice(0, 3), fresh(1)]);
    const edit = await pendingEditId();
    const before = { state: await postState(), media: await attached() };
    const r = await reject(edit);
    expect(r.ok && (r as any).rows[0].r.cleanup_asset_ids).toEqual([fresh(1)]);
    expect(await postState()).toEqual(before.state);
    expect(await attached()).toEqual(before.media);
    for (const a of ASSETS.slice(0, 3)) expect(await assetStatus(a)).toBe("ready");
    expect(await assetStatus(fresh(1))).toBe("deleting");
    expect(await val("select status from community_post_pending_edits where id=$1", [edit])).toBe("rejected");
    expect(await reject(edit)).toMatchObject({ ok: false, error: "edit_not_pending" });
  });
});

describe("eliminación, acceso directo y permisos", () => {
  it("eliminar la publicación elimina en cascada sus ediciones pendientes y sus filas de medios", async () => {
    await asset(fresh(1));
    await submit(POST, 2, "pendiente", [...ASSETS.slice(0, 3), fresh(1)]);
    await db.query("delete from community_post_media where post_id=$1", [POST]);
    await db.query("delete from community_posts where id=$1", [POST]);
    expect(await val("select count(*)::int from community_post_pending_edits")).toBe(0);
    expect(await val("select count(*)::int from community_post_pending_edit_media")).toBe(0);
  });

  it("las tablas nuevas no admiten acceso directo y las funciones solo se ejecutan con service_role", async () => {
    for (const t of ["community_post_pending_edits", "community_post_pending_edit_media"]) {
      for (const role of ["anon", "authenticated", "service_role"])
        for (const priv of ["select", "insert", "update", "delete"])
          expect(await val(`select has_table_privilege('${role}', 'public.${t}', '${priv}')`)).toBe(false);
      expect(await val("select relrowsecurity and relforcerowsecurity from pg_class where oid = $1::regclass", [`public.${t}`])).toBe(true);
    }
    const fns = [
      "community_post_pending_edit_submit(uuid,uuid,integer,text,jsonb,uuid[])",
      "community_post_pending_edit_cancel(uuid,uuid)",
      "community_post_pending_edit_reject(uuid,uuid)",
      "community_post_pending_edit_approve(uuid,uuid,integer)",
      "community_post_create_held(uuid,text,jsonb)",
      "community_post_hold_release(uuid,uuid,integer)",
      "community_post_hold_reject(uuid,uuid,integer)",
      "community_author_pending_read(uuid)",
    ];
    for (const f of fns) {
      expect(await val(`select has_function_privilege('service_role', 'public.${f}', 'execute')`)).toBe(true);
      for (const role of ["anon", "authenticated"])
        expect(await val(`select has_function_privilege('${role}', 'public.${f}', 'execute')`)).toBe(false);
    }
    expect(await val("select has_function_privilege('service_role', 'public.community_pending_edit_close(uuid,text,uuid,uuid[])', 'execute')")).toBe(false);
  });
});
