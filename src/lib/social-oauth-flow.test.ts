import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SOCIAL_OAUTH_FLOW_TTL_MS,
  SocialOAuthFlowError,
  claimSocialOAuthFlow,
  createSocialOAuthFlow,
  isSocialOAuthFlowCurrent,
  isSocialOAuthProvider,
  type SocialOAuthProvider,
} from "./social-oauth-flow";

// Fundación de la autorización OAuth vigente por proveedor (Bloque 8B). El cliente de
// Supabase se sustituye por una tabla en memoria que aplica la MISMA semántica que
// PostgREST/Postgres para lo que usa el módulo: upsert por PK que solo sobrescribe las
// columnas enviadas, UPDATE condicional con RETURNING evaluado de forma atómica y los CHECK
// relevantes de la migración. NO prueba el motor real (la atomicidad de Postgres se
// verifica contra Supabase real, fuera de este bloque).

interface Row {
  provider: string;
  nonce_hash: string;
  admin_user_id: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

const db = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  ops: [] as { op: string; table: string; detail?: unknown }[],
  /** Error devuelto por Supabase en la próxima operación (no una excepción). */
  errorNext: undefined as unknown,
  /** Excepción lanzada por el cliente en la próxima operación. */
  throwNext: undefined as unknown,
  clientKeys: [] as string[],
  /** CHECK de la migración aplicados en el fake. */
  violations: [] as string[],
}));

type Pred = (row: Record<string, unknown>) => boolean;

function timeOf(value: unknown): number {
  return Date.parse(String(value));
}

function checkConstraints(row: Record<string, unknown>): string | null {
  if (row.provider !== "instagram" && row.provider !== "tiktok") return "provider_check";
  if (typeof row.nonce_hash !== "string" || !/^[0-9a-f]{64}$/.test(row.nonce_hash))
    return "nonce_hash_format";
  if (!(timeOf(row.expires_at) > timeOf(row.created_at))) return "expiry_after_creation";
  if (row.consumed_at !== null && !(timeOf(row.consumed_at) >= timeOf(row.created_at)))
    return "consumed_after_creation";
  return null;
}

function takeFailure(): { error: unknown } | null {
  if (db.throwNext !== undefined) {
    const err = db.throwNext;
    db.throwNext = undefined;
    throw err;
  }
  if (db.errorNext !== undefined) {
    const error = db.errorNext;
    db.errorNext = undefined;
    return { error };
  }
  return null;
}

function project(row: Record<string, unknown>, columns: string) {
  const out: Record<string, unknown> = {};
  for (const column of columns.split(",").map((c) => c.trim())) out[column] = row[column];
  return out;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, key: string) => {
    db.clientKeys.push(key);
    return {
      from: (table: string) => ({
        async upsert(row: Record<string, unknown>, options: { onConflict?: string }) {
          db.ops.push({ op: "upsert", table, detail: { row, options } });
          const failure = takeFailure();
          if (failure) return failure;
          const key = String(row[options.onConflict ?? "provider"]);
          // Una fila nueva parte con consumed_at NULL (columna sin default = NULL); una existente
          // conserva lo que no se envía (semántica de upsert).
          const merged = { consumed_at: null, ...(db.rows.get(key) ?? {}), ...row };
          const violation = checkConstraints(merged);
          if (violation) {
            db.violations.push(violation);
            return { error: { code: "23514" } };
          }
          db.rows.set(key, merged);
          return { error: null };
        },
        async insert(row: Record<string, unknown>) {
          db.ops.push({ op: "insert", table, detail: { row } });
          const failure = takeFailure();
          if (failure) return failure;
          const key = String(row.provider);
          if (db.rows.has(key)) return { error: { code: "23505" } };
          const full = { consumed_at: null, ...row };
          if (checkConstraints(full)) return { error: { code: "23514" } };
          db.rows.set(key, full);
          return { error: null };
        },
        update(values: Record<string, unknown>) {
          const preds: Pred[] = [];
          const filters: string[] = [];
          const args: unknown[] = [];
          const builder = {
            eq(column: string, value: unknown) {
              filters.push(`eq:${column}`);
              args.push(value);
              preds.push((row) => row[column] === value);
              return builder;
            },
            is(column: string, value: null) {
              filters.push(`is:${column}`);
              args.push(value);
              preds.push((row) => row[column] === value);
              return builder;
            },
            gt(column: string, value: string) {
              filters.push(`gt:${column}`);
              args.push(value);
              preds.push((row) => timeOf(row[column]) > timeOf(value));
              return builder;
            },
            async select(columns: string) {
              db.ops.push({ op: "update", table, detail: { values, filters, args } });
              const failure = takeFailure();
              if (failure) return { data: null, ...failure };
              // Atómico: filtrar y aplicar sin cesión de control entre medias.
              const matched: Record<string, unknown>[] = [];
              for (const [key, row] of db.rows) {
                if (preds.every((p) => p(row))) {
                  const updated = { ...row, ...values };
                  db.rows.set(key, updated);
                  matched.push(project(updated, columns));
                }
              }
              return { data: matched, error: null };
            },
          };
          return builder;
        },
        select(columns: string) {
          const preds: Pred[] = [];
          const filters: string[] = [];
          const args: unknown[] = [];
          const builder = {
            eq(column: string, value: unknown) {
              filters.push(`eq:${column}`);
              args.push(value);
              preds.push((row) => row[column] === value);
              return builder;
            },
            not(column: string, operator: string, value: null) {
              filters.push(`not:${column}`);
              args.push(value);
              expect(operator).toBe("is");
              preds.push((row) => row[column] !== value);
              return builder;
            },
            async maybeSingle() {
              db.ops.push({ op: "select", table, detail: { filters, args } });
              const failure = takeFailure();
              if (failure) return { data: null, ...failure };
              const found = [...db.rows.values()].filter((row) =>
                preds.every((p) => p(row)),
              );
              return { data: found[0] ? project(found[0], columns) : null, error: null };
            },
          };
          return builder;
        },
      }),
    };
  },
}));

