// Doble de prueba de @supabase/supabase-js para Instagram (lectura, persistencia OAuth
// desde Lote 3B y, desde el auto-refresh, el lease de renovación). Solo tests. Simula la
// tabla `social_connections` con UNA fila por proveedor (como el índice único) y respeta
// el filtro `eq("provider", ...)`, para comprobar que Instagram nunca lee ni pisa la fila
// de TikTok. Independiente del fake de TikTok (tiktok-supabase-fake.ts), aunque el
// `update` condicionado sigue el mismo patrón (ver su comentario) porque
// `refresh_lock_until` es la misma columna compartida.

type Row = Record<string, unknown>;

/** Operaciones de `update` distinguibles por la forma de los valores escritos (ver
 *  `classifyUpdate`): adquisición/liberación del lease de renovación y guardado del
 *  token renovado. */
export type FakeUpdateOp = "lease" | "release" | "refresh-save";

function classifyUpdate(values: Row): FakeUpdateOp {
  if (values.refresh_lock_until && values.refresh_lock_until !== null) return "lease";
  return "access_token" in values ? "refresh-save" : "release";
}

function matchesOr(row: Row, expression: string): boolean {
  return expression.split(",").some((clause) => {
    const [column, operator, ...rest] = clause.split(".");
    const value = rest.join(".");
    const current = row[column];
    if (operator === "is" && value === "null") {
      return current === null || current === undefined;
    }
    if (operator === "lt") {
      return typeof current === "string" && Date.parse(current) < Date.parse(value);
    }
    return false;
  });
}

/** UPDATE condicionado: evalúa filtros y muta en un único paso síncrono, igual que un
 *  UPDATE de Postgres (así una carrera entre dos "peticiones" concurrentes se resuelve
 *  igual que con la restricción real). */
class IgUpdateBuilder implements PromiseLike<{ data: Row[] | null; error: unknown }> {
  private filters: [string, unknown][] = [];
  private orExpression: string | undefined;
  private wantsRows = false;

  constructor(private values: Row) {}

  eq(column: string, value: unknown) {
    this.filters.push([column, value]);
    return this;
  }

  or(expression: string) {
    this.orExpression = expression;
    return this;
  }

  select() {
    this.wantsRows = true;
    return this;
  }

