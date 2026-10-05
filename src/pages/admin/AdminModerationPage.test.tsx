import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { testQueryClient } from "@/test/query-client";
import AdminModerationPage from "./AdminModerationPage";
import { showActionSuccess } from "@/lib/action-notice";
import { notifyCommunityVisibility } from "@/lib/community-visibility-sync";
import type { ModerationCaseItem } from "@/lib/moderation-case-contract";
vi.mock("@/lib/community-visibility-sync", () => ({
  notifyCommunityVisibility: vi.fn(),
}));
vi.mock("@/lib/action-notice", () => ({ showActionSuccess: vi.fn() }));

// Fija el contrato de /admin/moderation (Fase 9K-1): a diferencia de /admin
// (AdminDashboardPage), el gate NO exige role === "admin", exige la CAPACIDAD `moderation`
// (moderator/developer/admin) — mismo GET /api/admin/access, pero comparando `capabilities`. No
// repite las pruebas de los endpoints (moderation-handlers.test.ts): aquí importa cómo la UI
// reacciona (loading/error/vacío/datos, denegación sin capacidad, MFA no reciente, detalle,
// cambio de estado).

const authFakes = vi.hoisted(() => ({
  session: null as null | { access_token: string; user: { id: string } },
  loading: false,
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    session: authFakes.session,
    user: authFakes.session?.user ?? null,
    loading: authFakes.loading,
    signOut: vi.fn(),
  }),
}));

const supabaseFakes = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: supabaseFakes.getSession } },
}));

function access(role: string | null, capabilities: string[], recent: boolean) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ role, capabilities, mfa: { recent } }),
  };
}
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const failure = (code: number, body: unknown = { error: "No autorizado" }) => ({
  ok: false,
  status: code,
  json: async () => body,
});

function signedIn() {
  authFakes.session = { access_token: "tok", user: { id: "mod-1" } };
  supabaseFakes.getSession.mockResolvedValue({
    data: { session: { access_token: "tok", user: { id: "mod-1" } } },
  });
}

