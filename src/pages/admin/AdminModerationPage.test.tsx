import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
  // Los textos de auditoría son i18n: se fija el idioma (el navegador de jsdom es en-US).
  window.localStorage.setItem("upmina:locale", "es");
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
      if (url.includes("summary=pending"))
        return ok({ pending: 3 }) as unknown as Response;
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
      expect(
        screen.getByRole("region", { name: "Detalles del reporte" }),
      ).toHaveTextContent("Caso " + testId(1, 2)),
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
    const panel = await screen.findByRole("region", { name: "Detalles del reporte" });
    expect(card(2).nextElementSibling).toBe(panel);
    expect(card(2).parentElement?.nextElementSibling).toContainElement(card(3));
    expect(card(2)).toHaveAttribute("aria-expanded", "true");
    expect(card(2)).toHaveAttribute("aria-controls", panel.id);
    fireEvent.click(card(3));
    await screen.findByText(new RegExp("Caso " + testId(1, 3)));
    expect(card(2)).toHaveAttribute("aria-expanded", "false");
    expect(screen.getAllByRole("region", { name: "Detalles del reporte" })).toHaveLength(
      1,
    );
    expect(card(3).nextElementSibling).toBe(
      screen.getByRole("region", { name: "Detalles del reporte" }),
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
    const before = calls.filter(
      (url) => url.includes("moderation-cases") && !url.includes("summary"),
    ).length;
    fireEvent.click(screen.getByRole("button", { name: "Actualizar contexto" }));
    await waitFor(() =>
      expect(
        calls.filter(
          (url) => url.includes("moderation-cases") && !url.includes("summary"),
        ),
      ).toHaveLength(before + 1),
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
      fireEvent.click(screen.getByRole("button", { name: "Cerrar detalles" }));
      expect(screen.queryByRole("region", { name: "Detalles del reporte" })).toBeNull();
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
  it("detail is a bordered card with a heading, a visible close button and the same data", async () => {
    setupCases();
    renderPage();
    await screen.findByText("Contenido 1");
    fireEvent.click(card(1));
    await screen.findByText(new RegExp("Caso " + testId(1, 1)));
    const region = screen.getByRole("region", { name: "Detalles del reporte" });
    expect(region.className).toMatch(/rounded-md/);
    expect(region.className).toMatch(/\bborder\b/);
    expect(
      within(region).getByRole("heading", { level: 2, name: "Detalles del reporte" }),
    ).toBeInTheDocument();
    expect(
      within(region).getByRole("heading", { name: "Contexto de la publicación" }),
    ).toBeInTheDocument();
    fireEvent.click(within(region).getByRole("button", { name: "Cerrar detalles" }));
    expect(screen.queryByRole("region", { name: "Detalles del reporte" })).toBeNull();
  });
  it.each([
    ["en", "Report details", "Close details"],
    ["de", "Details der Meldung", "Details schließen"],
  ])(
    "detail card texts follow the active language (%s)",
    async (locale, title, close) => {
      window.localStorage.setItem("upmina:locale", locale);
      setupCases();
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: /Contenido 1/ }));
      const region = await screen.findByRole("region", { name: title });
      expect(within(region).getByRole("button", { name: close })).toBeInTheDocument();
    },
  );
  it("responsive detail uses available width and wraps unbroken text/media", async () => {
    setupCases();
    renderPage();
    await screen.findByText("Contenido 1");
    fireEvent.click(card(1));
    await screen.findByText(new RegExp("Caso " + testId(1, 1)));
    expect(screen.getByText("<script>secret</script>").className).toContain(
      "[overflow-wrap:anywhere]",
    );
    expect(
      screen.getByRole("region", { name: "Detalles del reporte" }).className,
    ).toContain("min-w-0");
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
    expect(screen.queryByRole("region", { name: "Detalles del reporte" })).toBeNull();
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
          // far future: the window must still be open whatever the wall clock says
          removedAt: "2099-10-03T00:00:00Z",
          purgeAfter: "2099-10-06T00:00:00Z",
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
        if (url.includes("summary=pending"))
          return ok({ pending: 3 }) as unknown as Response;
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
        if (url.includes("summary=pending"))
          return ok({ pending: 3 }) as unknown as Response;
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
      name: mode === "close" ? "Cerrar detalles" : "Historial",
    }),
  );
  await act(async () => {
    finish?.(ok({ item: makeCase(1) }));
  });
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Detalles del reporte" })).toBeNull(),
  );
  expect(card(1)).toHaveAttribute("aria-expanded", "false");
  expect(showActionSuccess).not.toHaveBeenCalled();
  expect(notifyCommunityVisibility).not.toHaveBeenCalled();
});
it("malformed successful queue shows error instead of empty work or render crash", async () => {
  setupCases();
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) =>
    String(input).includes("moderation-cases") && !String(input).includes("summary")
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

describe("R4-E4 purged history", () => {
  const purgedCase = (): ModerationCaseItem => ({
    ...makeCase(1),
    caseStatus: "closed",
    cycleStatus: "closed",
    closureKind: "decision",
    closedAt: "2026-10-02T00:00:00Z",
    post: null,
    decision: {
      decisionId: testId(5, 1),
      result: "content_actioned",
      resolutionMessage: "Mensaje del moderador conservado",
      createdAt: "2026-10-02T00:00:00Z",
    },
    audit: [
      {
        id: testId(6, 1),
        action: "post_purged",
        actorKind: "system",
        createdAt: "2026-10-05T00:00:00Z",
        strikeLevel: null,
        states: {
          fromPostStatus: null,
          toPostStatus: null,
          fromReportStatus: null,
          toReportStatus: null,
        },
      },
    ],
  });
  async function openHistory(item: ModerationCaseItem, name: RegExp) {
    setupCases({ items: [item] });
    renderPage();
    const slow = { timeout: 5000 };
    fireEvent.click(await screen.findByRole("button", { name: "Historial" }, slow));
    fireEvent.click(await screen.findByRole("button", { name }, slow));
    await screen.findByRole("region", { name: "Detalles del reporte" }, slow);
  }
  it("a physically purged case stays in History, opens and renders a neutral deleted state", async () => {
    await openHistory(purgedCase(), /Publicación eliminada definitivamente/);
    expect(screen.getByText(/fue eliminada definitivamente el/)).toBeInTheDocument();
    expect(
      screen.getByText(/No se conserva una captura de su texto/),
    ).toBeInTheDocument();
    expect(screen.getByText("Decisión: Procede")).toBeInTheDocument();
    expect(screen.getByText("Mensaje del moderador conservado")).toBeInTheDocument();
    // audit entry: neutral label with timestamp, no raw action name, no state arrows
    const audit = screen.getByRole("region", { name: "Auditoría reciente" });
    expect(audit).toHaveTextContent("Publicación eliminada definitivamente · Sistema");
    expect(audit).not.toHaveTextContent("post_purged");
    expect(audit).not.toHaveTextContent("→");
    expect(screen.getByText("<script>secret</script>")).toBeInTheDocument(); // report detail kept
  });
  it("a purged case offers no mutating action and exposes no technical ids beyond the case header", async () => {
    await openHistory(purgedCase(), /Publicación eliminada definitivamente/);
    for (const name of [/^Procede$/, /^No procede$/, /Confirmar decisión/, /Restaurar/])
      expect(screen.queryByRole("button", { name })).toBeNull();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain(testId(5, 1)); // decision id
    expect(text).not.toMatch(/assets?_|storage|community\//i);
  });
  it("a purged case never appears in Active", async () => {
    setupCases({ items: [] });
    renderPage();
    expect(
      await screen.findByText("No hay casos activos por ahora."),
    ).toBeInTheDocument();
  });
  it("expired removed post whose row still exists: explicit expiry, no 'sin texto', no current-content claim", async () => {
    const item = purgedCase();
    item.post = {
      text: null,
      status: "removed_pending_purge",
      version: 5,
      updatedAt: "2026-10-02T00:00:00Z",
      authorUsername: "author",
      quarantineCycleId: null,
      removalDecisionId: testId(5, 1),
      removedAt: "2026-10-02T00:00:00Z",
      purgeAfter: "2026-10-05T00:00:00Z",
    };
    item.audit = [];
    await openHistory(item, /Contenido expirado/);
    expect(screen.getByText(/ya expiró y no está disponible/)).toBeInTheDocument();
    expect(screen.queryByText("Publicación sin texto")).toBeNull();
    expect(screen.queryByText(/Se muestra el contenido actual/)).toBeNull();
    expect(screen.getByText("Mensaje del moderador conservado")).toBeInTheDocument();
  });
  it("a post removed inside the window still shows its content to the moderator", async () => {
    // ONE clock read: the parser requires purgeAfter - removedAt to be exactly 72 h.
    const removedMs = Date.now() - 3_600_000;
    const item = purgedCase();
    item.post = {
      text: "Contenido aún vigente",
      status: "removed_pending_purge",
      version: 5,
      updatedAt: "2026-10-02T00:00:00Z",
      authorUsername: "author",
      quarantineCycleId: null,
      removalDecisionId: testId(5, 1),
      removedAt: new Date(removedMs).toISOString(),
      purgeAfter: new Date(removedMs + 72 * 3_600_000).toISOString(),
    };
    item.audit = [];
    await openHistory(item, /Contenido aún vigente/);
    expect(screen.getAllByText("Contenido aún vigente").length).toBeGreaterThan(0);
    expect(screen.queryByText(/ya expiró/)).toBeNull();
  });
});

describe("R5-E strike UX in moderation History", () => {
  const DECISION = testId(5, 1);
  const STRIKE_ID = testId(7, 1);
  type Block = NonNullable<ModerationCaseItem["strike"]>;
  type Existing = NonNullable<Block["existing"]>;
  const eligible = (level: 1 | 2 | 3): Block => ({
    eligible: true,
    ineligibleReason: null,
    predictedLevel: level,
    decisionId: DECISION,
    existing: null,
  });
  const existingBlock = (over: Partial<Existing> = {}): Block => ({
    eligible: false,
    ineligibleReason: "strike_already_issued",
    predictedLevel: null,
    decisionId: DECISION,
    existing: {
      id: STRIKE_ID,
      level: 1,
      reason: "Motivo del strike",
      permanent: false,
      startsAt: "2026-10-01T00:00:00Z",
      endsAt: "2099-10-15T00:00:00Z",
      revoked: false,
      sanctionInEffect: true,
      revokedAt: null,
      revocationReason: null,
      canRevoke: false,
      ...over,
    },
  });
  const closedCase = (strike?: Block): ModerationCaseItem => ({
    ...makeCase(1),
    caseStatus: "closed",
    cycleStatus: "closed",
    closureKind: "decision",
    closedAt: "2026-10-02T00:00:00Z",
    post: {
      text: "Contenido 1",
      status: "removed_pending_purge",
      version: 5,
      updatedAt: "2026-10-02T00:00:00Z",
      authorUsername: "author",
      quarantineCycleId: null,
      removalDecisionId: DECISION,
      removedAt: "2099-10-03T00:00:00Z",
      purgeAfter: "2099-10-06T00:00:00Z",
    },
    decision: {
      decisionId: DECISION,
      result: "content_actioned",
      resolutionMessage: "Resolución del moderador",
      createdAt: "2026-10-02T00:00:00Z",
    },
    ...(strike ? { strike } : {}),
  });
  type Mutation = { kind: "apply" | "revoke"; body: Record<string, unknown> };
  function strikeSetup(
    initial: ModerationCaseItem,
    behaviour: (
      m: Mutation,
      state: { item: ModerationCaseItem },
    ) => Response | Promise<Response> = () => ok({}) as Response,
    options: { activeToo?: boolean } = {},
  ) {
    const state = { item: initial };
    const setup = setupCases({ items: [initial] });
    const original = vi.mocked(fetch).getMockImplementation()!;
    const mutations: Mutation[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (
        url.includes("moderation-strike-apply") ||
        url.includes("moderation-strike-revoke")
      ) {
        const m: Mutation = {
          kind: url.includes("apply") ? "apply" : "revoke",
          body: JSON.parse(String(init?.body)),
        };
        mutations.push(m);
        return behaviour(m, state);
      }
      if (url.includes("summary=pending"))
        return ok({ pending: 3 }) as unknown as Response;
      if (url.includes("moderation-cases")) {
        setup.calls.push(url);
        if (url.includes("cycleId=")) return ok({ item: state.item }) as Response;
        return ok({
          cases: url.includes("scope=closed") || options.activeToo ? [state.item] : [],
          nextCursor: null,
        }) as Response;
      }
      return original(input, init);
    });
    return { ...setup, state, mutations };
  }
  async function openHistory() {
    renderPage();
    const slow = { timeout: 5000 };
    fireEvent.click(await screen.findByRole("button", { name: "Historial" }, slow));
    fireEvent.click(await screen.findByRole("button", { name: /Contenido 1/ }, slow));
    await screen.findByRole(
      "region",
      { name: /Detalles del reporte|Report details/ },
      slow,
    );
  }
  const section = () => screen.getByRole("region", { name: "Sanción al autor" });
  const reasonBox = () => screen.getByRole("textbox", { name: /Motivo/ });
  const submitForm = () => fireEvent.submit(reasonBox().closest("form")!);
  const applied = (level = 2) =>
    ok({
      strike: {
        id: STRIKE_ID,
        decisionId: DECISION,
        level,
        reason: "x",
        permanent: level === 3,
        startsAt: "2026-10-05T00:00:00+00:00",
        endsAt: level === 3 ? null : "2026-11-05T00:00:00+00:00",
        revoked: false,
        sanctionInEffect: true,
      },
    }) as Response;

  describe("eligible Procede without a strike", () => {
    it.each([
      [1, /durante 14 días/],
      [2, /durante 1 mes/],
      [3, /permanentemente/],
    ] as const)(
      "predicted Strike %i comes ONLY from the server and explains the effect",
      async (level, effect) => {
        strikeSetup(closedCase(eligible(level)));
        await openHistory();
        expect(section()).toHaveTextContent(`Próximo strike: Strike ${level}`);
        expect(section()).toHaveTextContent(effect);
        expect(section()).toHaveTextContent(
          "seguir eliminando sus propias publicaciones",
        );
        expect(
          screen.getByRole("button", { name: `Aplicar Strike ${level}` }),
        ).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Revocar/ })).toBeNull();
      },
    );
    it("there is no level/duration/author selector", async () => {
      strikeSetup(closedCase(eligible(2)));
      await openHistory();
      fireEvent.click(screen.getByRole("button", { name: "Aplicar Strike 2" }));
      // R5-G: los filtros de la cola también son controles; solo se inspecciona el diálogo.
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).queryByRole("combobox")).toBeNull();
      expect(within(dialog).queryByRole("radio")).toBeNull();
      expect(within(dialog).getAllByRole("textbox")).toHaveLength(1); // only the reason
    });
    it("Active scope never shows strike controls", async () => {
      strikeSetup(closedCase(eligible(1)), undefined, { activeToo: true });
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: /Contenido 1/ }));
      await screen.findByRole("region", { name: "Detalles del reporte" });
      expect(screen.queryByRole("region", { name: "Sanción al autor" })).toBeNull();
    });
    it("No procede / not-actionable decisions show no strike section", async () => {
      strikeSetup(
        closedCase({
          eligible: false,
          ineligibleReason: "decision_not_content_actioned",
          predictedLevel: null,
          decisionId: null,
          existing: null,
        }),
      );
      await openHistory();
      expect(screen.queryByRole("region", { name: "Sanción al autor" })).toBeNull();
    });
    it("a case without a strike block (database without R5) shows nothing and keeps working", async () => {
      strikeSetup(closedCase());
      await openHistory();
      expect(screen.queryByRole("region", { name: "Sanción al autor" })).toBeNull();
      expect(screen.getByText("Decisión: Procede")).toBeInTheDocument();
    });
    it("author-unavailable is explained without an action", async () => {
      strikeSetup(
        closedCase({
          eligible: false,
          ineligibleReason: "author_unavailable",
          predictedLevel: null,
          decisionId: DECISION,
          existing: null,
        }),
      );
      await openHistory();
      expect(section()).toHaveTextContent("ya no está disponible");
      expect(screen.queryByRole("button", { name: /Aplicar/ })).toBeNull();
    });
  });

  describe("apply dialog", () => {
    it("opens a native dialog with the consequence; reason required; 1000 accepted; 1001 rejected; no mutation until valid", async () => {
      const { mutations } = strikeSetup(closedCase(eligible(2)));
      await openHistory();
      fireEvent.click(screen.getByRole("button", { name: "Aplicar Strike 2" }));
      const dialog = screen.getByRole("dialog");
      expect(dialog.tagName).toBe("DIALOG");
      expect(dialog).toHaveTextContent("Confirmar Strike 2");
      expect(dialog).toHaveTextContent("durante 1 mes");
      expect(dialog).toHaveTextContent("lo verá el autor");
      submitForm();
      expect(await screen.findByText("Escribe el motivo.")).toBeInTheDocument();
      fireEvent.change(reasonBox(), { target: { value: "😀".repeat(1001) } });
      expect(
        screen.getByText(/1001\/1000 caracteres — supera el máximo/),
      ).toBeInTheDocument();
      submitForm();
      expect(await screen.findByText(/no puede superar 1000/)).toBeInTheDocument();
      expect(mutations).toHaveLength(0);
      fireEvent.change(reasonBox(), { target: { value: "😀".repeat(1000) } });
      expect(screen.getByText("1000/1000 caracteres")).toBeInTheDocument();
    });
    it("submits decisionId + reason + expectedLevel = the server's predicted level; refreshes from the server", async () => {
      const { mutations, calls, state } = strikeSetup(
        closedCase(eligible(2)),
        (_m, st) => {
          st.item = closedCase(
            existingBlock({
              level: 2,
              reason: "Motivo escrito",
              endsAt: "2099-11-05T00:00:00Z",
            }),
          );
          return applied(2);
        },
      );
      await openHistory();
      const detailCallsBefore = calls.filter((u) => u.includes("cycleId=")).length;
      fireEvent.click(screen.getByRole("button", { name: "Aplicar Strike 2" }));
      fireEvent.change(reasonBox(), { target: { value: "  Motivo escrito  " } });
      submitForm();
      await screen.findByText("Strike 2");
      expect(mutations).toEqual([
        {
          kind: "apply",
          body: { decisionId: DECISION, reason: "Motivo escrito", expectedLevel: 2 },
        },
      ]);
      expect(JSON.stringify(mutations[0].body)).not.toMatch(
        /userId|caseId|cycleId|level"|endsAt|permanent/,
      );
      expect(calls.filter((u) => u.includes("cycleId=")).length).toBeGreaterThan(
        detailCallsBefore,
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(section()).toHaveTextContent("Motivo: Motivo escrito");
      expect(section()).toHaveTextContent("Restricción activa hasta");
      expect(state.item.strike?.existing?.level).toBe(2);
      expect(showActionSuccess).toHaveBeenCalledOnce();
    });
    it("no optimistic fake strike: while the mutation is pending the section still says 'Próximo strike'", async () => {
      let release: ((r: Response) => void) | undefined;
      strikeSetup(
        closedCase(eligible(1)),
        () => new Promise<Response>((r) => (release = r)),
      );
      await openHistory();
      fireEvent.click(screen.getByRole("button", { name: "Aplicar Strike 1" }));
      fireEvent.change(reasonBox(), { target: { value: "Motivo" } });
      submitForm();
      expect(await screen.findByRole("status")).toHaveTextContent("Aplicando…");
      expect(section()).toHaveTextContent("Próximo strike: Strike 1");
      expect(section().textContent).not.toMatch(/Restricción activa/);
      await act(async () => release?.(failure(500) as Response));
    });
    it("is single-flight: double submit sends ONE request, buttons disabled, Cancel and Escape blocked", async () => {
      let release: ((r: Response) => void) | undefined;
      const { mutations } = strikeSetup(
        closedCase(eligible(1)),
        () => new Promise<Response>((r) => (release = r)),
      );
      await openHistory();
      fireEvent.click(screen.getByRole("button", { name: "Aplicar Strike 1" }));
      fireEvent.change(reasonBox(), { target: { value: "Motivo" } });
      submitForm();
      submitForm();
      expect(await screen.findByRole("status")).toHaveTextContent("Aplicando…");
      expect(mutations).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Cancelar" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Aplicando…" })).toBeDisabled();
      fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      await act(async () => release?.(failure(500) as Response));
    });
    it("Cancel and Escape close without mutating and return focus to the opener", async () => {
      const { mutations } = strikeSetup(closedCase(eligible(1)));
      await openHistory();
      const open = screen.getByRole("button", { name: "Aplicar Strike 1" });
      open.focus();
      fireEvent.click(open);
      fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByRole("button", { name: "Aplicar Strike 1" })).toHaveFocus();
      fireEvent.click(screen.getByRole("button", { name: "Aplicar Strike 1" }));
      fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(mutations).toHaveLength(0);
    });
    it("MFA: preserves the open case, the dialog and the typed reason; NEVER replays the mutation", async () => {
      const { mutations } = strikeSetup(
        closedCase(eligible(2)),
        () => failure(403, { code: "step_up_required" }) as Response,
      );
      await openHistory();
      fireEvent.click(screen.getByRole("button", { name: "Aplicar Strike 2" }));
      fireEvent.change(reasonBox(), { target: { value: "Motivo conservado" } });
      submitForm();
      expect(await screen.findByTestId("location")).toHaveTextContent("/admin/mfa");
      fireEvent.click(screen.getByRole("button", { name: "MFA success" }));
      expect(await screen.findByRole("textbox", { name: /Motivo/ })).toHaveValue(
        "Motivo conservado",
      );
      expect(screen.getByRole("dialog")).toHaveTextContent("Confirmar Strike 2");
      expect(screen.getByRole("status")).toHaveTextContent(
        "No se ha repetido la acción.",
      );
      expect(mutations).toHaveLength(1); // no automatic replay after MFA
      expect(screen.getByRole("button", { name: "Confirmar strike" })).toBeEnabled();
    });
    it("MFA resume shows the FRESH server level (the old prediction is never trusted)", async () => {
      const { mutations, state } = strikeSetup(closedCase(eligible(1)), (_m, st) => {
        st.item = closedCase(eligible(2)); // someone else's strike raised the level meanwhile
        return failure(403, { code: "step_up_required" }) as Response;
      });
      await openHistory();
      fireEvent.click(screen.getByRole("button", { name: "Aplicar Strike 1" }));
      fireEvent.change(reasonBox(), { target: { value: "Motivo" } });
      submitForm();
      await screen.findByTestId("location");
      fireEvent.click(screen.getByRole("button", { name: "MFA success" }));
      expect(await screen.findByRole("dialog")).toHaveTextContent("Confirmar Strike 2");
      expect(mutations).toHaveLength(1);
      expect(state.item.strike?.predictedLevel).toBe(2);
    });
    it.each([
      ["level_changed", 409],
      ["strike_already_issued", 409],
      ["decision_not_content_actioned", 409],
      ["case_not_closed", 409],
    ])(
      "%s is stale state: no retry, refresh, neutral explanation",
      async (code, status) => {
        const { mutations, calls } = strikeSetup(closedCase(eligible(1)), (_m, st) => {
          st.item = closedCase(code === "level_changed" ? eligible(3) : existingBlock());
          return failure(status, { code }) as Response;
        });
        await openHistory();
        const before = calls.filter((u) => u.includes("cycleId=")).length;
        fireEvent.click(screen.getByRole("button", { name: "Aplicar Strike 1" }));
        fireEvent.change(reasonBox(), { target: { value: "Motivo" } });
        submitForm();
        expect(
          await screen.findByText(/El estado de moderación de este caso cambió/),
        ).toBeInTheDocument();
        expect(mutations).toHaveLength(1);
        expect(screen.queryByRole("dialog")).toBeNull();
        await waitFor(() =>
          expect(calls.filter((u) => u.includes("cycleId=")).length).toBeGreaterThan(
            before,
          ),
        );
        if (code === "level_changed")
          expect(await screen.findByText("Próximo strike: Strike 3")).toBeInTheDocument();
        else if (code === "strike_already_issued")
          expect(await screen.findByText("Strike 1")).toBeInTheDocument();
        expect(showActionSuccess).not.toHaveBeenCalled();
      },
    );
    it("an invalid 200 stays controlled: submit disabled, closing refreshes the case", async () => {
      const { calls } = strikeSetup(
        closedCase(eligible(1)),
        () => ok({ strike: { level: 9 } }) as Response,
      );
      await openHistory();
      fireEvent.click(screen.getByRole("button", { name: "Aplicar Strike 1" }));
      fireEvent.change(reasonBox(), { target: { value: "Motivo" } });
      submitForm();
      await screen.findByText(/No pudimos confirmar el resultado/);
      expect(screen.getByRole("button", { name: "Confirmar strike" })).toBeDisabled();
      expect(showActionSuccess).not.toHaveBeenCalled();
      const before = calls.filter((u) => u.includes("cycleId=")).length;
      fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
      await waitFor(() =>
        expect(calls.filter((u) => u.includes("cycleId=")).length).toBeGreaterThan(
          before,
        ),
      );
    });
    it("a generic 403 (access lost) never leaks backend text", async () => {
      strikeSetup(
        closedCase(eligible(1)),
        () => failure(403, { error: "SELECT * FROM secret", code: "weird" }) as Response,
      );
      await openHistory();
      fireEvent.click(screen.getByRole("button", { name: "Aplicar Strike 1" }));
      fireEvent.change(reasonBox(), { target: { value: "Motivo" } });
      submitForm();
      expect(
        await screen.findByText(/Tu acceso para esta acción ya no está disponible/),
      ).toBeInTheDocument();
      expect(document.body.textContent).not.toContain("SELECT");
    });
  });

  describe("existing strike rendering", () => {
    it("active temporary: level, FULL reason, deadline; no ids, no actor identity, no revoke for a moderator", async () => {
      strikeSetup(
        closedCase(existingBlock({ reason: "Motivo largo ".repeat(40).trim() })),
      );
      await openHistory();
      expect(section()).toHaveTextContent("Strike 1");
      expect(section()).toHaveTextContent(/Restricción activa hasta .*2099/);
      expect(section()).toHaveTextContent("Motivo largo");
      expect(screen.queryByRole("button", { name: /Revocar/ })).toBeNull();
      expect(document.body.textContent).not.toContain(STRIKE_ID);
      expect(section().textContent).not.toMatch(/aplicado por|moderador:|appliedBy/i);
    });
    it("expired temporary sanction", async () => {
      strikeSetup(
        closedCase(
          existingBlock({ sanctionInEffect: false, endsAt: "2026-10-15T00:00:00Z" }),
        ),
      );
      await openHistory();
      expect(section()).toHaveTextContent("Restricción finalizada");
      expect(section().textContent).not.toMatch(/activa hasta/);
    });
    it("permanent strike", async () => {
      strikeSetup(closedCase(existingBlock({ level: 3, permanent: true, endsAt: null })));
      await openHistory();
      expect(section()).toHaveTextContent("Strike 3");
      expect(section()).toHaveTextContent("Restricción permanente");
    });
    it("revoked strike shows its revocation reason and no further action", async () => {
      strikeSetup(
        closedCase(
          existingBlock({
            revoked: true,
            sanctionInEffect: false,
            revokedAt: "2026-10-04T00:00:00Z",
            revocationReason: "Error de apreciación",
            canRevoke: false,
          }),
        ),
      );
      await openHistory();
      expect(section()).toHaveTextContent("Strike revocado");
      expect(section()).toHaveTextContent(
        "Motivo de la revocación: Error de apreciación",
      );
      expect(screen.queryByRole("button", { name: /Revocar|Aplicar/ })).toBeNull();
    });
  });

  describe("cierre R5-E: fallos de transporte, mensajes y diálogos reabiertos", () => {
    const failMessage = /No se pudo completar la acción/;
    it("un 500 en Aplicar: error genérico sin filtrar texto del backend, el diálogo sigue abierto y NO se repite solo", async () => {
      const { mutations } = strikeSetup(
        closedCase(eligible(1)),
        () =>
          failure(500, {
            error: "SELECT * FROM secret",
            code: "internal_failure",
          }) as Response,
      );
      await openHistory();
      fireEvent.click(screen.getByRole("button", { name: "Aplicar Strike 1" }));
      fireEvent.change(reasonBox(), { target: { value: "Motivo" } });
      submitForm();
      expect(await screen.findByText(failMessage)).toBeInTheDocument();
      expect(document.body.textContent).not.toContain("SELECT");
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(mutations).toHaveLength(1); // sin reintento automático
      expect(showActionSuccess).not.toHaveBeenCalled();
      expect(reasonBox()).toHaveValue("Motivo"); // el motivo escrito no se pierde
      expect(screen.getByRole("button", { name: "Confirmar strike" })).toBeEnabled();
    });
    it("un fallo de red en Aplicar se trata igual: mensaje controlado, sin éxito falso y reintento solo manual", async () => {
      let calls = 0;
      const { mutations } = strikeSetup(closedCase(eligible(1)), () => {
        calls += 1;
        if (calls === 1) throw new TypeError("Failed to fetch");
        return applied(1);
      });
      await openHistory();
      fireEvent.click(screen.getByRole("button", { name: "Aplicar Strike 1" }));
      fireEvent.change(reasonBox(), { target: { value: "Motivo" } });
      submitForm();
      expect(await screen.findByText(failMessage)).toBeInTheDocument();
      expect(showActionSuccess).not.toHaveBeenCalled();
      expect(mutations).toHaveLength(1);
      submitForm(); // el moderador decide reintentar a mano
      await waitFor(() => expect(mutations).toHaveLength(2));
      await waitFor(() => expect(showActionSuccess).toHaveBeenCalledOnce());
    });
    it("un 500 al Revocar: mismo tratamiento y el strike sigue mostrándose como activo", async () => {
      const { mutations } = strikeSetup(
        closedCase(existingBlock({ canRevoke: true })),
        () => failure(500, { code: "internal_failure" }) as Response,
      );
      await openHistory();
      fireEvent.click(screen.getByRole("button", { name: "Revocar strike" }));
      fireEvent.change(reasonBox(), { target: { value: "Motivo" } });
      submitForm();
      expect(await screen.findByText(failMessage)).toBeInTheDocument();
      expect(mutations).toHaveLength(1);
      expect(showActionSuccess).not.toHaveBeenCalled();
      expect(section()).toHaveTextContent("Restricción activa hasta");
    });
    it("la confirmación no promete un refresco que aún no ocurrió", async () => {
      strikeSetup(closedCase(eligible(1)), (_m, st) => {
        st.item = closedCase(existingBlock());
        return applied(1);
      });
      await openHistory();
      fireEvent.click(screen.getByRole("button", { name: "Aplicar Strike 1" }));
      fireEvent.change(reasonBox(), { target: { value: "Motivo" } });
      submitForm();
      await waitFor(() =>
        expect(showActionSuccess).toHaveBeenCalledWith("Strike aplicado."),
      );
    });
    it("tras reanudar por MFA y cancelar, un diálogo NUEVO ya no dice «No se ha repetido la acción»", async () => {
      strikeSetup(
        closedCase(eligible(2)),
        () => failure(403, { code: "step_up_required" }) as Response,
      );
      await openHistory();
      fireEvent.click(screen.getByRole("button", { name: "Aplicar Strike 2" }));
      fireEvent.change(reasonBox(), { target: { value: "Motivo conservado" } });
      submitForm();
      await screen.findByTestId("location");
      fireEvent.click(screen.getByRole("button", { name: "MFA success" }));
      expect(await screen.findByRole("dialog")).toHaveTextContent(
        "No se ha repetido la acción.",
      );
      fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Aplicar Strike 2" }));
      expect(screen.getByRole("dialog")).not.toHaveTextContent(
        "No se ha repetido la acción.",
      );
      expect(reasonBox()).toHaveValue("");
    });
  });

  describe("R5-F: estado de strike no disponible y auditoría legible", () => {
    const unavailableCase = (): ModerationCaseItem => ({
      ...closedCase(),
      strikeUnavailable: true,
    });
    it("fallo de lectura ≠ sin sanción: aviso con alerta, sin acciones de strike y sin texto interno", async () => {
      strikeSetup(unavailableCase());
      await openHistory();
      const box = section();
      expect(box).toHaveTextContent("No se pudo consultar el estado de la sanción");
      expect(box).toHaveTextContent("no significa que no haya una sanción");
      expect(within(box).getByRole("alert")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Aplicar Strike/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /Revocar strike/ })).toBeNull();
      expect(document.body.textContent).not.toMatch(/PGRST|SELECT|sqlstate/i);
    });
    it("Reintentar vuelve a pedir el caso al servidor y, si ya responde, muestra la sección real", async () => {
      const { state, calls } = strikeSetup(unavailableCase());
      await openHistory();
      const before = calls.filter((u) => u.includes("cycleId=")).length;
      state.item = closedCase(eligible(2));
      fireEvent.click(screen.getByRole("button", { name: "Reintentar consulta" }));
      expect(await screen.findByText("Próximo strike: Strike 2")).toBeInTheDocument();
      expect(calls.filter((u) => u.includes("cycleId=")).length).toBeGreaterThan(before);
      expect(
        screen.queryByText(/No se pudo consultar el estado de la sanción/),
      ).toBeNull();
    });
    it("si el reintento sigue fallando, el aviso permanece (sin éxito falso)", async () => {
      const { calls } = strikeSetup(unavailableCase());
      await openHistory();
      const before = calls.filter((u) => u.includes("cycleId=")).length;
      fireEvent.click(screen.getByRole("button", { name: "Reintentar consulta" }));
      await waitFor(() =>
        expect(calls.filter((u) => u.includes("cycleId=")).length).toBeGreaterThan(
          before,
        ),
      );
      expect(
        await screen.findByText(/No se pudo consultar el estado de la sanción/),
      ).toBeInTheDocument();
    });
    it("sin la bandera y sin bloque (No procede / BD sin strikes) no hay sección ni aviso", async () => {
      strikeSetup(closedCase());
      await openHistory();
      expect(screen.queryByRole("region", { name: "Sanción al autor" })).toBeNull();
      expect(
        screen.queryByText(/No se pudo consultar el estado de la sanción/),
      ).toBeNull();
    });
    it("el aviso solo se ofrece en el Historial, nunca en la cola activa", async () => {
      strikeSetup(unavailableCase(), undefined, { activeToo: true });
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: /Contenido 1/ }));
      await screen.findByRole("region", { name: "Detalles del reporte" });
      expect(
        screen.queryByText(/No se pudo consultar el estado de la sanción/),
      ).toBeNull();
    });
    it("la auditoría del detalle muestra el evento de strike con su nivel y la etiqueta legible", async () => {
      strikeSetup({
        ...closedCase(existingBlock()),
        audit: [
          {
            id: "0e000000-0000-4000-8000-0000000000a1",
            action: "strike_applied",
            actorKind: "human",
            createdAt: "2026-10-03T10:00:00Z",
            states: {
              fromPostStatus: null,
              toPostStatus: null,
              fromReportStatus: null,
              toReportStatus: null,
            },
            strikeLevel: 2,
          },
        ],
      });
      await openHistory();
      const audit = screen.getByRole("region", { name: "Auditoría reciente" });
      expect(audit).toHaveTextContent("Strike aplicado · Strike 2 · Acción humana");
      expect(audit).toHaveTextContent("Sanción");
      expect(audit.textContent).not.toContain("strike_applied");
    });
    it("con el idioma en inglés la auditoría se traduce (el resto del panel no cambia)", async () => {
      window.localStorage.setItem("upmina:locale", "en");
      strikeSetup({
        ...closedCase(),
        audit: [
          {
            id: "0e000000-0000-4000-8000-0000000000a2",
            action: "post_quarantined",
            actorKind: "system",
            createdAt: "2026-10-03T10:00:00Z",
            states: {
              fromPostStatus: "published",
              toPostStatus: "hidden_pending_review",
              fromReportStatus: null,
              toReportStatus: null,
            },
            strikeLevel: null,
          },
        ],
      });
      await openHistory();
      const audit = await screen.findByRole(
        "region",
        { name: "Recent audit trail" },
        { timeout: 5000 },
      );
      expect(audit).toHaveTextContent("Hidden as a precaution");
      expect(audit).toHaveTextContent("Post: Published → Hidden as a precaution");
      expect(audit.textContent).not.toContain("post_quarantined");
    });
  });

  describe("R5-N: por qué una acción no aparece (regresión de los síntomas reportados en DEV)", () => {
    /** Misma pila de fetch, pero el rol del usuario (GET /api/admin/access) es el indicado. */
    const asRole = (role: "moderator" | "developer" | "admin") => {
      const base = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (input, init) =>
        String(input).includes("/api/admin/access")
          ? (access(role, ["moderation"], true) as unknown as Response)
          : base(input, init),
      );
    };
    const noPost = (): ModerationCaseItem => ({ ...makeCase(1), post: null });

    describe("A · caso pendiente sin «Procede»", () => {
      it("la publicación ya no existe → solo «No procede», con la explicación (regla intencional)", async () => {
        setupCases({ items: [noPost()] });
        renderPage();
        fireEvent.click(
          await screen.findByRole("button", { name: /Caso|Publicación|Ciclo/ }),
        );
        const actions = await screen.findByRole("region", { name: "Decisión del caso" });
        expect(within(actions).getByRole("button", { name: "No procede" })).toBeEnabled();
        expect(within(actions).queryByRole("button", { name: "Procede" })).toBeNull();
        expect(actions).toHaveTextContent("La publicación ya no existe");
        expect(actions).toHaveTextContent("solo puede cerrarse como «No procede»");
      });
      it("con la publicación presente se ofrecen las dos decisiones y no hay aviso", async () => {
        setupCases({ items: [makeCase(1)] });
        renderPage();
        fireEvent.click(await screen.findByRole("button", { name: /Contenido 1/ }));
        const actions = await screen.findByRole("region", { name: "Decisión del caso" });
        expect(within(actions).getByRole("button", { name: "Procede" })).toBeEnabled();
        expect(within(actions).getByRole("button", { name: "No procede" })).toBeEnabled();
        expect(actions).not.toHaveTextContent("ya no existe");
      });
      it("un caso ya cerrado no ofrece decisiones en el Historial (no se puede decidir dos veces)", async () => {
        strikeSetup(closedCase(eligible(1)));
        await openHistory();
        expect(screen.queryByRole("region", { name: "Decisión del caso" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Procede" })).toBeNull();
        expect(screen.queryByRole("button", { name: "No procede" })).toBeNull();
      });
    });

    describe("B · «Procede» en el Historial sin botón de strike", () => {
      it("autor no disponible (sin perfil): explica el motivo y no ofrece aplicar", async () => {
        strikeSetup(
          closedCase({
            eligible: false,
            ineligibleReason: "author_unavailable",
            predictedLevel: null,
            decisionId: DECISION,
            existing: null,
          }),
        );
        await openHistory();
        expect(section()).toHaveTextContent("la cuenta del autor ya no está disponible");
        expect(screen.queryByRole("button", { name: /Aplicar Strike/ })).toBeNull();
      });
      it("auto-strike: explica que no puedes sancionar tu propio contenido", async () => {
        strikeSetup(
          closedCase({
            eligible: false,
            ineligibleReason: "self_strike_forbidden",
            predictedLevel: null,
            decisionId: DECISION,
            existing: null,
          }),
        );
        await openHistory();
        expect(section()).toHaveTextContent(
          "No puedes aplicar un strike sobre tu propio contenido",
        );
        expect(screen.queryByRole("button", { name: /Aplicar Strike/ })).toBeNull();
      });
      it("el ciclo «No procede» de un caso cuyo OTRO ciclo fue «Procede» no muestra acciones de strike", async () => {
        const noProcede: ModerationCaseItem = {
          ...closedCase(eligible(1)),
          decision: {
            decisionId: testId(5, 9),
            result: "reports_not_valid",
            resolutionMessage: null,
            createdAt: "2026-10-02T00:00:00Z",
          },
        };
        strikeSetup(noProcede);
        await openHistory();
        expect(screen.queryByRole("region", { name: "Sanción al autor" })).toBeNull();
        expect(screen.queryByRole("button", { name: /Aplicar Strike/ })).toBeNull();
      });
      it("un bloque que apunta a la decisión de OTRO ciclo tampoco se muestra", async () => {
        strikeSetup({
          ...closedCase({ ...eligible(1), decisionId: testId(5, 9) }),
        });
        await openHistory();
        expect(screen.queryByRole("region", { name: "Sanción al autor" })).toBeNull();
      });
      it("elegible: el botón aparece (control positivo)", async () => {
        strikeSetup(closedCase(eligible(1)));
        await openHistory();
        expect(screen.getByRole("button", { name: "Aplicar Strike 1" })).toBeEnabled();
      });
    });

    describe("C · strike registrado sin botón de revocación", () => {
      it("moderador: no puede revocar (regla de rol) y la interfaz lo explica", async () => {
        strikeSetup(closedCase(existingBlock({ canRevoke: false })));
        asRole("moderator");
        await openHistory();
        expect(screen.queryByRole("button", { name: "Revocar strike" })).toBeNull();
        expect(screen.getByTestId("revoke-unavailable")).toHaveTextContent(
          "Solo desarrollo o administración pueden revocar un strike.",
        );
      });
      it.each(["developer", "admin"] as const)(
        "%s que aplicó el strike: no puede revocarlo él mismo (dos personas) y se explica",
        async (role) => {
          strikeSetup(closedCase(existingBlock({ canRevoke: false })));
          asRole(role);
          await openHistory();
          expect(screen.queryByRole("button", { name: "Revocar strike" })).toBeNull();
          expect(screen.getByTestId("revoke-unavailable")).toHaveTextContent(
            "porque lo aplicaste tú",
          );
        },
      );
      it("otra persona con rol suficiente (canRevoke del servidor): botón visible y sin aviso", async () => {
        strikeSetup(closedCase(existingBlock({ canRevoke: true })));
        asRole("admin");
        await openHistory();
        expect(screen.getByRole("button", { name: "Revocar strike" })).toBeEnabled();
        expect(screen.queryByTestId("revoke-unavailable")).toBeNull();
      });
      it("strike ya revocado: ni botón ni aviso (no se puede revocar dos veces)", async () => {
        strikeSetup(
          closedCase(
            existingBlock({
              revoked: true,
              revokedAt: "2026-10-04T00:00:00Z",
              revocationReason: "Error",
              sanctionInEffect: false,
              canRevoke: false,
            }),
          ),
        );
        await openHistory();
        expect(screen.queryByRole("button", { name: "Revocar strike" })).toBeNull();
        expect(screen.queryByTestId("revoke-unavailable")).toBeNull();
        expect(section()).toHaveTextContent("Strike revocado");
      });
      it("con un strike ya emitido nunca se ofrece aplicar otro sobre la misma decisión", async () => {
        strikeSetup(closedCase(existingBlock({ canRevoke: true })));
        await openHistory();
        expect(screen.queryByRole("button", { name: /Aplicar Strike/ })).toBeNull();
      });
    });

    describe("auditoría vs estado vigente, errores y refresco", () => {
      it("la auditoría puede listar un strike y a la vez la sanción estar finalizada o revocada (son lecturas distintas)", async () => {
        strikeSetup({
          ...closedCase(existingBlock({ sanctionInEffect: false, canRevoke: false })),
          audit: [
            {
              id: testId(8, 1),
              action: "strike_applied",
              actorKind: "human",
              createdAt: "2026-09-01T00:00:00Z",
              states: {
                fromPostStatus: null,
                toPostStatus: null,
                fromReportStatus: null,
                toReportStatus: null,
              },
              strikeLevel: 1,
            },
          ],
        });
        await openHistory();
        expect(
          screen.getByRole("region", { name: "Auditoría reciente" }),
        ).toHaveTextContent("Strike aplicado");
        expect(section()).toHaveTextContent("Restricción finalizada");
      });
      it("si no se puede consultar el estado de strike NO se interpreta como «sin strike» ni se ofrece aplicar", async () => {
        strikeSetup({ ...closedCase(), strikeUnavailable: true });
        await openHistory();
        expect(screen.getByRole("alert")).toHaveTextContent("No se pudo consultar");
        expect(screen.queryByRole("button", { name: /Aplicar Strike/ })).toBeNull();
        expect(screen.queryByRole("button", { name: "Revocar strike" })).toBeNull();
      });
      it("tras aplicar, el detalle anterior no queda visible mientras llega el nuevo (sin «Aplicar» obsoleto)", async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const { state } = strikeSetup(closedCase(eligible(1)), (_m, st) => {
          st.item = closedCase(existingBlock());
          return applied(1);
        });
        await openHistory();
        const base = vi.mocked(fetch).getMockImplementation()!;
        let armed = false;
        vi.mocked(fetch).mockImplementation(async (input, init) => {
          if (armed && String(input).includes("cycleId=")) await gate;
          return base(input, init);
        });
        fireEvent.click(screen.getByRole("button", { name: "Aplicar Strike 1" }));
        fireEvent.change(reasonBox(), { target: { value: "Motivo" } });
        armed = true;
        submitForm();
        await waitFor(() =>
          expect(showActionSuccess).toHaveBeenCalledWith("Strike aplicado."),
        );
        expect(await screen.findByText("Cargando caso…")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Aplicar Strike 1" })).toBeNull();
        release();
        expect(await screen.findByText("Strike 1")).toBeInTheDocument();
        expect(state.item.strike?.existing).not.toBeNull();
        expect(screen.queryByRole("button", { name: /Aplicar Strike/ })).toBeNull();
      });
      it("cambiar entre Activos e Historial no arrastra acciones de strike a la cola activa", async () => {
        strikeSetup(closedCase(eligible(1)), undefined, { activeToo: true });
        renderPage();
        fireEvent.click(await screen.findByRole("button", { name: /Contenido 1/ }));
        await screen.findByRole("region", { name: "Detalles del reporte" });
        expect(screen.queryByRole("button", { name: /Aplicar Strike/ })).toBeNull();
      });
    });
  });

  describe("revoke", () => {
    const revocable = () => closedCase(existingBlock({ canRevoke: true }));
    const revokedOk = () =>
      ok({
        strike: {
          id: STRIKE_ID,
          level: 1,
          revoked: true,
          revokedAt: "2026-10-05T00:00:00+00:00",
        },
      }) as Response;
    it("the button exists ONLY when the server says canRevoke (never inferred from the role)", async () => {
      strikeSetup(closedCase(existingBlock({ canRevoke: false })));
      await openHistory();
      expect(screen.queryByRole("button", { name: "Revocar strike" })).toBeNull();
    });
    it("dialog explains the scope, requires a reason, sends only strikeId + reason, refreshes from the server", async () => {
      const { mutations, state } = strikeSetup(revocable(), (_m, st) => {
        st.item = closedCase(
          existingBlock({
            revoked: true,
            sanctionInEffect: false,
            revokedAt: "2026-10-05T00:00:00Z",
            revocationReason: "Error mío",
            canRevoke: false,
          }),
        );
        return revokedOk();
      });
      await openHistory();
      fireEvent.click(screen.getByRole("button", { name: "Revocar strike" }));
      const dialog = screen.getByRole("dialog");
      expect(dialog.tagName).toBe("DIALOG");
      expect(dialog).toHaveTextContent(
        "quita este strike del cálculo de futuros strikes",
      );
      expect(dialog).toHaveTextContent(
        "No restaura automáticamente una publicación retirada",
      );
      expect(dialog).toHaveTextContent("ni revierte la decisión de moderación");
      submitForm();
      expect(await screen.findByText("Escribe el motivo.")).toBeInTheDocument();
      expect(mutations).toHaveLength(0);
      fireEvent.change(reasonBox(), { target: { value: "Error mío" } });
      submitForm();
      await screen.findByText("Strike revocado");
      expect(mutations).toEqual([
        { kind: "revoke", body: { strikeId: STRIKE_ID, reason: "Error mío" } },
      ]);
      expect(section()).toHaveTextContent("Motivo de la revocación: Error mío");
      expect(state.item.strike?.existing?.revoked).toBe(true);
      expect(screen.queryByRole("button", { name: "Revocar strike" })).toBeNull();
    });
    it("single-flight; 1001 code points rejected", async () => {
      let release: ((r: Response) => void) | undefined;
      const { mutations } = strikeSetup(
        revocable(),
        () => new Promise<Response>((r) => (release = r)),
      );
      await openHistory();
      fireEvent.click(screen.getByRole("button", { name: "Revocar strike" }));
      fireEvent.change(reasonBox(), { target: { value: "😀".repeat(1001) } });
      submitForm();
      expect(await screen.findByText(/no puede superar 1000/)).toBeInTheDocument();
      expect(mutations).toHaveLength(0);
      fireEvent.change(reasonBox(), { target: { value: "ok" } });
      submitForm();
      submitForm();
      expect(await screen.findByRole("status")).toHaveTextContent("Revocando…");
      expect(mutations).toHaveLength(1);
      await act(async () => release?.(failure(500) as Response));
    });
    it("MFA preserves the draft; NO automatic replay", async () => {
      const { mutations } = strikeSetup(
        revocable(),
        () => failure(403, { code: "step_up_required" }) as Response,
      );
      await openHistory();
      fireEvent.click(screen.getByRole("button", { name: "Revocar strike" }));
      fireEvent.change(reasonBox(), { target: { value: "Motivo de revocación" } });
      submitForm();
      expect(await screen.findByTestId("location")).toHaveTextContent("/admin/mfa");
      fireEvent.click(screen.getByRole("button", { name: "MFA success" }));
      expect(await screen.findByRole("textbox", { name: /Motivo/ })).toHaveValue(
        "Motivo de revocación",
      );
      expect(screen.getByRole("dialog")).toHaveTextContent("Revocar Strike 1");
      expect(screen.getByRole("status")).toHaveTextContent(
        "No se ha repetido la acción.",
      );
      expect(mutations).toHaveLength(1);
    });
    it.each([
      ["strike_already_revoked", 409],
      ["self_revoke_forbidden", 403],
      ["revoker_role_insufficient", 403],
      ["strike_not_found", 404],
    ])(
      "%s refreshes the case without retry or raw backend text",
      async (code, status) => {
        const { mutations, calls } = strikeSetup(revocable(), (_m, st) => {
          st.item = closedCase(existingBlock({ canRevoke: false }));
          return failure(status, { error: "boom internals", code }) as Response;
        });
        await openHistory();
        const before = calls.filter((u) => u.includes("cycleId=")).length;
        fireEvent.click(screen.getByRole("button", { name: "Revocar strike" }));
        fireEvent.change(reasonBox(), { target: { value: "motivo" } });
        submitForm();
        expect(
          await screen.findByText(/El estado de moderación de este caso cambió/),
        ).toBeInTheDocument();
        expect(mutations).toHaveLength(1);
        await waitFor(() =>
          expect(calls.filter((u) => u.includes("cycleId=")).length).toBeGreaterThan(
            before,
          ),
        );
        expect(screen.queryByRole("button", { name: "Revocar strike" })).toBeNull();
        expect(document.body.textContent).not.toContain("boom internals");
      },
    );
  });

  describe("coexistence and regressions", () => {
    it("the Procede resolution message stays separate from the strike reason", async () => {
      strikeSetup(closedCase(existingBlock({ reason: "Motivo del strike" })));
      await openHistory();
      expect(screen.getByText("Resolución del moderador")).toBeInTheDocument();
      expect(section()).not.toHaveTextContent("Resolución del moderador");
      expect(section()).toHaveTextContent("Motivo del strike");
    });
    it("a purged case (post: null) still shows the strike controls", async () => {
      const item = { ...closedCase(eligible(1)), post: null };
      strikeSetup(item);
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: "Historial" }));
      fireEvent.click(
        await screen.findByRole("button", { name: /Publicación no disponible/ }),
      );
      await screen.findByRole("region", { name: "Detalles del reporte" });
      expect(section()).toHaveTextContent("Próximo strike: Strike 1");
    });
    it("Procede decision still never applies a strike and says so", async () => {
      const item = makeCase();
      strikeSetup(item, undefined, { activeToo: true });
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: /Contenido 1/ }));
      fireEvent.click(await screen.findByRole("button", { name: "Procede" }));
      expect(screen.getByRole("dialog")).toHaveTextContent(
        "Esta decisión no aplica un strike",
      );
    });
    it("layout safety: the section and dialogs wrap long text and never force horizontal scroll", async () => {
      strikeSetup(
        closedCase(existingBlock({ reason: "x".repeat(1000), canRevoke: true })),
      );
      await openHistory();
      const reason = within(section()).getByText(/x{40}/);
      expect(reason.className).toContain("break-words");
      expect(section().className).toContain("min-w-0");
      fireEvent.click(screen.getByRole("button", { name: "Revocar strike" }));
      expect(screen.getByRole("dialog").className).toMatch(/max-w-lg/);
      expect(screen.getByRole("dialog").className).toMatch(/w-\[calc\(100%-2rem\)\]/);
    });
    it("accessibility: dialog has an accessible name, the textarea a label and a visible counter", async () => {
      strikeSetup(closedCase(eligible(1)));
      await openHistory();
      fireEvent.click(screen.getByRole("button", { name: "Aplicar Strike 1" }));
      const dialog = screen.getByRole("dialog", { name: "Confirmar Strike 1" });
      expect(dialog).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: /Motivo del strike/ })).toBeRequired();
      expect(screen.getByText("0/1000 caracteres")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Cancelar" })).toHaveFocus();
    });
  });
});

