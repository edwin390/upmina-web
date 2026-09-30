// Doble de prueba de @supabase/supabase-js para el detalle público de UNA publicación de
// Comunidad (Fase 9J-2B.1): dos tablas, community_posts (select().eq().eq().maybeSingle()) y
// profiles (select().eq().maybeSingle()). Solo tests: no prueba el motor real ni sus RLS/CHECK.

type Row = Record<string, unknown>;

export const communityPostDetailDb = {
  posts: [] as Row[],
  profiles: [] as Row[],
  failNextPosts: null as unknown,
  failNextProfiles: null as unknown,
  throwNext: null as unknown,
};

export function resetCommunityPostDetailDb(): void {
  communityPostDetailDb.posts = [];
  communityPostDetailDb.profiles = [];
  communityPostDetailDb.failNextPosts = null;
  communityPostDetailDb.failNextProfiles = null;
  communityPostDetailDb.throwNext = null;
}

function tableApi(rows: () => Row[], failKey: "failNextPosts" | "failNextProfiles") {
  return {
    select() {
      const eqFilters: [string, unknown][] = [];
      const builder = {
        eq(column: string, value: unknown) {
          eqFilters.push([column, value]);
          return builder;
        },
        async maybeSingle() {
          if (communityPostDetailDb.throwNext) {
            const err = communityPostDetailDb.throwNext;
            communityPostDetailDb.throwNext = null;
            throw err;
          }
          if (communityPostDetailDb[failKey]) {
            const err = communityPostDetailDb[failKey];
            communityPostDetailDb[failKey] = null;
            return { data: null, error: err };
          }
          const matches = rows().filter((row) =>
            eqFilters.every(([column, value]) => row[column] === value),
          );
          return { data: matches[0] ? { ...matches[0] } : null, error: null };
        },
      };
      return builder;
    },
  };
}

export function fakeCreateClient(...args: unknown[]) {
  void args;
  return {
    from(table: string) {
      if (table === "community_posts") {
        return tableApi(() => communityPostDetailDb.posts, "failNextPosts");
      }
      if (table === "profiles") {
        return tableApi(() => communityPostDetailDb.profiles, "failNextProfiles");
      }
      throw new Error(`fake: tabla inesperada: ${table}`);
    },
  };
}