function renderPage(
  entry: string | { pathname: string; state: { cancelTo: string } } = "/admin/moderation",
) {
  return render(
    <QueryClientProvider client={testQueryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/admin/moderation" element={<AdminModerationPage />} />
          <Route path="/login" element={<LocationProbe />} />
          <Route path="/admin/mfa" element={<LocationProbe />} />
          <Route path="/account" element={<p>Cuenta</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <p data-testid="location">
        {location.pathname + location.search}
        {location.state?.cancelTo ? ` cancel:${location.state.cancelTo}` : ""}
      </p>
      <button onClick={() => navigate("/admin/moderation", { state: { fromMfa: true } })}>
        MFA success
      </button>
      <button
        onClick={() => navigate("/admin/moderation", { state: { mfaCancelled: true } })}
      >
        MFA cancel
      </button>
    </>
  );
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  vi.mocked(showActionSuccess).mockClear();
  vi.mocked(notifyCommunityVisibility).mockClear();
  testQueryClient.clear();
  authFakes.session = null;
  authFakes.loading = false;
  supabaseFakes.getSession.mockReset();
});

const testId = (kind: number, n: number) =>
  `${String(kind).repeat(8)}-1111-4111-8111-${String(n).padStart(12, "0")}`;
const testCursor = btoa(`2026-10-01T00:00:00Z|${testId(3, 1)}`).replace(/=/g, "");
const makeCase = (n = 1): ModerationCaseItem => ({
  caseId: testId(1, n),
  caseVersion: 4,
  postId: testId(2, n),
  cycleId: testId(3, n),
  currentCycleId: testId(3, n),
  cycleNumber: 1,
  currentCycleNumber: 1,
  isCurrentCycle: true,
  caseStatus: "pending",
  cycleStatus: "pending",
  closureKind: null,
  createdAt: "2026-10-01T00:00:00Z",
  openedAt: "2026-10-01T00:00:00Z",
  closedAt: null,
  activityAt: "2026-10-01T00:00:00Z",
  firstReportAt: "2026-10-01T00:00:00Z",
  lastReportAt: "2026-10-01T00:00:00Z",
  totalReports: 3,
  qualifyingReporters: 3,
  reasons: [
    { reason: "spam", count: 2 },
    { reason: "harassment", count: 1 },
  ],
  reportsTruncated: false,
  post: {
    text: `Contenido ${n}`,
    status: "hidden_pending_review",
    version: 5,
    updatedAt: "2026-10-02T00:00:00Z",
    authorUsername: "author",
    quarantineCycleId: testId(3, n),
  },
  reports: [
    {
      reportId: testId(4, n),
      reason: "spam",
      detail: "<script>secret</script>",
      status: "open",
      version: 1,
      createdAt: "2026-10-01T00:00:00Z",
    },
  ],
  media: [],
  audit: [],
});
function setupCases(
  options: {
    items?: ModerationCaseItem[];
    error?: number;
    actionError?: number;
    pending?: boolean;
    detailError?: boolean;
  } = {},
) {
  signedIn();
  const items = options.items ?? [makeCase(1), makeCase(2), makeCase(3)];
  const calls: string[] = [];
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/api/admin/access"))
        return access("moderator", ["moderation"], true);
      if (url.includes("moderation-report-status")) {
        writes.push(JSON.parse(String(init?.body)));
        if (options.actionError)
          return failure(options.actionError, { code: "post_version_conflict" });
        return ok({ id: "report-1", status: "resolved", version: 2 });
      }
      if (url.includes("moderation-cases")) {
        const params = new URL(url, "https://local.invalid").searchParams;
        const cycle = params.get("cycleId");
        if (cycle)
          return options.detailError
            ? failure(500)
            : ok({ item: items.find((i) => i.cycleId === cycle) });
        if (options.pending) return new Promise(() => {});
        if (options.error) return failure(options.error);
        return ok({
          cases: items,
          nextCursor: params.has("cursor") ? null : testCursor,
        });
      }
      return failure(404);
    }),
  );
  return { items, calls, writes };
}
const card = (n: number) =>
  screen.getByRole("button", { name: new RegExp(`Contenido ${n}`) });
