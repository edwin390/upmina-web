import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Sin Postgres real en este entorno de test: verificación ESTÁTICA de la migración del Bloque 9B
// (roles del equipo, invitaciones revocables, último ADMIN, bootstrap cerrado, privilegios). NO
// sustituye las pruebas contra una base PostgreSQL desechable (concurrencia, cascade, SET ROLE)
// que exige el bloque de aplicación; solo fija por texto las decisiones aprobadas.

const MIGRATIONS_DIR = resolve(__dirname, "../../supabase/migrations");
const FILE = "20260926120000_admin_team_roles_invariants.sql";
const raw = readFileSync(resolve(MIGRATIONS_DIR, FILE), "utf8");

/** SQL sin comentarios de línea: las comprobaciones "no debe existir X" no se disparan por texto
 *  explicativo. */
const code = raw
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

/** Definición completa de una función pública (desde `create or replace function` hasta `$$;`). */
function fn(name: string): string {
  const start = code.indexOf(`create or replace function public.${name}(`);
  expect(start, `función ${name}`).toBeGreaterThanOrEqual(0);
  const bodyStart = code.indexOf("$$", start);
  const end = code.indexOf("$$;", bodyStart + 2);
  expect(end).toBeGreaterThan(bodyStart);
  return code.slice(start, end + 3);
}

function header(name: string): string {
  const f = fn(name);
  return f.slice(0, f.indexOf("$$"));
}

describe("migración 9B — archivo", () => {
  it("es nueva, única y no modifica migraciones históricas", () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(files.filter((f) => f === FILE)).toHaveLength(1);
    expect(files[files.length - 1]).toBe(FILE);
  });

  it("no usa if not exists (debe fallar de forma visible si el schema no es el esperado)", () => {
    // (`if not exists (select ...)` dentro de plpgsql es una condición, no DDL condicional.)
    expect(code).not.toMatch(
      /(create|add column|drop constraint|drop trigger)[^;]*if (not )?exists(?![\w])/i,
    );
  });

  it("no contiene secretos ni DML de datos reales (no inserta roles ni invitaciones)", () => {
    expect(code).not.toMatch(/insert into public\.admin_invitations/i);
    expect(code).not.toMatch(
      /insert into public\.admin_roles\s*\(user_id, role, granted_by\)\s*values\s*\('/i,
    );
    expect(code).not.toMatch(/service_role_key|eyJ|(?<![\w])sk_/i);
  });
});

describe("migración 9B — developer", () => {
  it("admin_roles acepta admin, moderator y developer (CHECK reemplazado, sin enum)", () => {
    expect(code).toMatch(/drop constraint admin_roles_role_check;/);
    expect(code).toMatch(
      /add constraint admin_roles_role_check\s+check \(role in \('admin', 'moderator', 'developer'\)\)/,
    );
    expect(code).not.toMatch(/create type/i);
  });

  it("admin_invitations.role NO se toca: developer nunca se concede por invitación", () => {
    expect(code).not.toMatch(/admin_invitations_role_check/);
    expect(code).not.toMatch(/admin_invitations[^;]*developer/i);
    // La única invitación con rol fijo sigue siendo bootstrap → admin.
    expect(code).toMatch(
      /invitation_type = 'bootstrap_admin' and role = 'admin' and created_by is null/,
    );
  });

  it("no crea un valor developer en invitation_type", () => {
    expect(code).not.toMatch(/invitation_type[^;]*developer/i);
  });
});

