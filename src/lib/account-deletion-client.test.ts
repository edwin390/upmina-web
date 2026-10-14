// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ token: "jwt-sintetico" as string | null }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: auth.token ? { access_token: auth.token } : null },
      }),
    },
  },
}));

import {
  alertKind,
  canRetry,
  confirmAccountDeletion,
  fetchDeletionAlerts,
  parseDeletionAlerts,
  previewAccountDeletion,
  requestAccountDeletion,
  retryAccountDeletion,
  type DeletionAlert,
} from "./account-deletion-client";
import {
  PENDING_DELETION_TOKEN_TTL_MS,
  capturePendingDeletionToken,
  clearPendingDeletionToken,
  parseDeletionFragment,
  readPendingDeletionToken,
} from "./pending-deletion-token";

// DEL-3: contrato del cliente con los endpoints de DEL-2 (fetch doble) y token en memoria. Sin red, sin correo, sin borrado.

const TOKEN = "Tt0123456789_-abcdefghijklmnopqrstuvwxyzABC".slice(0, 43);
const ID = "33333333-3333-4333-8333-333333333333";
const fetchMock = vi.fn();
const res = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

beforeEach(() => {
  auth.token = "jwt-sintetico";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  clearPendingDeletionToken();
});
afterEach(() => vi.unstubAllGlobals());

