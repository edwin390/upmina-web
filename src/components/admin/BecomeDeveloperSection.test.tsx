import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import BecomeDeveloperSection from "./BecomeDeveloperSection";
import { ADMIN_ACCESS_QUERY_ROOT } from "@/hooks/useAdminAccess";

// «Convertirme en Developer»: un Admin transfiere SU PROPIA cuenta. Solo presentación + envío de la
// decisión; el servidor decide (otro Admin elegible, recuperaciones activas, lock de roles). SINTÉTICO.

const TOKEN = "jwt-sintetico";
const auth = vi.hoisted(() => ({ session: null as null | { access_token: string } }));
const totp = vi.hoisted(() => ({ reverify: vi.fn() }));
const failure = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: auth.session } }) } },
}));
vi.mock("@/lib/totp-reverify", () => ({ reverifyTotp: totp.reverify }));
vi.mock("@/hooks/privileged-failure", () => ({
  usePrivilegedFailureReporter: () => failure.report,
}));

const fetchMock = vi.fn();
const res = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const posts = () =>
  fetchMock.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([, init]) => init);
const gets = () => fetchMock.mock.calls.filter(([, init]) => !init?.method);

function serve(
  status: unknown = { eligible: true, reason: "ok" },
  post: () => unknown = () => res(200, { status: "transferred", role: "developer" }),
) {
  fetchMock.mockImplementation(async (_u: string, init?: { method?: string }) =>
    init?.method === "POST" ? post() : res(200, status),
  );
}

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}
let queryClient: QueryClient;
function renderIt() {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/admin"]}>
        <Routes>
          <Route path="/admin" element={<BecomeDeveloperSection />} />
          <Route path="/admin/developer" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const openConfirm = async () => {
  const button = await screen.findByRole("button", { name: "Convertirme en Developer" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  return screen.getByRole("group", { name: "Confirmar el cambio a Developer" });
};
const fillAndConfirm = (code = "123456", accept = true) => {
  if (accept) fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(screen.getByLabelText("Código de tu app autenticadora"), {
    target: { value: code },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirmar y convertirme" }));
};

beforeEach(() => {
  auth.session = { access_token: TOKEN };
  totp.reverify.mockReset();
  totp.reverify.mockResolvedValue("ok");
  failure.report.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BecomeDeveloperSection — siempre visible y comprensible", () => {
  it("muestra el título y explica en lenguaje sencillo qué pasa (deja de ser Admin, herramientas técnicas, necesita a otro Admin)", async () => {
    serve();
    renderIt();
    expect(
      await screen.findByRole("heading", { name: "Convertirme en Developer" }),
    ).toBeInTheDocument();
    const section = screen.getByTestId("become-developer");
    expect(section).toHaveTextContent("dejará de ser Admin");
    expect(section).toHaveTextContent("herramientas técnicas");
    expect(section).toHaveTextContent("necesitarás que otro Admin te restaure");
    expect(section).toHaveTextContent("no se puede hacer a otra persona");
  });

  it("no ofrece elegir a otra persona ni otro rol: solo un botón para la propia cuenta", async () => {
    serve();
    renderIt();
    await screen.findByRole("button", { name: "Convertirme en Developer" });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("BecomeDeveloperSection — cuándo se puede", () => {
  it("habilitado si hay otro Admin elegible y nada lo impide", async () => {
    serve();
    renderIt();
    const button = await screen.findByRole("button", {
      name: "Convertirme en Developer",
    });
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.queryByTestId("become-developer-reason")).toBeNull();
  });

  it("deshabilitado SIN otro Admin elegible, con el motivo en lenguaje sencillo y sin términos técnicos", async () => {
    serve({ eligible: false, reason: "no_eligible_peer" });
    renderIt();
    const reason = await screen.findByTestId("become-developer-reason");
    expect(reason).toHaveTextContent("no hay otro Admin que pueda quedarse a cargo");
    expect(reason.textContent).not.toMatch(/no_eligible_peer|TOTP|RPC|lock/i);
    const button = screen.getByRole("button", { name: "Convertirme en Developer" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-describedby", reason.id);
  });

  it("deshabilitado mientras haya una recuperación de un Admin en curso", async () => {
    serve({ eligible: false, reason: "recovery_in_progress" });
    renderIt();
    expect(await screen.findByTestId("become-developer-reason")).toHaveTextContent(
      "recuperación de autenticador en curso",
    );
    expect(
      screen.getByRole("button", { name: "Convertirme en Developer" }),
    ).toBeDisabled();
  });

  it("deshabilitado mientras carga y si no se puede comprobar (con reintento)", async () => {
    fetchMock.mockImplementation(async () => res(500));
    renderIt();
    expect(
      screen.getByRole("button", { name: "Convertirme en Developer" }),
    ).toBeDisabled();
    expect(await screen.findByRole("alert")).toHaveTextContent("No pudimos comprobar");
    expect(
      screen.getByRole("button", { name: "Convertirme en Developer" }),
    ).toBeDisabled();
    serve();
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Convertirme en Developer" }),
      ).toBeEnabled(),
    );
  });

  it("una respuesta inesperada del servidor nunca habilita el botón", async () => {
    serve({ eligible: true, reason: "otro" });
    renderIt();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Convertirme en Developer" }),
    ).toBeDisabled();
  });

  it("sin sesión no consulta y queda deshabilitado", async () => {
    auth.session = null;
    renderIt();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Convertirme en Developer" }),
    ).toBeDisabled();
  });
});

describe("BecomeDeveloperSection — confirmación", () => {
  it("abrir la confirmación no envía nada; explica lo que se pierde; exige aceptar y un código de 6 dígitos", async () => {
    serve();
    renderIt();
    const group = await openConfirm();
    expect(posts()).toHaveLength(0);
    expect(group).toHaveTextContent("Vas a dejar de ser Admin ahora mismo");
    expect(group).toHaveTextContent("conexiones sociales");
    const confirm = screen.getByRole("button", { name: "Confirmar y convertirme" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Código de tu app autenticadora"), {
      target: { value: "123456" },
    });
    expect(confirm).toBeDisabled(); // falta la aceptación
    fireEvent.click(screen.getByRole("checkbox"));
    expect(confirm).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Código de tu app autenticadora"), {
      target: { value: "12" },
    });
    expect(confirm).toBeDisabled(); // código incompleto
  });

  it("el foco pasa a la aceptación al abrir y «Cancelar» cierra sin enviar", async () => {
    serve();
    renderIt();
    await openConfirm();
    expect(screen.getByRole("checkbox")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("group")).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it("al confirmar: verifica el TOTP, envía SOLO { acknowledge: true } con el Bearer, retira la caché de acceso y navega al panel Developer", async () => {
    serve();
    queryClient.setQueryData([ADMIN_ACCESS_QUERY_ROOT, "u1"], { role: "admin" });
    renderIt();
    await openConfirm();
    fillAndConfirm();
    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent("/admin/developer"),
    );
    expect(totp.reverify).toHaveBeenCalledWith("123456");
    expect(posts()).toHaveLength(1);
    expect(posts()[0].headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    expect(JSON.parse(posts()[0].body)).toEqual({ acknowledge: true });
    expect(JSON.stringify(posts())).not.toContain("123456");
    // la caché de permisos de Admin se descarta de inmediato
    expect(queryClient.getQueryData([ADMIN_ACCESS_QUERY_ROOT, "u1"])).toBeUndefined();
  });

  it("código incorrecto: se informa y NO se envía la transferencia", async () => {
    totp.reverify.mockResolvedValue("invalid_code");
    serve();
    renderIt();
    await openConfirm();
    fillAndConfirm();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Código incorrecto o expirado.",
    );
    expect(posts()).toHaveLength(0);
    expect(
      screen.getByRole("group", { name: "Confirmar el cambio a Developer" }),
    ).toBeInTheDocument();
  });

  it.each([
    ["no_eligible_peer", "no hay otro Admin que pueda quedarse a cargo"],
    ["recovery_in_progress", "recuperación de autenticador en curso"],
  ])(
    "el servidor rechaza con «%s» (cambió el estado): se cierra la confirmación y se explica el motivo",
    async (code, text) => {
      serve({ eligible: true, reason: "ok" }, () =>
        res(409, { error: "Operación no permitida", code }),
      );
      renderIt();
      await openConfirm();
      fillAndConfirm();
      expect(await screen.findByTestId("become-developer-reason")).toHaveTextContent(
        text,
      );
      expect(screen.queryByRole("group")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Convertirme en Developer" }),
      ).toBeDisabled();
      expect(screen.queryByTestId("where")).toBeNull(); // no navega
    },
  );

  it("step_up_required del servidor: pide repetir el código y no navega", async () => {
    serve({ eligible: true, reason: "ok" }, () =>
      res(403, { error: "No autorizado", code: "step_up_required" }),
    );
    renderIt();
    await openConfirm();
    fillAndConfirm();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "no es lo bastante reciente",
    );
    expect(screen.queryByTestId("where")).toBeNull();
    expect(failure.report).toHaveBeenCalledTimes(1);
  });

  it("un solo envío aunque se pulse dos veces seguidas", async () => {
    let release!: (v: unknown) => void;
    serve(
      { eligible: true, reason: "ok" },
      () => new Promise((r) => (release = r)) as never,
    );
    renderIt();
    await openConfirm();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText("Código de tu app autenticadora"), {
      target: { value: "123456" },
    });
    const confirm = screen.getByRole("button", { name: "Confirmar y convertirme" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(posts()).toHaveLength(1));
    release(res(200, { status: "transferred", role: "developer" }));
    await waitFor(() => expect(screen.getByTestId("where")).toBeInTheDocument());
    expect(posts()).toHaveLength(1);
    expect(totp.reverify).toHaveBeenCalledTimes(1);
  });

  it("consulta el estado una sola vez al montar", async () => {
    serve();
    renderIt();
    await screen.findByRole("button", { name: "Convertirme en Developer" });
    expect(gets()).toHaveLength(1);
    expect(gets()[0][0]).toBe("/api/admin/team-developer-transfer");
  });
});