const SERVICE_ROLE_KEY = "srk-service-role-ficticia";
const ADMIN_A = "11111111-1111-4111-8111-111111111111";
const ADMIN_B = "22222222-2222-4222-8222-222222222222";
const NONCE_A = "nonce-sintetico-A-0000000000000000";
const NONCE_B = "nonce-sintetico-B-0000000000000000";
const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const row = (provider: SocialOAuthProvider) => db.rows.get(provider) as unknown as Row;

beforeEach(() => {
  db.rows.clear();
  db.ops = [];
  db.errorNext = undefined;
  db.throwNext = undefined;
  db.clientKeys = [];
  db.violations = [];
  vi.stubEnv("VITE_SUPABASE_URL", "https://proyecto-ficticio.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function rejection(fn: () => Promise<unknown>): Promise<SocialOAuthFlowError> {
  try {
    await fn();
  } catch (err) {
    return err as SocialOAuthFlowError;
  }
  throw new Error("se esperaba que la promesa rechazara");
}

describe("createSocialOAuthFlow", () => {
  it.each(["instagram", "tiktok"] as const)(
    "%s: crea la fila del proveedor",
    async (p) => {
      const created = await createSocialOAuthFlow(p, NONCE_A, ADMIN_A, T0);
      expect(created).toEqual({ expiresAt: T0 + SOCIAL_OAUTH_FLOW_TTL_MS });
      expect(row(p)).toEqual({
        provider: p,
        nonce_hash: sha256(NONCE_A),
        admin_user_id: ADMIN_A,
        created_at: new Date(T0).toISOString(),
        expires_at: new Date(T0 + SOCIAL_OAUTH_FLOW_TTL_MS).toISOString(),
        consumed_at: null,
      });
      expect(db.violations).toEqual([]);
    },
  );

  it("proveedor inválido → invalid_provider, sin tocar la base de datos", async () => {
    for (const bad of ["facebook", "", "INSTAGRAM", undefined, null, 1]) {
      const error = await rejection(() =>
        createSocialOAuthFlow(bad as never, NONCE_A, ADMIN_A, T0),
      );
      expect(error).toBeInstanceOf(SocialOAuthFlowError);
      expect(error.kind).toBe("invalid_provider");
    }
    expect(db.ops).toHaveLength(0);
    expect(db.clientKeys).toHaveLength(0);
  });

  it("entradas inválidas (nonce vacío o no string, admin no UUID) → invalid_input", async () => {
    for (const nonce of ["", undefined, null, 42]) {
      const error = await rejection(() =>
        createSocialOAuthFlow("instagram", nonce as never, ADMIN_A, T0),
      );
      expect(error.kind).toBe("invalid_input");
    }
    for (const admin of ["", "no-es-uuid", undefined, null, "1".repeat(36)]) {
      const error = await rejection(() =>
        createSocialOAuthFlow("instagram", NONCE_A, admin as never, T0),
      );
      expect(error.kind).toBe("invalid_input");
    }
    expect(db.ops).toHaveLength(0);
  });

  it("guarda SOLO el SHA-256 hex en minúsculas del nonce, nunca el nonce en claro", async () => {
    await createSocialOAuthFlow("instagram", NONCE_A, ADMIN_A, T0);
    const persisted = row("instagram").nonce_hash;
    expect(persisted).toMatch(/^[0-9a-f]{64}$/);
    expect(persisted).toBe(sha256(NONCE_A));
    const wire = JSON.stringify(db.ops) + JSON.stringify([...db.rows.values()]);
    expect(wire).not.toContain(NONCE_A);
  });

  it("TTL de 10 minutos exactos; created_at y expires_at salen del mismo instante", async () => {
    expect(SOCIAL_OAUTH_FLOW_TTL_MS).toBe(600_000);
    await createSocialOAuthFlow("tiktok", NONCE_A, ADMIN_A, T0);
    const r = row("tiktok");
    expect(Date.parse(r.created_at)).toBe(T0);
    expect(Date.parse(r.expires_at) - Date.parse(r.created_at)).toBe(600_000);
  });

  it("es UN único upsert por provider: sin SELECT previo ni otras operaciones", async () => {
    await createSocialOAuthFlow("instagram", NONCE_A, ADMIN_A, T0);
    expect(db.ops).toHaveLength(1);
    expect(db.ops[0].op).toBe("upsert");
    expect(db.ops[0].table).toBe("social_oauth_flows");
    expect((db.ops[0].detail as { options: unknown }).options).toEqual({
      onConflict: "provider",
    });
  });

  it("envía consumed_at = null explícito: reiniciar tras consumir deja el flujo nuevo reclamable", async () => {
    await createSocialOAuthFlow("instagram", NONCE_A, ADMIN_A, T0);
    await claimSocialOAuthFlow("instagram", NONCE_A, T0 + 1_000);
    expect(row("instagram").consumed_at).not.toBeNull();

    await createSocialOAuthFlow("instagram", NONCE_B, ADMIN_A, T0 + 2_000);
    expect(row("instagram").consumed_at).toBeNull();
    const sent = (db.ops[db.ops.length - 1].detail as { row: Record<string, unknown> })
      .row;
    expect(Object.prototype.hasOwnProperty.call(sent, "consumed_at")).toBe(true);
    expect(sent.consumed_at).toBeNull();
    await expect(
      claimSocialOAuthFlow("instagram", NONCE_B, T0 + 3_000),
    ).resolves.toMatchObject({ status: "claimed" });
  });

  it("un segundo create del mismo provider REEMPLAZA al primero (nonce, admin, tiempos)", async () => {
    await createSocialOAuthFlow("instagram", NONCE_A, ADMIN_A, T0);
    await createSocialOAuthFlow("instagram", NONCE_B, ADMIN_B, T0 + 5_000);
    expect(db.rows.size).toBe(1);
    expect(row("instagram")).toMatchObject({
      nonce_hash: sha256(NONCE_B),
      admin_user_id: ADMIN_B,
      created_at: new Date(T0 + 5_000).toISOString(),
      expires_at: new Date(T0 + 5_000 + SOCIAL_OAUTH_FLOW_TTL_MS).toISOString(),
    });
  });

  it("un provider distinto no interfiere: hay una fila por provider", async () => {
    await createSocialOAuthFlow("instagram", NONCE_A, ADMIN_A, T0);
    await createSocialOAuthFlow("tiktok", NONCE_B, ADMIN_B, T0 + 1_000);
    expect(db.rows.size).toBe(2);
    expect(row("instagram").nonce_hash).toBe(sha256(NONCE_A));
    expect(row("tiktok").nonce_hash).toBe(sha256(NONCE_B));
    expect(row("instagram").admin_user_id).toBe(ADMIN_A);
  });

  it("error de Supabase → infraestructura fail-closed, con código saneado y sin filtrar texto", async () => {
    db.errorNext = { code: "42501", message: `permission denied ${NONCE_A} ${ADMIN_A}` };
    const error = await rejection(() =>
      createSocialOAuthFlow("instagram", NONCE_A, ADMIN_A, T0),
    );
    expect(error.kind).toBe("infrastructure");
    expect(error.code).toBe("42501");
    expect(JSON.stringify({ m: error.message, c: error.code })).not.toContain(NONCE_A);
    expect(JSON.stringify({ m: error.message })).not.toContain("permission denied");
  });

  it("excepción del cliente (red) → infraestructura; sin fila escrita", async () => {
    db.throwNext = new Error("ECONNRESET con datos internos");
    const error = await rejection(() =>
      createSocialOAuthFlow("instagram", NONCE_A, ADMIN_A, T0),
    );
    expect(error.kind).toBe("infrastructure");
    expect(error.message).not.toContain("ECONNRESET");
    expect(db.rows.size).toBe(0);
  });

  it("sin configuración de Supabase → infraestructura, sin crear cliente", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const error = await rejection(() =>
      createSocialOAuthFlow("instagram", NONCE_A, ADMIN_A, T0),
    );
    expect(error.kind).toBe("infrastructure");
    expect(db.clientKeys).toHaveLength(0);
  });

  it("usa la service_role key (y ninguna otra)", async () => {
    await createSocialOAuthFlow("instagram", NONCE_A, ADMIN_A, T0);
    expect(db.clientKeys).toEqual([SERVICE_ROLE_KEY]);
  });
});

describe("claimSocialOAuthFlow", () => {
  beforeEach(async () => {
    await createSocialOAuthFlow("instagram", NONCE_A, ADMIN_A, T0);
    db.ops = [];
  });

  it("flujo vigente → claimed con el adminUserId y consumed_at fijado", async () => {
    const result = await claimSocialOAuthFlow("instagram", NONCE_A, T0 + 60_000);
    expect(result).toEqual({ status: "claimed", adminUserId: ADMIN_A });
    expect(row("instagram").consumed_at).toBe(new Date(T0 + 60_000).toISOString());
  });

  it("es UN solo UPDATE condicional con los cuatro filtros: sin SELECT previo", async () => {
    await claimSocialOAuthFlow("instagram", NONCE_A, T0 + 1_000);
    expect(db.ops).toHaveLength(1);
    expect(db.ops[0].op).toBe("update");
    expect((db.ops[0].detail as { filters: string[] }).filters.sort()).toEqual(
      ["eq:nonce_hash", "eq:provider", "gt:expires_at", "is:consumed_at"].sort(),
    );
  });

  it("nonce incorrecto → not_claimable, y NO consume el flujo legítimo", async () => {
    const result = await claimSocialOAuthFlow("instagram", NONCE_B, T0 + 1_000);
    expect(result).toEqual({ status: "not_claimable" });
    expect(row("instagram").consumed_at).toBeNull();
    await expect(
      claimSocialOAuthFlow("instagram", NONCE_A, T0 + 2_000),
    ).resolves.toMatchObject({ status: "claimed" });
  });

  it("provider incorrecto → not_claimable, sin modificar la fila del otro proveedor", async () => {
    const result = await claimSocialOAuthFlow("tiktok", NONCE_A, T0 + 1_000);
    expect(result).toEqual({ status: "not_claimable" });
    expect(row("instagram").consumed_at).toBeNull();
  });

  it("expirado → not_claimable (límite: en expires_at exacto ya no es válido)", async () => {
    const expiresAt = T0 + SOCIAL_OAUTH_FLOW_TTL_MS;
    expect(await claimSocialOAuthFlow("instagram", NONCE_A, expiresAt)).toEqual({
      status: "not_claimable",
    });
    expect(await claimSocialOAuthFlow("instagram", NONCE_A, expiresAt + 1)).toEqual({
      status: "not_claimable",
    });
    expect(row("instagram").consumed_at).toBeNull();
    // Un milisegundo antes todavía es válido.
    expect(await claimSocialOAuthFlow("instagram", NONCE_A, expiresAt - 1)).toMatchObject(
      {
        status: "claimed",
      },
    );
  });

  it("consumido → not_claimable", async () => {
    await claimSocialOAuthFlow("instagram", NONCE_A, T0 + 1_000);
    expect(await claimSocialOAuthFlow("instagram", NONCE_A, T0 + 2_000)).toEqual({
      status: "not_claimable",
    });
  });

  it("claim duplicado (secuencial): solo el primero gana", async () => {
    const results = [
      await claimSocialOAuthFlow("instagram", NONCE_A, T0 + 1_000),
      await claimSocialOAuthFlow("instagram", NONCE_A, T0 + 1_001),
      await claimSocialOAuthFlow("instagram", NONCE_A, T0 + 1_002),
    ];
    expect(results.map((r) => r.status)).toEqual([
      "claimed",
      "not_claimable",
      "not_claimable",
    ]);
  });

  it("claims concurrentes del mismo flujo: exactamente uno gana", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        claimSocialOAuthFlow("instagram", NONCE_A, T0 + 1_000),
      ),
    );
    expect(results.filter((r) => r.status === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r.status === "not_claimable")).toHaveLength(4);
  });

  it("no hay fila para el provider → not_claimable", async () => {
    expect(await claimSocialOAuthFlow("tiktok", NONCE_A, T0 + 1_000)).toEqual({
      status: "not_claimable",
    });
  });

  it("proveedor inválido / nonce inválido → error de entrada sin tocar la base de datos", async () => {
    const bad = await rejection(() => claimSocialOAuthFlow("x" as never, NONCE_A, T0));
    expect(bad.kind).toBe("invalid_provider");
    const empty = await rejection(() => claimSocialOAuthFlow("instagram", "", T0));
    expect(empty.kind).toBe("invalid_input");
    expect(db.ops).toHaveLength(0);
  });

  it("error de Supabase → infraestructura (nunca 'claimed' ni 'not_claimable')", async () => {
    db.errorNext = { code: "57014", message: "canceling statement" };
    const error = await rejection(() =>
      claimSocialOAuthFlow("instagram", NONCE_A, T0 + 1_000),
    );
    expect(error.kind).toBe("infrastructure");
    expect(error.code).toBe("57014");
    expect(row("instagram").consumed_at).toBeNull();
  });

  it("excepción del cliente → infraestructura", async () => {
    db.throwNext = new Error("fallo de red");
    const error = await rejection(() =>
      claimSocialOAuthFlow("instagram", NONCE_A, T0 + 1_000),
    );
    expect(error.kind).toBe("infrastructure");
  });

  it("el nonce en claro nunca llega a la base de datos en un claim", async () => {
    await claimSocialOAuthFlow("instagram", NONCE_A, T0 + 1_000);
    expect(JSON.stringify(db.ops)).not.toContain(NONCE_A);
    expect(JSON.stringify(db.ops)).toContain(sha256(NONCE_A));
  });
});

