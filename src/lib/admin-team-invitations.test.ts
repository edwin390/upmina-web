import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import router from "../../api/admin/[action]";
import { hashInvitationToken } from "./admin-invitation-token";
import {
  deriveInvitationStatus,
  TEAM_INVITATION_EXPIRY_MS,
} from "./admin-team-invitations";

// Bloque 9D. Se ejecutan el despachador, los handlers y requireCapability REALES; el cliente de
// Supabase es un falso en memoria que reproduce las reglas de la base de datos que el handler
// NO debe reimplementar (trigger de creador ADMIN al insertar; reglas de revoke_admin_invitation).
// El comportamiento real de esas reglas (y consume vs revoke) lo cubre el harness contra una base
// PostgreSQL desechable; aquí se fija el contrato HTTP, la autorización y que jamás se filtre un
// secreto ni se use UPDATE/DELETE directo.

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const MOD_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const DEV_ID = "55555555-5555-4555-8555-555555555555";
const INV_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const TOKENS: Record<string, { sub: string; aal: string; amr?: unknown }> = {
  "jwt-admin-aal2": {
    sub: ADMIN_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }],
  },
  "jwt-admin-aal1": { sub: ADMIN_ID, aal: "aal1" },
  // 9G-1: aal2 pero el último TOTP venció (fuera de la ventana), o sin amr en absoluto.
  "jwt-admin-aal2-stale": {
    sub: ADMIN_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) - 3600 }],
  },
  "jwt-admin-aal2-noamr": { sub: ADMIN_ID, aal: "aal2" },
  "jwt-moderator-aal2-stale": {
    sub: MOD_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) - 3600 }],
  },
  "jwt-user-aal2-stale": {
    sub: USER_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) - 3600 }],
  },
  "jwt-moderator-aal2": {
    sub: MOD_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }],
  },
  "jwt-developer-aal2": {
    sub: DEV_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }],
  },
  "jwt-user-aal2": {
    sub: USER_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }],
  },
};

type Row = Record<string, unknown>;

const fake = vi.hoisted(() => ({
  roles: {} as Record<string, string | undefined>,
  rows: [] as Row[],
  inserts: [] as Row[],
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  selectColumns: [] as string[],
  directWrites: 0, // update()/delete() sobre cualquier tabla
  tablesTouched: [] as string[],
  rolesError: undefined as unknown,
  insertError: undefined as unknown,
  listError: undefined as unknown,
  listRaw: false, // devuelve las filas SIN proyectar (simula una consulta futura que trajera todo)
  rpcOverride: undefined as { data: unknown; error: unknown } | undefined,
  rpcThrow: undefined as unknown,
  nextId: 1,
}));

const uuid = (n: number) => `bbbbbbbb-bbbb-4bbb-8bbb-${n.toString(16).padStart(12, "0")}`;

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      async getClaims(jwt: string) {
        const claims = TOKENS[jwt];
        return claims
          ? { data: { claims }, error: null }
          : { data: null, error: { message: "jwt inválido" } };
      },
    },
    from: (table: string) => {
      fake.tablesTouched.push(table);
      if (table === "admin_roles") {
        return {
          select: () => {
            let userId = "";
            const builder = {
              eq(_c: string, v: string) {
                userId = v;
                return builder;
              },
              async maybeSingle() {
                if (fake.rolesError) return { data: null, error: fake.rolesError };
                const role = fake.roles[userId];
                return { data: role ? { role } : null, error: null };
              },
            };
            return builder;
          },
        };
      }
      if (table !== "admin_invitations") throw new Error(`tabla inesperada: ${table}`);
      const project = (row: Row, columns: string) =>
        Object.fromEntries(columns.split(",").map((c) => [c.trim(), row[c.trim()]]));
      return {
        update() {
          fake.directWrites++;
          throw new Error("UPDATE directo no permitido");
        },
        delete() {
          fake.directWrites++;
          throw new Error("DELETE directo no permitido");
        },
        select(columns: string) {
          fake.selectColumns.push(columns);
          const q = {
            order: () => q,
            async limit() {
              if (fake.listError) return { data: null, error: fake.listError };
              return {
                data: fake.rows.map((r) =>
                  fake.listRaw ? { ...r } : project(r, columns),
                ),
                error: null,
              };
            },
          };
          return q;
        },
        insert(payload: Row) {
          fake.inserts.push(payload);
          return {
            select: (columns: string) => ({
              async single() {
                if (fake.insertError) return { data: null, error: fake.insertError };
                if (fake.roles[String(payload.created_by)] !== "admin") {
                  return {
                    data: null,
                    error: { code: "23000", message: "invitation_creator_not_admin" },
                  };
                }
                const row: Row = {
                  ...payload,
                  id: uuid(fake.nextId++),
                  created_at: "2026-09-25T12:00:00.000Z",
                  consumed_at: null,
                  consumed_by: null,
                  revoked_at: null,
                  revoked_by: null,
                };
                fake.rows.push(row);
                return { data: project(row, columns), error: null };
              },
            }),
          };
        },
      };
    },
    async rpc(name: string, args: Record<string, unknown>) {
      fake.rpcCalls.push({ name, args });
      if (fake.rpcThrow) throw fake.rpcThrow;
      if (fake.rpcOverride) return fake.rpcOverride;
      const err = (message: string) => ({
        data: null,
        error: { code: "P0001", message },
      });
      if (fake.roles[String(args.p_actor_user_id)] !== "admin")
        return err("actor_not_admin");
      const row = fake.rows.find((r) => r.id === args.p_invitation_id);
      if (!row) return err("invitation_not_found");
      if (row.invitation_type !== "standard") return err("invitation_not_revocable");
      if (row.consumed_at) return err("invitation_already_consumed");
      if (row.revoked_at) return err("invitation_already_revoked");
      if (Date.parse(String(row.expires_at)) < Date.now())
        return err("invitation_expired");
      row.revoked_at = new Date().toISOString();
      row.revoked_by = args.p_actor_user_id;
      return { data: [{ out_revoked_at: row.revoked_at }], error: null };
    },
  }),
}));

