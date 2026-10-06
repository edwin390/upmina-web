// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
vi.mock("./r2-client.js", () => ({
  publicVariantUrl: (key: string) => `https://media.synthetic.example/${key}`,
}));

// Foundation de moderación (Fase 9K-1): se ejecutan los handlers REALES, requireAuthenticated y
// requireCapability REALES; el cliente de Supabase es un falso en memoria. Las garantías reales
// de las RPC (re-verificación de rol (el lock de autoridad se añade en 9K-2), inmutabilidad del audit log, CHECK constraints)
// ya se verificaron aparte contra Postgres real en Upmina Testing (ver el informe 9K-1). Este
// archivo fija el contrato HTTP: autorización por capacidad `moderation` (nunca solo admin),
// requireAuthenticated-only para crear un reporte, forma del body/query, mapeo de errores de RPC,
// y que el actor SIEMPRE sale del JWT verificado.

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const MOD_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const DEV_ID = "55555555-5555-4555-8555-555555555555";
const POST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REPORT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const NOW = Math.floor(Date.now() / 1000);
const ASSET_ID = POST_ID;
const SIGNING_PKCS8 = Buffer.from(
  await crypto.subtle.exportKey(
    "pkcs8",
    (
      (await crypto.subtle.generateKey("Ed25519", true, [
        "sign",
        "verify",
      ])) as CryptoKeyPair
    ).privateKey,
  ),
).toString("base64");
function secureDelivery() {
  vi.stubEnv("MEDIA_DELIVERY_BASE_URL", "https://media.synthetic.example");
  vi.stubEnv("MEDIA_CAP_SIGNING_PRIVATE_KEY", SIGNING_PKCS8);
  vi.stubEnv("MEDIA_CAP_KEY_ID", "k1");
  vi.stubEnv("MEDIA_CAP_AUDIENCE", "upmina-media-synthetic");
}
const caseItemPost = (status: string, purgeAfter: string | null = null) => ({
  text: "x",
  status,
  version: 1,
  updatedAt: "2026-10-01T00:00:00Z",
  authorUsername: "kirito",
  quarantineCycleId: null,
  removalDecisionId: status === "removed_pending_purge" ? REPORT_ID : null,
  removedAt:
    status === "removed_pending_purge" && purgeAfter
      ? new Date(Date.parse(purgeAfter) - 72 * 3600 * 1000).toISOString()
      : null,
  purgeAfter,
});
const capOf = (url: string) => new URL(url).searchParams.get("cap");
const capPayload = (url: string) =>
  JSON.parse(Buffer.from(capOf(url)!.split(".")[1], "base64url").toString());
const TOKENS: Record<string, { sub: string; aal: string; amr?: unknown }> = {
  "jwt-admin-aal2": {
    sub: ADMIN_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: NOW }],
  },
  "jwt-moderator-aal2": {
    sub: MOD_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: NOW }],
  },
  "jwt-moderator-aal1": { sub: MOD_ID, aal: "aal1" },
  "jwt-moderator-stale": {
    sub: MOD_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: NOW - 86400 }],
  },
  "jwt-developer-aal2": {
    sub: DEV_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: NOW }],
  },
  "jwt-user-aal1": { sub: USER_ID, aal: "aal1" },
  "jwt-user-aal2": {
    sub: USER_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: NOW }],
  },
};

type Row = Record<string, unknown>;

const fake = vi.hoisted(() => ({
  roles: {} as Record<string, string | undefined>,
  reports: [] as Row[],
  posts: [] as Row[],
  profiles: [] as Row[],
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  rpcResult: undefined as { data: unknown; error: unknown } | undefined,
  auditRows: [] as unknown[],
  attachments: [] as Row[],
  assets: [] as Row[],
  assetLookups: [] as string[][],
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      async getClaims(jwt: string) {
        const claims = TOKENS[jwt];
        return claims
          ? { data: { claims }, error: null }
          : { data: null, error: { message: "jwt inválido" } };
      },
    },
    from(table: string) {
      if (table === "admin_roles") {
        let userId = "";
        const builder = {
          eq(_c: string, v: string) {
            userId = v;
            return builder;
          },
          async maybeSingle() {
            const role = fake.roles[userId];
            return { data: role ? { role } : null, error: null };
          },
        };
        return { select: () => builder };
      }
      if (table === "community_post_reports") {
        const state: { eqId?: string; statuses?: string[]; cursor?: string } = {};
        const builder = {
          in(_c: string, statuses: string[]) {
            state.statuses = statuses;
            return builder;
          },
          or(cursor: string) {
            state.cursor = cursor;
            return builder;
          },
          order() {
            return builder;
          },
          limit(limit: number) {
            const cursor = state.cursor?.match(
              /created_at.lt.([^,]+),and\(created_at.eq.[^,]+,id.lt.([^)]+)/,
            );
            const rows = fake.reports
              .filter(
                (r) =>
                  (!state.statuses || state.statuses.includes(String(r.status))) &&
                  (!cursor ||
                    String(r.created_at) < cursor[1]! ||
                    (String(r.created_at) === cursor[1] && String(r.id) < cursor[2]!)),
              )
              .sort(
                (a, b) =>
                  String(b.created_at).localeCompare(String(a.created_at)) ||
                  String(b.id).localeCompare(String(a.id)),
              );
            return Promise.resolve({ data: rows.slice(0, limit), error: null });
          },
          eq(_c: string, v: string) {
            state.eqId = v;
            return builder;
          },
          async maybeSingle() {
            const row = fake.reports.find((r) => r.id === state.eqId);
            return { data: row ?? null, error: null };
          },
        };
        return { select: () => builder };
      }
      if (table === "community_posts") {
        const state = { eqId: "" };
        const builder = {
          eq(_c: string, v: string) {
            state.eqId = v;
            return builder;
          },
          async maybeSingle() {
            return {
              data: fake.posts.find((p) => p.id === state.eqId) ?? null,
              error: null,
            };
          },
          in(_c: string, ids: string[]) {
            return Promise.resolve({
              data: fake.posts.filter((p) => ids.includes(p.id as string)),
              error: null,
            });
          },
        };
        return { select: () => builder };
      }
      if (table === "profiles") {
        const builder = {
          in(_c: string, ids: string[]) {
            return Promise.resolve({
              data: fake.profiles.filter((p) => ids.includes(p.user_id as string)),
              error: null,
            });
          },
        };
        return { select: () => builder };
      }
      if (table === "media_assets") {
        return {
          select: () => ({
            in: async (_c: string, ids: string[]) => {
              fake.assetLookups.push(ids);
              return {
                data: fake.assets.filter((a) => ids.includes(a.id as string)),
                error: null,
              };
            },
          }),
        };
      }
      if (table === "community_post_media") {
        const builder = {
          eq: () => builder,
          order: () => builder,
          limit: async () => ({ data: fake.attachments, error: null }),
        };
        return { select: () => builder };
      }
      throw new Error(`tabla inesperada: ${table}`);
    },
    async rpc(name: string, args: Record<string, unknown>) {
      fake.rpcCalls.push({ name, args });
      if (name === "community_moderation_audit")
        return { data: fake.auditRows, error: null };
      return (
        fake.rpcResult ?? {
          data: null,
          error: { code: "XX000", message: "sin resultado" },
        }
      );
    },
  }),
}));

