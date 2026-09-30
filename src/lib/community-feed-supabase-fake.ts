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

/** Ordena por una lista de (columna, ascendente) en secuencia — genérico para soportar tanto
 *  "Recientes" (created_at desc, id desc) como "Populares" (Fase 9J-2C: like_count desc,
 *  created_at desc, id desc), según lo que el handler realmente encadene vía `.order()`. Columnas
 *  ausentes en una fila (p. ej. like_count en un fixture que no la especifica) se tratan como
 *  iguales entre sí y el desempate pasa a la siguiente columna — mismo resultado que antes de que
 *  existiera like_count para los tests que no la usan. */
function genericSort(
  rows: Row[],
  orderCols: { column: string; ascending: boolean }[],
): Row[] {
  return [...rows].sort((a, b) => {
    for (const { column, ascending } of orderCols) {
      const av = a[column];
      const bv = b[column];
      let cmp: number;
      if (typeof av === "number" || typeof bv === "number") {
        cmp = Number(av ?? 0) - Number(bv ?? 0);
      } else {
        const as = String(av ?? "");
        const bs = String(bv ?? "");
        cmp = as < bs ? -1 : as > bs ? 1 : 0;
      }
      if (cmp !== 0) return ascending ? cmp : -cmp;
    }
    return 0;
  });
}

/** Solo entiende los DOS patrones que community-feed-handlers.ts genera: el cursor de 2 columnas
 *  de "Recientes" ("created_at.lt.<ts>,and(created_at.eq.<ts>,id.lt.<id>)") y el de 3 columnas de
 *  "Populares" (Fase 9J-2C: "like_count.lt.<n>,and(like_count.eq.<n>,created_at.lt.<ts>),
 *  and(like_count.eq.<n>,created_at.eq.<ts>,id.lt.<id>)"). */
function applyOr(rows: Row[], expr: string): Row[] {
  const twoKey = expr.match(
    /^created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.lt\.([^)]+)\)$/,
  );
  if (twoKey) {
    const [, ltTs, eqTs, ltId] = twoKey;
    return rows.filter((row) => {
      const createdAt = String(row.created_at ?? "");
      const id = String(row.id ?? "");
      return createdAt < ltTs! || (createdAt === eqTs! && id < ltId!);
    });
  }

  const threeKey = expr.match(
    /^like_count\.lt\.(\d+),and\(like_count\.eq\.\d+,created_at\.lt\.([^)]+)\),and\(like_count\.eq\.\d+,created_at\.eq\.([^,]+),id\.lt\.([^)]+)\)$/,
  );
  if (threeKey) {
    const [, ltLikesRaw, ltCreatedAt, eqCreatedAt, ltId] = threeKey;
    const ltLikes = Number(ltLikesRaw);
    return rows.filter((row) => {
      const likeCount = Number(row.like_count ?? 0);
      const createdAt = String(row.created_at ?? "");
      const id = String(row.id ?? "");
      if (likeCount < ltLikes) return true;
      if (likeCount === ltLikes && createdAt < ltCreatedAt!) return true;
      return likeCount === ltLikes && createdAt === eqCreatedAt! && id < ltId!;
    });
  }

  throw new Error(`fake: expresión .or() no soportada: ${expr}`);
}

function postsApi() {
  return {
    select() {
      const eqFilters: [string, unknown][] = [];
      const gteFilters: [string, unknown][] = [];
      const orderCols: { column: string; ascending: boolean }[] = [];
      let orExpr: string | undefined;
      let limitN: number | undefined;

      const builder = {
        eq(column: string, value: unknown) {
          eqFilters.push([column, value]);
          return builder;
        },
        gte(column: string, value: unknown) {
          gteFilters.push([column, value]);
          return builder;
        },
        or(expr: string) {
          orExpr = expr;
          return builder;
        },
        order(column: string, opts?: { ascending?: boolean }) {
          orderCols.push({ column, ascending: opts?.ascending ?? true });
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
        let rows = communityFeedDb.posts.filter(
          (row) =>
            eqFilters.every(([column, value]) => row[column] === value) &&
            gteFilters.every(
              ([column, value]) => String(row[column] ?? "") >= String(value),
            ),
        );
        rows = genericSort(rows, orderCols);
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
