// Doble de prueba de @supabase/supabase-js para cosplay_posts (con cosplay_post_images/
// media_assets ya incrustados, como PostgREST los devolvería con el `select` embebido de
// cosplay-handlers.ts). Solo tests: no prueba el motor real ni sus RLS/CHECK (eso corresponde a
// cosplay-foundation-migration.test.ts, estático, y a una verificación manual contra el proyecto
// desechable si hiciera falta). Soporta EXACTAMENTE la forma de consulta que usan los handlers:
// select().eq().order().order().limit()[.or()] y select().eq().eq().maybeSingle().

type Row = Record<string, unknown>;

export const cosplayDb = {
  /** Filas sembradas por los tests, en cualquier orden (el fake las ordena como PostgREST). */
  rows: [] as Row[],
  /** Error devuelto por Supabase (no una excepción) en la próxima consulta. */
  failNext: null as unknown,
  /** Excepción lanzada por el cliente en la próxima consulta. */
  throwNext: null as unknown,
  /** Consultas realizadas, para aserciones (filtros aplicados). */
  queries: [] as { eq: [string, unknown][]; or?: string; limit?: number }[],
};

export function resetCosplayDb(): void {
  cosplayDb.rows = [];
  cosplayDb.failNext = null;
  cosplayDb.throwNext = null;
  cosplayDb.queries = [];
}

function compareDesc(a: Row, b: Row): number {
  const ap = String(a.published_at ?? "");
  const bp = String(b.published_at ?? "");
  if (ap !== bp) return ap < bp ? 1 : -1;
  const ai = String(a.id ?? "");
  const bi = String(b.id ?? "");
  return ai < bi ? 1 : ai > bi ? -1 : 0;
}

/** Solo entiende el ÚNICO patrón que cosplay-handlers.ts genera:
 *  "published_at.lt.<ts>,and(published_at.eq.<ts>,id.lt.<id>)". */
function applyOr(rows: Row[], expr: string): Row[] {
  const ltMatch = expr.match(
    /^published_at\.lt\.([^,]+),and\(published_at\.eq\.([^,]+),id\.lt\.([^)]+)\)$/,
  );
  if (!ltMatch) throw new Error(`fake: expresión .or() no soportada: ${expr}`);
  const [, ltTs, eqTs, ltId] = ltMatch;
  return rows.filter((row) => {
    const publishedAt = String(row.published_at ?? "");
    const id = String(row.id ?? "");
    return publishedAt < ltTs! || (publishedAt === eqTs! && id < ltId!);
  });
}

function tableApi() {
  return {
    select() {
      const eqFilters: [string, unknown][] = [];
      let orExpr: string | undefined;
      let limitN: number | undefined;

      const builder = {
        eq(column: string, value: unknown) {
          eqFilters.push([column, value]);
          return builder;
        },
        or(expr: string) {
          orExpr = expr;
          return builder;
        },
        order() {
          return builder;
        },
        limit(n: number) {
          limitN = n;
          return builder;
        },
        async maybeSingle() {
          const result = resolve();
          if (result.error) return { data: null, error: result.error };
          const matches = (result.data as Row[]).slice(0, 1);
          return { data: matches[0] ?? null, error: null };
        },
        then<R1 = unknown, R2 = never>(
          onfulfilled?:
            | ((value: { data: Row[] | null; error: unknown }) => R1 | PromiseLike<R1>)
            | null,
          onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
        ): PromiseLike<R1 | R2> {
          return Promise.resolve(resolve()).then(onfulfilled, onrejected);
        },
      };

      function resolve(): { data: Row[] | null; error: unknown } {
        cosplayDb.queries.push({ eq: [...eqFilters], or: orExpr, limit: limitN });
        if (cosplayDb.throwNext) {
          const err = cosplayDb.throwNext;
          cosplayDb.throwNext = null;
          throw err;
        }
        if (cosplayDb.failNext) {
          const err = cosplayDb.failNext;
          cosplayDb.failNext = null;
          return { data: null, error: err };
        }
        let rows = cosplayDb.rows.filter((row) =>
          eqFilters.every(([column, value]) => row[column] === value),
        );
        rows = [...rows].sort(compareDesc);
        if (orExpr) rows = applyOr(rows, orExpr);
        if (typeof limitN === "number") rows = rows.slice(0, limitN);
        return { data: rows.map((row) => ({ ...row })), error: null };
      }

      return builder;
    },
  };
}

export function fakeCreateClient(...args: unknown[]) {
  void args;
  return {
    from(table: string) {
      if (table !== "cosplay_posts") throw new Error(`fake: tabla inesperada: ${table}`);
      return tableApi();
    },
  };
}