const {
  handleModerationReports,
  handleModerationReport,
  handleModerationReportStatus,
  handleModerationReportCreate,
} = await import("./moderation-handlers");
const { handleModerationCaseDecision } = await import("./moderation-decision-handlers");
const { handleModerationCases, normalizeModerationCase } =
  await import("./moderation-case-handlers");

function mockRes() {
  const state: { status?: number; body?: unknown; headers: Record<string, string> } = {
    headers: {},
  };
  const res = {
    setHeader(name: string, value: string) {
      state.headers[name] = value;
      return res;
    },
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  };
  return { res: res as unknown as VercelResponse, state };
}

function req(opts: {
  method?: string;
  token?: string | null;
  body?: unknown;
  query?: Record<string, string | undefined>;
}) {
  const headers: Record<string, string> = {};
  if (opts.token !== null)
    headers.authorization = `Bearer ${opts.token ?? "jwt-moderator-aal2"}`;
  return {
    method: opts.method ?? "GET",
    headers,
    query: opts.query ?? {},
    body: opts.body,
  } as unknown as VercelRequest;
}

async function call(
  handler: (req: VercelRequest, res: VercelResponse) => Promise<VercelResponse>,
  request: VercelRequest,
) {
  const { res, state } = mockRes();
  await handler(request, res);
  return state;
}

const ok = (data: unknown) => ({ data, error: null });
const rpcError = (message: string) => ({ data: null, error: { code: "P0001", message } });

const item = () => ({
  caseId: POST_ID,
  postId: POST_ID,
  cycleId: REPORT_ID,
  currentCycleId: REPORT_ID,
  caseVersion: 1,
  cycleNumber: 1,
  currentCycleNumber: 1,
  caseStatus: "pending",
  cycleStatus: "pending",
  closureKind: null,
  isCurrentCycle: true,
  createdAt: "2026-10-01T00:00:00Z",
  openedAt: "2026-10-01T00:00:00Z",
  closedAt: null,
  activityAt: "2026-10-01T00:00:00Z",
  firstReportAt: null,
  lastReportAt: null,
  post: null,
  totalReports: 0,
  qualifyingReporters: 0,
  reasons: [],
  reports: [],
  reportsTruncated: false,
  media: [],
  audit: [],
});

