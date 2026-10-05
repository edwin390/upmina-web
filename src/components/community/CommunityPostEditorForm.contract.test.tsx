import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import CommunityPostEditorForm from "./CommunityPostEditorForm";
import {
  createAtomicTestDatabase,
  ATTACHMENTS,
  ASSETS,
  type TestDatabase,
} from "@/lib/community-atomic-save-test-db";
import { listOwnCommunityPosts, saveCommunityPost } from "@/lib/community-client";
import {
  handleCommunityPostListOwn,
  handleCommunityPostSave,
} from "@/lib/community-post-handlers";

const fake = vi.hoisted(() => ({ rpc: vi.fn(), abort: vi.fn(), success: vi.fn() }));
vi.mock("@/lib/r2-client.js", async () => ({
  ...(await vi.importActual<typeof import("@/lib/r2-client")>("@/lib/r2-client")),
  publicVariantUrl: (key: string) => `https://cdn.fixture.test/${key}`,
}));
vi.mock("@/lib/cosplay-media-lifecycle.js", () => ({
  attemptMediaAssetCleanup: async (assetId: string) => ({ assetId, cleaned: false }),
}));
let db: TestDatabase;
afterEach(async () => {
  await db?.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const postId = "24655b41-1bc7-487c-834e-d1715a596e9e";
const assets = ASSETS.slice(0, 3);
const row = {
  id: postId,
  author_user_id: "33333333-3333-4333-8333-333333333333",
  text: "Original",
  status: "published",
  version: 2,
  like_count: 0,
  created_at: "x",
  updated_at: "x",
  community_post_media: assets.map((asset, position) => ({
    id: ATTACHMENTS[position],
    asset_id: asset,
    position,
    media_assets: {
      id: asset,
      status: "ready",
      kind: "image",
      width: 480,
      height: 400,
      storage_key: null,
    },
  })),
};
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getClaims: async () => ({
        data: { claims: { sub: row.author_user_id, aal: "aal1" } },
        error: null,
      }),
    },
    from: (table: string) => {
      if (table !== "media_assets") throw new Error(`Unexpected table: ${table}`);
      return {
        select: () => ({
          in: async () => ({
            data: row.community_post_media.map((m) => ({
              domain: "community",
              duration_seconds: null,
              ...m.media_assets,
              storage_key: `community/${m.asset_id}.webp`,
            })),
            error: null,
          }),
        }),
      };
    },
    // Explicit dispatch: the R4-C owner read path legitimately calls community_author_posts_read.
    // Any other RPC still goes through fake.rpc, which asserts community_post_save_atomic.
    rpc: async (name: string, ...rest: unknown[]) => {
      if (name === "community_author_posts_read")
        return {
          error: null,
          data: {
            serverNow: "2026-10-04T18:00:00Z",
            noticeId: null,
            items: [
              {
                id: row.id,
                text: row.text,
                status: row.status,
                version: row.version,
                createdAt: "2026-10-04T17:00:00Z",
                updatedAt: "2026-10-04T17:00:00Z",
                likeCount: row.like_count,
                resolvedNoticeUnseen: false,
                author: { username: "author_test", displayName: null },
                moderation: { kind: "none", deadline: null, message: null },
                media: row.community_post_media.map((m) => ({
                  id: m.id,
                  assetId: m.asset_id,
                  position: m.position,
                })),
              },
            ],
          },
        };
      return fake.rpc(name, ...rest);
    },
  }),
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: "fixture" } } }),
    },
  },
}));
vi.mock("@/lib/media-client", async () => ({
  ...(await vi.importActual("@/lib/media-client")),
  abortMediaUpload: fake.abort,
}));
vi.mock("@/lib/action-notice", () => ({ showActionSuccess: fake.success }));

