import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SocialConnectionsSection, {
  SocialConnectionCard,
} from "./SocialConnectionsSection";

// Sección "Redes sociales" de /admin (Bloque 8E). El backend (ADMIN+AAL2) decide todo lo
// privilegiado; aquí se fija cómo la UI pinta el estado que recibe, cómo inicia la conexión
// (solo POST /api/admin/social-connect con { provider }) y que nunca inventa un estado, una
// URL de autorización ni un secreto.

const TOKEN = "jwt-sintetico-de-prueba";
const IG_URL =
  "https://www.instagram.com/oauth/authorize?client_id=1&state=st-sintetico&redirect_uri=x";
const TT_URL =
  "https://www.tiktok.com/v2/auth/authorize/?client_key=k&state=st-sintetico";

const auth = vi.hoisted(() => ({ session: null as null | { access_token: string } }));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: auth.session } }),
    },
  },
}));

type Status = "connected" | "not_connected" | "reauth_required";
const fetchMock = vi.fn();

function httpResponse(status: number, body: unknown = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function statusBody(instagram: Status, tiktok: Status) {
  return {
    connections: { instagram: { status: instagram }, tiktok: { status: tiktok } },
  };
}

/** Enruta por URL: el estado inicial y (opcional) la respuesta del inicio de conexión. */
function route(opts: {
  instagram?: Status;
  tiktok?: Status;
  status?: () => unknown;
  connect?: (body: string) => unknown;
}) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/admin/social-status") {
      return opts.status
        ? opts.status()
        : httpResponse(
            200,
            statusBody(opts.instagram ?? "not_connected", opts.tiktok ?? "not_connected"),
          );
    }
    if (url === "/api/admin/social-connect") {
      const result = opts.connect?.(String(init?.body));
      if (result instanceof Error) throw result;
      return result ?? httpResponse(200, { authorization_url: IG_URL });
    }
    throw new Error(`fetch inesperado a ${url}`);
  });
}

const connectCalls = () =>
  fetchMock.mock.calls.filter((c) => c[0] === "/api/admin/social-connect");

async function renderReady(opts: Parameters<typeof route>[0] = {}) {
  route(opts);
  const navigate = vi.fn();
  render(<SocialConnectionsSection navigate={navigate} />);
  await screen.findByRole("heading", { name: "Instagram" });
  return navigate;
}