function mockRes() {
  const state: { status?: number; body?: unknown; headers: Record<string, string> } = {
    headers: {},
  };
  const res = {
    setHeader(name: string, value: string) {
      state.headers[name] = value;
      return res;
    },
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  };
  return { res: res as unknown as VercelResponse, state };
}

function req(opts: {
  method?: string;
  token?: string | null;
  action?: string;
  body?: unknown;
}) {
  const headers: Record<string, string> = {};
  if (opts.token !== null)
    headers.authorization = `Bearer ${opts.token ?? "jwt-admin-aal2"}`;
  return {
    method: opts.method ?? "POST",
    headers,
    query: { action: opts.action ?? "team-invitations" },
    body: opts.body,
  } as unknown as VercelRequest;
}

async function call(request: VercelRequest) {
  const { res, state } = mockRes();
  await router(request, res);
  return state;
}

const create = (body: unknown, token?: string | null) =>
  call(req({ method: "POST", body, token }));
const list = (token?: string | null) => call(req({ method: "GET", token }));
const revoke = (body: unknown, token?: string | null) =>
  call(req({ method: "POST", action: "team-invitations-revoke", body, token }));

function seedRow(over: Row = {}): Row {
  const row: Row = {
    id: INV_ID,
    token_hash: "h".repeat(64),
    role: "moderator",
    invitation_type: "standard",
    created_by: ADMIN_ID,
    created_at: "2026-09-20T12:00:00.000Z",
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    consumed_at: null,
    consumed_by: null,
    revoked_at: null,
    revoked_by: null,
    ...over,
  };
  fake.rows.push(row);
  return row;
}

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://proyecto-ficticio.supabase.co");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-ficticia");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "srk-service-role-ficticia");
  fake.roles = {
    [ADMIN_ID]: "admin",
    [MOD_ID]: "moderator",
    [DEV_ID]: "developer",
  };
  fake.rows = [];
  fake.inserts = [];
  fake.rpcCalls = [];
  fake.selectColumns = [];
  fake.directWrites = 0;
  fake.tablesTouched = [];
  fake.rolesError = undefined;
  fake.insertError = undefined;
  fake.listError = undefined;
  fake.listRaw = false;
  fake.rpcOverride = undefined;
  fake.rpcThrow = undefined;
  fake.nextId = 1;
});

const DENIED = [
  { who: "ADMIN con AAL1", token: "jwt-admin-aal1", status: 403 },
  { who: "DEVELOPER con AAL2", token: "jwt-developer-aal2", status: 403 },
  { who: "MODERATOR con AAL2", token: "jwt-moderator-aal2", status: 403 },
  { who: "USER (sin rol) con AAL2", token: "jwt-user-aal2", status: 403 },
  { who: "JWT inválido", token: "jwt-que-no-existe", status: 401 },
  { who: "sin Bearer", token: null, status: 401 },
];