describe("R3 case read HTTP boundary", () => {
  it.each([null, "jwt-user-aal2", "jwt-moderator-aal1", "jwt-moderator-stale"])(
    "requires JWT/capability/recent MFA (%s)",
    async (token) => {
      const response = await call(handleModerationCases, req({ token }));
      expect(response.status).toBe(token === null ? 401 : 403);
      expect(fake.rpcCalls).toHaveLength(0);
    },
  );
  it.each(["jwt-moderator-aal2", "jwt-developer-aal2", "jwt-admin-aal2"])(
    "authorized %s uses one grouped RPC with verified actor",
    async (token) => {
      fake.rpcResult = ok({ cases: [item()], next: null });
      const response = await call(
        handleModerationCases,
        req({ token, query: { actorUserId: USER_ID } }),
      );
      expect(response.status).toBe(200);
      expect(fake.rpcCalls).toEqual([
        {
          name: "community_moderation_cases_read",
          args: {
            p_actor_user_id: TOKENS[token]!.sub,
            p_scope: "active",
            p_before_activity: null,
            p_before_cycle: null,
            p_cycle_id: null,
          },
        },
      ]);
      expect(response.headers["Cache-Control"]).toBe("no-store");
      expect(fake.assetLookups).toEqual([]);
    },
  );

  it.each([
    { createdAt: "invalid" },
    { openedAt: "2026-02-30T00:00:00Z" },
    {
      media: [
        {
          id: REPORT_ID,
          position: 0,
          media_assets: {
            status: "ready",
            kind: "audio",
            storage_key: "synthetic/image",
            width: 640,
            height: 480,
            duration_seconds: null,
          },
        },
      ],
    },
    { media: [{ id: "invalid", position: 0, media_assets: null }] },
    { media: [{ id: REPORT_ID, position: -1, media_assets: null }] },
    {
      media: [
        {
          id: REPORT_ID,
          position: 0,
          media_assets: {
            status: "ready",
            kind: "image",
            storage_key: "synthetic/image",
            width: 0,
            height: 480,
            duration_seconds: null,
          },
        },
      ],
    },
  ])(
    "rejects malformed DB dates/media without raw payload leakage (%j)",
    async (fields) => {
      fake.rpcResult = ok({ cases: [{ ...item(), ...fields }], next: null });
      const response = await call(handleModerationCases, req({}));
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: "Error interno" });
    },
  );
  it("validates raw media then preserves existing ready-only filtering", () => {
    const asset = {
      status: "ready",
      kind: "image",
      storage_key: "synthetic/image",
      width: 640,
      height: 480,
      duration_seconds: null,
    };
    const result = normalizeModerationCase({
      ...item(),
      media: [
        { id: REPORT_ID, position: 0, media_assets: asset },
        {
          id: POST_ID,
          position: 1,
          media_assets: {
            ...asset,
            status: "processing",
            storage_key: null,
            width: null,
            height: null,
          },
        },
      ],
    });
    expect(result.media).toHaveLength(1);
    expect(result.media[0]).toMatchObject({
      id: REPORT_ID,
      kind: "image",
      width: 640,
      url: "https://media.synthetic.example/synthetic/image",
    });
    expect(JSON.stringify(result)).not.toContain("storage_key");
  });
  it("detail batches opaque media references without leaking storage", async () => {
    fake.rpcResult = ok({
      item: {
        ...item(),
        post: caseItemPost("published"),
        media: [{ id: REPORT_ID, assetId: POST_ID, position: 0 }],
      },
    });
    fake.assets = [
      {
        id: POST_ID,
        domain: "community",
        status: "ready",
        kind: "video",
        storage_key: `community/${POST_ID}/original.mp4`,
        width: 640,
        height: 480,
        duration_seconds: 3,
      },
    ];
    const response = await call(
      handleModerationCases,
      req({ query: { cycleId: REPORT_ID } }),
    );
    expect(response.status).toBe(200);
    expect(fake.assetLookups).toEqual([[POST_ID]]);
    expect(JSON.stringify(response.body)).not.toContain("storage_key");
    expect(response.body).toMatchObject({
      item: { media: [{ kind: "video", durationSeconds: 3 }] },
    });
  });
  it("missing resolved asset fails controlled", async () => {
    fake.rpcResult = ok({
      item: { ...item(), media: [{ id: REPORT_ID, assetId: POST_ID, position: 0 }] },
    });
    const response = await call(
      handleModerationCases,
      req({ query: { cycleId: REPORT_ID } }),
    );
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Error interno" });
  });
  it("detail uses the same privileged bounded RPC", async () => {
    fake.rpcResult = ok({ item: item() });
    const response = await call(
      handleModerationCases,
      req({ query: { cycleId: REPORT_ID } }),
    );
    expect(response.body).toMatchObject({ item: { cycleId: REPORT_ID } });
    expect(fake.rpcCalls).toHaveLength(1);
  });
  it("cursor matches activity/cycle tie-break and roundtrips", async () => {
    fake.rpcResult = ok({
      cases: [item()],
      next: { activityAt: item().activityAt, cycleId: REPORT_ID },
    });
    const first = await call(handleModerationCases, req({}));
    const cursor = (first.body as { nextCursor: string }).nextCursor;
    await call(handleModerationCases, req({ query: { cursor } }));
    expect(fake.rpcCalls[1]!.args).toMatchObject({
      p_before_activity: item().activityAt,
      p_before_cycle: REPORT_ID,
    });
  });
  it.each([
    { scope: "invalid" },
    { cycleId: "not-uuid" },
    { cursor: "broken" },
    { cycleId: REPORT_ID, cursor: "broken" },
  ])("rejects malformed inputs before RPC %j", async (query) => {
    expect((await call(handleModerationCases, req({ query }))).status).toBe(400);
    expect(fake.rpcCalls).toHaveLength(0);
  });
  it.each([
    ["actor_not_moderator", 403],
    ["case_not_found", 404],
    ["private SQL diagnostic", 500],
  ] as const)("closed DB error mapping %s", async (code, status) => {
    fake.rpcResult = rpcError(code);
    const response = await call(handleModerationCases, req({}));
    expect(response.status).toBe(status);
    expect(JSON.stringify(response.body)).not.toContain("private SQL");
  });
  it("allowlist strips unexpected reporter identities and arbitrary audit metadata", () => {
    const value = {
      ...item(),
      reporter_user_id: USER_ID,
      reports: [
        {
          reportId: REPORT_ID,
          reason: "spam",
          detail: "safe text",
          status: "open",
          version: 1,
          createdAt: item().activityAt,
          reporter_user_id: USER_ID,
        },
      ],
      audit: [
        {
          id: REPORT_ID,
          action: "post_hidden",
          actorKind: "human",
          createdAt: item().activityAt,
          actor_user_id: ADMIN_ID,
          states: {
            fromPostStatus: "published",
            toPostStatus: "hidden",
            fromReportStatus: null,
            toReportStatus: null,
            reporter: USER_ID,
          },
        },
      ],
    };
    const text = JSON.stringify(normalizeModerationCase(value));
    expect(text).not.toContain(USER_ID);
    expect(text).not.toContain(ADMIN_ID);
    expect(text).not.toContain("reporter");
  });
  it("rejects oversized RPC page rather than exposing unbounded data", async () => {
    fake.rpcResult = ok({ cases: Array.from({ length: 21 }, item), next: null });
    expect((await call(handleModerationCases, req({}))).status).toBe(500);
  });
  it("rejects POST without invoking a writer", async () => {
    expect((await call(handleModerationCases, req({ method: "POST" }))).status).toBe(405);
    expect(fake.rpcCalls).toHaveLength(0);
  });
});