beforeEach(() => {
  auth.session = { access_token: TOKEN };
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SocialConnectionCard (los tres estados, con independencia de lo que produzca el backend)", () => {
  const renderCard = (status: Status) =>
    render(
      <ul>
        <SocialConnectionCard
          name="Instagram"
          status={status}
          pending={false}
          disabled={false}
          error={null}
          onConnect={() => {}}
        />
      </ul>,
    );

  it("CONNECTED → 'Conectado', sin Conectar ni Reconectar", () => {
    renderCard("connected");
    expect(screen.getByText("Conectado")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/Reconectar|Conectar/)).toBeNull();
  });

  it("NOT_CONNECTED → 'No conectado' y 'Conectar Instagram'", () => {
    renderCard("not_connected");
    expect(screen.getByText("No conectado")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Conectar Instagram" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Reconectar/)).toBeNull();
  });

  it("REAUTH_REQUIRED → 'Requiere autorización' y 'Reconectar Instagram'", () => {
    renderCard("reauth_required");
    expect(screen.getByText("Requiere autorización")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reconectar Instagram" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Conectar/ })).toBeNull();
  });

  it("el estado siempre se comunica con texto (no solo con el punto de color)", () => {
    for (const [status, label] of [
      ["connected", "Conectado"],
      ["not_connected", "No conectado"],
      ["reauth_required", "Requiere autorización"],
    ] as const) {
      cleanup();
      const { container } = renderCard(status);
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    }
  });
});

describe("carga del estado", () => {
  it("muestra 'Cargando conexiones…' y luego las dos tarjetas", async () => {
    route({ instagram: "connected", tiktok: "not_connected" });
    render(<SocialConnectionsSection navigate={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Cargando conexiones…");
    await screen.findByRole("heading", { name: "Instagram" });
    expect(screen.getByRole("heading", { name: "TikTok" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Redes sociales" })).toBeInTheDocument();
    expect(screen.queryByText("Cargando conexiones…")).toBeNull();
  });

  it("consulta GET /api/admin/social-status con el Bearer de la sesión existente, una sola vez", async () => {
    await renderReady();
    const status = fetchMock.mock.calls.filter(
      (c) => c[0] === "/api/admin/social-status",
    );
    expect(status).toHaveLength(1);
    expect(status[0][1]).toEqual({ headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["connected", "not_connected"],
    ["not_connected", "connected"],
    ["connected", "connected"],
    ["not_connected", "not_connected"],
    ["reauth_required", "connected"],
    ["connected", "reauth_required"],
  ] as [Status, Status][])(
    "Instagram=%s / TikTok=%s → cada tarjeta muestra su estado",
    async (ig, tt) => {
      await renderReady({ instagram: ig, tiktok: tt });
      const labels: Record<Status, string> = {
        connected: "Conectado",
        not_connected: "No conectado",
        reauth_required: "Requiere autorización",
      };
      const items = screen.getAllByRole("listitem");
      expect(items).toHaveLength(2);
      expect(items[0]).toHaveTextContent(labels[ig]);
      expect(items[1]).toHaveTextContent(labels[tt]);
      // Con un estado conectado no hay botón en esa tarjeta.
      expect(items[0].querySelector("button") === null).toBe(ig === "connected");
      expect(items[1].querySelector("button") === null).toBe(tt === "connected");
    },
  );

  it("recarga al restaurar la página desde el historial (pageshow persistido), sin polling", async () => {
    await renderReady({ instagram: "not_connected" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    route({ instagram: "connected", tiktok: "connected" });
    await act(async () => {
      const event = new Event("pageshow") as PageTransitionEvent;
      Object.defineProperty(event, "persisted", { value: true });
      window.dispatchEvent(event);
    });
    await waitFor(() => expect(screen.getAllByText("Conectado")).toHaveLength(2));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Un pageshow normal (no persistido) no vuelve a consultar.
    await act(async () => {
      window.dispatchEvent(new Event("pageshow"));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe("errores de carga: NUNCA se presentan como 'No conectado'", () => {
    const notConnectedFalsely = () => {
      expect(screen.queryByText("No conectado")).toBeNull();
      expect(screen.queryByRole("button", { name: /Conectar/ })).toBeNull();
    };

    it("401 → mensaje de sesión", async () => {
      route({ status: () => httpResponse(401, { error: "No autenticado" }) });
      render(<SocialConnectionsSection navigate={vi.fn()} />);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Tu sesión ya no es válida",
      );
      notConnectedFalsely();
    });

    it("403 (p. ej. sesión AAL1) → mensaje de verificación en dos pasos, no 'No conectado'", async () => {
      route({ status: () => httpResponse(403, { error: "No autorizado" }) });
      render(<SocialConnectionsSection navigate={vi.fn()} />);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "verificación en dos pasos",
      );
      notConnectedFalsely();
    });

    it.each([500, 503])("%i → error genérico con Reintentar", async (status) => {
      route({ status: () => httpResponse(status, { error: "Error interno" }) });
      render(<SocialConnectionsSection navigate={vi.fn()} />);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "No se pudo cargar el estado de las conexiones.",
      );
      expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument();
      notConnectedFalsely();
    });

    it("fallo de red → error genérico", async () => {
      route({
        status: () => {
          throw new Error("ECONNRESET interno");
        },
      });
      render(<SocialConnectionsSection navigate={vi.fn()} />);
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("No se pudo cargar el estado de las conexiones.");
      expect(alert.textContent).not.toContain("ECONNRESET");
      notConnectedFalsely();
    });

    it("200 con forma inesperada → error, nunca un estado inventado", async () => {
      for (const body of [
        null,
        {},
        { connections: {} },
        statusBody("connected", "raro" as Status),
      ]) {
        cleanup();
        route({ status: () => httpResponse(200, body) });
        render(<SocialConnectionsSection navigate={vi.fn()} />);
        expect(await screen.findByRole("alert")).toBeInTheDocument();
        notConnectedFalsely();
      }
    });

    it("sin sesión de Supabase → mensaje de sesión y ninguna petición", async () => {
      auth.session = null;
      route({});
      render(<SocialConnectionsSection navigate={vi.fn()} />);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Tu sesión ya no es válida",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("Reintentar vuelve a consultar y muestra el estado real", async () => {
      route({ status: () => httpResponse(500) });
      render(<SocialConnectionsSection navigate={vi.fn()} />);
      fireEvent.click(await screen.findByRole("button", { name: "Reintentar" }));
      route({ instagram: "connected", tiktok: "connected" });
      await waitFor(() => expect(screen.getAllByText("Conectado")).toHaveLength(2));
    });
  });
});

describe("conectar", () => {
  it("Instagram: POST /api/admin/social-connect con body EXACTO { provider }, Bearer y JSON; luego navega", async () => {
    const navigate = await renderReady({
      instagram: "not_connected",
      tiktok: "connected",
      connect: () => httpResponse(200, { authorization_url: IG_URL }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Conectar Instagram" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));

    expect(connectCalls()).toHaveLength(1);
    const [url, init] = connectCalls()[0];
    expect(url).toBe("/api/admin/social-connect");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body)).toEqual({ provider: "instagram" });
    expect(Object.keys(JSON.parse(init.body))).toEqual(["provider"]);
    expect(navigate).toHaveBeenCalledWith(IG_URL);
  });

  it("TikTok: body { provider: 'tiktok' } y navega a la URL de TikTok", async () => {
    const navigate = await renderReady({
      instagram: "connected",
      tiktok: "not_connected",
      connect: () => httpResponse(200, { authorization_url: TT_URL }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Conectar TikTok" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(TT_URL));
    expect(JSON.parse(connectCalls()[0][1].body)).toEqual({ provider: "tiktok" });
  });

  it("Reconectar (reauth_required) usa exactamente el mismo endpoint y body", async () => {
    const navigate = await renderReady({
      instagram: "reauth_required",
      tiktok: "connected",
      connect: () => httpResponse(200, { authorization_url: IG_URL }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Reconectar Instagram" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(JSON.parse(connectCalls()[0][1].body)).toEqual({ provider: "instagram" });
  });

  it("mientras se inicia: el botón muestra 'Conectando…', queda deshabilitado y el otro también", async () => {
    let release!: (r: unknown) => void;
    const navigate = await renderReady({
      instagram: "not_connected",
      tiktok: "not_connected",
      connect: () => new Promise((resolve) => (release = resolve)) as never,
    });
    // Un test con promesa pendiente: sustituye el mock de connect por una promesa manual.
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/admin/social-connect") {
        return new Promise((resolve) => (release = resolve));
      }
      return httpResponse(200, statusBody("not_connected", "not_connected"));
    });
    fireEvent.click(screen.getByRole("button", { name: "Conectar Instagram" }));

    const busy = await screen.findByRole("button", { name: "Conectando Instagram…" });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Conectar TikTok" })).toBeDisabled();

    await act(async () => release(httpResponse(200, { authorization_url: IG_URL })));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    // Tras navegar, sigue bloqueado (la página está saliendo hacia el proveedor).
    expect(screen.getByRole("button", { name: "Conectando Instagram…" })).toBeDisabled();
  });

  it("doble click (síncrono) → UN solo inicio", async () => {
    const navigate = await renderReady({
      instagram: "not_connected",
      connect: () => httpResponse(200, { authorization_url: IG_URL }),
    });
    const button = screen.getByRole("button", { name: "Conectar Instagram" });
    const other = screen.getByRole("button", { name: "Conectar TikTok" });
    // Todos los clicks dentro de UN mismo act: React aún no ha re-renderizado (el botón sigue
    // habilitado), así que solo el guard síncrono puede impedir un segundo inicio.
    act(() => {
      button.click();
      button.click();
      other.click();
    });
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(connectCalls()).toHaveLength(1);
  });

  describe("errores del inicio: mensaje humano, sin detalles, y se puede reintentar", () => {
    it.each([
      [400, "No pudimos iniciar la conexión"],
      [401, "Tu sesión ya no es válida"],
      [403, "verificación en dos pasos"],
      [500, "No pudimos iniciar la conexión"],
      [503, "No pudimos iniciar la conexión"],
    ])("%i → alerta, sin navegar, botón habilitado de nuevo", async (status, text) => {
      const navigate = await renderReady({
        instagram: "not_connected",
        connect: () => httpResponse(status, { error: "detalle interno secreto" }),
      });
      fireEvent.click(screen.getByRole("button", { name: "Conectar Instagram" }));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(text);
      expect(alert.textContent).not.toContain("detalle interno secreto");
      expect(navigate).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Conectar Instagram" })).toBeEnabled(),
      );
    });

    describe.each([
      ["Instagram", "instagram"],
      ["TikTok", "tiktok"],
    ] as const)("%s: 403 según el cuerpo", (name, provider) => {
      const click = async (connect: () => unknown) => {
        const navigate = await renderReady({ [provider]: "not_connected", connect });
        fireEvent.click(screen.getByRole("button", { name: `Conectar ${name}` }));
        return { navigate, alert: await screen.findByRole("alert") };
      };

      it("403 'No disponible en este entorno' → mensaje de entorno, no de MFA, sin navegar", async () => {
        const { navigate, alert } = await click(() =>
          httpResponse(403, { error: "No disponible en este entorno" }),
        );
        expect(alert).toHaveTextContent(
          "Esta conexión solo está disponible en el entorno de producción.",
        );
        expect(alert.textContent).not.toContain("dos pasos");
        expect(navigate).not.toHaveBeenCalled();
      });

      it("403 step_up_required → sigue el camino de autorización (mensaje de verificación), sin reproducir", async () => {
        const { navigate, alert } = await click(() =>
          httpResponse(403, { error: "No autorizado", code: "step_up_required" }),
        );
        expect(alert).toHaveTextContent("verificación en dos pasos");
        expect(alert.textContent).not.toContain("entorno de producción");
        expect(navigate).not.toHaveBeenCalled();
        expect(connectCalls()).toHaveLength(1);
      });

      it("403 genérico (o con el texto de entorno pero code de step-up) → NO usa el mensaje de entorno", async () => {
        for (const body of [
          { error: "No autorizado" },
          { error: "No disponible en este entorno", code: "step_up_required" },
        ]) {
          cleanup();
          fetchMock.mockReset();
          const { alert } = await click(() => httpResponse(403, body));
          expect(alert).toHaveTextContent("verificación en dos pasos");
          expect(alert.textContent).not.toContain("entorno de producción");
        }
      });
    });

    it("fallo de red → alerta genérica sin filtrar el mensaje", async () => {
      const navigate = await renderReady({
        instagram: "not_connected",
        connect: () => new Error("ECONNRESET con datos internos"),
      });
      fireEvent.click(screen.getByRole("button", { name: "Conectar Instagram" }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("No pudimos iniciar la conexión");
      expect(alert.textContent).not.toContain("ECONNRESET");
      expect(navigate).not.toHaveBeenCalled();
    });

    it("tras un error se puede reintentar y el segundo intento navega", async () => {
      let attempt = 0;
      const navigate = await renderReady({
        instagram: "not_connected",
        connect: () =>
          ++attempt === 1
            ? httpResponse(500)
            : httpResponse(200, { authorization_url: IG_URL }),
      });
      fireEvent.click(screen.getByRole("button", { name: "Conectar Instagram" }));
      await screen.findByRole("alert");
      fireEvent.click(await screen.findByRole("button", { name: "Conectar Instagram" }));
      await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("sin sesión al pulsar → mensaje de sesión y ninguna petición de inicio", async () => {
      const navigate = await renderReady({ instagram: "not_connected" });
      auth.session = null;
      fireEvent.click(screen.getByRole("button", { name: "Conectar Instagram" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Tu sesión ya no es válida",
      );
      expect(connectCalls()).toHaveLength(0);
      expect(navigate).not.toHaveBeenCalled();
    });
  });

  describe("authorization_url inválida: no navega", () => {
    const bad: [string, unknown][] = [
      ["ausente", undefined],
      ["no string", 42],
      ["vacía", ""],
      ["no es una URL", "esto-no-es-una-url"],
      ["http en vez de https", "http://www.instagram.com/oauth/authorize"],
      ["javascript:", "javascript:alert(1)"],
      ["host ajeno", "https://evil.example/oauth/authorize"],
      ["host parecido", "https://www.instagram.com.evil.example/oauth/authorize"],
      ["credenciales embebidas", "https://www.instagram.com@evil.example/x"],
      ["URL de TikTok para Instagram", TT_URL],
    ];

    it.each(bad)("%s", async (_name, value) => {
      const navigate = await renderReady({
        instagram: "not_connected",
        connect: () => httpResponse(200, { authorization_url: value }),
      });
      fireEvent.click(screen.getByRole("button", { name: "Conectar Instagram" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "No pudimos iniciar la conexión",
      );
      expect(navigate).not.toHaveBeenCalled();
      // El mensaje nunca incluye la URL recibida.
      expect(document.body.textContent).not.toContain("evil.example");
    });

    it("un 200 sin JSON tampoco navega", async () => {
      const navigate = await renderReady({
        instagram: "not_connected",
        connect: () => ({
          ok: true,
          status: 200,
          json: async () => Promise.reject(new Error("x")),
        }),
      });
      fireEvent.click(screen.getByRole("button", { name: "Conectar Instagram" }));
      await screen.findByRole("alert");
      expect(navigate).not.toHaveBeenCalled();
    });
  });
});

describe("rutas, secretos y no-bypass", () => {
  it("solo llama a /api/admin/social-status y /api/admin/social-connect (ninguna ruta legacy)", async () => {
    await renderReady({ instagram: "not_connected", tiktok: "not_connected" });
    fireEvent.click(screen.getByRole("button", { name: "Conectar TikTok" }));
    await waitFor(() => expect(connectCalls()).toHaveLength(1));
    const urls = new Set(fetchMock.mock.calls.map((c) => c[0]));
    expect([...urls].sort()).toEqual([
      "/api/admin/social-connect",
      "/api/admin/social-status",
    ]);
  });

  it("no renderiza tokens, ni campos ajenos que el servidor pudiera enviar por error", async () => {
    await renderReady({
      status: () =>
        httpResponse(200, {
          connections: {
            instagram: { status: "connected", access_token: "IGAA-secreto-ficticio" },
            tiktok: { status: "not_connected", refresh_token: "rft-secreto-ficticio" },
          },
          admin_user_id: "11111111-1111-4111-8111-111111111111",
        }),
    });
    const text = document.body.textContent ?? "";
    for (const secret of [
      "IGAA-secreto-ficticio",
      "rft-secreto-ficticio",
      "11111111-1111-4111-8111-111111111111",
      TOKEN,
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("la fuente del componente no genera state, no construye URLs de autorización ni envía redirect_uri/scopes", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/components/admin/SocialConnectionsSection.tsx"),
      "utf8",
    );
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(
      /instagram-auth|tiktok-auth|instagram-callback|tiktok-callback/,
    );
    expect(code).not.toMatch(/oauth\/authorize|v2\/auth\/authorize/);
    expect(code).not.toMatch(
      /redirect_uri|scope|client_id|client_key|randomBytes|crypto|nonce/i,
    );
    expect(code).not.toMatch(/localStorage|sessionStorage|dangerouslySetInnerHTML/);
    // Un único body JSON con provider; el proveedor sale de una lista cerrada.
    expect(code).toMatch(/JSON\.stringify\(\{ provider \}\)/);
  });
});
