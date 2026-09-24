// Doble de prueba de las tablas que usa la capability de los callbacks OAuth (Bloque 8D):
// `social_oauth_flows` (módulo REAL social-oauth-flow) y `admin_roles` (lectura del rol por
// requireCapabilityForUser, también REAL). Solo tests. Aplica la misma semántica que Postgres
// para lo que usan esos módulos: upsert por PK que solo sobrescribe las columnas enviadas,
// UPDATE condicional con RETURNING evaluado de forma atómica en un único paso síncrono y los
// CHECK relevantes de la migración. NO prueba el motor real (eso se verificó en 8B contra
// Supabase). Los callbacks componen este fake con el de `social_connections` de cada proveedor.

type Row = Record<string, unknown>;

export type FlowEvent = "create" | "claim" | "current" | "roles" | "exchange" | "persist";

export const flowFake = {
  /** Filas de social_oauth_flows por provider (PK). */
  flows: new Map<string, Row>(),
  /** Rol por user_id en admin_roles (ausente = USER). */
  roles: {} as Record<string, string | undefined>,
  /** Cronología de operaciones (los tests añaden "exchange" y "persist"). */
  events: [] as FlowEvent[],
  /** Error devuelto por Supabase en la operación indicada. */
  failOn: {} as Partial<Record<"create" | "claim" | "current" | "roles", unknown>>,
  /** Se ejecuta justo antes de aplicar la operación (simula otra petición). */
  before: {} as Partial<Record<"claim" | "current", () => void | Promise<void>>>,
};

export function resetFlowFake(): void {
  flowFake.flows = new Map();
  flowFake.roles = {};
  flowFake.events = [];
  flowFake.failOn = {};
  flowFake.before = {};
}

const timeOf = (value: unknown) => Date.parse(String(value));

function violatesChecks(row: Row): boolean {
  if (row.provider !== "instagram" && row.provider !== "tiktok") return true;
  if (typeof row.nonce_hash !== "string" || !/^[0-9a-f]{64}$/.test(row.nonce_hash))
    return true;
  if (!(timeOf(row.expires_at) > timeOf(row.created_at))) return true;
  return row.consumed_at !== null && !(timeOf(row.consumed_at) >= timeOf(row.created_at));
}

function project(row: Row, columns: string): Row {
  const out: Row = {};
  for (const column of columns.split(",").map((c) => c.trim())) out[column] = row[column];
  return out;
}

type Pred = (row: Row) => boolean;

function flowsTable() {
  return {
    async upsert(row: Row, options: { onConflict?: string }) {
      flowFake.events.push("create");
      if (flowFake.failOn.create) return { error: flowFake.failOn.create };
      const key = String(row[options.onConflict ?? "provider"]);
      const merged = { consumed_at: null, ...(flowFake.flows.get(key) ?? {}), ...row };
      if (violatesChecks(merged)) return { error: { code: "23514" } };
      flowFake.flows.set(key, merged);
      return { error: null };
    },
    update(values: Row) {
      const preds: Pred[] = [];
      const builder = {
        eq(column: string, value: unknown) {
          preds.push((row) => row[column] === value);
          return builder;
        },
        is(column: string, value: null) {
          preds.push((row) => row[column] === value);
          return builder;
        },
        gt(column: string, value: string) {
          preds.push((row) => timeOf(row[column]) > timeOf(value));
          return builder;
        },
        async select(columns: string) {
          await flowFake.before.claim?.();
          flowFake.events.push("claim");
          if (flowFake.failOn.claim) return { data: null, error: flowFake.failOn.claim };
          // Atómico: filtrar y aplicar sin ceder el control entre medias.
          const matched: Row[] = [];
          for (const [key, row] of flowFake.flows) {
            if (preds.every((p) => p(row))) {
              const updated = { ...row, ...values };
              flowFake.flows.set(key, updated);
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
      const builder = {
        eq(column: string, value: unknown) {
          preds.push((row) => row[column] === value);
          return builder;
        },
        not(column: string, _operator: string, value: null) {
          preds.push((row) => row[column] !== value);
          return builder;
        },
        async maybeSingle() {
          await flowFake.before.current?.();
          flowFake.events.push("current");
          if (flowFake.failOn.current)
            return { data: null, error: flowFake.failOn.current };
          const found = [...flowFake.flows.values()].find((row) =>
            preds.every((p) => p(row)),
          );
          return { data: found ? project(found, columns) : null, error: null };
        },
      };
      return builder;
    },
  };
}

function rolesTable() {
  return {
    select() {
      let userId = "";
      const builder = {
        eq(_column: string, value: string) {
          userId = value;
          return builder;
        },
        async maybeSingle() {
          flowFake.events.push("roles");
          if (flowFake.failOn.roles) return { data: null, error: flowFake.failOn.roles };
          const role = flowFake.roles[userId];
          return { data: role ? { role } : null, error: null };
        },
      };
      return builder;
    },
  };
}

/** Tabla de la capability si `table` le pertenece; `undefined` para cualquier otra. */
export function flowTableFor(table: string) {
  if (table === "social_oauth_flows") return flowsTable();
  if (table === "admin_roles") return rolesTable();
  return undefined;
}