// ---------------------------------------------------------------------------------------------
// R5-G: filtros, paginación hacia delante/atrás y continuidad de la cola.
// El servidor falso modela la API real: recibe scope/cursor/filtros y responde por página.
// ---------------------------------------------------------------------------------------------
describe("R5-G filtros, paginación y continuidad de la cola", () => {
  const cur = (n: number) =>
    btoa(`2026-10-0${n}T00:00:00Z|${testId(3, n)}`)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  const PAGES: Record<string, { ids: number[]; next: number | null }> = {
    "": { ids: [1, 2], next: 1 },
    [cur(1)]: { ids: [3, 4], next: 2 },
    [cur(2)]: { ids: [5], next: null },
  };
  type Params = URLSearchParams;
  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  };
  /** Servidor falso de la cola. `respond` puede devolver una promesa para controlar el orden. */
  function queueServer(
    respond: (p: Params) => unknown | Promise<unknown> = (p) => {
      const page = PAGES[p.get("cursor") ?? ""];
      return page
        ? ok({
            cases: page.ids.map((n) => makeCase(n)),
            nextCursor: page.next ? cur(page.next) : null,
          })
        : failure(400, { error: "Solicitud inválida" });
    },
  ) {
    signedIn();
    const queueCalls: Params[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/admin/access"))
          return access("moderator", ["moderation"], true);
        if (url.includes("summary=pending"))
          return ok({ pending: 3 }) as unknown as Response;
        if (url.includes("moderation-cases")) {
          const params = new URL(url, "https://local.invalid").searchParams;
          if (params.get("summary")) return ok({ pending: 3 }) as unknown as Response;
          const cycle = params.get("cycleId");
          if (cycle) {
            const n = [1, 2, 3, 4, 5].find((k) => testId(3, k) === cycle) ?? 1;
            return ok({ item: makeCase(n) });
          }
          queueCalls.push(params);
          return respond(params);
        }
        return failure(404);
      }),
    );
    return { queueCalls };
  }
  const filterBox = () => screen.getByRole("search", { name: "Filtros de la cola" });
  const reasonSelect = () => within(filterBox()).getByLabelText("Motivo del reporte");
  const authorInput = () => within(filterBox()).getByLabelText("Autor (usuario)");
  const fromInput = () => within(filterBox()).getByLabelText("Desde");
  const toInput = () => within(filterBox()).getByLabelText("Hasta");
  const hiddenBox = () =>
    within(filterBox()).getByRole("checkbox", { name: "Solo ocultas preventivamente" });
  const clearButton = () =>
    within(filterBox()).getByRole("button", { name: "Limpiar filtros" });
  const last = (calls: URLSearchParams[]) => calls[calls.length - 1]!;
  const click = (name: string | RegExp) =>
    fireEvent.click(screen.getByRole("button", { name }));
  const loaded = async () => {
    renderPage();
    await screen.findByText("Contenido 1");
  };

  describe("filtros", () => {
    it("motivo, ocultas y fechas se piden al servidor (filtrado real, no sobre la página)", async () => {
      const { queueCalls } = queueServer();
      await loaded();
      expect([...last(queueCalls).keys()]).toEqual(["scope"]);
      fireEvent.change(reasonSelect(), { target: { value: "harassment" } });
      await waitFor(() => expect(last(queueCalls).get("reason")).toBe("harassment"));
      fireEvent.click(hiddenBox());
      await waitFor(() => expect(last(queueCalls).get("hiddenOnly")).toBe("1"));
      fireEvent.change(fromInput(), { target: { value: "2026-09-01" } });
      fireEvent.change(toInput(), { target: { value: "2026-09-30" } });
      await waitFor(() => expect(last(queueCalls).get("to")).toBe("2026-09-30"));
      // Combinados en UNA misma petición (AND en el servidor).
      expect(Object.fromEntries(last(queueCalls))).toEqual({
        scope: "active",
        reason: "harassment",
        hiddenOnly: "1",
        from: "2026-09-01",
        to: "2026-09-30",
      });
    });

    it("autor: escribir rápido hace UNA sola consulta (debounce) y 1 carácter no consulta", async () => {
      const { queueCalls } = queueServer();
      await loaded();
      const before = queueCalls.length;
      fireEvent.change(authorInput(), { target: { value: "a" } });
      expect(
        await screen.findByText("Escribe al menos 2 caracteres (letras, números o _)."),
      ).toBeInTheDocument();
      fireEvent.change(authorInput(), { target: { value: "al" } });
      fireEvent.change(authorInput(), { target: { value: "ali" } });
      fireEvent.change(authorInput(), { target: { value: "@alice" } });
      expect(queueCalls.length).toBe(before); // nada se pidió mientras se escribía
      await waitFor(() => expect(last(queueCalls).get("author")).toBe("alice"), {
        timeout: 3000,
      });
      expect(queueCalls.filter((p) => p.has("author"))).toHaveLength(1);
    });

    it("un autor con símbolos no se envía nunca", async () => {
      const { queueCalls } = queueServer();
      await loaded();
      fireEvent.change(authorInput(), { target: { value: "a%; drop" } });
      await new Promise((r) => setTimeout(r, 600));
      expect(queueCalls.some((p) => p.has("author"))).toBe(false);
    });

    it("rango invertido: aviso y ninguna consulta (no se envía un rango imposible)", async () => {
      const { queueCalls } = queueServer();
      await loaded();
      fireEvent.change(fromInput(), { target: { value: "2026-10-05" } });
      await waitFor(() => expect(last(queueCalls).get("from")).toBe("2026-10-05"));
      const before = queueCalls.length;
      fireEvent.change(toInput(), { target: { value: "2026-10-01" } });
      expect(
        await screen.findByText("La fecha inicial no puede ser posterior a la final."),
      ).toBeInTheDocument();
      await new Promise((r) => setTimeout(r, 100));
      expect(queueCalls.length).toBe(before);
    });

    it("estado vacío con filtros y «Limpiar filtros» restablece todo", async () => {
      const { queueCalls } = queueServer((p) =>
        ok({
          cases: p.has("reason") ? [] : [makeCase(1)],
          nextCursor: null,
        }),
      );
      await loaded();
      expect(clearButton()).toBeDisabled();
      fireEvent.change(reasonSelect(), { target: { value: "other" } });
      expect(
        await screen.findByText("Ningún caso coincide con los filtros."),
      ).toBeInTheDocument();
      expect(screen.queryByText("No hay casos activos por ahora.")).toBeNull();
      fireEvent.change(authorInput(), { target: { value: "bo" } });
      fireEvent.click(clearButton());
      await screen.findByText("Contenido 1");
      expect(last(queueCalls).has("reason")).toBe(false);
      expect(reasonSelect()).toHaveValue("");
      expect(authorInput()).toHaveValue("");
      expect(hiddenBox()).not.toBeChecked();
      expect(clearButton()).toBeDisabled();
    });

    it("sin filtros, la cola vacía conserva el mensaje original", async () => {
      queueServer(() => ok({ cases: [], nextCursor: null }));
      renderPage();
      expect(
        await screen.findByText("No hay casos activos por ahora."),
      ).toBeInTheDocument();
    });

    it("los filtros se conservan al cambiar entre Activos e Historial y se envían en ambos", async () => {
      const { queueCalls } = queueServer();
      await loaded();
      fireEvent.change(reasonSelect(), { target: { value: "spam" } });
      await waitFor(() => expect(last(queueCalls).get("reason")).toBe("spam"));
      click("Historial");
      await waitFor(() => expect(last(queueCalls).get("scope")).toBe("closed"));
      expect(last(queueCalls).get("reason")).toBe("spam");
      expect(reasonSelect()).toHaveValue("spam");
    });

    it("controles accesibles: etiquetas, región de búsqueda y áreas táctiles de 44 px", async () => {
      queueServer();
      await loaded();
      for (const control of [reasonSelect(), authorInput(), fromInput(), toInput()])
        expect(control.className).toContain("min-h-11");
      expect(clearButton().className).toContain("min-h-11");
    });

    it("los textos de los filtros siguen el idioma activo", async () => {
      window.localStorage.setItem("upmina:locale", "en");
      queueServer();
      renderPage();
      await screen.findByText("Contenido 1");
      expect(
        await screen.findByRole("search", { name: "Queue filters" }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Report reason")).toBeInTheDocument();
    });
  });

  describe("paginación por cursor", () => {
    it("siguiente → anterior vuelve por el mismo rastro de cursores, sin duplicados ni saltos", async () => {
      const { queueCalls } = queueServer();
      await loaded();
      expect(screen.queryByRole("button", { name: "Página anterior" })).toBeNull();
      click("Siguiente página");
      await screen.findByText("Contenido 3");
      expect(last(queueCalls).get("cursor")).toBe(cur(1));
      click("Siguiente página");
      await screen.findByText("Contenido 5");
      expect(last(queueCalls).get("cursor")).toBe(cur(2));
      expect(screen.queryByRole("button", { name: "Siguiente página" })).toBeNull();
      click("Página anterior");
      await screen.findByText("Contenido 3");
      expect(last(queueCalls).get("cursor")).toBe(cur(1));
      expect(screen.queryByText("Contenido 5")).toBeNull();
      click("Página anterior");
      await screen.findByText("Contenido 1");
      expect(last(queueCalls).has("cursor")).toBe(false);
      expect(screen.queryByRole("button", { name: "Página anterior" })).toBeNull();
      // Cada página mostró sus casos exactamente una vez.
      expect(
        screen.getAllByRole("button", { name: /^Contenido|Publicación|Oculta/ }).length,
      ).toBeGreaterThan(0);
    });

    it("«Volver al inicio» salta a la primera página y borra el rastro", async () => {
      const { queueCalls } = queueServer();
      await loaded();
      click("Siguiente página");
      await screen.findByText("Contenido 3");
      click("Siguiente página");
      await screen.findByText("Contenido 5");
      click("Volver al inicio");
      await screen.findByText("Contenido 1");
      expect(last(queueCalls).has("cursor")).toBe(false);
      expect(screen.queryByRole("button", { name: "Página anterior" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Volver al inicio" })).toBeNull();
    });

    it("cambiar filtros reinicia el cursor y el rastro", async () => {
      const { queueCalls } = queueServer();
      await loaded();
      click("Siguiente página");
      await screen.findByText("Contenido 3");
      fireEvent.change(reasonSelect(), { target: { value: "spam" } });
      await waitFor(() => expect(last(queueCalls).get("reason")).toBe("spam"));
      expect(last(queueCalls).has("cursor")).toBe(false);
      await screen.findByText("Contenido 1");
      expect(screen.queryByRole("button", { name: "Página anterior" })).toBeNull();
    });

    it("cambiar de vista reinicia el cursor y el rastro", async () => {
      const { queueCalls } = queueServer();
      await loaded();
      click("Siguiente página");
      await screen.findByText("Contenido 3");
      click("Historial");
      await waitFor(() => expect(last(queueCalls).get("scope")).toBe("closed"));
      expect(last(queueCalls).has("cursor")).toBe(false);
      await screen.findByText("Contenido 1");
      expect(screen.queryByRole("button", { name: "Página anterior" })).toBeNull();
    });

    it("cursor inválido o caducado (400): mensaje claro y «Volver al inicio» recupera la cola", async () => {
      let broken = false;
      const { queueCalls } = queueServer((p) => {
        if (broken && p.has("cursor"))
          return failure(400, { error: "Solicitud inválida" });
        const page = PAGES[p.get("cursor") ?? ""]!;
        return ok({
          cases: page.ids.map((n) => makeCase(n)),
          nextCursor: page.next ? cur(page.next) : null,
        });
      });
      await loaded();
      broken = true;
      click("Siguiente página");
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Esta página ya no es válida");
      expect(alert.textContent).not.toMatch(/Solicitud inválida|400/);
      broken = false;
      fireEvent.click(within(alert).getByRole("button", { name: "Volver al inicio" }));
      await screen.findByText("Contenido 1");
      expect(last(queueCalls).has("cursor")).toBe(false);
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  describe("continuidad de la interfaz", () => {
    it("durante una actualización la cola NO se sustituye por «Cargando casos…»", async () => {
      const gate = deferred<unknown>();
      let calls = 0;
      queueServer(() => {
        calls++;
        return calls === 1
          ? ok({ cases: [makeCase(1), makeCase(2)], nextCursor: null })
          : gate.promise;
      });
      await loaded();
      click("Actualizar contexto");
      expect(await screen.findByText("Actualizando…")).toHaveAttribute("role", "status");
      expect(screen.getByText("Contenido 1")).toBeInTheDocument();
      expect(screen.getByText("Contenido 2")).toBeInTheDocument();
      expect(screen.queryByText("Cargando casos…")).toBeNull();
      await act(async () =>
        gate.resolve(ok({ cases: [makeCase(1), makeCase(2)], nextCursor: null })),
      );
      await waitFor(() => expect(screen.queryByText("Actualizando…")).toBeNull());
      expect(screen.getByText("Contenido 1")).toBeInTheDocument();
    });

    it("al cambiar filtros los resultados anteriores siguen visibles hasta que llega la respuesta", async () => {
      const gate = deferred<unknown>();
      queueServer((p) =>
        p.has("reason")
          ? gate.promise
          : ok({ cases: [makeCase(1), makeCase(2)], nextCursor: null }),
      );
      await loaded();
      fireEvent.change(reasonSelect(), { target: { value: "spam" } });
      expect(await screen.findByText("Actualizando…")).toBeInTheDocument();
      expect(screen.getByText("Contenido 2")).toBeInTheDocument();
      await act(async () => gate.resolve(ok({ cases: [makeCase(2)], nextCursor: null })));
      await waitFor(() => expect(screen.queryByText("Contenido 1")).toBeNull());
      expect(screen.getByText("Contenido 2")).toBeInTheDocument();
    });

    it("una respuesta antigua llegada tarde NUNCA pisa la de los filtros actuales", async () => {
      const slow = deferred<unknown>();
      const { queueCalls } = queueServer((p) => {
        if (p.get("reason") === "spam") return slow.promise; // A: lenta
        if (p.get("reason") === "other")
          return ok({ cases: [makeCase(2)], nextCursor: null }); // B
        return ok({ cases: [makeCase(1)], nextCursor: null });
      });
      await loaded();
      fireEvent.change(reasonSelect(), { target: { value: "spam" } });
      await waitFor(() => expect(last(queueCalls).get("reason")).toBe("spam"));
      fireEvent.change(reasonSelect(), { target: { value: "other" } });
      await screen.findByText("Contenido 2");
      await act(async () => slow.resolve(ok({ cases: [makeCase(3)], nextCursor: null })));
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.getByText("Contenido 2")).toBeInTheDocument();
      expect(screen.queryByText("Contenido 3")).toBeNull();
      expect(screen.queryByText("Actualizando…")).toBeNull();
    });

    it("una respuesta antigua con ERROR tampoco afecta a la vista actual", async () => {
      const slow = deferred<unknown>();
      const { queueCalls } = queueServer((p) => {
        if (p.get("reason") === "spam") return slow.promise;
        return ok({ cases: [makeCase(p.get("reason") ? 2 : 1)], nextCursor: null });
      });
      await loaded();
      fireEvent.change(reasonSelect(), { target: { value: "spam" } });
      await waitFor(() => expect(last(queueCalls).get("reason")).toBe("spam"));
      fireEvent.change(reasonSelect(), { target: { value: "other" } });
      await screen.findByText("Contenido 2");
      await act(async () => slow.resolve(failure(500)));
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByText("Contenido 2")).toBeInTheDocument();
    });

    it("el caso expandido se conserva tras actualizar mientras siga en la cola", async () => {
      queueServer((p) =>
        ok({
          cases: [makeCase(1), makeCase(2)],
          nextCursor: p.has("cursor") ? null : null,
        }),
      );
      await loaded();
      fireEvent.click(card(2));
      const panel = await screen.findByRole("region", { name: "Detalles del reporte" });
      expect(panel).toHaveTextContent("Caso " + testId(1, 2));
      click("Actualizar contexto");
      await waitFor(() =>
        expect(
          screen.getByRole("region", { name: "Detalles del reporte" }),
        ).toHaveTextContent("Caso " + testId(1, 2)),
      );
      expect(card(2)).toHaveAttribute("aria-expanded", "true");
    });

    it("el caso expandido se conserva al aplicar un filtro que lo sigue incluyendo", async () => {
      queueServer(() => ok({ cases: [makeCase(1), makeCase(2)], nextCursor: null }));
      await loaded();
      fireEvent.click(card(2));
      await screen.findByRole("region", { name: "Detalles del reporte" });
      fireEvent.change(reasonSelect(), { target: { value: "spam" } });
      await waitFor(() => expect(screen.queryByText("Actualizando…")).toBeNull());
      expect(card(2)).toHaveAttribute("aria-expanded", "true");
      expect(
        screen.getByRole("region", { name: "Detalles del reporte" }),
      ).toBeInTheDocument();
    });

    it("si el caso expandido ya no está en la nueva vista, el panel se cierra sin quedar huérfano", async () => {
      queueServer((p) =>
        ok({
          cases: p.has("reason") ? [makeCase(1)] : [makeCase(1), makeCase(2)],
          nextCursor: null,
        }),
      );
      await loaded();
      fireEvent.click(card(2));
      await screen.findByRole("region", { name: "Detalles del reporte" });
      fireEvent.change(reasonSelect(), { target: { value: "spam" } });
      await waitFor(() => expect(screen.queryByText("Contenido 2")).toBeNull());
      expect(screen.queryByRole("region", { name: "Detalles del reporte" })).toBeNull();
    });

    it("error al ACTUALIZAR la misma vista: se conservan los resultados y se avisa con reintento", async () => {
      let calls = 0;
      queueServer(() => {
        calls++;
        return calls === 2
          ? failure(500)
          : ok({ cases: [makeCase(1)], nextCursor: null });
      });
      await loaded();
      click("Actualizar contexto");
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("No se pudo actualizar la cola");
      expect(screen.getByText("Contenido 1")).toBeInTheDocument();
      fireEvent.click(within(alert).getByRole("button", { name: "Reintentar" }));
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      expect(screen.getByText("Contenido 1")).toBeInTheDocument();
    });

    it("error al cambiar de filtros: NO se muestran resultados de otra consulta como si fueran actuales", async () => {
      queueServer((p) =>
        p.has("reason") ? failure(500) : ok({ cases: [makeCase(1)], nextCursor: null }),
      );
      await loaded();
      fireEvent.change(reasonSelect(), { target: { value: "spam" } });
      expect(
        await screen.findByText(/No se pudieron cargar los casos/),
      ).toBeInTheDocument();
      expect(screen.queryByText("Contenido 1")).toBeNull();
    });

    it("error de red en la carga inicial sigue mostrando el error con reintento", async () => {
      signedIn();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("/api/admin/access"))
            return access("moderator", ["moderation"], true);
          if (url.includes("summary=pending"))
            return ok({ pending: 3 }) as unknown as Response;
          throw new TypeError("network down");
        }),
      );
      renderPage();
      expect(
        await screen.findByText(/No se pudieron cargar los casos/),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument();
    });

    it("tras una decisión la cola se refresca sin vaciarse y sin repetir la mutación", async () => {
      const gate = deferred<unknown>();
      const writes: unknown[] = [];
      let queueReads = 0;
      signedIn();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.includes("/api/admin/access"))
            return access("moderator", ["moderation"], true);
          if (url.includes("moderation-decision") || init?.method === "POST") {
            writes.push(url);
            return ok({ ok: true });
          }
          if (url.includes("summary=pending"))
            return ok({ pending: 3 }) as unknown as Response;
          if (url.includes("moderation-cases")) {
            const params = new URL(url, "https://local.invalid").searchParams;
            if (params.get("cycleId")) return ok({ item: makeCase(1) });
            queueReads++;
            return queueReads === 1
              ? ok({ cases: [makeCase(1), makeCase(2)], nextCursor: null })
              : gate.promise;
          }
          return failure(404);
        }),
      );
      await loaded();
      // Actualización manual: mientras llega la respuesta, la cola sigue a la vista.
      click("Actualizar contexto");
      expect(await screen.findByText("Actualizando…")).toBeInTheDocument();
      expect(screen.getByText("Contenido 2")).toBeInTheDocument();
      expect(writes).toHaveLength(0);
      await act(async () => gate.resolve(ok({ cases: [makeCase(2)], nextCursor: null })));
      await waitFor(() => expect(screen.queryByText("Contenido 1")).toBeNull());
      expect(writes).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// R5-H: contador de pendientes y resiliencia multimedia en el detalle de moderación.
// ---------------------------------------------------------------------------------------------
describe("R5-H contador de pendientes", () => {
  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  };
  function counterServer(
    summary: () => unknown | Promise<unknown>,
    items: ModerationCaseItem[] = [makeCase(1), makeCase(2)],
  ) {
    const setup = setupCases({ items });
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (!String(input).includes("summary=pending")) return base(input, init);
      setup.calls.push(String(input));
      return (await summary()) as Response;
    });
    return setup;
  }
  const summaryCalls = (calls: string[]) =>
    calls.filter((u) => u.includes("summary=pending")).length;
  const counter = () => screen.getByRole("group", { name: "Casos pendientes" });

  it.each([
    [0, "Sin casos pendientes"],
    [1, "1 caso pendiente"],
    [7, "7 casos pendientes"],
  ])("muestra %i pendientes como «%s»", async (n, text) => {
    counterServer(() => ok({ pending: n }));
    renderPage();
    await screen.findByText("Contenido 1");
    await waitFor(() => expect(counter()).toHaveTextContent(text));
  });

  it("es el total del servidor, no el tamaño de la página visible (más de una página)", async () => {
    counterServer(() => ok({ pending: 45 }));
    renderPage();
    await screen.findByText("Contenido 1");
    await waitFor(() => expect(counter()).toHaveTextContent("45 casos pendientes"));
    // La cola mostrada tiene 2 casos y un cursor de siguiente página: el contador no se deriva de ahí.
    expect(screen.getByRole("button", { name: "Siguiente página" })).toBeInTheDocument();
  });

  it("no cambia al paginar ni al filtrar (es un total global, no de la vista)", async () => {
    const { calls } = counterServer(() => ok({ pending: 45 }));
    renderPage();
    await screen.findByText("Contenido 1");
    await waitFor(() => expect(counter()).toHaveTextContent("45"));
    const before = summaryCalls(calls);
    fireEvent.click(screen.getByRole("button", { name: "Siguiente página" }));
    fireEvent.change(screen.getByLabelText("Motivo del reporte"), {
      target: { value: "spam" },
    });
    await waitFor(() => expect(calls.some((u) => u.includes("reason=spam"))).toBe(true));
    expect(summaryCalls(calls)).toBe(before);
    expect(counter()).toHaveTextContent("45 casos pendientes");
  });

  it("distingue carga, valor y error (nunca confunde un fallo con cero)", async () => {
    const gate = deferred<unknown>();
    counterServer(() => gate.promise);
    renderPage();
    await screen.findByText("Contenido 1");
    expect(counter()).toHaveTextContent("Contando casos pendientes…");
    expect(counter()).not.toHaveTextContent("Sin casos pendientes");
    await act(async () => gate.resolve(failure(500)));
    expect(await within(counter()).findByRole("alert")).toHaveTextContent(
      "No se pudo contar los casos pendientes.",
    );
    expect(counter()).not.toHaveTextContent("Sin casos pendientes");
  });

  it("error → Reintentar vuelve a consultar y muestra el valor", async () => {
    let n = 0;
    const { calls } = counterServer(() =>
      ++n === 1 ? failure(500) : ok({ pending: 2 }),
    );
    renderPage();
    await screen.findByText("Contenido 1");
    fireEvent.click(await within(counter()).findByRole("button", { name: "Reintentar" }));
    await waitFor(() => expect(counter()).toHaveTextContent("2 casos pendientes"));
    expect(summaryCalls(calls)).toBe(2);
    expect(within(counter()).queryByRole("alert")).toBeNull();
  });

  it("una respuesta inválida del servidor se trata como error, no como cero", async () => {
    counterServer(() => ok({ pending: "3" }));
    renderPage();
    await screen.findByText("Contenido 1");
    expect(await within(counter()).findByRole("alert")).toBeInTheDocument();
  });

  it("«Actualizar contexto» vuelve a consultar el total, conservando el valor anterior mientras tanto", async () => {
    let value = 3;
    const gate = deferred<unknown>();
    let slow = false;
    const { calls } = counterServer(() => (slow ? gate.promise : ok({ pending: value })));
    renderPage();
    await screen.findByText("Contenido 1");
    await waitFor(() => expect(counter()).toHaveTextContent("3 casos pendientes"));
    slow = true;
    fireEvent.click(screen.getByRole("button", { name: "Actualizar contexto" }));
    await waitFor(() => expect(summaryCalls(calls)).toBe(2));
    expect(counter()).toHaveTextContent("3 casos pendientes"); // sin parpadeo a «Contando…»
    value = 2;
    await act(async () => gate.resolve(ok({ pending: value })));
    await waitFor(() => expect(counter()).toHaveTextContent("2 casos pendientes"));
  });

  it("no hace polling: sin interacción no hay consultas adicionales", async () => {
    const { calls } = counterServer(() => ok({ pending: 1 }));
    renderPage();
    await screen.findByText("Contenido 1");
    await waitFor(() => expect(counter()).toHaveTextContent("1 caso pendiente"));
    await new Promise((r) => setTimeout(r, 400));
    expect(summaryCalls(calls)).toBe(1);
  });

  it("tras una decisión de moderación el contador se actualiza", async () => {
    const setup = (() => {
      const first = setupCases({ items: [makeCase()] });
      return first;
    })();
    const base = vi.mocked(fetch).getMockImplementation()!;
    let decided = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("moderation-case-decision")) {
        decided = true;
        return ok({
          decisionId: testId(5, 1),
          caseId: testId(1, 1),
          cycleId: testId(3, 1),
          postId: testId(2, 1),
          decision: "reports_not_valid",
          caseVersion: 5,
          postStatus: "published",
          postVersion: 6,
          visibilityChanged: true,
          createdAt: "2026-10-03T00:00:00Z",
        }) as unknown as Response;
      }
      if (url.includes("summary=pending")) {
        setup.calls.push(url);
        return ok({ pending: decided ? 0 : 1 }) as unknown as Response;
      }
      if (decided && url.includes("moderation-cases") && !url.includes("cycleId="))
        return ok({ cases: [], nextCursor: null }) as unknown as Response;
      return base(input, init);
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Contenido 1/ }));
    await waitFor(() => expect(counter()).toHaveTextContent("1 caso pendiente"));
    fireEvent.click(await screen.findByRole("button", { name: "No procede" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar decisión" }));
    await waitFor(() => expect(counter()).toHaveTextContent("Sin casos pendientes"));
    expect(setup.calls.filter((u) => u.includes("summary=pending")).length).toBe(2);
  });

  it("sin la capacidad de moderación no se pide ni se muestra ningún contador", async () => {
    signedIn();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        if (String(input).includes("/api/admin/access")) return access("user", [], true);
        return ok({ pending: 99 });
      }),
    );
    renderPage();
    await waitFor(() =>
      expect(calls.some((u) => u.includes("/api/admin/access"))).toBe(true),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.some((u) => u.includes("moderation-cases"))).toBe(false);
    expect(document.body.textContent).not.toContain("99");
    expect(screen.queryByRole("group", { name: "Casos pendientes" })).toBeNull();
  });

  it("con MFA no reciente no se consulta el contador", async () => {
    signedIn();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return String(input).includes("/api/admin/access")
          ? access("moderator", ["moderation"], false)
          : ok({ pending: 5 });
      }),
    );
    renderPage();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.some((u) => u.includes("moderation-cases"))).toBe(false);
  });

  it("un 403 del contador se gestiona como error de acceso (no muestra datos)", async () => {
    counterServer(() => failure(403, { error: "Acceso no autorizado" }));
    renderPage();
    await screen.findByText("Contenido 1");
    await waitFor(() => expect(screen.queryByText(/\d+ casos? pendientes?/)).toBeNull());
  });

  it("los textos siguen el idioma activo (en/de)", async () => {
    window.localStorage.setItem("upmina:locale", "en");
    counterServer(() => ok({ pending: 1 }));
    const view = renderPage();
    await screen.findByText("Contenido 1");
    await waitFor(() =>
      expect(screen.getByRole("group", { name: "Pending cases" })).toHaveTextContent(
        "1 pending case",
      ),
    );
    view.unmount();
    cleanup();
    window.localStorage.setItem("upmina:locale", "de");
    counterServer(() => ok({ pending: 2 }));
    renderPage();
    await screen.findByText("Contenido 1");
    await waitFor(() =>
      expect(screen.getByRole("group", { name: "Offene Fälle" })).toHaveTextContent(
        "2 offene Fälle",
      ),
    );
  });
});