  then<T1, T2>(
    onfulfilled?:
      ((value: { data: Row[] | null; error: unknown }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return this.run().then(onfulfilled, onrejected);
  }

  private async run(): Promise<{ data: Row[] | null; error: unknown }> {
    const op = classifyUpdate(this.values);
    // Cede el turno: permite que otras "peticiones" concurrentes (Promise.all) se
    // intercalen antes de que esta mute la fila.
    await Promise.resolve();
    if (igFakeDb.throwOn[op]) throw igFakeDb.throwOn[op];
    igFakeDb.before[op]?.();
    igFakeDb.ops.push(op);
    if (igFakeDb.failOn[op]) return { data: null, error: igFakeDb.failOn[op] };

    const providerFilter = this.filters.find(([column]) => column === "provider");
    const provider = providerFilter ? String(providerFilter[1]) : undefined;
    const row = provider ? igFakeDb.rows[provider] : undefined;
    const matches =
      row !== undefined &&
      this.filters.every(([column, value]) => row[column] === value) &&
      (this.orExpression === undefined || matchesOr(row, this.orExpression));
    if (!matches || !row) return { data: this.wantsRows ? [] : null, error: null };

    Object.assign(row, this.values);
    return { data: this.wantsRows ? [{ provider: row.provider }] : null, error: null };
  }
}

export function countIgOps(op: FakeUpdateOp): number {
  return igFakeDb.ops.filter((o) => o === op).length;
}

export interface FakeQuery {
  table: string;
  columns: string;
  filters: [string, unknown][];
}

export interface FakeUpsert {
  table: string;
  row: Row;
  options: unknown;
}

export interface FakeNonceInsert {
  table: string;
  row: Row;
}

export const igFakeDb = {
  /** Filas por proveedor. */
  rows: {} as Record<string, Row>,
  /** Consultas de lectura ejecutadas. */
  queries: [] as FakeQuery[],
  /** Upserts ejecutados (uno por llamada a saveInstagramConnection). */
  upserts: [] as FakeUpsert[],
  /** Argumentos con los que se creó cada cliente (url, key, opciones). */
  clients: [] as unknown[][],
  /** Error devuelto por Supabase en la lectura. */
  failWith: undefined as unknown,
  /** Excepción lanzada (p. ej. fallo de red) en la lectura. */
  throwWith: undefined as unknown,
  /** Error devuelto por Supabase en el upsert (independiente del de lectura). */
  upsertFailWith: undefined as unknown,
  /** Excepción lanzada (p. ej. fallo de red) en el upsert. */
  upsertThrowWith: undefined as unknown,
  /** Filas de la tabla instagram_oauth_nonces, por nonce_hash (simula su primary key). */
  nonces: {} as Record<string, Row>,
  /** Inserts de nonce ejecutados (uno por intento de claimInstagramOAuthNonce). */
  nonceInserts: [] as FakeNonceInsert[],
  /** Error devuelto por Supabase en el insert de nonce (fallo real, no choque de PK). */
  nonceInsertFailWith: undefined as unknown,
  /** Excepción lanzada (p. ej. fallo de red) en el insert de nonce. */
  nonceInsertThrowWith: undefined as unknown,
  /** Historial de operaciones de `update` ejecutadas (lease/release/refresh-save). */
  ops: [] as FakeUpdateOp[],
  /** Error devuelto por Supabase en la operación de `update` indicada. */
  failOn: {} as Partial<Record<FakeUpdateOp, unknown>>,
  /** Excepción lanzada (p. ej. fallo de red) en la operación de `update` indicada. */
  throwOn: {} as Partial<Record<FakeUpdateOp, unknown>>,
  /** Se ejecuta justo antes de aplicar la operación (simula otra petición concurrente). */
  before: {} as Partial<Record<FakeUpdateOp, () => void>>,
};

export function resetIgFakeDb(): void {
  igFakeDb.rows = {};
  igFakeDb.queries = [];
  igFakeDb.upserts = [];
  igFakeDb.clients = [];
  igFakeDb.failWith = undefined;
  igFakeDb.throwWith = undefined;
  igFakeDb.upsertFailWith = undefined;
  igFakeDb.upsertThrowWith = undefined;
  igFakeDb.nonces = {};
  igFakeDb.nonceInserts = [];
  igFakeDb.nonceInsertFailWith = undefined;
  igFakeDb.nonceInsertThrowWith = undefined;
  igFakeDb.ops = [];
  igFakeDb.failOn = {};
  igFakeDb.throwOn = {};
  igFakeDb.before = {};
}

export function fakeInstagramCreateClient(...args: unknown[]) {
  igFakeDb.clients.push(args);
  return {
    from: (table: string) => ({
      select: (columns: string) => {
        const query: FakeQuery = { table, columns, filters: [] };
        const builder = {
          eq(column: string, value: unknown) {
            query.filters.push([column, value]);
            return builder;
          },
          async maybeSingle() {
            await Promise.resolve();
            igFakeDb.queries.push(query);
            if (igFakeDb.throwWith) throw igFakeDb.throwWith;
            if (igFakeDb.failWith) return { data: null, error: igFakeDb.failWith };
            const match = query.filters.find(([column]) => column === "provider");
            const row = match ? igFakeDb.rows[String(match[1])] : undefined;
            return { data: row ? { ...row } : null, error: null };
          },
        };
        return builder;
      },
      update: (values: Row) => new IgUpdateBuilder(values),
      async upsert(row: Row, options: unknown) {
        await Promise.resolve();
        if (igFakeDb.upsertThrowWith) throw igFakeDb.upsertThrowWith;
        igFakeDb.upserts.push({ table, row, options });
        if (igFakeDb.upsertFailWith) return { error: igFakeDb.upsertFailWith };
        const provider = String(row.provider);
        const existing = igFakeDb.rows[provider];
        // created_at solo se fija al insertar; en conflicto se actualiza el resto.
        igFakeDb.rows[provider] = {
          created_at: existing?.created_at ?? "primera-vez",
          ...existing,
          ...row,
        };
        return { error: null };
      },
      // Solo usado por claimInstagramOAuthNonce (tabla instagram_oauth_nonces). El
      // check-then-set es síncrono tras el único `await` de la función: dos llamadas
      // "concurrentes" (Promise.all) con el mismo nonce_hash se intercalan en el
      // microtask queue exactamente como lo haría una primary key real en Postgres,
      // así que solo una de las dos puede ver la fila como inexistente.
      async insert(row: Row) {
        await Promise.resolve();
        if (igFakeDb.nonceInsertThrowWith) throw igFakeDb.nonceInsertThrowWith;
        if (igFakeDb.nonceInsertFailWith) return { error: igFakeDb.nonceInsertFailWith };
        igFakeDb.nonceInserts.push({ table, row });
        const hash = String(row.nonce_hash);
        if (igFakeDb.nonces[hash]) {
          return {
            error: {
              code: "23505",
              message: "duplicate key value violates unique constraint",
            },
          };
        }
        igFakeDb.nonces[hash] = row;
        return { error: null };
      },
      delete: () => ({
        async lt(column: string, value: unknown) {
          await Promise.resolve();
          for (const [hash, row] of Object.entries(igFakeDb.nonces)) {
            const cell = row[column];
            if (typeof cell === "string" && typeof value === "string" && cell < value) {
              delete igFakeDb.nonces[hash];
            }
          }
          return { error: null };
        },
      }),
    }),
  };
}