describe("la autorización más reciente gana (latest-wins)", () => {
  it("A crea → B crea → claim A falla → claim B funciona", async () => {
    await createSocialOAuthFlow("instagram", NONCE_A, ADMIN_A, T0);
    await createSocialOAuthFlow("instagram", NONCE_B, ADMIN_B, T0 + 1_000);
    expect(await claimSocialOAuthFlow("instagram", NONCE_A, T0 + 2_000)).toEqual({
      status: "not_claimable",
    });
    // El flujo B no se consumió por el intento stale de A.
    expect(row("instagram").consumed_at).toBeNull();
    expect(await claimSocialOAuthFlow("instagram", NONCE_B, T0 + 3_000)).toEqual({
      status: "claimed",
      adminUserId: ADMIN_B,
    });
  });

  it("A creado, A reclamado y luego B creado: A ya no se puede reclamar y B sí", async () => {
    await createSocialOAuthFlow("tiktok", NONCE_A, ADMIN_A, T0);
    await claimSocialOAuthFlow("tiktok", NONCE_A, T0 + 1_000);
    await createSocialOAuthFlow("tiktok", NONCE_B, ADMIN_B, T0 + 2_000);
    expect((await claimSocialOAuthFlow("tiktok", NONCE_A, T0 + 3_000)).status).toBe(
      "not_claimable",
    );
    expect((await claimSocialOAuthFlow("tiktok", NONCE_B, T0 + 3_000)).status).toBe(
      "claimed",
    );
  });

  it("callbacks A y B concurrentes tras dos inicios: solo B completa", async () => {
    await createSocialOAuthFlow("instagram", NONCE_A, ADMIN_A, T0);
    await createSocialOAuthFlow("instagram", NONCE_B, ADMIN_B, T0 + 1_000);
    const [a, b] = await Promise.all([
      claimSocialOAuthFlow("instagram", NONCE_A, T0 + 2_000),
      claimSocialOAuthFlow("instagram", NONCE_B, T0 + 2_000),
    ]);
    expect(a.status).toBe("not_claimable");
    expect(b).toEqual({ status: "claimed", adminUserId: ADMIN_B });
  });

  it("dos inicios concurrentes del mismo provider: queda UNA fila, la del último en aplicarse", async () => {
    await Promise.all([
      createSocialOAuthFlow("instagram", NONCE_A, ADMIN_A, T0),
      createSocialOAuthFlow("instagram", NONCE_B, ADMIN_B, T0),
    ]);
    expect(db.rows.size).toBe(1);
    const survivor = row("instagram").nonce_hash;
    expect([sha256(NONCE_A), sha256(NONCE_B)]).toContain(survivor);
    const winner = survivor === sha256(NONCE_A) ? NONCE_A : NONCE_B;
    const loser = winner === NONCE_A ? NONCE_B : NONCE_A;
    expect((await claimSocialOAuthFlow("instagram", loser, T0 + 1_000)).status).toBe(
      "not_claimable",
    );
    expect((await claimSocialOAuthFlow("instagram", winner, T0 + 1_000)).status).toBe(
      "claimed",
    );
  });

  it("Instagram A y TikTok B son independientes: ambos funcionan", async () => {
    await createSocialOAuthFlow("instagram", NONCE_A, ADMIN_A, T0);
    await createSocialOAuthFlow("tiktok", NONCE_B, ADMIN_B, T0 + 1_000);
    const [ig, tt] = await Promise.all([
      claimSocialOAuthFlow("instagram", NONCE_A, T0 + 2_000),
      claimSocialOAuthFlow("tiktok", NONCE_B, T0 + 2_000),
    ]);
    expect(ig).toEqual({ status: "claimed", adminUserId: ADMIN_A });
    expect(tt).toEqual({ status: "claimed", adminUserId: ADMIN_B });
  });

  it("aislamiento entre proveedores: el nonce de uno no sirve en el otro aunque coincida", async () => {
    await createSocialOAuthFlow("instagram", NONCE_A, ADMIN_A, T0);
    await createSocialOAuthFlow("tiktok", NONCE_B, ADMIN_B, T0);
    expect((await claimSocialOAuthFlow("tiktok", NONCE_A, T0 + 1)).status).toBe(
      "not_claimable",
    );
    expect((await claimSocialOAuthFlow("instagram", NONCE_B, T0 + 1)).status).toBe(
      "not_claimable",
    );
  });

  it("crear un flujo nuevo de un provider no toca el flujo del otro", async () => {
    await createSocialOAuthFlow("instagram", NONCE_A, ADMIN_A, T0);
    await createSocialOAuthFlow("tiktok", NONCE_B, ADMIN_B, T0 + 1_000);
    await createSocialOAuthFlow(
      "tiktok",
      "nonce-sintetico-C-0000000000000000",
      ADMIN_B,
      T0 + 2_000,
    );
    expect((await claimSocialOAuthFlow("instagram", NONCE_A, T0 + 3_000)).status).toBe(
      "claimed",
    );
  });
});