describe("R3 grouped case UX", () => {
  it("queue has a distinct pending read state", async () => {
    setupCases({ pending: true });
    renderPage();
    expect(await screen.findByText("Cargando casos…")).toHaveAttribute("role", "status");
  });
  it("late response from an older selection cannot overwrite the new inline detail", async () => {
    setupCases();
    const original = vi.mocked(fetch).getMockImplementation()!;
    let finish: ((response: ReturnType<typeof ok>) => void) | undefined;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes(`cycleId=${testId(3, 1)}`))
        return new Promise<Response>((resolve) => {
          finish = (response) => resolve(response as unknown as Response);
        });
      return original(input, init);
    });
    renderPage();
    await screen.findByText("Contenido 1");
    fireEvent.click(card(1));
    expect(await screen.findByText("Cargando caso…")).toBeInTheDocument();
    fireEvent.click(card(2));
    await screen.findByText(new RegExp("Caso " + testId(1, 2)));
    await act(async () => {
      finish?.(ok({ item: makeCase(1) }));
    });
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Detalle del caso" })).toHaveTextContent(
        "Caso " + testId(1, 2),
      ),
    );
    expect(screen.queryByText(new RegExp("Caso " + testId(1, 1)))).toBeNull();
  });
  it("preserves Profile origin for MFA", async () => {
    signedIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => access("moderator", ["moderation"], false)),
    );
    renderPage({ pathname: "/admin/moderation", state: { cancelTo: "/@edwin1" } });
    expect(await screen.findByTestId("location")).toHaveTextContent("cancel:/@edwin1");
  });
  it("one card per case, grouped reasons/counts and neutral HPR", async () => {
    setupCases();
    renderPage();
    await screen.findByText("Contenido 1");
    expect(screen.getAllByText("3 cuentas calificantes · 3 reportes")).toHaveLength(3);
    expect(screen.getAllByText("Spam ×2")).toHaveLength(3);
    expect(screen.queryByText("Resolver reporte")).toBeNull();
    fireEvent.click(card(1));
    expect(
      await screen.findByText(/esto no confirma una infracción/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /Ocultar publicación|Restaurar publicación|Marcar como/,
      }),
    ).toBeNull();
  });
  it("detail immediately follows selected card, moves and stays single", async () => {
    const { writes } = setupCases();
    renderPage();
    await screen.findByText("Contenido 2");
    fireEvent.click(card(2));
    const panel = await screen.findByRole("region", { name: "Detalle del caso" });
    expect(card(2).nextElementSibling).toBe(panel);
    expect(card(2).parentElement?.nextElementSibling).toContainElement(card(3));
    expect(card(2)).toHaveAttribute("aria-expanded", "true");
    expect(card(2)).toHaveAttribute("aria-controls", panel.id);
    fireEvent.click(card(3));
    await screen.findByText(new RegExp("Caso " + testId(1, 3)));
    expect(card(2)).toHaveAttribute("aria-expanded", "false");
    expect(screen.getAllByRole("region", { name: "Detalle del caso" })).toHaveLength(1);
    expect(card(3).nextElementSibling).toBe(
      screen.getByRole("region", { name: "Detalle del caso" }),
    );
    expect(writes).toEqual([]);
  });
  it("top controls preserve selection and refresh the current queue without mutations", async () => {
    const { calls, writes } = setupCases();
    renderPage();
    await screen.findByText("Contenido 1");
    const active = screen.getByRole("button", { name: "Activos" });
    const history = screen.getByRole("button", { name: "Historial" });
    expect(active).toHaveAttribute("aria-pressed", "true");
    expect(history).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(history);
    await waitFor(() => expect(history).toHaveAttribute("aria-pressed", "true"));
    expect(active).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(active);
    await waitFor(() => expect(active).toHaveAttribute("aria-pressed", "true"));
    expect(history).toHaveAttribute("aria-pressed", "false");
    const before = calls.filter((url) => url.includes("moderation-cases")).length;
    fireEvent.click(screen.getByRole("button", { name: "Actualizar contexto" }));
    await waitFor(() =>
      expect(calls.filter((url) => url.includes("moderation-cases"))).toHaveLength(
        before + 1,
      ),
    );
    expect(writes).toEqual([]);
  });
  it.each([null, "legacy", "decision"] as const)(
    "X closes and reopens %s context without mutations",
    async (closure) => {
      const item = makeCase();
      if (closure) {
        item.cycleStatus = "closed";
        item.closureKind = closure;
        item.reports[0]!.status = closure === "legacy" ? "dismissed" : "resolved";
      }
      const { calls, writes } = setupCases({ items: [item] });
      renderPage();
      await screen.findByText("Contenido 1");
      fireEvent.click(screen.getByRole("button", { name: "Historial" }));
      await screen.findByText("Contenido 1");
      fireEvent.click(screen.getByRole("button", { name: "Siguiente página" }));
      await screen.findByText("Contenido 1");
      fireEvent.click(card(1));
      await screen.findByText(new RegExp("Caso " + testId(1, 1)));
      fireEvent.click(screen.getByRole("button", { name: "Cerrar detalle del caso" }));
      expect(screen.queryByRole("region", { name: "Detalle del caso" })).toBeNull();
      expect(card(1)).toHaveFocus();
      expect(screen.getByRole("button", { name: "Historial" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(
        screen.getByRole("button", { name: "Volver al inicio" }),
      ).toBeInTheDocument();
      fireEvent.click(card(1));
      await screen.findByText(new RegExp("Caso " + testId(1, 1)));
      expect(calls.filter((u) => u.includes("cycleId="))).toHaveLength(2);
      expect(writes).toEqual([]);
      expect(showActionSuccess).not.toHaveBeenCalled();
    },
  );
  it("unavailable target is explicit; text is rendered safely; truncation is explicit", async () => {
    const item = makeCase();
    item.post = null;
    item.reportsTruncated = true;
    item.totalReports = 80;
    setupCases({ items: [item] });
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: /Publicación original no disponible/ }),
    );
    expect(
      await screen.findByText(/No se conserva una captura de su texto/),
    ).toBeInTheDocument();
    expect(screen.getByText("<script>secret</script>")).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText(/Hay más reportes/)).toBeInTheDocument();
  });
  it.each(["active", "closed"])("empty %s state is honest", async (scope) => {
    setupCases({ items: [] });
    renderPage();
    if (scope === "closed")
      fireEvent.click(await screen.findByRole("button", { name: "Historial" }));
    expect(
      await screen.findByText(
        scope === "closed"
          ? "No hay ciclos cerrados por ahora."
          : "No hay casos activos por ahora.",
      ),
    ).toBeInTheDocument();
  });
  it("queue loading and error/retry are visible", async () => {
    setupCases({ error: 500 });
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No se pudieron cargar los casos",
    );
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
  });
  it("loading remains bounded to selected case and detail failure is retryable", async () => {
    setupCases({ detailError: true });
    renderPage();
    await screen.findByText("Contenido 1");
    fireEvent.click(card(1));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No se pudo cargar este caso",
    );
    expect(
      screen.getByRole("button", { name: "Reintentar detalle" }),
    ).toBeInTheDocument();
  });
  it("responsive detail uses available width and wraps unbroken text/media", async () => {
    setupCases();
    renderPage();
    await screen.findByText("Contenido 1");
    fireEvent.click(card(1));
    await screen.findByText(new RegExp("Caso " + testId(1, 1)));
    expect(screen.getByText("<script>secret</script>").className).toContain(
      "[overflow-wrap:anywhere]",
    );
    expect(screen.getByRole("region", { name: "Detalle del caso" }).className).toContain(
      "min-w-0",
    );
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("R4-B grouped decisions", () => {
  function decisionSetup(
    mode: "success" | "conflict" | "invalid" | "stepup" | "pending" = "success",
    item = makeCase(),
  ) {
    const setup = setupCases({ items: [item] });
    const original = vi.mocked(fetch).getMockImplementation()!;
    const mutations: Record<string, unknown>[] = [];
    let finished = false;
    let resolve: ((value: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("moderation-case-decision")) {
        const body = JSON.parse(String(init?.body));
        mutations.push(body);
        if (mode === "pending")
          return new Promise<Response>((done) => {
            resolve = done;
          });
        if (mode === "conflict")
          return failure(409, { code: "case_version_conflict" }) as Response;
        if (mode === "stepup")
          return failure(403, { code: "step_up_required" }) as Response;
        if (mode === "invalid") return ok({}) as Response;
        finished = true;
        const changed =
          item.post !== null &&
          (body.decision === "content_actioned" ||
            item.post.status === "hidden_pending_review");
        return ok({
          decisionId: testId(5, 1),
          caseId: item.caseId,
          cycleId: item.cycleId,
          postId: item.postId,
          decision: body.decision,
          caseVersion: item.caseVersion + 1,
          postStatus:
            item.post === null
              ? null
              : body.decision === "content_actioned"
                ? "removed_pending_purge"
                : item.post.status === "hidden_pending_review"
                  ? "published"
                  : item.post.status,
          postVersion: item.post === null ? null : item.post.version + Number(changed),
          visibilityChanged: changed,
          createdAt: "2026-10-03T00:00:00Z",
        }) as Response;
      }
      if (finished && String(input).includes("moderation-cases")) {
        const closed = {
          ...item,
          caseStatus: "closed",
          cycleStatus: "closed",
          closureKind: "decision",
          closedAt: "2026-10-03T00:00:00Z",
          decision: {
            decisionId: testId(5, 1),
            result: mutations[0].decision,
            resolutionMessage: null,
            createdAt: "2026-10-03T00:00:00Z",
          },
        };
        if (String(input).includes("cycleId=")) return ok({ item: closed }) as Response;
        return ok({
          cases: String(input).includes("scope=closed") ? [closed] : [],
          nextCursor: null,
        }) as Response;
      }
      return original(input, init);
    });
    return { ...setup, mutations, finish: () => resolve?.(failure(500) as Response) };
  }
  async function openDecision(name = "No procede") {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Contenido 1/ }));
    const action = await screen.findByRole("button", { name });
    action.focus();
    fireEvent.click(action);
    return screen.getByRole("dialog");
  }
  it("active exposes both actions; cancellation and Escape do not mutate and return focus", async () => {
    const { mutations } = decisionSetup();
    const dialog = await openDecision();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "No procede" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Procede" }));
    fireEvent(
      dialog.ownerDocument.querySelector("dialog")!,
      new Event("cancel", { cancelable: true }),
    );
    expect(mutations).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("No procede confirms once, refreshes Active, clears stale detail and History is read-only", async () => {
    const { mutations } = decisionSetup();
    await openDecision();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar decisión" }));
    await screen.findByText("No hay casos activos por ahora.");
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({
      originalPostState: "hidden_pending_review",
      expectedCaseVersion: 4,
      expectedPostVersion: 5,
      resolutionMessage: null,
    });
    expect(screen.queryByRole("region", { name: "Detalle del caso" })).toBeNull();
    expect(showActionSuccess).toHaveBeenCalledOnce();
    expect(notifyCommunityVisibility).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Historial" }));
    await screen.findByRole("button", { name: /Contenido 1/ });
    fireEvent.click(card(1));
    await screen.findByText("Decisión: No procede");
    expect(screen.queryByRole("button", { name: "No procede" })).toBeNull();
  });
  it.each(["", "   ", "😀".repeat(1001)])(
    "rejects invalid Procede message without HTTP",
    async (message) => {
      const { mutations } = decisionSetup();
      await openDecision("Procede");
      fireEvent.change(screen.getByRole("textbox"), { target: { value: message } });
      fireEvent.submit(screen.getByRole("textbox").closest("form")!);
      await screen.findByText(/Escribe un mensaje de resolución/);
      expect(mutations).toHaveLength(0);
    },
  );
  it("accepts 1000 Unicode code points and trims the canonical message", async () => {
    const { mutations } = decisionSetup();
    await openDecision("Procede");
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: `  ${"😀".repeat(1000)}  ` },
    });
    fireEvent.submit(screen.getByRole("textbox").closest("form")!);
    await screen.findByText("No hay casos activos por ahora.");
    expect(mutations[0].resolutionMessage).toBe("😀".repeat(1000));
    expect(showActionSuccess).toHaveBeenCalledWith(
      "Se retiró la publicación y se cerró el caso.",
    );
    expect(notifyCommunityVisibility).toHaveBeenCalledOnce();
  });
  it.each(["published", "hidden", "deleted"])(
    "No procede %s succeeds without visibility signal",
    async (state) => {
      const item = makeCase();
      if (state === "deleted") item.post = null;
      else {
        item.post!.status = state as "published" | "hidden";
        item.post!.quarantineCycleId = null;
      }
      const { mutations } = decisionSetup("success", item);
      renderPage();
      fireEvent.click(
        await screen.findByRole("button", {
          name:
            state === "deleted" ? /Publicación original no disponible/ : /Contenido 1/,
        }),
      );
      fireEvent.click(await screen.findByRole("button", { name: "No procede" }));
      expect(screen.queryByRole("button", { name: "Restaurar publicación" })).toBeNull();
      if (state === "deleted")
        expect(screen.queryByRole("button", { name: "Procede" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Confirmar decisión" }));
      await screen.findByText("No hay casos activos por ahora.");
      expect(mutations).toHaveLength(1);
      expect(notifyCommunityVisibility).not.toHaveBeenCalled();
      expect(showActionSuccess).toHaveBeenCalledOnce();
    },
  );
  it("pending is single-flight and cannot close via cancel or Escape", async () => {
    const { mutations, finish } = decisionSetup("pending");
    const dialog = await openDecision();
    const form = screen
      .getByRole("button", { name: "Confirmar decisión" })
      .closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await screen.findByText("Guardando decisión…");
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeDisabled();
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(mutations).toHaveLength(1);
    await act(async () => finish());
  });
  it("conflict revalidates and requires conscious review without retry or freshness", async () => {
    const { mutations, calls } = decisionSetup("conflict");
    await openDecision();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar decisión" }));
    await screen.findByText(/Este caso cambió mientras/);
    expect(mutations).toHaveLength(1);
    await waitFor(() =>
      expect(calls.filter((url) => url.includes("scope=active")).length).toBeGreaterThan(
        1,
      ),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(notifyCommunityVisibility).not.toHaveBeenCalled();
    expect(showActionSuccess).not.toHaveBeenCalled();
  });
  it("invalid HTTP 200 stays controlled, disables retry and emits no success/freshness", async () => {
    decisionSetup("invalid");
    await openDecision();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar decisión" }));
    await screen.findByText(/No pudimos confirmar el resultado/);
    expect(screen.getByRole("button", { name: "Confirmar decisión" })).toBeDisabled();
    expect(notifyCommunityVisibility).not.toHaveBeenCalled();
    expect(showActionSuccess).not.toHaveBeenCalled();
  });
  it.each(["MFA success", "MFA cancel"])(
    "step-up preserves case/draft on %s with no replay",
    async (returnButton) => {
      const { mutations } = decisionSetup("stepup");
      await openDecision("Procede");
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "Mensaje conservado" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Confirmar decisión" }));
      expect(await screen.findByTestId("location")).toHaveTextContent("/admin/mfa");
      fireEvent.click(screen.getByRole("button", { name: returnButton }));
      expect(await screen.findByRole("textbox")).toHaveValue("Mensaje conservado");
      expect(mutations).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Confirmar decisión" })).toBeEnabled();
      expect(notifyCommunityVisibility).not.toHaveBeenCalled();
    },
  );
  it.each(["closed", "stale", "removed", "attribution"])(
    "does not expose actions for %s context",
    async (state) => {
      const item = makeCase();
      if (state === "closed") {
        item.caseStatus = "closed";
        item.cycleStatus = "closed";
        item.closureKind = "legacy";
      }
      if (state === "stale") {
        item.isCurrentCycle = false;
        item.currentCycleNumber = 2;
        item.currentCycleId = testId(3, 2);
      }
      if (state === "removed") {
        Object.assign(item.post!, {
          status: "removed_pending_purge",
          quarantineCycleId: null,
          removalDecisionId: testId(5, 1),
          removedAt: "2026-10-03T00:00:00Z",
          purgeAfter: "2026-10-06T00:00:00Z",
        });
      }
      if (state === "attribution") item.post!.quarantineCycleId = testId(3, 2);
      decisionSetup("success", item);
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: /Contenido 1/ }));
      await screen.findByText(/Contexto de la publicación/);
      expect(screen.queryByRole("button", { name: "No procede" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Procede" })).toBeNull();
    },
  );
});

describe("/admin/moderation — acceso", () => {
  it("sin sesión → /login?returnTo=/admin/moderation, nunca llama a /api/admin/access", async () => {
    vi.stubGlobal("fetch", vi.fn());
    renderPage();
    const probe = await screen.findByTestId("location");
    expect(probe).toHaveTextContent("/login?returnTo=/admin/moderation");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("USER (rol null, sin capacidad moderation) → acceso denegado, SIN redirigir a MFA", async () => {
    signedIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => access(null, [], false)),
    );
    renderPage();
    expect(
      await screen.findByText("No tienes acceso al panel de moderación."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("location")).toBeNull();
  });

  it("ADMIN (capacidad moderation incluida) sin MFA reciente → redirige a /admin/mfa?returnTo=/admin/moderation", async () => {
    signedIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => access("admin", ["moderation", "technical"], false)),
    );
    renderPage();
    const probe = await screen.findByTestId("location");
    expect(probe).toHaveTextContent("/admin/mfa?returnTo=/admin/moderation");
  });

  it("MODERATOR con capacidad moderation + MFA reciente → carga el panel (rol distinto de admin, SÍ entra)", async () => {
    signedIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/admin/access"))
          return access("moderator", ["moderation"], true);
        if (url.includes("/api/admin/moderation-cases"))
          return ok({ cases: [], nextCursor: null });
        return failure(404);
      }),
    );
    renderPage();
    expect(await screen.findByText("Moderación")).toBeInTheDocument();
    expect(await screen.findByText("MODERATOR")).toBeInTheDocument();
  });

  it("DEVELOPER con capacidad moderation también carga el panel", async () => {
    signedIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/admin/access"))
          return access("developer", ["moderation", "technical"], true);
        if (url.includes("/api/admin/moderation-cases"))
          return ok({ cases: [], nextCursor: null });
        return failure(404);
      }),
    );
    renderPage();
    expect(await screen.findByText("Moderación")).toBeInTheDocument();
  });
});

