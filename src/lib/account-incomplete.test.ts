import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountIncompleteReason,
  parseAccountIncompleteReason,
} from "./account-incomplete";
import { restrictionOutcome } from "./author-restriction";

// AUTH-2: la cuenta incompleta es un dominio distinto de las sanciones; el cliente la interpreta
// desde el 403 del servidor y los clientes de Community y Media la propagan sin tocar el modelo
// de strikes.

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

const { saveCommunityPost, setCommunityPostLike, deleteCommunityPost } =
  await import("./community-client");
const { reserveMediaUpload } = await import("./media-client");

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
async function failure(op: () => Promise<unknown>): Promise<unknown> {
  try {
    await op();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to fail");
}
beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("accountIncompleteReason", () => {
  it.each([
    ["email_unverified", "email_unverified"],
    ["username_missing", "username_missing"],
  ])("code account_incomplete + reason %s → %s", (reason, expected) => {
    expect(
      accountIncompleteReason({ code: "account_incomplete", accountReason: reason }),
    ).toBe(expected);
  });
  it("razón inválida o ausente → la más segura (verificar el correo), nunca null", () => {
    expect(accountIncompleteReason({ code: "account_incomplete" })).toBe(
      "email_unverified",
    );
    expect(
      accountIncompleteReason({ code: "account_incomplete", accountReason: "otra" }),
    ).toBe("email_unverified");
  });
  it("contrato anterior profile_required = username pendiente", () => {
    expect(accountIncompleteReason({ code: "profile_required" })).toBe(
      "username_missing",
    );
  });
  it.each([
    [null],
    [undefined],
    ["texto"],
    [{ code: "author_restricted" }],
    [{ code: "community_version_conflict" }],
  ])("%j no es cuenta incompleta", (err) => {
    expect(accountIncompleteReason(err)).toBeNull();
  });
  it("parse estricto de la razón", () => {
    expect(parseAccountIncompleteReason("email_unverified")).toBe("email_unverified");
    expect(parseAccountIncompleteReason("x")).toBeNull();
    expect(parseAccountIncompleteReason(null)).toBeNull();
  });
  it("account_incomplete y author_restricted son disjuntos", () => {
    const incomplete = { code: "account_incomplete", accountReason: "email_unverified" };
    expect(restrictionOutcome(incomplete)).toBeNull();
    expect(
      accountIncompleteReason({ code: "author_restricted", restriction: {} }),
    ).toBeNull();
  });
});

describe("clientes: propagan la razón de account_incomplete", () => {
  const body = { error: "Cuenta incompleta", code: "account_incomplete" };
  it.each(["email_unverified", "username_missing"])(
    "save / like / reserva con reason %s",
    async (reason) => {
      respond(403, { ...body, reason });
      const save = (await failure(() =>
        saveCommunityPost({
          postId: null,
          expectedVersion: null,
          text: "x",
          media: [],
          removedMediaIds: [],
        }),
      )) as { code?: string; accountReason?: string; restriction: unknown };
      expect(save).toMatchObject({ code: "account_incomplete", accountReason: reason });
      expect(save.restriction).toBeNull();
      const like = (await failure(() =>
        setCommunityPostLike({ postId: "p", liked: true }),
      )) as { accountReason?: string };
      expect(like.accountReason).toBe(reason);
      const reserve = (await failure(() =>
        reserveMediaUpload({
          domain: "community",
          kind: "image",
          sourceMime: "image/jpeg",
          sourceBytes: 10,
        } as never),
      )) as { code?: string; accountReason?: string };
      expect(reserve).toMatchObject({
        code: "account_incomplete",
        accountReason: reason,
      });
    },
  );
  it("una razón inventada por el servidor no se propaga", async () => {
    respond(403, { ...body, reason: "algo" });
    const err = (await failure(() =>
      setCommunityPostLike({ postId: "p", liked: true }),
    )) as { accountReason: unknown };
    expect(err.accountReason).toBeNull();
  });
  it("otros 403 (forbidden) no llevan razón de cuenta", async () => {
    respond(403, { error: "No", code: "forbidden" });
    const err = (await failure(() =>
      setCommunityPostLike({ postId: "p", liked: true }),
    )) as { accountReason: unknown };
    expect(err.accountReason).toBeNull();
  });
  it("eliminar una publicación propia no se trata como cuenta incompleta (200)", async () => {
    respond(200, { postId: "p", deletedAssets: [], allCleaned: true });
    await expect(
      deleteCommunityPost({ postId: "p", expectedVersion: 1 }),
    ).resolves.toBeTruthy();
  });
});