beforeEach(async () => {
  vi.resetAllMocks();
  db = await createAtomicTestDatabase();
  vi.stubEnv("VITE_SUPABASE_URL", "https://fixture.test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fixture");
  fake.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    expect(name).toBe("community_post_save_atomic");
    try {
      const result = await db.query<{ result: unknown }>(
        "select community_post_save_atomic($1::uuid,$2::uuid,$3::integer,$4::text,$5::jsonb,$6::uuid[]) result",
        [
          args.p_actor_user_id,
          args.p_post_id,
          args.p_expected_version,
          args.p_text,
          JSON.stringify(args.p_media),
          args.p_removed_media_ids,
        ],
      );
      return { data: result.rows[0].result, error: null };
    } catch (error) {
      return { data: null, error: { code: "P0001", message: (error as Error).message } };
    }
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      let status = 200;
      let body: unknown;
      const response = {
        setHeader: () => response,
        status: (code: number) => {
          status = code;
          return response;
        },
        json: (value: unknown) => {
          body = value;
          return response;
        },
      };
      const request = {
        method: init.method,
        headers: { authorization: "Bearer fixture" },
        query: {},
        body: init.body,
      } as VercelRequest;
      if (url === "/api/admin/community-post-list-own")
        await handleCommunityPostListOwn(request, response as unknown as VercelResponse);
      else if (url === "/api/admin/community-post-save")
        await handleCommunityPostSave(request, response as unknown as VercelResponse);
      else throw new Error("Unexpected local request");
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}, 30000);

it("real own-list → edit form → real client → HTTP validator preserves post/version/three asset IDs", async () => {
  const { items } = await listOwnCommunityPosts();
  const saved = vi.fn();
  render(
    <CommunityPostEditorForm initialPost={items[0]} onSaved={saved} onCancel={vi.fn()} />,
  );
  expect(screen.getByPlaceholderText("¿Qué quieres compartir?")).toHaveValue("Original");
  expect(screen.getAllByRole("button", { name: "Quitar imagen" })).toHaveLength(3);
  fireEvent.change(screen.getByPlaceholderText("¿Qué quieres compartir?"), {
    target: { value: "Editado" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Publicar" }));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  expect(fake.rpc).toHaveBeenCalledTimes(1);
  expect(fake.rpc).toHaveBeenCalledWith("community_post_save_atomic", {
    p_actor_user_id: row.author_user_id,
    p_post_id: postId,
    p_expected_version: 2,
    p_text: "Editado",
    p_media: assets.map((asset_id, position) => ({ asset_id, position })),
    p_removed_media_ids: [],
  });
  expect(fake.success).toHaveBeenCalledWith("Publicación actualizada correctamente");
  expect(fake.abort).not.toHaveBeenCalled();
});

it("real remove B → client → handler → PostgreSQL succeeds; omission alone produces the human error", async () => {
  await expect(
    saveCommunityPost({
      postId,
      expectedVersion: 2,
      text: "Original",
      media: [0, 2].map((n, position) => ({ assetId: ASSETS[n], position })),
      removedMediaIds: [],
    }),
  ).rejects.toMatchObject({
    status: 400,
    code: "media_missing_existing",
    message: "Solicitud inválida",
  });
  fake.rpc.mockClear();
  const { items } = await listOwnCommunityPosts();
  const saved = vi.fn();
  render(
    <CommunityPostEditorForm initialPost={items[0]} onSaved={saved} onCancel={vi.fn()} />,
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Quitar imagen" })[1]);
  expect(fake.rpc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Publicar" }));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  expect(fake.rpc.mock.calls[0][1]).toMatchObject({
    p_removed_media_ids: [ATTACHMENTS[1]],
    p_media: [0, 2].map((n, position) => ({ asset_id: ASSETS[n], position })),
  });
  expect(
    (
      await db.query(
        "select asset_id,position from community_post_media order by position",
      )
    ).rows,
  ).toEqual([0, 2].map((n, position) => ({ asset_id: ASSETS[n], position })));
  expect((await db.query("select version from community_posts")).rows[0].version).toBe(3);
  expect(fake.success).toHaveBeenCalledWith("Publicación actualizada correctamente");
  expect(fake.abort).not.toHaveBeenCalled();
});

it("the Supabase mock still rejects any RPC other than the two legitimate ones", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  await expect(
    createClient("https://fixture.test", "fixture").rpc("unexpected_rpc"),
  ).rejects.toThrow();
});
