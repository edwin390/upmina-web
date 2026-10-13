import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// R5-E: los clientes de Community y de Media parsean `restriction` de forma estricta y solo cuando
// el código es author_restricted; reorder/detach (sin UI hoy) comparten el mismo modelo central.

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "t", user: { id: "u" } } },
        error: null,
      }),
    },
  },
}));

const {
  CommunityClientError,
  saveCommunityPost,
  reorderCommunityPostMedia,
  detachCommunityPostMedia,
  deleteCommunityPost,
  fetchAuthorRestriction,
} = await import("./community-client");
const { MediaClientError, reserveMediaUpload } = await import("./media-client");
const { restrictionOutcome } = await import("./author-restriction");

type Failure = { status?: number; code?: string; restriction: unknown };
async function failure(op: () => Promise<unknown>): Promise<Failure> {
  try {
    await op();
  } catch (e) {
    return e as Failure;
  }
  throw new Error("expected the call to fail");
}

const RESTRICTION = {
  level: 1,
  permanent: false,
  endsAt: "2099-10-20T10:00:00+00:00",
  reason: "Motivo",
};
function respond(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}
beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

const ops: [string, () => Promise<unknown>][] = [
  [
    "save (create/edit)",
    () =>
      saveCommunityPost({
        postId: null,
        expectedVersion: null,
        text: "x",
        media: [],
        removedMediaIds: [],
      }),
  ],
  [
    "reorder media",
    () => reorderCommunityPostMedia({ postId: "p", expectedVersion: 1, positions: [] }),
  ],
  [
    "detach media",
    () => detachCommunityPostMedia({ postId: "p", expectedVersion: 1, mediaId: "m" }),
  ],
];

describe("Community client: author_restricted", () => {
  it.each(ops)(
    "%s: 403 carries the strict restriction (no extra fields)",
    async (_n, op) => {
      respond(403, {
        error: "Tu cuenta tiene una restricción",
        code: "author_restricted",
        restriction: { ...RESTRICTION, appliedBy: "x", caseId: "y" },
      });
      const err = await failure(op);
      expect(err).toBeInstanceOf(CommunityClientError);
      expect(err.status).toBe(403);
      expect(err.restriction).toEqual(RESTRICTION);
      expect(restrictionOutcome(err)).toEqual({
        kind: "restricted",
        restriction: RESTRICTION,
      });
      expect(JSON.stringify(err.restriction)).not.toMatch(/appliedBy|caseId/);
    },
  );
  it.each(ops)(
    "%s: 409 author_restriction_changed → 'changed', no detail",
    async (_n, op) => {
      respond(409, { error: "x", code: "author_restriction_changed" });
      const err = await failure(op);
      expect(restrictionOutcome(err)).toEqual({ kind: "changed" });
      expect(err.restriction).toBeNull();
    },
  );
  it("403 without / with a malformed restriction keeps the code and drops the detail", async () => {
    respond(403, { error: "x", code: "author_restricted" });
    expect(
      ((await ops[0][1]().catch((e: unknown) => e)) as { restriction: unknown })
        .restriction,
    ).toBeNull();
    respond(403, { error: "x", code: "author_restricted", restriction: { level: 9 } });
    const err = await failure(ops[0][1]);
    expect(err.code).toBe("author_restricted");
    expect(err.restriction).toBeNull();
  });
  it("a restriction object on any OTHER code is never adopted", async () => {
    respond(409, {
      error: "x",
      code: "community_version_conflict",
      restriction: RESTRICTION,
    });
    const err = await failure(ops[0][1]);
    expect(err.restriction).toBeNull();
    expect(restrictionOutcome(err)).toBeNull();
  });
  it("own DELETE is a plain call that is never gated by the restriction model", async () => {
    respond(200, { postId: "p", allCleaned: true, deletedAssets: [] });
    await expect(
      deleteCommunityPost({ postId: "p", expectedVersion: 1 }),
    ).resolves.toBeTruthy();
  });
});

describe("Media client: reserve rejected by the non-authoritative precheck", () => {
  const reserveInput = {
    domain: "community",
    kind: "image",
    sourceMime: "image/jpeg",
    sourceBytes: 10,
    sourceWidth: 1,
    sourceHeight: 1,
  } as never;
  it("MediaClientError carries the restriction", async () => {
    respond(403, { error: "x", code: "author_restricted", restriction: RESTRICTION });
    const err = await failure(() => reserveMediaUpload(reserveInput));
    expect(err).toBeInstanceOf(MediaClientError);
    expect(err.restriction).toEqual(RESTRICTION);
  });
  it("other failures never adopt a restriction", async () => {
    respond(400, { error: "x", code: "invalid_kind", restriction: RESTRICTION });
    const err = await failure(() => reserveMediaUpload(reserveInput));
    expect(err.restriction).toBeNull();
  });
});

describe("fetchAuthorRestriction (R5-F)", () => {
  it("GET sin identidad en la URL: sin restricción → null; restringida → vista parseada", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ restricted: false, restriction: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchAuthorRestriction()).toBeNull();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/admin/community-author-restriction");
    expect(init.method).toBe("GET");
    respond(200, { restricted: true, restriction: RESTRICTION });
    expect(await fetchAuthorRestriction()).toEqual(RESTRICTION);
  });

  it("503, red caída o forma inesperada LANZAN: nunca se interpreta como sin restricción", async () => {
    respond(503, { error: "x", code: "restriction_unavailable" });
    await expect(fetchAuthorRestriction()).rejects.toMatchObject({ status: 503 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network");
      }),
    );
    await expect(fetchAuthorRestriction()).rejects.toBeInstanceOf(CommunityClientError);
    for (const body of [
      {},
      { restricted: "no" },
      { restricted: true },
      { restricted: true, restriction: { ...RESTRICTION, level: 9 } },
    ]) {
      respond(200, body);
      await expect(fetchAuthorRestriction()).rejects.toBeInstanceOf(CommunityClientError);
    }
  });
});
