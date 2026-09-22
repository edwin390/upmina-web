// Doble de prueba de @supabase/supabase-js para la lectura de Instagram. Solo tests.
// Simula la tabla `social_connections` con UNA fila por proveedor (como el índice único) y
// respeta el filtro `eq("provider", ...)`, para comprobar que Instagram nunca lee la fila
// de TikTok. Independiente del fake de TikTok.

type Row = Record<string, unknown>;

export interface FakeQuery {
  table: string;
  columns: string;
  filters: [string, unknown][];
}

export const igFakeDb = {
  /** Filas por proveedor. */
  rows: {} as Record<string, Row>,
  /** Consultas ejecutadas. */
  queries: [] as FakeQuery[],
  /** Argumentos con los que se creó cada cliente (url, key, opciones). */
  clients: [] as unknown[][],
  /** Error devuelto por Supabase en la lectura. */
  failWith: undefined as unknown,
  /** Excepción lanzada (p. ej. fallo de red) en la lectura. */
  throwWith: undefined as unknown,
};

export function resetIgFakeDb(): void {
  igFakeDb.rows = {};
  igFakeDb.queries = [];
  igFakeDb.clients = [];
  igFakeDb.failWith = undefined;
  igFakeDb.throwWith = undefined;
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
    }),
  };
}