describe("isSocialOAuthFlowCurrent", () => {
  it("flujo vigente y reclamado → true; solo lectura", async () => {
    await createSocialOAuthFlow("instagram", NONCE_A, ADMIN_A, T0);
    await claimSocialOAuthFlow("instagram", NONCE_A, T0 + 1_000);
    const before = JSON.stringify([...db.rows.values()]);
    db.ops = [];
    expect(await isSocialOAuthFlowCurrent("instagram", NONCE_A)).toBe(true);
    expect(db.ops).toHaveLength(1);
    expect(db.ops[0].op).toBe("select");
    expect(JSON.stringify([...db.rows.values()])).toBe(before);
  });

  it("sin reclamar todavía → false (consumed_at IS NOT NULL es obligatorio)", async () => {
    await createSocialOAuthFlow("instagram", NONCE_A, ADMIN_A, T0);
    expect(await isSocialOAuthFlowCurrent("instagram", NONCE_A)).toBe(false);
  });

  it("superseded: reclamado y luego sustituido por un inicio más reciente → false", async () => {
    await createSocialOAuthFlow("instagram", NONCE_A, ADMIN_A, T0);
    await claimSocialOAuthFlow("instagram", NONCE_A, T0 + 1_000);
    await createSocialOAuthFlow("instagram", NONCE_B, ADMIN_B, T0 + 2_000);
    expect(await isSocialOAuthFlowCurrent("instagram", NONCE_A)).toBe(false);
    // B todavía no reclamado: tampoco es "current" (nadie lo ha consumido).
    expect(await isSocialOAuthFlowCurrent("instagram", NONCE_B)).toBe(false);
  });

  it("nonce incorrecto → false", async () => {
    await createSocialOAuthFlow("instagram", NONCE_A, ADMIN_A, T0);
    await claimSocialOAuthFlow("instagram", NONCE_A, T0 + 1_000);
    expect(await isSocialOAuthFlowCurrent("instagram", NONCE_B)).toBe(false);
  });

  it("provider incorrecto → false", async () => {
    await createSocialOAuthFlow("instagram", NONCE_A, ADMIN_A, T0);
    await claimSocialOAuthFlow("instagram", NONCE_A, T0 + 1_000);
    expect(await isSocialOAuthFlowCurrent("tiktok", NONCE_A)).toBe(false);
  });

  it("NO exige expires_at > ahora: un flujo reclamado a tiempo sigue vigente aunque expire durante el intercambio", async () => {
    await createSocialOAuthFlow("instagram", NONCE_A, ADMIN_A, T0);
    // Reclamado 1 s antes de expirar; el intercambio lento cruza expires_at.
    await claimSocialOAuthFlow(
      "instagram",
      NONCE_A,
      T0 + SOCIAL_OAUTH_FLOW_TTL_MS - 1_000,
    );
    vi.setSystemTime(T0 + SOCIAL_OAUTH_FLOW_TTL_MS + 60_000);
    try {
      expect(await isSocialOAuthFlowCurrent("instagram", NONCE_A)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("proveedor/nonce inválido → error de entrada sin consultar", async () => {
    expect(
      (await rejection(() => isSocialOAuthFlowCurrent("x" as never, NONCE_A))).kind,
    ).toBe("invalid_provider");
    expect((await rejection(() => isSocialOAuthFlowCurrent("instagram", ""))).kind).toBe(
      "invalid_input",
    );
    expect(db.ops).toHaveLength(0);
  });

  it("error de Supabase o excepción → infraestructura (nunca false silencioso)", async () => {
    await createSocialOAuthFlow("instagram", NONCE_A, ADMIN_A, T0);
    db.errorNext = { code: "08006", message: "conexión" };
    expect(
      (await rejection(() => isSocialOAuthFlowCurrent("instagram", NONCE_A))).kind,
    ).toBe("infrastructure");
    db.throwNext = new Error("boom");
    expect(
      (await rejection(() => isSocialOAuthFlowCurrent("instagram", NONCE_A))).kind,
    ).toBe("infrastructure");
  });

  it("el nonce en claro nunca llega a la base de datos en la comprobación", async () => {
    await createSocialOAuthFlow("instagram", NONCE_A, ADMIN_A, T0);
    db.ops = [];
    await isSocialOAuthFlowCurrent("instagram", NONCE_A);
    expect(JSON.stringify(db.ops)).not.toContain(NONCE_A);
  });
});

describe("isSocialOAuthProvider", () => {
  it("solo instagram y tiktok", () => {
    expect(isSocialOAuthProvider("instagram")).toBe(true);
    expect(isSocialOAuthProvider("tiktok")).toBe(true);
    for (const v of ["", "youtube", "Instagram", null, undefined, {}, 1]) {
      expect(isSocialOAuthProvider(v)).toBe(false);
    }
  });
});
