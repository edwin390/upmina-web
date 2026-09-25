import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Verificación ESTÁTICA de la migración del Bloque 9F (gestión de miembros + auditoría). No
// sustituye las pruebas contra PostgreSQL real (carreras, último ADMIN, SET ROLE), que se hacen con
// el harness contra una base desechable; solo fija por texto las decisiones aprobadas.

const MIGRATIONS_DIR = resolve(__dirname, "../../supabase/migrations");
const FILE = "20260928120000_admin_team_member_management.sql";
const raw = readFileSync(resolve(MIGRATIONS_DIR, FILE), "utf8");
const code = raw
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");
const handlerSrc = readFileSync(resolve(__dirname, "admin-team-members.ts"), "utf8");

/** Cabecera (firma hasta `as $$`) y cuerpo ($$ … $$;) de una función por nombre. */
function fn(name: string): { header: string; body: string } {
  const start = code.indexOf(`create or replace function public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const open = code.indexOf("$$", start);
  const close = code.indexOf("$$;", open + 2);
  return { header: code.slice(start, open), body: code.slice(open, close + 3) };
}

const list = fn("list_admin_team_members");
const change = fn("change_admin_member_role");
const remove = fn("remove_admin_member");
const RPCS = {
  list_admin_team_members: { ...list, sig: "(uuid)" },
  change_admin_member_role: { ...change, sig: "(uuid, uuid, text)" },
  remove_admin_member: { ...remove, sig: "(uuid, uuid)" },
};
const MUTATIONS = [change, remove];

describe("migración 9F — archivo", () => {
  it("es nueva, única, posterior a 9D y no toca migraciones históricas", () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(files.filter((f) => f === FILE)).toHaveLength(1);
    expect(files[files.indexOf(FILE) - 1]).toBe(
      "20260927120000_admin_team_invitation_revoke.sql",
    );
  });

  it("no altera tablas existentes ni desactiva RLS, triggers o constraints de 9B", () => {
    expect(code).not.toMatch(/\balter\s+table\s+public\.admin_(roles|invitations)/i);
    expect(code).not.toMatch(/\b(drop|disable)\b/i);
    expect(code).not.toMatch(
      /\bcreate\s+trigger\b[^;]*\bon\s+public\.admin_(roles|invitations)/i,
    );
    expect(code).not.toMatch(/service_role_key|eyJ|(?<![\w])sk_/i);
  });

  it("crea exactamente 4 funciones (3 RPC + la del trigger de auditoría)", () => {
    expect(code.match(/create or replace function/gi)).toHaveLength(4);
  });
});

describe("migración 9F — admin_team_audit", () => {
  const table = code.slice(
    code.indexOf("create table public.admin_team_audit"),
    code.indexOf(");", code.indexOf("create table public.admin_team_audit")),
  );

  it("tiene las columnas aprobadas y NINGUNA FK a auth.users", () => {
    for (const col of [
      "id             uuid primary key default gen_random_uuid()",
      "action         text not null",
      "actor_user_id  uuid not null",
      "target_user_id uuid not null",
      "old_role       text not null",
      "new_role       text,",
      "created_at     timestamptz not null default now()",
    ]) {
      expect(table, col).toContain(col);
    }
    expect(table).not.toMatch(/references/i);
    expect(code).not.toMatch(/foreign key/i);
  });

  it("checks de forma: acciones, roles, actor <> target y new_role según la acción", () => {
    expect(table).toMatch(/action in \('role_changed', 'access_removed'\)/);
    expect(table).toMatch(/old_role in \('admin', 'moderator', 'developer'\)/);
    expect(table).toMatch(
      /new_role is null or new_role in \('admin', 'moderator', 'developer'\)/,
    );
    expect(table).toMatch(/actor_user_id <> target_user_id/);
    expect(table).toMatch(
      /action = 'role_changed' and new_role is not null and new_role <> old_role/,
    );
    expect(table).toMatch(/action = 'access_removed' and new_role is null/);
  });

  it("RLS y FORCE RLS, sin ninguna policy", () => {
    expect(code).toContain(
      "alter table public.admin_team_audit enable row level security;",
    );
    expect(code).toContain(
      "alter table public.admin_team_audit force row level security;",
    );
    expect(code).not.toMatch(/create policy/i);
  });

  it("UPDATE, DELETE y TRUNCATE siempre fallan (triggers)", () => {
    expect(code).toMatch(
      /create trigger admin_team_audit_no_update_delete\s+before update or delete on public\.admin_team_audit\s+for each row execute function public\.admin_team_audit_immutable\(\)/,
    );
    expect(code).toMatch(
      /create trigger admin_team_audit_no_truncate\s+before truncate on public\.admin_team_audit\s+for each statement execute function public\.admin_team_audit_immutable\(\)/,
    );
    const trig = fn("admin_team_audit_immutable").body;
    expect(trig).toMatch(/raise exception 'admin_team_audit_immutable'/);
    expect(trig).not.toMatch(/\breturn\b/i);
  });

  it("ningún privilegio de tabla para public, anon, authenticated ni service_role", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(code).toContain(
        `revoke all privileges on table public.admin_team_audit from ${role};`,
      );
    }
    expect(code).not.toMatch(/grant\s+[^;]*\bon\s+(table\s+)?public\.admin_team_audit/i);
  });

  it("la única escritura de la tabla son los INSERT de las dos RPC de mutación", () => {
    expect(code.match(/insert into public\.admin_team_audit/gi)).toHaveLength(2);
    expect(change.body).toMatch(/insert into public\.admin_team_audit/);
    expect(remove.body).toMatch(/insert into public\.admin_team_audit/);
    expect(list.body).not.toMatch(/admin_team_audit/);
    expect(code).not.toMatch(/(update|delete from)\s+public\.admin_team_audit/i);
  });

  it("la función del trigger no es invocable por ningún rol de API", () => {
    expect(code).toMatch(
      /revoke all on function public\.admin_team_audit_immutable\(\)\s+from public, anon, authenticated, service_role;/,
    );
  });
});

describe("migración 9F — RPC comunes", () => {
  for (const [name, r] of Object.entries(RPCS)) {
    describe(name, () => {
      it("SECURITY DEFINER con search_path fijo (pg_catalog, public)", () => {
        expect(r.header).toMatch(/security definer/);
        expect(r.header).toMatch(/set search_path = pg_catalog, public/);
        expect(r.header).not.toMatch(/security invoker/);
      });

      it("EXECUTE solo para service_role (revocado a PUBLIC, anon y authenticated)", () => {
        const s = `public.${name}${r.sig}`;
        expect(code).toContain(`revoke all on function ${s} from public;`);
        expect(code).toContain(`revoke execute on function ${s} from anon;`);
        expect(code).toContain(`revoke execute on function ${s} from authenticated;`);
        expect(code).toContain(`grant execute on function ${s} to service_role;`);
      });

      it("no captura excepciones (last_admin_protected / 23001 se propagan)", () => {
        expect(r.body).not.toMatch(/\bexception\s+when\b/i);
        expect(r.body).not.toMatch(/\bwhen others\b/i);
        expect(r.body).not.toMatch(/last_admin_protected/);
      });

      it("verifica que el actor sea ADMIN dentro de la función (y rechaza si NO existe)", () => {
        expect(r.body).toMatch(
          /not exists \(\s*select 1 from public\.admin_roles ar\s+where ar\.user_id = p_actor_user_id and ar\.role = 'admin'\s*\)[\s\S]*?then\s+raise exception 'actor_not_admin'/,
        );
      });
    });
  }

  it("solo esos tres GRANT de EXECUTE; ningún privilegio de tabla en toda la migración", () => {
    expect(code.match(/\bgrant\b/gi)).toHaveLength(3);
    expect(code).not.toMatch(/\bgrant\s+(all|select|insert|update|delete|truncate)\b/i);
  });
});

describe("migración 9F — mutaciones (change_admin_member_role / remove_admin_member)", () => {
  it("la única validación anterior al lock es pura (sin consultas a tablas)", () => {
    for (const m of MUTATIONS) {
      const lock = m.body.indexOf("public.upmina_lock_admin_roles()");
      expect(lock).toBeGreaterThan(-1);
      const before = m.body.slice(0, lock);
      expect(before).not.toMatch(/\bfrom\b|\bupdate\b|\bdelete\b|\binsert\b|for update/i);
    }
  });

  it("el lock va ANTES de cualquier lectura, FOR UPDATE o mutación", () => {
    for (const m of MUTATIONS) {
      const lock = m.body.indexOf("public.upmina_lock_admin_roles()");
      for (const later of [
        "from public.admin_roles",
        "for update",
        "update public.admin_roles",
        "delete from public.admin_roles",
        "update public.admin_invitations",
        "insert into public.admin_team_audit",
      ]) {
        const at = m.body.indexOf(later);
        if (at === -1) continue;
        expect(lock, later).toBeLessThan(at);
      }
    }
  });

  it("orden: actor ADMIN → actor <> target → target FOR UPDATE → operación → mutación → invitaciones → auditoría", () => {
    for (const m of MUTATIONS) {
      const order = [
        "public.upmina_lock_admin_roles()",
        "raise exception 'actor_not_admin'",
        "raise exception 'self_change_not_allowed'",
        "for update",
        "raise exception 'member_not_found'",
      ].map((s) => m.body.indexOf(s));
      expect(order.every((i) => i > -1)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);

      const mutation = Math.max(
        m.body.indexOf("update public.admin_roles"),
        m.body.indexOf("delete from public.admin_roles"),
      );
      const invitations = m.body.indexOf("update public.admin_invitations");
      const audit = m.body.indexOf("insert into public.admin_team_audit");
      const ret = m.body.indexOf("return query");
      expect(order[order.length - 1]).toBeLessThan(mutation);
      expect(mutation).toBeLessThan(invitations);
      expect(invitations).toBeLessThan(audit);
      expect(audit).toBeLessThan(ret);
    }
  });

  it("el instante v_now se toma DESPUÉS del lock (clock_timestamp) y se usa en revoked_at, auditoría y resultado", () => {
    for (const m of MUTATIONS) {
      expect(m.body).toMatch(/v_now timestamptz;/);
      expect(m.body).not.toMatch(/pg_catalog\.now\(\)|\bnow\(\)/);
      const lock = m.body.indexOf("public.upmina_lock_admin_roles()");
      const assign = m.body.indexOf("v_now := pg_catalog.clock_timestamp();");
      expect(assign).toBeGreaterThan(lock);
      expect(assign).toBeLessThan(m.body.indexOf("raise exception 'actor_not_admin'"));
      expect(m.body).toMatch(/set revoked_at = v_now,/);
      expect(m.body).toMatch(/insert into public\.admin_team_audit \([^)]*created_at\)/);
      expect(m.body).toMatch(/return query select [^;]*v_now/);
    }
  });

  it("rechaza actor = target y bloquea la fila del target por user_id", () => {
    for (const m of MUTATIONS) {
      expect(m.body).toMatch(/if p_actor_user_id = p_target_user_id then/);
      expect(m.body).toMatch(/where ar\.user_id = p_target_user_id\s+for update/);
    }
  });

  it("change_admin_member_role valida el rol (lista cerrada), rechaza mismo rol y solo actualiza `role`", () => {
    expect(change.body).toMatch(
      /p_new_role not in \('admin', 'moderator', 'developer'\)/,
    );
    expect(change.body).toMatch(
      /if v_old_role = p_new_role then\s+raise exception 'role_unchanged'/,
    );
    const updates = change.body.match(/update public\.admin_roles[\s\S]*?;/g) ?? [];
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(
      /set role = p_new_role\s+where user_id = p_target_user_id;/,
    );
    expect(updates[0]).not.toMatch(/granted_at|granted_by|user_id =.*,/);
    expect(change.body).not.toMatch(/\bdelete\b/i);
    expect(change.body).toMatch(
      /values \('role_changed', p_actor_user_id, p_target_user_id, v_old_role, p_new_role, v_now\)/,
    );
  });

  it("remove_admin_member solo borra la fila de admin_roles del target (sin tocar auth ni profiles)", () => {
    const deletes = remove.body.match(/delete from [\w.]+/gi) ?? [];
    expect(deletes).toEqual(["delete from public.admin_roles"]);
    expect(remove.body).toMatch(
      /delete from public\.admin_roles\s+where user_id = p_target_user_id;/,
    );
    expect(remove.body).not.toMatch(/auth\.users|public\.profiles/);
    expect(remove.body).not.toMatch(/update public\.admin_roles/);
    expect(remove.body).toMatch(
      /values \('access_removed', p_actor_user_id, p_target_user_id, v_old_role, null, v_now\)/,
    );
  });

  it("los literales de error son EXACTAMENTE los que reconoce el handler (lista cerrada)", () => {
    const all = [list, change, remove].map((f) => f.body).join("\n");
    const raised = [
      ...new Set([...all.matchAll(/raise exception '(\w+)'/g)].map((m) => m[1])),
    ].sort();
    expect(raised).toEqual(
      [
        "actor_not_admin",
        "invalid_argument",
        "invalid_role",
        "member_not_found",
        "role_unchanged",
        "self_change_not_allowed",
      ].sort(),
    );
    for (const literal of [
      "actor_not_admin",
      "member_not_found",
      "self_change_not_allowed",
      "role_unchanged",
    ]) {
      expect(handlerSrc).toContain(`"${literal}"`);
    }
    // invalid_role / invalid_argument son inalcanzables desde el handler (valida antes): 500.
    expect(handlerSrc).not.toContain('"invalid_role"');
    expect(handlerSrc).toContain("last_admin_protected");
  });
});

describe("migración 9F — invitaciones pendientes del ADMIN que pierde el rol", () => {
  for (const [name, m, cond] of [
    [
      "change_admin_member_role",
      change,
      "if v_old_role = 'admin' and p_new_role <> 'admin' then",
    ],
    ["remove_admin_member", remove, "if v_old_role = 'admin' then"],
  ] as const) {
    describe(name, () => {
      const updates = m.body.match(/update public\.admin_invitations[\s\S]*?;/g) ?? [];

      it("solo se ejecuta si el target ERA ADMIN y deja de serlo", () => {
        expect(m.body).toContain(cond);
        expect(m.body.indexOf(cond)).toBeLessThan(
          m.body.indexOf("update public.admin_invitations"),
        );
      });

      it("un único UPDATE que usa la transición PENDING -> REVOKED de 9D (revoked_at + revoked_by)", () => {
        expect(updates).toHaveLength(1);
        expect(updates[0]).toMatch(
          /set revoked_at = v_now,\s+revoked_by = p_actor_user_id/,
        );
        expect(m.body).not.toMatch(/delete from public\.admin_invitations/i);
      });

      it("solo standard del target, sin consumir, sin revocar y sin expirar (no toca consumidas, revocadas, expiradas ni bootstrap)", () => {
        const u = updates[0] ?? "";
        expect(u).toMatch(/i\.invitation_type = 'standard'/);
        expect(u).toMatch(/i\.created_by = p_target_user_id/);
        expect(u).toMatch(/i\.consumed_at is null/);
        expect(u).toMatch(/i\.revoked_at is null/);
        expect(u).toMatch(/i\.expires_at >= v_now/);
        expect(u).not.toMatch(/bootstrap/);
        // No modifica campos inmutables ni de consumo:
        const setClause = u.slice(u.indexOf("set "), u.indexOf("where "));
        expect(setClause).not.toMatch(
          /consumed_|expires_at|role|token_hash|invitation_type|created_/,
        );
      });

      it("devuelve el número de invitaciones revocadas", () => {
        expect(m.body).toMatch(/get diagnostics v_revoked = row_count;/);
        expect(m.header).toMatch(/out_revoked_invitations integer/);
      });
    });
  }

  it("no introduce estados nuevos ni columnas nuevas en admin_invitations", () => {
    expect(code).not.toMatch(/alter\s+table\s+public\.admin_invitations/i);
    expect(code).not.toMatch(/add column/i);
  });
});

describe("migración 9F — list_admin_team_members", () => {
  it("devuelve exactamente user_id, role, granted_at, username, display_name, email, is_self", () => {
    for (const col of [
      "out_user_id uuid",
      "out_role text",
      "out_granted_at timestamptz",
      "out_username text",
      "out_display_name text",
      "out_email text",
      "out_is_self boolean",
    ]) {
      expect(list.header, col).toContain(col);
    }
    expect(list.header.match(/\bout_\w+/g)).toHaveLength(7);
  });

  it("solo miembros de admin_roles con LEFT JOIN a profiles y auth.users (columnas explícitas)", () => {
    expect(list.body).toMatch(/from public\.admin_roles ar/);
    expect(list.body).toMatch(/left join public\.profiles p on p\.user_id = ar\.user_id/);
    expect(list.body).toMatch(/left join auth\.users u on u\.id = ar\.user_id/);
    expect(list.body).toContain("u.email::text");
    expect(list.body).not.toMatch(/select\s+\*|\.\*/);
  });

  it("no expone metadata, identidades, teléfono, tokens, last_sign_in, granted_by ni avatar_path", () => {
    for (const forbidden of [
      "raw_user_meta_data",
      "raw_app_meta_data",
      "identities",
      "phone",
      "last_sign_in",
      "encrypted_password",
      "granted_by",
      "avatar_path",
      "bio",
    ]) {
      expect(list.body, forbidden).not.toContain(forbidden);
    }
  });

  it("verifica ADMIN antes de leer y no muta nada", () => {
    expect(list.body.indexOf("actor_not_admin")).toBeLessThan(
      list.body.indexOf("return query"),
    );
    expect(list.body).not.toMatch(/\b(insert|update|delete)\b/i);
  });
});