describe("9K-2 authoritative HTTP contract", () => {
  const input = (action = "hide") => ({
    reportId: REPORT_ID,
    action,
    expectedReportVersion: 2,
    expectedPostVersion: 3,
  });
  it.each(["hide", "restore", "resolve", "dismiss", "reviewing"])(
    "%s requires verified capability and recent MFA",
    async (action) => {
      for (const token of [
        null,
        "jwt-user-aal2",
        "jwt-moderator-aal1",
        "jwt-moderator-stale",
      ]) {
        const response = await call(
          handleModerationReportStatus,
          req({ method: "POST", token, body: input(action) }),
        );
        expect(response.status).toBe(token === null ? 401 : 403);
        if (token?.includes("moderator"))
          expect(response.body).toMatchObject({ code: "step_up_required" });
        expect(fake.rpcCalls).toHaveLength(0);
      }
    },
  );
  it("bounded active/closed pages use stable cursors without reporter identity", async () => {
    fake.reports = Array.from({ length: 53 }, (_, i) => ({
      id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, "0")}`,
      post_id: POST_ID,
      reason: "spam",
      status: i === 52 ? "dismissed" : "open",
      created_at: "2026-03-01T00:00:00.000Z",
      version: 1,
      reporter_user_id: USER_ID,
    }));
    const first = await call(handleModerationReports, req({}));
    const page = first.body as { reports: Row[]; nextCursor: string };
    expect(page.reports).toHaveLength(50);
    expect(page.nextCursor).toBeTruthy();
    const next = (
      await call(handleModerationReports, req({ query: { cursor: page.nextCursor } }))
    ).body as { reports: Row[]; nextCursor: string | null };
    expect(next.reports).toHaveLength(2);
    expect(next.nextCursor).toBeNull();
    expect(new Set([...page.reports, ...next.reports].map((r) => r.id)).size).toBe(52);
    expect(JSON.stringify(page)).not.toContain("reporter_user_id");
    const closed = (
      await call(handleModerationReports, req({ query: { scope: "closed" } }))
    ).body as { reports: Row[] };
    expect(closed.reports).toHaveLength(1);
    expect(closed.reports[0]).toMatchObject({ status: "dismissed" });
  });
  it("invalid pagination and scope fail closed", async () => {
    for (const query of [{ scope: "all" }, { cursor: "bad" }] as Record<string, string>[])
      expect((await call(handleModerationReports, req({ query }))).status).toBe(400);
  });
  it("hidden post detail keeps full current content, safe media and audit context", async () => {
    fake.reports = [
      {
        id: REPORT_ID,
        post_id: POST_ID,
        reason: "spam",
        status: "open",
        version: 2,
        created_at: "2026-03-01T00:00:00.000Z",
        updated_at: "2026-03-01T00:00:00.000Z",
      },
    ];
    fake.posts = [
      {
        id: POST_ID,
        text: "x".repeat(900),
        status: "hidden_pending_review",
        author_user_id: USER_ID,
        version: 3,
        updated_at: "2026-03-02T00:00:00.000Z",
      },
    ];
    fake.attachments = [
      {
        id: "media",
        position: 0,
        media_assets: {
          status: "ready",
          kind: "image",
          storage_key: `community/${ASSET_ID}/w480.webp`,
          width: 320,
          height: 200,
          duration_seconds: null,
        },
      },
      { id: "pending", position: 1, media_assets: { status: "reserved" } },
    ];
    secureDelivery();
    const response = await call(
      handleModerationReport,
      req({ query: { id: REPORT_ID } }),
    );
    expect(response.status).toBe(200);
    const report = (
      response.body as {
        report: {
          postPreview: { text: string; status: string };
          media: unknown[];
          audit: unknown[];
        };
      }
    ).report;
    expect(report.postPreview).toMatchObject({
      text: "x".repeat(900),
      status: "hidden_pending_review",
    });
    expect(report.media).toHaveLength(1);
    const mediaUrl = (report.media[0] as { url: string }).url;
    expect(
      mediaUrl.startsWith(
        `https://media.synthetic.example/community/${ASSET_ID}/w480.webp?cap=`,
      ),
    ).toBe(true);
    expect(capPayload(mediaUrl)).toMatchObject({
      a: ASSET_ID,
      s: "moderator",
      u: "upmina-media-synthetic",
    });
    expect(report.audit).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("storage_key");
  });
});

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://proyecto-ficticio.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "srk-service-role-ficticia");
  fake.roles = { [ADMIN_ID]: "admin", [MOD_ID]: "moderator", [DEV_ID]: "developer" };
  fake.reports = [];
  fake.posts = [];
  fake.profiles = [];
  fake.rpcCalls = [];
  fake.rpcResult = undefined;
  fake.auditRows = [];
  fake.attachments = [];
  fake.assets = [];
  fake.assetLookups = [];
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// GET /api/admin/moderation-reports

describe("handleModerationReports — autorización (capacidad moderation, nunca solo admin)", () => {
  it("método distinto de GET → 405", async () => {
    const state = await call(handleModerationReports, req({ method: "POST" }));
    expect(state.status).toBe(405);
    expect(state.headers.Allow).toBe("GET");
  });

  it("visitante (sin Authorization) → 401", async () => {
    const state = await call(handleModerationReports, req({ token: null }));
    expect(state.status).toBe(401);
  });

  it("USER normal (sin fila en admin_roles) → 403, nunca lista reportes", async () => {
    const state = await call(handleModerationReports, req({ token: "jwt-user-aal2" }));
    expect(state.status).toBe(403);
  });

  it("MODERATOR (no solo ADMIN) puede acceder: la capacidad moderation basta", async () => {
    const state = await call(
      handleModerationReports,
      req({ token: "jwt-moderator-aal2" }),
    );
    expect(state.status).toBe(200);
  });

  it("DEVELOPER también puede acceder (misma capacidad moderation)", async () => {
    const state = await call(
      handleModerationReports,
      req({ token: "jwt-developer-aal2" }),
    );
    expect(state.status).toBe(200);
  });

  it("ADMIN también puede acceder", async () => {
    const state = await call(handleModerationReports, req({ token: "jwt-admin-aal2" }));
    expect(state.status).toBe(200);
  });

  it("MODERATOR con rol válido pero SIN MFA reciente → 403 con step_up_required", async () => {
    const state = await call(
      handleModerationReports,
      req({ token: "jwt-moderator-aal1" }),
    );
    expect(state.status).toBe(403);
    expect((state.body as { code?: string }).code).toBe("step_up_required");
  });
});