describe("R5-H multimedia en el detalle de moderación", () => {
  const SECRET_URL =
    "https://signed.example.test/private/archivo-secreto.jpg?token=SECRETO123";
  const media = (n: number, kind: "image" | "video", url = SECRET_URL) => ({
    id: testId(6, n),
    position: n - 1,
    kind,
    url: kind === "video" ? url.replace(".jpg", ".mp4") : url,
    width: 640,
    height: 480,
    durationSeconds: kind === "video" ? 3 : null,
  });
  const withMedia = (
    n: number,
    items: ReturnType<typeof media>[],
  ): ModerationCaseItem => ({
    ...makeCase(n),
    media: items,
  });
  async function openMedia(items: ReturnType<typeof media>[]) {
    setupCases({ items: [withMedia(1, items)] });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Contenido 1/ }));
    await screen.findByRole("region", {
      name: /Detalles del reporte|Report details|Details der Meldung/,
    });
  }
  const img = (label: RegExp | string) => screen.getByAltText(label);

  it("imagen correcta: estado de carga y luego contenido con alt accesible y numeración", async () => {
    await openMedia([media(1, "image"), media(2, "image")]);
    const first = img("Imagen de la publicación (1 de 2)");
    expect(first).toHaveAttribute("src", SECRET_URL);
    expect(screen.getAllByText("Cargando contenido…")).toHaveLength(2);
    fireEvent.load(first);
    expect(screen.getAllByText("Cargando contenido…")).toHaveLength(1);
    expect(img("Imagen de la publicación (2 de 2)")).toBeInTheDocument();
  });

  it("imagen rota: placeholder accesible sin imagen rota, sin URL ni nombre de archivo", async () => {
    await openMedia([media(1, "image")]);
    fireEvent.error(img("Imagen de la publicación (1 de 1)"));
    const box = screen.getByRole("group", { name: "Imagen de la publicación (1 de 1)" });
    expect(within(box).getByRole("alert")).toHaveTextContent(
      "No se pudo cargar esta imagen.",
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(box.textContent).not.toMatch(/archivo-secreto|SECRETO123|signed\.example/);
    expect(box.querySelector("a")).toBeNull();
    expect(document.querySelector('a[href*="signed.example"]')).toBeNull();
  });

  it("reintento de imagen: vuelve a cargar y, si funciona, queda lista", async () => {
    await openMedia([media(1, "image")]);
    fireEvent.error(img(/Imagen de la publicación/));
    fireEvent.click(screen.getByRole("button", { name: "Reintentar carga" }));
    const again = img("Imagen de la publicación (1 de 1)");
    expect(screen.getByText("Cargando contenido…")).toBeInTheDocument();
    fireEvent.load(again);
    expect(screen.queryByText("Cargando contenido…")).toBeNull();
    expect(screen.queryByRole("alert", { name: /imagen/ })).toBeNull();
  });

  it("si el reintento vuelve a fallar se vuelve a mostrar el error (sin bucles)", async () => {
    await openMedia([media(1, "image")]);
    fireEvent.error(img(/Imagen/));
    fireEvent.click(screen.getByRole("button", { name: "Reintentar carga" }));
    fireEvent.error(img(/Imagen/));
    expect(screen.getByRole("button", { name: "Reintentar carga" })).toBeInTheDocument();
    expect(screen.getByText(/actualiza el caso/)).toBeInTheDocument();
  });

  it("vídeo correcto: fallback visual hasta los metadatos, controles y preload conservados", async () => {
    await openMedia([media(1, "video")]);
    const video = document.querySelector("video")!;
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("preload", "metadata");
    expect(video).not.toHaveAttribute("poster"); // el contrato no entrega poster
    expect(video).toHaveAttribute("aria-label", "Vídeo de la publicación (1 de 1)");
    expect(screen.getByText("Vídeo sin vista previa")).toBeInTheDocument();
    fireEvent.loadedMetadata(video);
    expect(screen.queryByText("Vídeo sin vista previa")).toBeNull();
    expect(document.querySelector("video")).toBe(video);
  });

  it("vídeo roto: error accesible con reintento y el resto del caso sigue disponible", async () => {
    await openMedia([media(1, "video"), media(2, "image")]);
    fireEvent.error(document.querySelector("video")!);
    const box = screen.getByRole("group", { name: "Vídeo de la publicación (1 de 2)" });
    expect(within(box).getByRole("alert")).toHaveTextContent(
      "No se pudo cargar este vídeo.",
    );
    expect(box.textContent).not.toMatch(/archivo-secreto|SECRETO123/);
    // La otra imagen, el texto, los reportes y la auditoría siguen ahí.
    expect(img("Imagen de la publicación (2 de 2)")).toBeInTheDocument();
    expect(screen.getByText("Reportes del ciclo")).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Auditoría reciente" }),
    ).toBeInTheDocument();
    fireEvent.click(within(box).getByRole("button", { name: "Reintentar carga" }));
    expect(document.querySelector("video")).not.toBeNull();
    expect(screen.getByText("Vídeo sin vista previa")).toBeInTheDocument();
  });

  it("un medio roto no bloquea las acciones de moderación del caso", async () => {
    await openMedia([media(1, "image")]);
    fireEvent.error(img(/Imagen/));
    expect(screen.getByRole("button", { name: "No procede" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Procede" })).toBeEnabled();
  });

  it("accesibilidad: el botón de reintento tiene área táctil de 44 px y es alcanzable por teclado", async () => {
    await openMedia([media(1, "image")]);
    fireEvent.error(img(/Imagen/));
    const retry = screen.getByRole("button", { name: "Reintentar carga" });
    expect(retry.className).toContain("min-h-11");
    retry.focus();
    expect(retry).toHaveFocus();
  });

  it("no escribe URLs ni tokens en la consola al fallar", async () => {
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    await openMedia([media(1, "image"), media(2, "video")]);
    fireEvent.error(img(/Imagen/));
    fireEvent.error(document.querySelector("video")!);
    for (const spy of spies)
      expect(JSON.stringify(spy.mock.calls)).not.toMatch(/SECRETO123|signed\.example/);
    spies.forEach((s) => s.mockRestore());
  });

  it("cambios rápidos entre casos: el estado de error de un caso no se arrastra al siguiente", async () => {
    setupCases({
      items: [
        withMedia(1, [media(1, "image")]),
        withMedia(2, [{ ...media(2, "image"), id: testId(6, 9) }]),
      ],
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Contenido 1/ }));
    await screen.findByRole("region", { name: "Detalles del reporte" });
    fireEvent.error(img(/Imagen/));
    expect(screen.getByRole("button", { name: "Reintentar carga" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Contenido 2/ }));
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Detalles del reporte" }),
      ).toHaveTextContent("Caso " + testId(1, 2)),
    );
    expect(screen.queryByRole("button", { name: "Reintentar carga" })).toBeNull();
    expect(img("Imagen de la publicación (1 de 1)")).toBeInTheDocument();
  });

  it("los textos de error siguen el idioma activo", async () => {
    window.localStorage.setItem("upmina:locale", "en");
    await openMedia([media(1, "image")]);
    fireEvent.error(await screen.findByAltText("Post image (1 of 1)"));
    expect(screen.getByRole("alert", { name: "" })).toBeDefined();
    expect(screen.getByText("This image could not be loaded.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry loading" })).toBeInTheDocument();
  });
});