describe("autorización team_admin (capacidad real, sin social_admin ni requirePrivileged)", () => {
  describe.each(DENIED)("$who", ({ token, status }) => {
    it(`crear → ${status}, sin escribir nada`, async () => {
      const s = await create({ role: "moderator" }, token);
      expect(s.status).toBe(status);
      expect(fake.inserts).toHaveLength(0);
      expect(fake.tablesTouched).not.toContain("admin_invitations");
    });
    it(`listar → ${status}, sin leer invitaciones`, async () => {
      const s = await list(token);
      expect(s.status).toBe(status);
      expect(fake.tablesTouched).not.toContain("admin_invitations");
    });
    it(`revocar → ${status}, sin llamar a la RPC`, async () => {
      const s = await revoke({ id: INV_ID }, token);
      expect(s.status).toBe(status);
      expect(fake.rpcCalls).toHaveLength(0);
    });
  });

  it("ADMIN + AAL2 puede crear, listar y revocar", async () => {
    expect((await create({ role: "admin" })).status).toBe(201);
    expect((await list()).status).toBe(200);
    const id = String((fake.rows[0] as Row).id);
    expect((await revoke({ id })).status).toBe(200);
  });

  it("un fallo de infraestructura al leer admin_roles es 500 genérico, nunca 403 ni escritura", async () => {
    fake.rolesError = { code: "57014", message: "detalle interno de postgres" };
    for (const s of [
      await create({ role: "admin" }),
      await list(),
      await revoke({ id: INV_ID }),
    ]) {
      expect(s.status).toBe(500);
      expect(s.body).toEqual({ error: "Error interno" });
    }
    expect(fake.inserts).toHaveLength(0);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("identidad y rol enviados por el cliente no cuentan (body/query/headers)", async () => {
    const s = await call({
      ...req({ token: "jwt-moderator-aal2", body: { role: "admin", userId: ADMIN_ID } }),
      query: { action: "team-invitations", role: "admin", user_id: ADMIN_ID },
    } as unknown as VercelRequest);
    expect(s.status).toBe(403);
    expect(fake.inserts).toHaveLength(0);
  });
});

describe("crear", () => {
  it.each(["admin", "moderator"] as const)(
    "invitación válida para %s → 201, siempre standard",
    async (role) => {
      const s = await create({ role });
      expect(s.status).toBe(201);
      const body = s.body as {
        invitation: Row;
        token: string;
        activation_path: string;
      };
      expect(body.invitation).toMatchObject({
        role,
        invitation_type: "standard",
        status: "pending",
        consumed_at: null,
        revoked_at: null,
      });
      expect(fake.inserts).toHaveLength(1);
      expect(fake.inserts[0].invitation_type).toBe("standard");
      expect(fake.inserts[0].role).toBe(role);
      expect(fake.inserts[0].created_by).toBe(ADMIN_ID);
      expect(s.headers["Cache-Control"]).toBe("no-store");
    },
  );

  it.each([
    ["developer", { role: "developer" }],
    ["valor desconocido", { role: "owner" }],
    ["mayúsculas", { role: "ADMIN" }],
    ["sin role", {}],
    ["role no string", { role: 1 }],
    ["body no objeto", "admin"],
    ["body array", ["admin"]],
    ["body ausente", undefined],
  ])("rechaza %s → 400, sin insertar", async (_n, body) => {
    const s = await create(body);
    expect(s.status).toBe(400);
    expect(s.body).toEqual({ error: "Solicitud inválida" });
    expect(fake.inserts).toHaveLength(0);
  });

  it("ignora invitation_type, created_by, expires_at y token_hash enviados por el cliente", async () => {
    const s = await create({
      role: "moderator",
      invitation_type: "bootstrap_admin",
      created_by: USER_ID,
      expires_at: "2099-01-01T00:00:00.000Z",
      token_hash: "x".repeat(64),
      revoked_at: "2026-01-01T00:00:00.000Z",
    });
    expect(s.status).toBe(201);
    const p = fake.inserts[0];
    expect(p.invitation_type).toBe("standard");
    expect(p.created_by).toBe(ADMIN_ID);
    expect(p.token_hash).not.toBe("x".repeat(64));
    expect(Object.keys(p).sort()).toEqual(
      ["created_by", "expires_at", "invitation_type", "role", "token_hash"].sort(),
    );
  });

  it("la DB recibe SOLO el hash SHA-256 del token; la respuesta lleva el token una vez", async () => {
    const s = await create({ role: "admin" });
    const { token, activation_path } = s.body as {
      token: string;
      activation_path: string;
    };
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // mismo formato que consume/activate acepta
    const p = fake.inserts[0];
    expect(p.token_hash).toBe(hashInvitationToken(token));
    expect(String(p.token_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(fake.inserts)).not.toContain(token);
    expect(JSON.stringify(fake.rows)).not.toContain(token);
    expect(activation_path).toBe(`/admin/activate#token=${token}`); // fragmento, no query string
  });

  it("cada creación genera un token distinto (aleatorio)", async () => {
    const a = (await create({ role: "admin" })).body as { token: string };
    const b = (await create({ role: "admin" })).body as { token: string };
    expect(a.token).not.toBe(b.token);
  });

  it("expiración explícita fijada por el servidor (7 días)", async () => {
    const before = Date.now();
    await create({ role: "moderator" });
    const exp = Date.parse(String(fake.inserts[0].expires_at));
    expect(exp).toBeGreaterThanOrEqual(before + TEAM_INVITATION_EXPIRY_MS - 1000);
    expect(exp).toBeLessThanOrEqual(Date.now() + TEAM_INVITATION_EXPIRY_MS + 1000);
  });

  it("ADMIN degradado entre autorizar e insertar: el trigger de DB rechaza → 403, sin token", async () => {
    // requireCapability lee el rol UNA vez; el falso del INSERT ve el rol ya cambiado.
    let reads = 0;
    const roles = fake.roles;
    Object.defineProperty(roles, ADMIN_ID, {
      configurable: true,
      get: () => (reads++ === 0 ? "admin" : "moderator"),
    });
    const s = await create({ role: "admin" });
    expect(s.status).toBe(403);
    expect(s.body).toEqual({ error: "No autorizado" });
    expect(JSON.stringify(s.body)).not.toMatch(/token|activation/);
  });

  it("error de INSERT → 500 genérico sin detalles ni token", async () => {
    fake.insertError = { code: "XX000", message: "detalle interno con SQL" };
    const s = await create({ role: "admin" });
    expect(s.status).toBe(500);
    expect(s.body).toEqual({ error: "Error interno" });
  });

  it("otros rechazos del trigger (P. ej. estado inicial inválido) no se traducen a 403", async () => {
    fake.insertError = { code: "23000", message: "invitation_insert_state_invalid" };
    expect((await create({ role: "admin" })).status).toBe(500);
  });

  it("sin configuración de Supabase → 500 genérico", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const s = await create({ role: "admin" });
    expect(s.status).toBe(500);
    expect(fake.inserts).toHaveLength(0);
  });

  it("método distinto de GET/POST → 405 con Allow, sin autenticar", async () => {
    const s = await call(req({ method: "DELETE" }));
    expect(s.status).toBe(405);
    expect(s.headers.Allow).toBe("GET, POST");
    expect(fake.tablesTouched).toHaveLength(0);
  });
});

describe("listar", () => {
  it("devuelve metadata con estado derivado y NUNCA token/token_hash/created_by", async () => {
    const now = Date.now();
    seedRow({ id: uuid(1), token_hash: "SECRETO-HASH-1" });
    seedRow({
      id: uuid(2),
      consumed_at: "2026-09-21T00:00:00.000Z",
      consumed_by: MOD_ID,
    });
    seedRow({
      id: uuid(3),
      revoked_at: "2026-09-21T00:00:00.000Z",
      revoked_by: ADMIN_ID,
    });
    seedRow({ id: uuid(4), expires_at: new Date(now - 1000).toISOString() });
    seedRow({
      id: uuid(5),
      invitation_type: "bootstrap_admin",
      role: "admin",
      created_by: null,
      consumed_at: "2026-09-01T00:00:00.000Z",
    });

    const s = await list();
    expect(s.status).toBe(200);
    expect(s.headers["Cache-Control"]).toBe("no-store");
    const { invitations } = s.body as { invitations: Row[] };
    expect(invitations.map((i) => i.status)).toEqual([
      "pending",
      "consumed",
      "revoked",
      "expired",
      "consumed",
    ]);
    for (const inv of invitations) {
      expect(Object.keys(inv).sort()).toEqual(
        [
          "consumed_at",
          "created_at",
          "expires_at",
          "id",
          "invitation_type",
          "revoked_at",
          "role",
          "status",
        ].sort(),
      );
    }
    const serialized = JSON.stringify(s.body);
    expect(serialized).not.toMatch(
      /token|hash|SECRETO|created_by|consumed_by|revoked_by/i,
    );
    expect(fake.selectColumns.join(",")).not.toMatch(/token/);
    expect(invitations[4]).toMatchObject({
      invitation_type: "bootstrap_admin",
      role: "admin",
    });
  });

  it("aunque la consulta trajera columnas extra, la respuesta no las incluye (whitelist por fila)", async () => {
    seedRow({ token_hash: "HASH-QUE-NO-DEBE-SALIR" });
    fake.listRaw = true;
    const s = await list();
    expect(s.status).toBe(200);
    expect(JSON.stringify(s.body)).not.toContain("HASH-QUE-NO-DEBE-SALIR");
    expect(JSON.stringify(s.body)).not.toMatch(/token_hash|created_by/);
  });

  it("lista vacía → 200 { invitations: [] }", async () => {
    const s = await list();
    expect(s.status).toBe(200);
    expect(s.body).toEqual({ invitations: [] });
  });

  it("error de lectura → 500 genérico; nunca una lista vacía", async () => {
    fake.listError = { code: "42501", message: "permission denied for table x" };
    const s = await list();
    expect(s.status).toBe(500);
    expect(s.body).toEqual({ error: "Error interno" });
  });

  it("fila con forma inesperada (rol fuera de admin/moderator, uuid inválido) → 500, no se filtra a medias", async () => {
    seedRow({ role: "developer" });
    expect((await list()).status).toBe(500);
    fake.rows = [];
    seedRow({ id: "no-es-uuid" });
    expect((await list()).status).toBe(500);
  });

  it("deriveInvitationStatus: consumida > revocada > expirada > pendiente", () => {
    const now = Date.UTC(2026, 8, 25);
    const future = new Date(now + 1000).toISOString();
    const past = new Date(now - 1000).toISOString();
    const t = "2026-09-01T00:00:00.000Z";
    expect(
      deriveInvitationStatus({ consumed_at: t, revoked_at: null, expires_at: past }, now),
    ).toBe("consumed");
    expect(
      deriveInvitationStatus({ consumed_at: null, revoked_at: t, expires_at: past }, now),
    ).toBe("revoked");
    expect(
      deriveInvitationStatus(
        { consumed_at: null, revoked_at: null, expires_at: past },
        now,
      ),
    ).toBe("expired");
    expect(
      deriveInvitationStatus(
        { consumed_at: null, revoked_at: null, expires_at: future },
        now,
      ),
    ).toBe("pending");
  });
});

describe("revocar", () => {
  it("standard pendiente → 200; llama SOLO a la RPC con el actor verificado; sin UPDATE/DELETE directo", async () => {
    seedRow();
    const s = await revoke({ id: INV_ID });
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ id: INV_ID, status: "revoked" });
    expect(fake.rpcCalls).toEqual([
      {
        name: "revoke_admin_invitation",
        args: { p_invitation_id: INV_ID, p_actor_user_id: ADMIN_ID },
      },
    ]);
    expect(fake.directWrites).toBe(0);
    expect(fake.rows[0].revoked_by).toBe(ADMIN_ID);
    expect(fake.rows).toHaveLength(1); // se conserva el historial
  });

  it("el actor sale del JWT, nunca del body", async () => {
    seedRow();
    await revoke({
      id: INV_ID,
      p_actor_user_id: USER_ID,
      actor: USER_ID,
      revoked_by: USER_ID,
    });
    expect(fake.rpcCalls[0].args.p_actor_user_id).toBe(ADMIN_ID);
  });

  it("id inexistente → 404 genérico", async () => {
    const s = await revoke({ id: INV_ID });
    expect(s.status).toBe(404);
    expect(s.body).toEqual({ error: "No encontrado" });
  });

  it.each([
    ["ya consumida", { consumed_at: "2026-09-21T00:00:00.000Z", consumed_by: MOD_ID }],
    ["ya revocada", { revoked_at: "2026-09-21T00:00:00.000Z", revoked_by: ADMIN_ID }],
    ["expirada", { expires_at: new Date(Date.now() - 1000).toISOString() }],
    [
      "bootstrap",
      { invitation_type: "bootstrap_admin", role: "admin", created_by: null },
    ],
  ])("%s → 409 con la MISMA respuesta (sin oráculo)", async (_n, over) => {
    seedRow(over);
    const s = await revoke({ id: INV_ID });
    expect(s.status).toBe(409);
    expect(s.body).toEqual({ error: "La invitación ya no se puede revocar" });
    expect(fake.rows[0].revoked_at ?? null).toBe((over as Row).revoked_at ?? null);
  });

  it("actor ya no ADMIN dentro de la RPC (degradado tras autenticar) → 403, sin revocar", async () => {
    seedRow();
    fake.rpcOverride = {
      data: null,
      error: { code: "P0001", message: "actor_not_admin" },
    };
    const s = await revoke({ id: INV_ID });
    expect(s.status).toBe(403);
    expect(s.body).toEqual({ error: "No autorizado" });
    expect(fake.rows[0].revoked_at).toBeNull();
  });

  it("segunda revocación (carrera perdida) → 409, la primera se conserva", async () => {
    seedRow();
    expect((await revoke({ id: INV_ID })).status).toBe(200);
    const first = fake.rows[0].revoked_at;
    expect((await revoke({ id: INV_ID })).status).toBe(409);
    expect(fake.rows[0].revoked_at).toBe(first);
  });

  it.each([
    ["sin id", {}],
    ["id no string", { id: 5 }],
    ["id no uuid", { id: "no-es-uuid" }],
    ["body ausente", undefined],
  ])("%s → 400 sin llamar a la RPC", async (_n, body) => {
    const s = await revoke(body);
    expect(s.status).toBe(400);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("errores no reconocidos de la RPC → 500 genérico (fail closed), sin detalles", async () => {
    for (const error of [
      { code: "P0001", message: "mensaje_nuevo_desconocido" },
      { code: "42501", message: "invitation_not_found" }, // code distinto: no es rechazo de negocio
      { code: "XX000", message: "SELECT secreto FROM x" },
    ]) {
      fake.rpcOverride = { data: null, error };
      const s = await revoke({ id: INV_ID });
      expect(s.status).toBe(500);
      expect(s.body).toEqual({ error: "Error interno" });
    }
  });

  it("respuesta de la RPC con forma inesperada o excepción → 500", async () => {
    fake.rpcOverride = { data: [], error: null };
    expect((await revoke({ id: INV_ID })).status).toBe(500);
    fake.rpcOverride = undefined;
    fake.rpcThrow = new Error("ECONNRESET secreto");
    const s = await revoke({ id: INV_ID });
    expect(s.status).toBe(500);
    expect(JSON.stringify(s.body)).not.toMatch(/ECONNRESET|secreto/);
  });

  it("GET a revoke → 405 con Allow: POST, sin autenticar", async () => {
    const s = await call(req({ method: "GET", action: "team-invitations-revoke" }));
    expect(s.status).toBe(405);
    expect(s.headers.Allow).toBe("POST");
    expect(fake.tablesTouched).toHaveLength(0);
  });
});

describe("9G-1 — MFA reciente: capacidad ANTES del step-up", () => {
  it.each([
    ["ADMIN aal2 con TOTP vencido", "jwt-admin-aal2-stale"],
    ["ADMIN aal2 sin amr", "jwt-admin-aal2-noamr"],
    ["ADMIN con aal1", "jwt-admin-aal1"],
  ])(
    "%s → 403 step_up_required en crear, listar y revocar, sin tocar datos",
    async (_n, token) => {
      for (const s of [
        await create({ role: "moderator" }, token),
        await list(token),
        await revoke({ id: INV_ID }, token),
      ]) {
        expect(s.status).toBe(403);
        expect(s.body).toEqual({ error: "No autorizado", code: "step_up_required" });
      }
      expect(fake.inserts).toHaveLength(0);
      expect(fake.rpcCalls).toHaveLength(0);
      expect(fake.tablesTouched).not.toContain("admin_invitations");
    },
  );

  it.each([
    ["MODERATOR con MFA vencido", "jwt-moderator-aal2-stale"],
    ["USER con MFA vencido", "jwt-user-aal2-stale"],
    ["USER con aal2 y MFA reciente", "jwt-user-aal2"],
  ])("%s → 403 genérico SIN code", async (_n, token) => {
    const s = await create({ role: "moderator" }, token);
    expect(s.status).toBe(403);
    expect(s.body).toEqual({ error: "No autorizado" });
    expect(fake.inserts).toHaveLength(0);
  });
});
