// Doble de prueba de @supabase/supabase-js para el feed público de Comunidad (Fase 9J-2A): dos
// tablas, community_posts (con community_post_media/media_assets ya incrustados, como PostgREST
// los devolvería con el `select` embebido de community-feed-handlers.ts) y profiles (consulta
// aparte por .in(), ver el comentario de ese handler sobre por qué no se embebe). Solo tests: no
// prueba el motor real ni sus RLS/CHECK. Soporta EXACTAMENTE la forma de consulta que usa el
// handler: community_posts.select().eq().order().order().limit()[.or()], y
// profiles.select().in().

type Row = Record<string, unknown>;

export const communityFeedDb = {
  posts: [] as Row[],
  profiles: [] as Row[],
  /** Error devuelto por Supabase (no una excepción) en la PRÓXIMA consulta de community_posts. */
  failNextPosts: null as unknown,
  /** Igual, pero para la consulta de profiles. */
  failNextProfiles: null as unknown,
  /** Excepción lanzada por el cliente en la próxima consulta (cualquier tabla). */
  throwNext: null as unknown,
};

export function resetCommunityFeedDb(): void {
  communityFeedDb.posts = [];
  communityFeedDb.profiles = [];
  communityFeedDb.failNextPosts = null;
  communityFeedDb.failNextProfiles = null;
  communityFeedDb.throwNext = null;
}

function compareDesc(a: Row, b: Row): number {
  const ac = String(a.created_at ?? "");
  const bc = String(b.created_at ?? "");
  if (ac !== bc) return ac < bc ? 1 : -1;
  const ai = String(a.id ?? "");
  const bi = String(b.id ?? "");
  return ai < bi ? 1 : ai > bi ? -1 : 0;
}

/** Solo entiende el ÚNICO patrón que community-feed-handlers.ts genera:
 *  "created_at.lt.<ts>,and(created_at.eq.<ts>,id.lt.<id>)". */
function applyOr(rows: Row[], expr: string): Row[] {
  const ltMatch = expr.match(
    /^created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.lt\.([^)]+)\)$/,
  );
  if (!ltMatch) throw new Error(`fake: expresión .or() no soportada: ${expr}`);
  const [, ltTs, eqTs, ltId] = ltMatch;
  return rows.filter((row) => {
    const createdAt = String(row.created_at ?? "");
    const id = String(row.id ?? "");
    return createdAt < ltTs! || (createdAt === eqTs! && id < ltId!);
  });
}

function postsApi() {
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
        if (communityFeedDb.throwNext) {
          const err = communityFeedDb.throwNext;
          communityFeedDb.throwNext = null;
          throw err;
        }
        if (communityFeedDb.failNextPosts) {
          const err = communityFeedDb.failNextPosts;
          communityFeedDb.failNextPosts = null;
          return { data: null, error: err };
        }
        let rows = communityFeedDb.posts.filter((row) =>
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

function profilesApi() {
  return {
    select() {
      let inColumn: string | undefined;
      let inValues: unknown[] = [];

      const builder = {
        in(column: string, values: unknown[]) {
          inColumn = column;
          inValues = values;
          return builder;
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
        if (communityFeedDb.throwNext) {
          const err = communityFeedDb.throwNext;
          communityFeedDb.throwNext = null;
          throw err;
        }
        if (communityFeedDb.failNextProfiles) {
          const err = communityFeedDb.failNextProfiles;
          communityFeedDb.failNextProfiles = null;
          return { data: null, error: err };
        }
        const rows = inColumn
          ? communityFeedDb.profiles.filter((row) => inValues.includes(row[inColumn!]))
          : [];
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
      if (table === "community_posts") return postsApi();
      if (table === "profiles") return profilesApi();
      throw new Error(`fake: tabla inesperada: ${table}`);
    },
  };
}