describe("requestAccountDeletion", () => {
  it("POST sin cuerpo con claves, con el Bearer vigente, sin caché ni cookies, y 200 → sent", async () => {
    fetchMock.mockResolvedValue(res(200, { ok: true, expiresInMinutes: 30 }));
    expect(await requestAccountDeletion()).toEqual({ kind: "sent" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/admin/account-deletion-request");
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    expect(init.headers.Authorization).toBe("Bearer jwt-sintetico");
    expect(JSON.parse(init.body)).toEqual({}); // el cliente no aporta ni usuario ni correo
  });

  it.each([
    [401, {}, "unauthenticated"],
    [403, { code: "privileged_account" }, "privileged"],
    [409, { code: "already_deleting" }, "already_deleting"],
    [429, {}, "rate_limited"],
    [502, { code: "mail_failed" }, "mail_failed"],
    [503, {}, "unavailable"],
    [500, {}, "error"],
    [403, {}, "error"],
    [200, { ok: false }, "error"],
  ])("estado %s %j → %s", async (status, body, kind) => {
    fetchMock.mockResolvedValue(res(status, body));
    expect((await requestAccountDeletion()).kind).toBe(kind);
  });

  it("sin sesión o con error de red nunca lanza: unauthenticated / error", async () => {
    auth.token = null;
    expect((await requestAccountDeletion()).kind).toBe("unauthenticated");
    expect(fetchMock).not.toHaveBeenCalled();
    auth.token = "jwt";
    fetchMock.mockRejectedValue(new Error("red"));
    expect((await requestAccountDeletion()).kind).toBe("error");
  });
});

describe("previewAccountDeletion", () => {
  it("envía el token solo en el cuerpo (nunca en la URL) y valida los estados", async () => {
    fetchMock.mockResolvedValue(res(200, { state: "valid" }));
    expect(await previewAccountDeletion(TOKEN)).toEqual({ kind: "ok", state: "valid" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/admin/account-deletion-preview");
    expect(String(url)).not.toContain(TOKEN);
    expect(JSON.parse(init.body)).toEqual({ token: TOKEN });
    for (const state of ["expired", "invalid", "already_deleting"]) {
      fetchMock.mockResolvedValue(res(200, { state }));
      expect(await previewAccountDeletion(TOKEN)).toEqual({ kind: "ok", state });
    }
  });

  it("estados desconocidos, errores y red caída → error; 401 → unauthenticated", async () => {
    fetchMock.mockResolvedValue(res(200, { state: "raro" }));
    expect((await previewAccountDeletion(TOKEN)).kind).toBe("error");
    fetchMock.mockResolvedValue(res(500));
    expect((await previewAccountDeletion(TOKEN)).kind).toBe("error");
    fetchMock.mockResolvedValue(res(401));
    expect((await previewAccountDeletion(TOKEN)).kind).toBe("unauthenticated");
    fetchMock.mockRejectedValue(new Error("red"));
    expect((await previewAccountDeletion(TOKEN)).kind).toBe("error");
  });
});

describe("confirmAccountDeletion", () => {
  it("envía token + confirm:true exactos", async () => {
    fetchMock.mockResolvedValue(res(202, { status: "accepted" }));
    await confirmAccountDeletion(TOKEN);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/admin/account-deletion-confirm");
    expect(JSON.parse(init.body)).toEqual({ token: TOKEN, confirm: true });
  });

  it.each([
    [202, { status: "accepted" }, "accepted"],
    [200, { status: "already_deleting" }, "already_deleting"],
    [400, { code: "invalid_token" }, "invalid_token"],
    [410, { code: "expired" }, "expired"],
    [403, { code: "privileged_account" }, "privileged"],
    [401, {}, "unauthenticated"],
  ])("estado %s %j → %s", async (status, body, kind) => {
    fetchMock.mockResolvedValue(res(status, body));
    expect((await confirmAccountDeletion(TOKEN)).kind).toBe(kind);
  });

  it("un timeout, una red caída, un 5xx o un 2xx irreconocible son «ambiguous» (jamás «no ocurrió»); un 4xx extraño es error", async () => {
    fetchMock.mockRejectedValue(new Error("timeout"));
    expect((await confirmAccountDeletion(TOKEN)).kind).toBe("ambiguous");
    for (const status of [500, 502, 503, 504]) {
      fetchMock.mockResolvedValue(res(status));
      expect((await confirmAccountDeletion(TOKEN)).kind, String(status)).toBe(
        "ambiguous",
      );
    }
    fetchMock.mockResolvedValue(res(200, {}));
    expect((await confirmAccountDeletion(TOKEN)).kind).toBe("ambiguous");
    fetchMock.mockResolvedValue(res(202, {}));
    expect((await confirmAccountDeletion(TOKEN)).kind).toBe("ambiguous");
    fetchMock.mockResolvedValue(res(418));
    expect((await confirmAccountDeletion(TOKEN)).kind).toBe("error");
  });

  it("sin sesión no envía nada", async () => {
    auth.token = null;
    expect((await confirmAccountDeletion(TOKEN)).kind).toBe("unauthenticated");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("alertas y reintento de Developer", () => {
  const alert = (over: Record<string, unknown> = {}) => ({
    requestId: ID,
    status: "cleanup_retry_pending",
    accessBlocked: true,
    failedStage: "media_gc",
    errorCode: "media_gc_pending",
    lastErrorAt: "2026-11-14T10:00:00Z",
    lastAttemptAt: "2026-11-14T10:00:00Z",
    totalAttempts: 3,
    consecutiveFailures: 1,
    nextRetryAt: "2026-11-14T10:05:00Z",
    manualRequired: false,
    stalled: false,
    pendingStages: ["media_gc", "auth_delete"],
    ...over,
  });

  it("parser estricto: acepta el contrato de DEL-2, descarta campos extra y rechaza la lista entera si una fila es incoherente", () => {
    const parsed = parseDeletionAlerts({
      alerts: [alert({ userId: "NO-DEBE-PASAR", email: "x@example.com" })],
    });
    expect(parsed).toHaveLength(1);
    expect(JSON.stringify(parsed)).not.toMatch(/NO-DEBE-PASAR|example\.com/);
    expect(
      parseDeletionAlerts({ alerts: [alert(), alert({ status: "completed" })] }),
    ).toBeNull();
    expect(parseDeletionAlerts({ alerts: [alert({ requestId: "no-uuid" })] })).toBeNull();
    expect(parseDeletionAlerts({ alerts: [alert({ pendingStages: "x" })] })).toBeNull();
    expect(parseDeletionAlerts({ alerts: [alert({ manualRequired: "no" })] })).toBeNull();
    expect(parseDeletionAlerts({})).toBeNull();
    expect(parseDeletionAlerts({ alerts: [] })).toEqual([]);
  });

  it("clasificación y reintento permitido solo cuando el backend lo admite", () => {
    const base = parseDeletionAlerts({ alerts: [alert()] })![0]!;
    const make = (over: Partial<DeletionAlert>): DeletionAlert => ({ ...base, ...over });
    expect(
      alertKind(make({ manualRequired: true, status: "cleanup_manual_required" })),
    ).toBe("manual");
    expect(alertKind(make({ stalled: true, status: "access_blocked" }))).toBe("stalled");
    expect(alertKind(make({}))).toBe("retry");
    expect(alertKind(make({ status: "cleanup_in_progress" }))).toBe("running");
    expect(canRetry(make({}))).toBe(true);
    expect(canRetry(make({ status: "cleanup_manual_required" }))).toBe(true);
    expect(canRetry(make({ status: "cleanup_in_progress" }))).toBe(false);
    expect(canRetry(make({ status: "access_blocked", stalled: true }))).toBe(false);
  });

  it("GET con Bearer; error HTTP devuelve la respuesta para clasificar 401/403/MFA; forma inválida → error", async () => {
    fetchMock.mockResolvedValue(res(200, { alerts: [alert()] }));
    const ok = await fetchDeletionAlerts();
    expect(ok.kind).toBe("ok");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/admin/account-deletion-alerts");
    fetchMock.mockResolvedValue(res(403, { code: "step_up_required" }));
    expect((await fetchDeletionAlerts()).kind).toBe("failure");
    fetchMock.mockResolvedValue(res(200, { alerts: "x" }));
    expect((await fetchDeletionAlerts()).kind).toBe("error");
    fetchMock.mockRejectedValue(new Error("red"));
    expect((await fetchDeletionAlerts()).kind).toBe("error");
  });

  it("reintento: solo envía {requestId}; mapea 200/409/404/401-403/otros", async () => {
    fetchMock.mockResolvedValue(res(200, {}));
    expect(await retryAccountDeletion(ID)).toEqual({ kind: "requested" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/admin/account-deletion-retry");
    expect(JSON.parse(init.body)).toEqual({ requestId: ID });
    const table: Array<[number, string]> = [
      [409, "not_applicable"],
      [404, "not_found"],
      [403, "forbidden"],
      [401, "forbidden"],
      [500, "failure"],
    ];
    for (const [status, kind] of table) {
      fetchMock.mockResolvedValue(res(status));
      expect((await retryAccountDeletion(ID)).kind, String(status)).toBe(kind);
    }
    fetchMock.mockRejectedValue(new Error("red"));
    expect((await retryAccountDeletion(ID)).kind).toBe("error");
  });
});

describe("token en memoria (pending-deletion-token)", () => {
  it("captura solo tokens con forma válida, no los consume al leerlos y caducan a los 30 minutos", () => {
    expect(capturePendingDeletionToken("corto")).toBe(false);
    expect(readPendingDeletionToken()).toBeNull();
    expect(capturePendingDeletionToken(TOKEN, 1000)).toBe(true);
    expect(readPendingDeletionToken(2000)).toBe(TOKEN);
    expect(readPendingDeletionToken(3000)).toBe(TOKEN);
    expect(readPendingDeletionToken(1000 + PENDING_DELETION_TOKEN_TTL_MS)).toBeNull();
    expect(readPendingDeletionToken(2000)).toBeNull(); // una vez vencido se destruye
  });

  it("clear lo destruye y el fragmento se analiza como el de la apelación (`t` fuera, resto intacto)", () => {
    capturePendingDeletionToken(TOKEN);
    clearPendingDeletionToken();
    expect(readPendingDeletionToken()).toBeNull();
    expect(parseDeletionFragment(`#t=${TOKEN}&otro=1`)).toEqual({
      present: true,
      token: TOKEN,
      remainder: "#otro=1",
    });
    expect(parseDeletionFragment("#t=corto")).toMatchObject({
      present: true,
      token: null,
    });
    expect(parseDeletionFragment("#ajeno")).toMatchObject({
      present: false,
      remainder: "#ajeno",
    });
  });

  it("el módulo no usa almacenamiento persistente ni cookies", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/pending-deletion-token.ts", "utf8").replace(
      /\/\/.*$/gm,
      "",
    );
    expect(src).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/);
    const client = readFileSync("src/lib/account-deletion-client.ts", "utf8").replace(
      /\/\/.*$/gm,
      "",
    );
    expect(client).not.toMatch(/localStorage|sessionStorage|document\.cookie|console\./);
  });
});