describe("migración 9B — invitaciones", () => {
  it("añade id uuid único, revoked_at y revoked_by (SET NULL); token_hash sigue siendo la PK", () => {
    expect(code).toMatch(/add column id uuid not null default gen_random_uuid\(\)/);
    expect(code).toMatch(/add column revoked_at timestamptz/);
    expect(code).toMatch(
      /add column revoked_by uuid references auth\.users\(id\) on delete set null/,
    );
    expect(code).toMatch(/add constraint admin_invitations_id_key unique \(id\)/);
    expect(code).not.toMatch(/drop constraint admin_invitations_pkey/);
    expect(code).not.toMatch(/primary key/i);
  });

  it("created_by: el CHECK ya no exige creador y standard puede quedar sin él tras SET NULL", () => {
    expect(code).toMatch(/drop constraint admin_invitations_bootstrap_shape/);
    expect(code).toMatch(
      /admin_invitations_shape_check\s+check \(\s*\(invitation_type = 'bootstrap_admin' and role = 'admin' and created_by is null\)\s+or invitation_type = 'standard'\s*\)/,
    );
    // Ya no hay una condición "standard ⇒ created_by is not null" en un CHECK.
    expect(code).not.toMatch(/standard'\s+and created_by is not null/);
    // Y la FK de created_by no se altera (sigue siendo SET NULL de la migración original).
    expect(code).not.toMatch(/created_by[^;]*on delete (restrict|cascade|no action)/i);
  });

  it("estado: consumida y revocada son mutuamente excluyentes y las referencias exigen su fecha", () => {
    expect(code).toMatch(/consumed_by is null or consumed_at is not null/);
    expect(code).toMatch(/revoked_by is null or revoked_at is not null/);
    expect(code).toMatch(/not \(consumed_at is not null and revoked_at is not null\)/);
  });

  it("CHECKs nuevos se añaden NOT VALID y se validan", () => {
    expect(code).toMatch(/validate constraint admin_roles_role_check/);
    expect(code).toMatch(/validate constraint admin_invitations_shape_check/);
    expect(code).toMatch(/validate constraint admin_invitations_state_check/);
  });

  it("trigger de inserción: estado inicial limpio, lock, bootstrap sin ADMIN, standard con creador ADMIN", () => {
    const f = fn("admin_invitations_before_insert");
    expect(f).toMatch(/new\.consumed_at is not null[\s\S]*new\.revoked_by is not null/);
    expect(f).toMatch(/perform public\.upmina_lock_admin_roles\(\)/);
    expect(f).toMatch(/new\.invitation_type = 'bootstrap_admin'/);
    expect(f).toMatch(
      /exists \(select 1 from public\.admin_roles where role = 'admin'\)/,
    );
    expect(f).toMatch(/raise exception 'bootstrap_not_allowed'/);
    expect(f).toMatch(/new\.created_by is null/);
    expect(f).toMatch(/where user_id = new\.created_by and role = 'admin'/);
    expect(code).toMatch(
      /create trigger admin_invitations_before_insert\s+before insert on public\.admin_invitations\s+for each row/,
    );
  });

  it("inmutabilidad: campos núcleo fijos y consumed_at/revoked_at de una sola vía (las referencias *_by se cubren en la máquina de estados)", () => {
    const f = fn("admin_invitations_immutable");
    for (const col of [
      "token_hash",
      "id",
      "invitation_type",
      "role",
      "created_at",
      "expires_at",
    ]) {
      expect(f).toMatch(new RegExp(`new\\.${col} is distinct from old\\.${col}`));
    }
    expect(f).toMatch(
      /old\.consumed_at is not null and new\.consumed_at is distinct from old\.consumed_at/,
    );
    expect(f).toMatch(
      /old\.revoked_at is not null and new\.revoked_at is distinct from old\.revoked_at/,
    );
    expect(code).toMatch(
      /create trigger admin_invitations_immutable\s+before update on public\.admin_invitations\s+for each row/,
    );
  });
});

describe("migración 9B — máquina de estados de invitaciones (modelo derivado del SQL)", () => {
  // IMPORTANTE: estos tests NO ejecutan PostgreSQL. Extraen las expresiones booleanas reales de
  // admin_invitations_immutable() y de admin_invitations_state_check del propio archivo SQL y las
  // evalúan sobre TODO el espacio de estados (NULL / valor / otro valor). Así fijan la máquina de
  // estados sin depender de un regex frágil por cláusula. El comportamiento real (FK ON DELETE SET
  // NULL sobre auth.users, consume_admin_invitation bajo service_role) lo valida el harness real
  // 9B.2B.3 contra una base PostgreSQL limpia.
  type Row = Record<string, string | null>;
  type Pred = (
    n: Row | undefined,
    o: Row | undefined,
    r: Row | undefined,
    d: (a: unknown, b: unknown) => boolean,
  ) => boolean;

  const CORE = {
    token_hash: "h",
    id: "i",
    invitation_type: "standard",
    role: "moderator",
    created_at: "c",
    expires_at: "e",
  };
  const distinct = (a: unknown, b: unknown) => a !== b;

  /** Traduce la mini-gramática SQL usada (is [not] null, is distinct from, and/or/not) a JS. */
  function compile(cond: string, mode: "new-old" | "row"): Pred {
    let js = cond;
    js =
      mode === "new-old"
        ? js.replace(/\bnew\.(\w+)/g, "N.$1").replace(/\bold\.(\w+)/g, "O.$1")
        : js.replace(/\b(consumed_by|consumed_at|revoked_by|revoked_at)\b/g, "R.$1");
    js = js
      .replace(/([NOR]\.\w+)\s+is\s+distinct\s+from\s+([NOR]\.\w+)/g, "D($1,$2)")
      .replace(/([NOR]\.\w+)\s+is\s+not\s+null/g, "($1!==null)")
      .replace(/([NOR]\.\w+)\s+is\s+null/g, "($1===null)")
      .replace(/\band\b/g, "&&")
      .replace(/\bor\b/g, "||")
      .replace(/\bnot\b/g, "!");
    // Si quedara SQL sin traducir, el evaluador fallaría en vez de aprobar por accidente.
    expect(js).not.toMatch(/\b(is|distinct|from)\b/);
    return new Function("N", "O", "R", "D", `return (${js});`) as Pred;
  }

  const immutableBlocks = [
    ...fn("admin_invitations_immutable").matchAll(
      /if\s+([\s\S]*?)\s+then\s+raise exception '(\w+)'/g,
    ),
  ].map((m) => ({ msg: m[2], test: compile(m[1], "new-old") }));

  const stateCond =
    /add constraint admin_invitations_state_check\s+check \(([\s\S]*?)\) not valid;/.exec(
      code,
    )?.[1];
  const stateOk = compile(stateCond ?? "false", "row");

  const row = (
    cat: string | null,
    cby: string | null,
    rat: string | null,
    rby: string | null,
    created_by: string | null = "c1",
  ): Row => ({
    ...CORE,
    created_by,
    consumed_at: cat,
    consumed_by: cby,
    revoked_at: rat,
    revoked_by: rby,
  });

  const raised = (o: Row, n: Row) =>
    immutableBlocks.filter((b) => b.test(n, o, undefined, distinct)).map((b) => b.msg);
  const stateValid = (r: Row) => stateOk(undefined, undefined, r, distinct);
  const allowed = (o: Row, n: Row) => raised(o, n).length === 0 && stateValid(n);

  const PENDING = row(null, null, null, null);
  const REF = "invitation_reference_immutable";
  const STATE = "invitation_state_immutable";

  it("el modelo se construyó: 3 bloques de referencia + 2 de estado + 1 de campos núcleo", () => {
    expect(immutableBlocks.map((b) => b.msg).sort()).toEqual(
      ["invitation_immutable_field", REF, REF, REF, STATE, STATE].sort(),
    );
    expect(stateCond).toBeDefined();
  });

  it("PENDING → CONSUMED (con y sin consumed_by) y PENDING → REVOKED (con y sin revoked_by) están permitidos", () => {
    expect(allowed(PENDING, row("t1", "u1", null, null))).toBe(true);
    expect(allowed(PENDING, row("t1", null, null, null))).toBe(true);
    expect(allowed(PENDING, row(null, null, "t1", "u1"))).toBe(true);
    expect(allowed(PENDING, row(null, null, "t1", null))).toBe(true);
  });

  it("consumed_by NULL→usuario SOLO junto con consumed_at NULL→NOT NULL", () => {
    expect(raised(PENDING, row(null, "u1", null, null))).toContain(REF); // sin consumed_at
    expect(raised(row("t1", null, null, null), row("t1", "u1", null, null))).toContain(
      REF,
    ); // *_at ya fijado
    expect(raised(PENDING, row("t1", "u1", null, null))).not.toContain(REF); // transición conjunta
  });

  it("revoked_by NULL→usuario SOLO junto con revoked_at NULL→NOT NULL", () => {
    expect(raised(PENDING, row(null, null, null, "u1"))).toContain(REF);
    expect(raised(row(null, null, "t1", null), row(null, null, "t1", "u1"))).toContain(
      REF,
    );
    expect(raised(PENDING, row(null, null, "t1", "u1"))).not.toContain(REF);
  });

  it("no se reescribe consumed_by ni revoked_by (valor→otro y NULL→valor tras un SET NULL)", () => {
    const consumed = row("t1", "u1", null, null);
    expect(raised(consumed, row("t1", "u2", null, null))).toContain(REF);
    const orphanConsumed = row("t1", null, null, null); // tras ON DELETE SET NULL
    expect(raised(orphanConsumed, row("t1", "u2", null, null))).toContain(REF);
    const revoked = row(null, null, "t1", "u1");
    expect(raised(revoked, row(null, null, "t1", "u2"))).toContain(REF);
    const orphanRevoked = row(null, null, "t1", null);
    expect(raised(orphanRevoked, row(null, null, "t1", "u2"))).toContain(REF);
  });

  it("consumed_at / revoked_at no cambian ni vuelven a NULL una vez fijados", () => {
    expect(raised(row("t1", "u1", null, null), row(null, "u1", null, null))).toContain(
      STATE,
    );
    expect(raised(row("t1", "u1", null, null), row("t2", "u1", null, null))).toContain(
      STATE,
    );
    expect(raised(row(null, null, "t1", "u1"), row(null, null, null, "u1"))).toContain(
      STATE,
    );
    expect(raised(row(null, null, "t1", "u1"), row(null, null, "t2", "u1"))).toContain(
      STATE,
    );
  });

  it("consumed y revoked son excluyentes; *_by exige *_at; el estado huérfano tras SET NULL es válido (state_check)", () => {
    expect(stateValid(PENDING)).toBe(true);
    expect(stateValid(row("t1", "u1", null, null))).toBe(true);
    expect(stateValid(row(null, null, "t1", "u1"))).toBe(true);
    expect(stateValid(row("t1", null, null, null))).toBe(true); // consumed_by NULL con consumed_at
    expect(stateValid(row(null, null, "t1", null))).toBe(true); // revoked_by NULL con revoked_at
    expect(stateValid(row("t1", "u1", "t2", "u2"))).toBe(false); // consumida y revocada
    expect(stateValid(row("t1", null, "t2", null))).toBe(false);
    expect(stateValid(row(null, "u1", null, null))).toBe(false); // consumed_by sin consumed_at
    expect(stateValid(row(null, null, null, "u1"))).toBe(false); // revoked_by sin revoked_at
    // Y no se puede pasar de consumida a revocada ni de revocada a consumida.
    expect(allowed(row("t1", "u1", null, null), row("t1", "u1", "t2", null))).toBe(false);
    expect(allowed(row(null, null, "t1", "u1"), row("t2", null, "t1", "u1"))).toBe(false);
  });

  it("created_by conserva su semántica: solo valor→NULL (ON DELETE SET NULL)", () => {
    const withCreator = row(null, null, null, null, "c1");
    expect(
      raised(row(null, null, null, null, null), row(null, null, null, null, "c1")),
    ).toContain(REF); // NULL→valor
    expect(raised(withCreator, row(null, null, null, null, "c2"))).toContain(REF); // valor→otro
    expect(allowed(withCreator, row(null, null, null, null, null))).toBe(true); // valor→NULL
    expect(allowed(withCreator, withCreator)).toBe(true); // sin cambio
  });

  it("ON DELETE SET NULL sobre consumed_by / revoked_by / created_by es compatible con el trigger y con state_check", () => {
    expect(allowed(row("t1", "u1", null, null), row("t1", null, null, null))).toBe(true);
    expect(allowed(row(null, null, "t1", "u1"), row(null, null, "t1", null))).toBe(true);
    expect(
      allowed(row("t1", "u1", null, null, "c1"), row("t1", "u1", null, null, null)),
    ).toBe(true);
    // Las tres FK siguen siendo ON DELETE SET NULL (revoked_by en esta migración; el resto, en las históricas).
    expect(code).toMatch(
      /add column revoked_by uuid references auth\.users\(id\) on delete set null/,
    );
    const historical = readFileSync(
      resolve(MIGRATIONS_DIR, "20260923120000_admin_invitations.sql"),
      "utf8",
    );
    expect(historical).toMatch(
      /created_by\s+uuid references auth\.users\(id\) on delete set null/,
    );
    expect(historical).toMatch(
      /consumed_by\s+uuid references auth\.users\(id\) on delete set null/,
    );
  });

  it("consume_admin_invitation: su UPDATE (consumed_at + consumed_by en una sola sentencia) atraviesa el trigger", () => {
    const f = fn("consume_admin_invitation");
    expect(f).toMatch(
      /update public\.admin_invitations\s+set consumed_at = now\(\), consumed_by = p_user_id\s+where token_hash = p_token_hash;/,
    );
    // Ese UPDATE es exactamente PENDING → CONSUMED con consumed_by: debe estar permitido.
    expect(allowed(PENDING, row("t1", "u1", null, null))).toBe(true);
  });

  it("revoke_pending_bootstrap solo fija revoked_at: PENDING → REVOKED sin revoked_by atraviesa el trigger", () => {
    const f = fn("admin_roles_revoke_pending_bootstrap");
    expect(f).toMatch(/set revoked_at = pg_catalog\.now\(\)/);
    expect(f).not.toMatch(/revoked_by/);
    expect(allowed(PENDING, row(null, null, "t1", null))).toBe(true);
  });

  it("propiedad exhaustiva: en todo el espacio de estados, las transiciones permitidas respetan la máquina de una sola vía", () => {
    const ats = [null, "t1", "t2"];
    const bys = [null, "u1", "u2"];
    const creators = [null, "c1", "c2"];
    const rows: Row[] = [];
    for (const cat of ats)
      for (const cby of bys)
        for (const rat of ats)
          for (const rby of bys)
            for (const cr of creators) rows.push(row(cat, cby, rat, rby, cr));
    const valid = rows.filter(stateValid);
    let allowedCount = 0;
    for (const o of valid) {
      for (const n of rows) {
        if (!allowed(o, n)) continue;
        allowedCount += 1;
        // consumed_at / revoked_at nunca cambian una vez fijados; y no hay vuelta atrás.
        if (o.consumed_at !== null) expect(n.consumed_at).toBe(o.consumed_at);
        if (o.revoked_at !== null) expect(n.revoked_at).toBe(o.revoked_at);
        // consumida y revocada nunca a la vez.
        expect(n.consumed_at !== null && n.revoked_at !== null).toBe(false);
        // *_by: valor → mismo o NULL; NULL → valor solo con la transición conjunta de *_at.
        for (const [by, at] of [
          ["consumed_by", "consumed_at"],
          ["revoked_by", "revoked_at"],
        ] as const) {
          if (o[by] !== null) expect([o[by], null]).toContain(n[by]);
          if (o[by] === null && n[by] !== null) {
            expect(o[at]).toBeNull();
            expect(n[at]).not.toBeNull();
          }
        }
        // created_by: valor → mismo o NULL; NULL → valor prohibido.
        if (o.created_by !== null) expect([o.created_by, null]).toContain(n.created_by);
        else expect(n.created_by).toBeNull();
      }
    }
    expect(allowedCount).toBeGreaterThan(0);
  });
});

describe("migración 9B — bootstrap", () => {
  it("backfill: revoca bootstrap pendientes solo si ya existe un ADMIN, bajo el lock y antes de los triggers", () => {
    const lock = code.indexOf("select public.upmina_lock_admin_roles();");
    const backfill = code.indexOf("set revoked_at = now()");
    const firstTrigger = code.indexOf("create trigger");
    expect(lock).toBeGreaterThan(0);
    expect(backfill).toBeGreaterThan(lock);
    expect(firstTrigger).toBeGreaterThan(backfill);
    const block = code.slice(backfill, code.indexOf(";", backfill));
    expect(block).toMatch(/invitation_type = 'bootstrap_admin'/);
    expect(block).toMatch(/consumed_at is null/);
    expect(block).toMatch(/revoked_at is null/);
    expect(block).toMatch(
      /exists \(select 1 from public\.admin_roles where role = 'admin'\)/,
    );
  });

  it("cuando aparece un ADMIN se revocan los bootstrap pendientes (definitivo) — SECURITY DEFINER", () => {
    const f = fn("admin_roles_revoke_pending_bootstrap");
    expect(header("admin_roles_revoke_pending_bootstrap")).toMatch(/security definer/);
    expect(f).toMatch(/set revoked_at = pg_catalog\.now\(\)/);
    expect(f).toMatch(/invitation_type = 'bootstrap_admin'/);
    expect(f).toMatch(/consumed_at is null/);
    expect(code).toMatch(
      /create trigger admin_roles_revoke_pending_bootstrap\s+after insert or update of role on public\.admin_roles\s+for each row when \(new\.role = 'admin'\)/,
    );
  });
});

describe("migración 9B — último ADMIN", () => {
  it("guard AFTER UPDATE OR DELETE FOR EACH ROW WHEN (old.role = 'admin'), NO constraint trigger", () => {
    expect(code).toMatch(
      /create trigger admin_roles_last_admin_guard\s+after update or delete on public\.admin_roles\s+for each row when \(old\.role = 'admin'\)\s+execute function public\.admin_roles_last_admin_guard\(\)/,
    );
    expect(code).not.toMatch(/constraint trigger/i);
    expect(code).not.toMatch(/deferrable/i);
  });

  it("la función exige READ COMMITTED, toma el lock antes de comprobar y lanza last_admin_protected / 23001", () => {
    const f = fn("admin_roles_last_admin_guard");
    const lock = f.indexOf("perform public.upmina_lock_admin_roles()");
    const iso = f.indexOf("current_setting('transaction_isolation') <> 'read committed'");
    const check = f.indexOf(
      "not exists (select 1 from public.admin_roles where role = 'admin')",
    );
    expect(lock).toBeGreaterThan(0);
    expect(iso).toBeGreaterThan(lock);
    expect(check).toBeGreaterThan(iso);
    expect(f).toMatch(
      /raise exception 'admin_guard_requires_read_committed' using errcode = '23001'/,
    );
    expect(f).toMatch(/raise exception 'last_admin_protected' using errcode = '23001'/);
    // Un UPDATE que deja al usuario como admin no es una degradación.
    expect(f).toMatch(/tg_op = 'UPDATE' and new\.role = 'admin'/);
  });

  it("lock por sentencia BEFORE INSERT/UPDATE/DELETE FOR EACH STATEMENT", () => {
    expect(code).toMatch(
      /create trigger admin_roles_lock_statement\s+before insert or update or delete on public\.admin_roles\s+for each statement/,
    );
    expect(fn("admin_roles_lock_statement")).toMatch(
      /perform public\.upmina_lock_admin_roles\(\)/,
    );
  });

  it("TRUNCATE siempre falla (trigger) y user_id/granted_at son inmutables", () => {
    expect(code).toMatch(
      /create trigger admin_roles_no_truncate\s+before truncate on public\.admin_roles\s+for each statement/,
    );
    expect(fn("admin_roles_no_truncate")).toMatch(
      /raise exception 'admin_roles_truncate_not_allowed'/,
    );
    const f = fn("admin_roles_immutable_identity");
    expect(f).toMatch(/new\.user_id is distinct from old\.user_id/);
    expect(f).toMatch(/new\.granted_at is distinct from old\.granted_at/);
    expect(f).toMatch(
      /new\.granted_by is distinct from old\.granted_by and new\.granted_by is not null/,
    );
  });
});

describe("migración 9B — lock único", () => {
  it("una única clave advisory, en una única función; ningún otro pg_advisory en el archivo", () => {
    const f = fn("upmina_lock_admin_roles");
    expect(f).toMatch(
      /pg_catalog\.pg_advisory_xact_lock\(\s*pg_catalog\.hashtextextended\('upmina:admin_roles:v1', 0\)\s*\)/,
    );
    expect(code.match(/pg_advisory/g)).toHaveLength(1);
    expect(code.match(/hashtext/g)).toHaveLength(1);
    expect(code).not.toMatch(/admin_bootstrap/);
  });

  it("consume, guard, trigger de lock e inserción de invitaciones usan el lock compartido", () => {
    for (const name of [
      "consume_admin_invitation",
      "admin_roles_last_admin_guard",
      "admin_roles_lock_statement",
      "admin_invitations_before_insert",
    ]) {
      expect(fn(name)).toMatch(/perform public\.upmina_lock_admin_roles\(\)/);
    }
  });
});

describe("migración 9B — SECURITY DEFINER / INVOKER", () => {
  const definer = ["admin_roles_revoke_pending_bootstrap", "consume_admin_invitation"];
  const invoker = [
    "upmina_lock_admin_roles",
    "admin_roles_lock_statement",
    "admin_roles_no_truncate",
    "admin_roles_immutable_identity",
    "admin_roles_last_admin_guard",
    "admin_invitations_before_insert",
    "admin_invitations_immutable",
  ];

  it.each(definer)("%s es SECURITY DEFINER con search_path fijo", (name) => {
    const h = header(name);
    expect(h).toMatch(/security definer/);
    expect(h).toMatch(/set search_path = pg_catalog, public/);
  });

  it.each(invoker)("%s es SECURITY INVOKER (no DEFINER) con search_path fijo", (name) => {
    const h = header(name);
    expect(h).toMatch(/security invoker/);
    expect(h).not.toMatch(/security definer/);
    expect(h).toMatch(/set search_path = pg_catalog, public/);
  });

  it("no hay ninguna otra función en la migración", () => {
    const names = [...code.matchAll(/create or replace function public\.(\w+)\(/g)].map(
      (m) => m[1],
    );
    expect(names.sort()).toEqual([...definer, ...invoker].sort());
  });
});

describe("migración 9B — consume_admin_invitation", () => {
  const f = fn("consume_admin_invitation");

  it("orden exacto: lock, FOR UPDATE, existe, consumida, revocada, expirada, usuario, bootstrap/standard, consumo, insert", () => {
    const marks = [
      "perform public.upmina_lock_admin_roles()",
      "for update;",
      "raise exception 'invitation_not_found'",
      "raise exception 'invitation_already_consumed'",
      "raise exception 'invitation_revoked'",
      "raise exception 'invitation_expired'",
      "raise exception 'user_already_privileged'",
      "raise exception 'admin_already_exists'",
      "raise exception 'invitation_creator_not_admin'",
      "set consumed_at = now(), consumed_by = p_user_id",
      "insert into public.admin_roles",
      "return query select v_row.role",
    ];
    const positions = marks.map((m) => f.indexOf(m));
    positions.forEach((p, i) => expect(p, marks[i]).toBeGreaterThan(-1));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("rechaza usuario ya privilegiado y exige que el creador standard siga siendo ADMIN", () => {
    expect(f).toMatch(/ar\.user_id = p_user_id/);
    expect(f).toMatch(/v_row\.created_by is null/);
    expect(f).toMatch(/ar\.user_id = v_row\.created_by and ar\.role = 'admin'/);
  });

  it("solo concede el rol almacenado en la invitación (nunca developer, nunca del cliente)", () => {
    expect(f).toMatch(/values \(p_user_id, v_row\.role, v_row\.created_by\)/);
    expect(f).not.toMatch(/developer/);
  });

  it("los mensajes coinciden con la lista cerrada del handler", () => {
    const handler = readFileSync(resolve(__dirname, "admin-handlers.ts"), "utf8");
    const raised = [...f.matchAll(/raise exception '(\w+)'/g)].map((m) => m[1]);
    expect(raised.sort()).toEqual(
      [
        "invitation_not_found",
        "invitation_already_consumed",
        "invitation_revoked",
        "invitation_expired",
        "user_already_privileged",
        "admin_already_exists",
        "invitation_creator_not_admin",
      ].sort(),
    );
    for (const message of raised) {
      expect(handler).toContain(`"${message}"`);
    }
  });
});

describe("migración 9B — privilegios", () => {
  // Modelo por ALLOWLIST: por tabla, `revoke all privileges ... from service_role` seguido de UN
  // `grant` mínimo. Verifica el modelo, no una lista parcial de REVOKEs (MAINTAIN de PostgreSQL 17
  // y cualquier privilegio futuro quedan cubiertos por REVOKE ALL).
  const ALLOWLIST: Record<string, string[]> = {
    admin_roles: ["select"],
    admin_invitations: ["insert", "select"],
  };

  /** Sentencias `<verb> <privs> on table public.<table> <from|to> <roles>;` del SQL sin comentarios. */
  function statements(verb: "revoke" | "grant", table: string) {
    const preposition = verb === "revoke" ? "from" : "to";
    const re = new RegExp(
      String.raw`${verb}\s+([^;]*?)\s+on\s+table\s+public\.${table}\s+${preposition}\s+([^;]*);`,
      "gi",
    );
    return [...code.matchAll(re)].map((m) => ({
      privileges: m[1].trim().toLowerCase(),
      roles: m[2].trim().toLowerCase(),
      index: m.index ?? -1,
    }));
  }

  it.each(Object.entries(ALLOWLIST))(
    "%s: revoke all privileges a service_role y un único grant con la allowlist %j",
    (table, allowed) => {
      const revokes = statements("revoke", table).filter((s) =>
        /service_role/.test(s.roles),
      );
      expect(revokes).toHaveLength(1);
      expect(revokes[0].privileges).toBe("all privileges");

      const grants = statements("grant", table);
      expect(grants).toHaveLength(1);
      expect(grants[0].roles).toBe("service_role");
      const granted = grants[0].privileges.split(",").map((p) => p.trim());
      expect([...granted].sort()).toEqual([...allowed].sort());

      // El grant va DESPUÉS del revoke (si no, la allowlist quedaría anulada).
      expect(grants[0].index).toBeGreaterThan(revokes[0].index);
    },
  );

  it("regresión: ningún grant de delete/update/truncate/references/trigger/maintain/all sobre las tablas privilegiadas", () => {
    for (const table of Object.keys(ALLOWLIST)) {
      for (const g of statements("grant", table)) {
        expect(g.privileges).not.toMatch(
          /\b(delete|update|truncate|references|trigger|maintain|all)\b/,
        );
      }
      // Tampoco por sintaxis alternativa (sin la palabra TABLE).
      const bare = new RegExp(String.raw`grant\s+[^;]*\bon\s+public\.${table}\b`, "i");
      expect(code).not.toMatch(bare);
    }
    expect(code).not.toMatch(/grant\s+[^;]*on\s+all\s+tables/i);
  });

  it("no queda una denylist parcial de privilegios (ya no se enumeran REVOKEs sueltos de tabla)", () => {
    expect(code).not.toMatch(
      /revoke\s+(?:insert|update|delete|truncate|references|trigger|maintain)\b[^;]*on\s+table\s+public\.admin_(roles|invitations)/i,
    );
  });

  it("funciones trigger: EXECUTE revocado a public, anon, authenticated y service_role", () => {
    for (const name of [
      "admin_roles_lock_statement",
      "admin_roles_no_truncate",
      "admin_roles_immutable_identity",
      "admin_roles_last_admin_guard",
      "admin_roles_revoke_pending_bootstrap",
      "admin_invitations_before_insert",
      "admin_invitations_immutable",
    ]) {
      expect(code).toMatch(
        new RegExp(
          `revoke all on function public\\.${name}\\(\\)\\s+from public, anon, authenticated, service_role;`,
        ),
      );
      expect(code).not.toMatch(new RegExp(`grant execute on function public\\.${name}`));
    }
  });

  it("lock: EXECUTE solo para service_role entre los roles de aplicación", () => {
    expect(code).toMatch(
      /revoke all on function public\.upmina_lock_admin_roles\(\)\s+from public, anon, authenticated, service_role;/,
    );
    expect(code).toMatch(
      /grant execute on function public\.upmina_lock_admin_roles\(\) to service_role;/,
    );
  });

  it("consume_admin_invitation: EXECUTE solo service_role", () => {
    expect(code).toMatch(
      /revoke all on function public\.consume_admin_invitation\(text, uuid\) from public;/,
    );
    expect(code).toMatch(
      /revoke execute on function public\.consume_admin_invitation\(text, uuid\) from anon;/,
    );
    expect(code).toMatch(
      /revoke execute on function public\.consume_admin_invitation\(text, uuid\) from authenticated;/,
    );
    expect(code).toMatch(
      /grant execute on function public\.consume_admin_invitation\(text, uuid\) to service_role;/,
    );
  });

  it("no concede nada a anon/authenticated/public sobre las tablas ni desactiva RLS", () => {
    expect(code).not.toMatch(/grant [^;]* to (anon|authenticated|public)/i);
    expect(code).not.toMatch(/disable row level security/i);
    expect(code).not.toMatch(/no force row level security/i);
    expect(code).not.toMatch(/create policy/i);
  });
});
