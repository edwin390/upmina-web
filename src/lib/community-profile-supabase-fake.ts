// Doble de prueba de @supabase/supabase-js para el perfil público de Comunidad (Fase 9J-2B): dos
// tablas, profiles (select().eq("username",…).maybeSingle()) y community_posts, usada dos veces
// por el handler — una vez en modo conteo (select(cols,{count:"exact",head:true}).eq().eq()) y
// otra para la página de publicaciones (select(cols).eq().eq().order().order().limit()[.or()]).
// Solo tests: no prueba el motor real ni sus RLS/CHECK.

type Row = Record<string, unknown>;

export const communityProfileDb = {
  profiles: [] as Row[],
  posts: [] as Row[],
  failNextProfiles: null as unknown,
  failNextCount: null as unknown,
  failNextPosts: null as unknown,
  throwNext: null as unknown,
};

export function resetCommunityProfileDb(): void {
  communityProfileDb.profiles = [];
  communityProfileDb.posts = [];
  communityProfileDb.failNextProfiles = null;
  communityProfileDb.failNextCount = null;
  communityProfileDb.failNextPosts = null;
  communityProfileDb.throwNext = null;
}

function compareDesc(a: Row, b: Row): number {
  const ac = String(a.created_at ?? "");
  const bc = String(b.created_at ?? "");
  if (ac !== bc) return ac < bc ? 1 : -1;
  const ai = String(a.id ?? "");
  const bi = String(b.id ?? "");
  return ai < bi ? 1 : ai > bi ? -1 : 0;
}

/** Solo entiende el ÚNICO patrón que community-profile-handlers.ts genera:
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

function profilesApi() {
  return {
    select() {
      const eqFilters: [string, unknown][] = [];
      const builder = {
        eq(column: string, value: unknown) {
          eqFilters.push([column, value]);
          return builder;
        },
        async maybeSingle() {
          if (communityProfileDb.throwNext) {
            const err = communityProfileDb.throwNext;
            communityProfileDb.throwNext = null;
            throw err;
          }
          if (communityProfileDb.failNextProfiles) {
            const err = communityProfileDb.failNextProfiles;
            communityProfileDb.failNextProfiles = null;
            return { data: null, error: err };
          }
          const rows = communityProfileDb.profiles.filter((row) =>
            eqFilters.every(([column, value]) => row[column] === value),
          );
          return { data: rows[0] ? { ...rows[0] } : null, error: null };
        },
      };
      return builder;
    },
  };
}

function postsApi() {
  return {
    select(_columns: string, options?: { count?: string; head?: boolean }) {
      const isCount = Boolean(options?.head);
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
            | ((value: {
                data: Row[] | null;
                error: unknown;
                count?: number | null;
              }) => R1 | PromiseLike<R1>)
            | null,
          onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
        ): PromiseLike<R1 | R2> {
          return Promise.resolve(resolve()).then(onfulfilled, onrejected);
        },
      };

      function resolve(): { data: Row[] | null; error: unknown; count?: number | null } {
        if (communityProfileDb.throwNext) {
          const err = communityProfileDb.throwNext;
          communityProfileDb.throwNext = null;
          throw err;
        }
        if (isCount) {
          if (communityProfileDb.failNextCount) {
            const err = communityProfileDb.failNextCount;
            communityProfileDb.failNextCount = null;
            return { data: null, error: err, count: null };
          }
          const matched = communityProfileDb.posts.filter((row) =>
            eqFilters.every(([column, value]) => row[column] === value),
          );
          return { data: null, error: null, count: matched.length };
        }
        if (communityProfileDb.failNextPosts) {
          const err = communityProfileDb.failNextPosts;
          communityProfileDb.failNextPosts = null;
          return { data: null, error: err };
        }
        let rows = communityProfileDb.posts.filter((row) =>
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
      if (table === "profiles") return profilesApi();
      if (table === "community_posts") return postsApi();
      throw new Error(`fake: tabla inesperada: ${table}`);
    },
  };
}