it.each(["close", "tab"])("pending detail cannot reopen after %s", async (mode) => {
  setupCases();
  const original = vi.mocked(fetch).getMockImplementation()!;
  let finish: ((response: ReturnType<typeof ok>) => void) | undefined;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (String(input).includes("cycleId=" + testId(3, 1)))
      return new Promise<Response>((resolve) => {
        finish = (response) => resolve(response as unknown as Response);
      });
    return original(input, init);
  });
  renderPage();
  await screen.findByText("Contenido 1");
  fireEvent.click(card(1));
  await screen.findByText("Cargando caso…");
  fireEvent.click(
    screen.getByRole("button", {
      name: mode === "close" ? "Cerrar detalle del caso" : "Historial",
    }),
  );
  await act(async () => {
    finish?.(ok({ item: makeCase(1) }));
  });
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Detalle del caso" })).toBeNull(),
  );
  expect(card(1)).toHaveAttribute("aria-expanded", "false");
  expect(showActionSuccess).not.toHaveBeenCalled();
  expect(notifyCommunityVisibility).not.toHaveBeenCalled();
});
it("malformed successful queue shows error instead of empty work or render crash", async () => {
  setupCases();
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) =>
    String(input).includes("moderation-cases")
      ? (ok({ cases: null, nextCursor: null }) as unknown as Response)
      : original(input, init),
  );
  renderPage();
  await screen.findByText(/No se pudieron cargar los casos/);
  expect(screen.queryByText("Contenido 1")).toBeNull();
  expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument();
});
it("malformed successful detail remains a controlled detail error", async () => {
  setupCases();
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) =>
    String(input).includes("cycleId=")
      ? (ok({ item: { cycleId: testId(3, 1) } }) as unknown as Response)
      : original(input, init),
  );
  renderPage();
  await screen.findByText("Contenido 1");
  fireEvent.click(card(1));
  await screen.findByText(/No se pudo cargar este caso/);
  expect(card(1)).toBeInTheDocument();
  expect(screen.queryByText("<script>secret</script>")).toBeNull();
});