describe("handleModerationReports — cola de reportes", () => {
  it("vacío: devuelve reports: [] (nunca un error)", async () => {
    const state = await call(handleModerationReports, req({}));
    expect(state.status).toBe(200);
    expect(state.body).toEqual({ reports: [], nextCursor: null });
  });

  it("lista reportes reales con reason/status/createdAt/postId", async () => {
    fake.reports = [
      {
        id: REPORT_ID,
        post_id: POST_ID,
        version: 1,
        reason: "spam",
        status: "open",
        created_at: "2026-03-01T00:00:00.000Z",
      },
    ];
    const state = await call(handleModerationReports, req({}));
    expect(state.status).toBe(200);
    const body = state.body as { reports: unknown[] };
    expect(body.reports).toHaveLength(1);
    expect(body.reports[0]).toMatchObject({
      id: REPORT_ID,
      postId: POST_ID,
      reason: "spam",
      status: "open",
      createdAt: "2026-03-01T00:00:00.000Z",
    });
  });

  it("incluye un preview del contenido si la publicación reportada todavía existe (texto + username del autor)", async () => {
    fake.reports = [
      {
        id: REPORT_ID,
        post_id: POST_ID,
        version: 1,
        reason: "spam",
        status: "open",
        created_at: "2026-03-01T00:00:00.000Z",
      },
    ];
    fake.posts = [
      {
        id: POST_ID,
        text: "hola",
        status: "published",
        author_user_id: USER_ID,
        version: 1,
        updated_at: "2026-03-01T00:00:00.000Z",
      },
    ];
    fake.profiles = [{ user_id: USER_ID, username: "kirito" }];
    const state = await call(handleModerationReports, req({}));
    const body = state.body as { reports: { postPreview: unknown }[] };
    expect(body.reports[0]?.postPreview).toEqual({
      text: "hola",
      status: "published",
      authorUsername: "kirito",
      version: 1,
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
  });

  it("publicación ya borrada: postPreview es null (nunca un error, el reporte sigue siendo visible)", async () => {
    fake.reports = [
      {
        id: REPORT_ID,
        post_id: POST_ID,
        version: 1,
        reason: "spam",
        status: "open",
        created_at: "2026-03-01T00:00:00.000Z",
      },
    ];
    fake.posts = [];
    const state = await call(handleModerationReports, req({}));
    const body = state.body as { reports: { postPreview: unknown }[] };
    expect(body.reports[0]?.postPreview).toBeNull();
  });

  it("R4-E4: la cola legacy no expone el texto de un post removed_pending_purge y NO falla (preview null)", async () => {
    fake.reports = [
      {
        id: REPORT_ID,
        post_id: POST_ID,
        version: 1,
        reason: "spam",
        status: "open",
        created_at: "2026-03-01T00:00:00.000Z",
      },
    ];
    fake.posts = [
      {
        id: POST_ID,
        text: "texto-que-no-debe-salir",
        status: "removed_pending_purge",
        author_user_id: USER_ID,
        version: 3,
        updated_at: "2026-03-01T00:00:00.000Z",
      },
    ];
    fake.profiles = [{ user_id: USER_ID, username: "kirito" }];
    const state = await call(handleModerationReports, req({}));
    expect(JSON.stringify(state.body)).not.toContain("texto-que-no-debe-salir");
    expect(state.status).toBe(200);
    const body = state.body as { reports: { id: string; postPreview: unknown }[] };
    expect(body.reports).toHaveLength(1);
    expect(body.reports[0]?.postPreview).toBeNull();
  });

  it("R4-E4: un post removido, uno vencido-ausente y uno malformado no hacen fallar las filas ajenas", async () => {
    const OTHER = "0b2ad7a0-1c0e-4a8d-9a11-0c4f59f0a0aa";
    const MISSING = "0b2ad7a0-1c0e-4a8d-9a11-0c4f59f0a0bb";
    const BAD = "0b2ad7a0-1c0e-4a8d-9a11-0c4f59f0a0cc";
    const mkReport = (id: string, post: string, at: string) => ({
      id,
      post_id: post,
      version: 1,
      reason: "spam",
      status: "open",
      created_at: at,
    });
    fake.reports = [
      mkReport(
        "0c000000-0000-4000-8000-000000000001",
        POST_ID,
        "2026-03-04T00:00:00.000Z",
      ),
      mkReport("0c000000-0000-4000-8000-000000000002", OTHER, "2026-03-03T00:00:00.000Z"),
      mkReport(
        "0c000000-0000-4000-8000-000000000003",
        MISSING,
        "2026-03-02T00:00:00.000Z",
      ),
      mkReport("0c000000-0000-4000-8000-000000000004", BAD, "2026-03-01T00:00:00.000Z"),
    ];
    fake.posts = [
      {
        id: POST_ID,
        text: "removed-secret-text",
        status: "removed_pending_purge",
        author_user_id: USER_ID,
        version: 3,
        updated_at: "2026-03-01T00:00:00.000Z",
      },
      {
        id: OTHER,
        text: "visible-text",
        status: "published",
        author_user_id: USER_ID,
        version: 1,
        updated_at: "2026-03-01T00:00:00.000Z",
      },
      {
        id: BAD,
        text: "bad-row-text",
        status: "some_unknown_status",
        author_user_id: USER_ID,
        version: 1,
        updated_at: "2026-03-01T00:00:00.000Z",
      },
    ];
    fake.profiles = [{ user_id: USER_ID, username: "kirito" }];
    const state = await call(handleModerationReports, req({}));
    expect(state.status).toBe(200);
    const body = state.body as {
      reports: { postId: string; postPreview: { text: string } | null }[];
    };
    expect(body.reports).toHaveLength(4);
    const byPost = new Map(body.reports.map((r) => [r.postId, r.postPreview]));
    expect(byPost.get(OTHER)?.text).toBe("visible-text");
    expect(byPost.get(POST_ID)).toBeNull();
    expect(byPost.get(MISSING)).toBeNull();
    expect(byPost.get(BAD)).toBeNull();
    expect(JSON.stringify(state.body)).not.toMatch(/removed-secret-text|bad-row-text/);
  });

  it("Cache-Control: no-store", async () => {
    const state = await call(handleModerationReports, req({}));
    expect(state.headers["Cache-Control"]).toBe("no-store");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// GET /api/admin/moderation-report?id=

describe("handleModerationReport — detalle", () => {
  it("id ausente o no-UUID → 400", async () => {
    const state = await call(
      handleModerationReport,
      req({ query: { id: "no-es-un-uuid" } }),
    );
    expect(state.status).toBe(400);
  });

  it("reporte inexistente → 404", async () => {
    const state = await call(handleModerationReport, req({ query: { id: REPORT_ID } }));
    expect(state.status).toBe(404);
  });

  it("USER normal (sin capacidad moderation) → 403, nunca ve el detalle", async () => {
    fake.reports = [
      {
        id: REPORT_ID,
        post_id: POST_ID,
        version: 1,
        reason: "spam",
        detail: "detalle",
        status: "open",
        resolved_by: null,
        resolution_note: null,
        created_at: "2026-03-01T00:00:00.000Z",
        updated_at: "2026-03-01T00:00:00.000Z",
      },
    ];
    const state = await call(
      handleModerationReport,
      req({ token: "jwt-user-aal2", query: { id: REPORT_ID } }),
    );
    expect(state.status).toBe(403);
  });

  it("R4-E4: la auditoría post_purged se devuelve sin metadata técnica y el detalle sobrevive al post ausente", async () => {
    fake.reports = [
      {
        id: REPORT_ID,
        post_id: POST_ID,
        version: 1,
        reason: "spam",
        detail: "motivo del reporte",
        status: "resolved",
        created_at: "2026-03-01T00:00:00.000Z",
        updated_at: "2026-03-02T00:00:00.000Z",
      },
    ];
    fake.posts = []; // physically purged
    fake.auditRows = [
      {
        id: "0a000000-0000-4000-8000-000000000001",
        actor_user_id: null,
        action: "post_purged",
        metadata: { post_id: POST_ID, removal_decision_id: "x", assets_marked: 3 },
        created_at: "2026-03-05T00:00:00.000Z",
      },
      {
        id: "0a000000-0000-4000-8000-000000000002",
        actor_user_id: MOD_ID,
        action: "post_hidden",
        metadata: { reason: "kept" },
        created_at: "2026-03-02T00:00:00.000Z",
      },
    ];
    const state = await call(handleModerationReport, req({ query: { id: REPORT_ID } }));
    expect(state.status).toBe(200);
    const report = (
      state.body as {
        report: { postPreview: unknown; audit: { action: string; metadata: unknown }[] };
      }
    ).report;
    expect(report.postPreview).toBeNull();
    expect(report.audit.find((a) => a.action === "post_purged")?.metadata).toEqual({});
    expect(report.audit.find((a) => a.action === "post_hidden")?.metadata).toEqual({
      reason: "kept",
    });
    expect(JSON.stringify(state.body)).not.toMatch(/assets_marked|removal_decision_id/);
  });

  it("reporte existente: incluye detail/resolvedBy/resolutionNote/updatedAt", async () => {
    fake.reports = [
      {
        id: REPORT_ID,
        post_id: POST_ID,
        version: 1,
        reason: "harassment",
        detail: "explicación del reportante",
        status: "resolved",
        resolved_by: MOD_ID,
        resolution_note: "gestionado",
        created_at: "2026-03-01T00:00:00.000Z",
        updated_at: "2026-03-02T00:00:00.000Z",
      },
    ];
    const state = await call(handleModerationReport, req({ query: { id: REPORT_ID } }));
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({
      report: {
        id: REPORT_ID,
        reason: "harassment",
        detail: "explicación del reportante",
        status: "resolved",
        resolvedBy: MOD_ID,
        resolutionNote: "gestionado",
        updatedAt: "2026-03-02T00:00:00.000Z",
      },
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// POST /api/admin/moderation-report-status

describe("R4-A retired individual route", () => {
  it.each(["hide", "restore", "resolve", "dismiss", "reviewing"])(
    "%s never invokes a mutation",
    async (action) => {
      const r = await call(
        handleModerationReportStatus,
        req({ method: "POST", body: { action } }),
      );
      expect(r.status).toBe(410);
      expect(r.body).toMatchObject({ code: "individual_moderation_retired" });
      expect(fake.rpcCalls).toEqual([]);
    },
  );
  it("wrong method rejects", async () =>
    expect((await call(handleModerationReportStatus, req({}))).status).toBe(405));
});

const submittedReport = {
  reportId: REPORT_ID,
  reportStatus: "open",
  caseId: POST_ID,
  cycleId: REPORT_ID,
  caseVersion: 2,
  distinctReporterCount: 1,
  alreadyReported: false,
  visibilityChanged: false,
  postStatus: "published",
  postVersion: 1,
};
// POST /api/admin/moderation-report-create

describe("handleModerationReportCreate — cualquier usuario AUTENTICADO (no requiere capacidad moderation)", () => {
  it("an unknown RPC exception cannot escape the closed error contract", async () => {
    fake.rpcResult = rpcError("toString");
    const state = await call(
      handleModerationReportCreate,
      req({ method: "POST", body: { postId: POST_ID, reason: "spam" } }),
    );
    expect(state.status).toBe(500);
    expect(state.body).toEqual({ error: "Error interno", code: "internal_failure" });
  });
  it.each([
    ["self_report", 403],
    ["post_not_reportable", 409],
    ["case_cycle_inconsistent", 409],
    ["detail_too_long", 400],
  ])("%s returns a closed safe machine-readable error", async (code, status) => {
    fake.rpcResult = rpcError(String(code));
    const state = await call(
      handleModerationReportCreate,
      req({ method: "POST", body: { postId: POST_ID, reason: "spam" } }),
    );
    expect(state.status).toBe(status);
    expect(state.body).toEqual({ error: "No se pudo crear el reporte", code });
  });
  it("duplicate response is 200 and strips unexpected private RPC fields", async () => {
    fake.rpcResult = ok({
      ...submittedReport,
      alreadyReported: true,
      reporter_user_id: USER_ID,
    });
    const state = await call(
      handleModerationReportCreate,
      req({ method: "POST", body: { postId: POST_ID, reason: "spam" } }),
    );
    expect(state.status).toBe(200);
    expect(state.body).toEqual({ ...submittedReport, alreadyReported: true });
    expect(fake.rpcCalls[0]?.name).toBe("community_post_report_submit");
  });
  it("método distinto de POST → 405", async () => {
    const state = await call(handleModerationReportCreate, req({ method: "GET" }));
    expect(state.status).toBe(405);
  });

  it("visitante (sin Authorization) → 401", async () => {
    const state = await call(
      handleModerationReportCreate,
      req({ method: "POST", token: null, body: { postId: POST_ID, reason: "spam" } }),
    );
    expect(state.status).toBe(401);
  });

  it("USER normal SIN rol/MFA puede reportar: no exige capacidad moderation", async () => {
    fake.rpcResult = ok(submittedReport);
    const state = await call(
      handleModerationReportCreate,
      req({
        method: "POST",
        token: "jwt-user-aal1",
        body: { postId: POST_ID, reason: "spam" },
      }),
    );
    expect(state.status).toBe(201);
  });

  it("reason inválida → 400, sin llamar a la RPC", async () => {
    const state = await call(
      handleModerationReportCreate,
      req({
        method: "POST",
        body: { postId: POST_ID, reason: "no_es_una_razon_valida" },
      }),
    );
    expect(state.status).toBe(400);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("postId no-UUID → 400, sin llamar a la RPC", async () => {
    const state = await call(
      handleModerationReportCreate,
      req({ method: "POST", body: { postId: "no-es-un-uuid", reason: "spam" } }),
    );
    expect(state.status).toBe(400);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("el reportero SIEMPRE sale del JWT verificado, nunca de un reporterUserId del body", async () => {
    fake.rpcResult = ok(submittedReport);
    await call(
      handleModerationReportCreate,
      req({
        method: "POST",
        token: "jwt-user-aal1",
        body: { postId: POST_ID, reason: "spam", reporterUserId: ADMIN_ID },
      }),
    );
    expect(fake.rpcCalls[0]?.args.p_reporter_user_id).toBe(USER_ID);
  });

  it("publicación inexistente (rechazo de la RPC) → 404", async () => {
    fake.rpcResult = rpcError("post_not_found");
    const state = await call(
      handleModerationReportCreate,
      req({ method: "POST", body: { postId: POST_ID, reason: "spam" } }),
    );
    expect(state.status).toBe(404);
  });

  it("creación exitosa: 201 con id/status reales de la RPC", async () => {
    fake.rpcResult = ok(submittedReport);
    const state = await call(
      handleModerationReportCreate,
      req({ method: "POST", body: { postId: POST_ID, reason: "spam", detail: "texto" } }),
    );
    expect(state.status).toBe(201);
    expect(state.body).toEqual(submittedReport);
  });
});

const decisionInput = {
  originalPostState: "published",
  caseId: POST_ID,
  cycleId: REPORT_ID,
  expectedCaseVersion: 2,
  expectedPostVersion: 3,
  decision: "content_actioned",
  resolutionMessage: "  Mensaje humano  ",
};
const decisionResult = {
  decisionId: REPORT_ID,
  caseId: POST_ID,
  cycleId: REPORT_ID,
  postId: POST_ID,
  decision: "content_actioned",
  caseVersion: 3,
  postStatus: "removed_pending_purge",
  postVersion: 4,
  visibilityChanged: true,
  createdAt: "2026-10-03T00:00:00Z",
};
describe("R4-A grouped HTTP decision boundary", () => {
  it.each([null, "jwt-user-aal2", "jwt-moderator-aal1", "jwt-moderator-stale"])(
    "rejects identity/capability/MFA %s",
    async (token) => {
      const r = await call(
        handleModerationCaseDecision,
        req({ method: "POST", token, body: decisionInput }),
      );
      expect(r.status).toBe(token === null ? 401 : 403);
      expect(fake.rpcCalls).toEqual([]);
      if (token?.includes("moderator"))
        expect(r.body).toMatchObject({ code: "step_up_required" });
    },
  );
  it.each(["jwt-moderator-aal2", "jwt-developer-aal2", "jwt-admin-aal2"])(
    "%s derives actor, normalizes text and strips private output",
    async (token) => {
      fake.rpcResult = ok({
        ...decisionResult,
        actor_user_id: USER_ID,
        metadata: { secret: "synthetic" },
      });
      const r = await call(
        handleModerationCaseDecision,
        req({ method: "POST", token, body: { ...decisionInput, actorUserId: USER_ID } }),
      );
      expect(r.status).toBe(200);
      expect(r.body).toEqual(decisionResult);
      expect(fake.rpcCalls).toEqual([
        {
          name: "community_moderation_case_decide",
          args: {
            p_actor_user_id: TOKENS[token]!.sub,
            p_case_id: POST_ID,
            p_cycle_id: REPORT_ID,
            p_expected_case_version: 2,
            p_expected_post_version: 3,
            p_decision: "content_actioned",
            p_resolution_message: "Mensaje humano",
          },
        },
      ]);
    },
  );
  it.each([
    {},
    null,
    { ...decisionInput, expectedCaseVersion: 0 },
    { ...decisionInput, expectedCaseVersion: 2147483648 },
    { ...decisionInput, expectedPostVersion: 2147483648 },
    { ...decisionInput, expectedCaseVersion: 1.5 },
    { ...decisionInput, expectedPostVersion: undefined },
    { ...decisionInput, decision: "strike" },
    { ...decisionInput, resolutionMessage: "\n\t" },
    { ...decisionInput, resolutionMessage: "😀".repeat(1001) },
  ])("invalid input rejected %j", async (body) => {
    expect(
      (await call(handleModerationCaseDecision, req({ method: "POST", body }))).status,
    ).toBe(400);
    expect(fake.rpcCalls).toEqual([]);
  });
  it.each([
    "case_version_conflict",
    "post_version_conflict",
    "cycle_state_conflict",
    "post_state_conflict",
    "decision_already_exists",
  ])("%s never retries", async (code) => {
    fake.rpcResult = rpcError(code);
    const r = await call(
      handleModerationCaseDecision,
      req({ method: "POST", body: decisionInput }),
    );
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code });
    expect(fake.rpcCalls).toHaveLength(1);
  });
  it.each([
    {},
    null,
    { ...decisionResult, caseVersion: 2 },
    { ...decisionResult, postVersion: 3 },
    { ...decisionResult, postVersion: 5 },
    { ...decisionResult, cycleId: USER_ID },
    { ...decisionResult, createdAt: "2026-02-30T00:00:00Z" },
  ])("malformed confirmed response fails controlled %j", async (value) => {
    fake.rpcResult = ok(value);
    const r = await call(
      handleModerationCaseDecision,
      req({ method: "POST", body: decisionInput }),
    );
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "Respuesta inválida", code: "invalid_response" });
  });
  it("unknown DB details never escape", async () => {
    fake.rpcResult = {
      data: null,
      error: { code: "XX000", message: "storage_key synthetic" },
    };
    expect(
      (
        await call(
          handleModerationCaseDecision,
          req({ method: "POST", body: decisionInput }),
        )
      ).body,
    ).toEqual({ error: "Error interno", code: "internal_failure" });
  });
  it("only POST", async () =>
    expect((await call(handleModerationCaseDecision, req({}))).status).toBe(405));
});

describe("R4-A FIX2 original request context", () => {
  const matrix = [
    {
      origin: "published",
      decision: "reports_not_valid",
      status: "published",
      version: 3,
      changed: false,
    },
    {
      origin: "hidden_pending_review",
      decision: "reports_not_valid",
      status: "published",
      version: 4,
      changed: true,
    },
    {
      origin: "hidden",
      decision: "reports_not_valid",
      status: "hidden",
      version: 3,
      changed: false,
    },
    {
      origin: null,
      decision: "reports_not_valid",
      status: null,
      version: null,
      changed: false,
    },
    ...["published", "hidden_pending_review", "hidden"].map((origin) => ({
      origin,
      decision: "content_actioned",
      status: "removed_pending_purge",
      version: 4,
      changed: true,
    })),
  ];
  it.each(matrix)("accepts only transition for original context %j", async (t) => {
    const body = {
      ...decisionInput,
      originalPostState: t.origin,
      expectedPostVersion: t.origin === null ? null : 3,
      decision: t.decision,
      resolutionMessage: t.decision === "content_actioned" ? "Reason" : null,
    };
    const response = {
      ...decisionResult,
      decision: t.decision,
      postStatus: t.status,
      postVersion: t.version,
      visibilityChanged: t.changed,
    };
    fake.rpcResult = ok(response);
    expect(
      (await call(handleModerationCaseDecision, req({ method: "POST", body }))).body,
    ).toEqual(response);
    for (const malformed of [
      { ...response, visibilityChanged: !t.changed },
      { ...response, postVersion: t.version === null ? 3 : t.version + 1 },
      {
        ...response,
        postStatus: "published",
        postVersion: t.origin === "published" ? 4 : 3,
        visibilityChanged: t.origin === "published",
      },
    ]) {
      fake.rpcResult = ok(malformed);
      const r = await call(handleModerationCaseDecision, req({ method: "POST", body }));
      expect(r.status).toBe(500);
      expect(r.body).toEqual({ error: "Respuesta inválida", code: "invalid_response" });
    }
  });
  it.each([2147483647, 2147483648])(
    "increment overflow %i rejected before RPC",
    async (version) => {
      const r = await call(
        handleModerationCaseDecision,
        req({ method: "POST", body: { ...decisionInput, expectedCaseVersion: version } }),
      );
      expect(r.status).toBe(400);
      expect(fake.rpcCalls).toEqual([]);
    },
  );
  it("deleted Procede and missing origin reject before RPC", async () => {
    for (const body of [
      { ...decisionInput, originalPostState: null, expectedPostVersion: null },
      { ...decisionInput, originalPostState: undefined },
    ])
      expect(
        (await call(handleModerationCaseDecision, req({ method: "POST", body }))).status,
      ).toBe(400);
    expect(fake.rpcCalls).toEqual([]);
  });
});

describe("R4-D2 moderator media delivery (issued only after the endpoint's own authorization)", () => {
  beforeEach(() => {
    for (const name of [
      "MEDIA_DELIVERY_BASE_URL",
      "MEDIA_CAP_SIGNING_PRIVATE_KEY",
      "MEDIA_CAP_KEY_ID",
      "MEDIA_CAP_AUDIENCE",
    ])
      vi.stubEnv(name, "");
  });
  const detail = async (
    status: string,
    purgeAfter: string | null = null,
    token = "jwt-moderator-aal2",
  ) => {
    fake.rpcResult = ok({
      item: {
        ...item(),
        post: caseItemPost(status, purgeAfter),
        media: [{ id: REPORT_ID, assetId: ASSET_ID, position: 0 }],
      },
    });
    fake.assets = [
      {
        id: ASSET_ID,
        domain: "community",
        status: "ready",
        kind: "image",
        storage_key: `community/${ASSET_ID}/w960.webp`,
        width: 640,
        height: 480,
        duration_seconds: null,
      },
    ];
    const response = await call(
      handleModerationCases,
      req({ query: { cycleId: REPORT_ID }, token }),
    );
    return response;
  };
  const urls = (r: { body?: unknown }) =>
    (r.body as { item: { media: { url: string }[] } }).item.media.map((m) => m.url);

  it("published → public delivery URL without any capability", async () => {
    secureDelivery();
    const r = await detail("published");
    expect(r.status).toBe(200);
    expect(urls(r)).toEqual([
      `https://media.synthetic.example/community/${ASSET_ID}/w960.webp`,
    ]);
  });
  it("hidden_pending_review → moderator capability bound to the asset", async () => {
    secureDelivery();
    const [url] = urls(await detail("hidden_pending_review"));
    expect(capPayload(url)).toMatchObject({ a: ASSET_ID, s: "moderator" });
    const exp = capPayload(url).e as number;
    expect(exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(600);
  });
  it("removed_pending_purge before expiry → capability capped by purge_after minus the margin", async () => {
    secureDelivery();
    const purge = new Date(Date.now() + 120_000);
    const [url] = urls(await detail("removed_pending_purge", purge.toISOString()));
    expect(capPayload(url).e).toBe(Math.floor(purge.getTime() / 1000) - 5);
  });
  it.each([-1000, 0, 3000])(
    "removed_pending_purge at/after expiry (offset %i ms) or inside the safety margin → no media, no capability",
    async (offset) => {
      secureDelivery();
      const r = await detail(
        "removed_pending_purge",
        new Date(Date.now() + offset).toISOString(),
      );
      expect(r.status).toBe(200);
      expect(urls(r)).toEqual([]);
    },
  );
  it("manual hidden → no media", async () => {
    secureDelivery();
    expect(urls(await detail("hidden"))).toEqual([]);
  });
  it("secure delivery not configured: private states get NO url (never a fake-private public URL)", async () => {
    expect(urls(await detail("hidden_pending_review"))).toEqual([]);
    expect(
      urls(
        await detail(
          "removed_pending_purge",
          new Date(Date.now() + 60_000).toISOString(),
        ),
      ),
    ).toEqual([]);
    const published = await detail("published");
    expect(urls(published)).toEqual([
      `https://media.synthetic.example/community/${ASSET_ID}/w960.webp`,
    ]);
  });
  it("an ordinary user never receives a moderator capability (gate unchanged: 403, no lookups)", async () => {
    secureDelivery();
    const r = await detail("hidden_pending_review", null, "jwt-user-aal2");
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toContain("cap=");
    expect(fake.assetLookups).toEqual([]);
  });
  it("a moderator without recent MFA (aal1) is rejected before any capability is issued", async () => {
    secureDelivery();
    const r = await detail("hidden_pending_review", null, "jwt-moderator-aal1");
    expect(r.status).not.toBe(200);
    expect(JSON.stringify(r.body)).not.toContain("cap=");
    expect(fake.assetLookups).toEqual([]);
  });
  it("a misconfigured delivery base fails closed with a generic error", async () => {
    vi.stubEnv("MEDIA_DELIVERY_BASE_URL", "http://insecure.example");
    const r = await detail("published");
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/insecure|MEDIA_/);
  });
});