// R5-I: validación integrada — filtros + paginación + contador + detalle + auditoría traducida +
// estado de strike no disponible + medio roto, en un mismo recorrido del Historial.
describe("R5-I integración del panel", () => {
  const cur = btoa(`2026-10-01T00:00:00Z|${testId(3, 1)}`)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  const closedItem = (n: number): ModerationCaseItem => ({
    ...makeCase(n),
    caseStatus: "closed",
    cycleStatus: "closed",
    closureKind: "decision",
    closedAt: "2026-10-02T00:00:00Z",
    decision: {
      decisionId: testId(5, n),
      result: "content_actioned",
      resolutionMessage: "Mensaje",
      createdAt: "2026-10-02T00:00:00Z",
    },
    strikeUnavailable: true,
    media: [
      {
        id: testId(6, n),
        position: 0,
        kind: "image",
        url: "https://signed.example.test/p/secreto.jpg?token=T0KEN",
        width: 640,
        height: 480,
        durationSeconds: null,
      },
    ],
    audit: [
      {
        id: testId(7, n),
        action: "content_actioned",
        actorKind: "human",
        createdAt: "2026-10-02T00:00:00Z",
        states: {
          fromPostStatus: "hidden_pending_review",
          toPostStatus: "removed_pending_purge",
          fromReportStatus: null,
          toReportStatus: null,
        },
        strikeLevel: null,
      },
    ],
  });

  it("recorrido completo del Historial: todo convive sin pisarse", async () => {
    signedIn();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/api/admin/access"))
          return access("moderator", ["moderation"], true);
        const p = new URL(url, "https://local.invalid").searchParams;
        if (p.get("summary")) return ok({ pending: 4 });
        if (p.get("cycleId"))
          return ok({
            item: closedItem([1, 2, 3].find((k) => testId(3, k) === p.get("cycleId"))!),
          });
        if (p.get("cursor")) return ok({ cases: [closedItem(3)], nextCursor: null });
        return ok({ cases: [closedItem(1), closedItem(2)], nextCursor: cur });
      }),
    );
    renderPage();
    const pending = () => screen.getByRole("group", { name: "Casos pendientes" });
    await waitFor(() => expect(pending()).toHaveTextContent("4 casos pendientes"));
    fireEvent.click(screen.getByRole("button", { name: "Historial" }));
    await screen.findByText("Contenido 1");
    // Filtro + siguiente + anterior; el contador no se mueve ni se vuelve a pedir.
    fireEvent.change(screen.getByLabelText("Motivo del reporte"), {
      target: { value: "spam" },
    });
    await waitFor(() => expect(calls.at(-1)).toContain("reason=spam"));
    fireEvent.click(await screen.findByRole("button", { name: "Siguiente página" }));
    await screen.findByText("Contenido 3");
    fireEvent.click(screen.getByRole("button", { name: "Página anterior" }));
    await screen.findByText("Contenido 1");
    expect(calls.filter((u) => u.includes("summary=pending"))).toHaveLength(1);
    // Detalle: auditoría traducida + fallo de strike + medio roto, sin bloquear la revisión.
    fireEvent.click(card(1));
    const detail = await screen.findByRole("region", { name: "Detalles del reporte" });
    expect(
      await within(detail).findByRole("region", { name: "Auditoría reciente" }),
    ).toHaveTextContent("Retirada por moderación");
    expect(
      within(detail).getByRole("region", { name: "Sanción al autor" }),
    ).toHaveTextContent("No se pudo consultar el estado de la sanción");
    fireEvent.error(within(detail).getByAltText("Imagen de la publicación (1 de 1)"));
    const box = within(detail).getByRole("group", {
      name: "Imagen de la publicación (1 de 1)",
    });
    expect(box.textContent).not.toMatch(/secreto|T0KEN|signed\.example/);
    expect(within(detail).getByText("Reportes del ciclo")).toBeInTheDocument();
    // «Actualizar contexto» conserva el caso expandido, el filtro y el contador.
    fireEvent.click(screen.getByRole("button", { name: "Actualizar contexto" }));
    await waitFor(() =>
      expect(calls.filter((u) => u.includes("summary=pending"))).toHaveLength(2),
    );
    await waitFor(() => expect(screen.queryByText("Actualizando…")).toBeNull());
    expect(card(1)).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Motivo del reporte")).toHaveValue("spam");
    expect(pending()).toHaveTextContent("4 casos pendientes");
    // Teclado: los controles clave son alcanzables y operables.
    card(2).focus();
    expect(card(2)).toHaveFocus();
  });
});
