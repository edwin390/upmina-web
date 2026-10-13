import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ForgotPasswordPage from "./ForgotPasswordPage";
import SignupPage from "./SignupPage";

// /forgot-password con la COMPROBACIÓN DEL CORREO activada (VITE_PASSWORD_RECOVERY_LOOKUP=1). Se ejecutan los
// componentes reales; el endpoint propio (fetch) y supabase.auth son dobles. No se envía ningún correo.

const authState = vi.hoisted(() => ({
  session: null as null | { user: { id: string }; access_token: string },
  loading: false,
  refreshSession: vi.fn(),
}));
const sb = vi.hoisted(() => ({ reset: vi.fn(), resend: vi.fn(), signUp: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      resetPasswordForEmail: sb.reset,
      resend: sb.resend,
      signUp: sb.signUp,
    },
  },
}));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => authState }));

const reply = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});
const fetchMock = vi.fn();

function Where() {
  const l = useLocation();
  return (
    <p data-testid="where">
      {l.pathname}|{l.search}|{l.hash}
    </p>
  );
}
function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/forgot-password"]}>
      <Routes>
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route
          path="/signup"
          element={
            <>
              <Where />
              <SignupPage />
            </>
          }
        />
        <Route path="/login" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}
const submit = (email: string) => {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: "Enviar enlace" }));
};
const outcome = (status: number, body: unknown) =>
  fetchMock.mockResolvedValueOnce(reply(status, body));
const noSignupLink = () =>
  expect(document.querySelector('a[href^="/signup"]')).toBeNull();

beforeEach(() => {
  vi.stubEnv("VITE_PASSWORD_RECOVERY_LOOKUP", "1");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  for (const fn of Object.values(sb)) fn.mockReset();
  sb.resend.mockResolvedValue({ data: {}, error: null });
  authState.session = null;
  authState.loading = false;
  authState.refreshSession.mockReset();
  localStorage.clear();
  localStorage.setItem("upmina:locale", "es");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("/forgot-password con comprobación del correo", () => {
  it("correo registrado y confirmado: el servidor solo comprueba y el NAVEGADOR envía la recuperación oficial; confirmación, aviso de Spam y cooldown", async () => {
    sb.reset.mockResolvedValue({ data: {}, error: null });
    outcome(200, { status: "confirmed" });
    renderPage();
    submit("  persona@example.test ");
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/Te enviamos un enlace para restablecer/);
    expect(status).not.toHaveTextContent(/Si existe/);
    expect(status).toHaveTextContent(/Spam o Correo no deseado/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/profile?action=password-recovery");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("omit");
    expect(JSON.parse(init.body)).toEqual({ email: "persona@example.test" });
    // el envío sale del navegador (la IP de cada persona cuenta en los límites por IP de Auth), con la redirección propia
    expect(sb.reset).toHaveBeenCalledTimes(1);
    expect(sb.reset).toHaveBeenCalledWith("persona@example.test", {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    expect(
      screen.getByRole("button", { name: /Podrás pedir otro enlace en 60 s/ }),
    ).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
    noSignupLink();
  });

  it("confirmado pero Supabase Auth limita el envío → aviso y cuenta atrás de 60 s; si falla por otra causa → error (no neutro, no «Crear cuenta»)", async () => {
    for (const error of [
      { status: 429, code: "over_email_send_rate_limit" },
      { code: "over_request_rate_limit" },
      { status: 429 },
    ]) {
      cleanup();
      sb.reset.mockResolvedValue({ data: null, error });
      outcome(200, { status: "confirmed" });
      renderPage();
      submit("persona@example.test");
      expect(await screen.findByRole("alert")).toHaveTextContent(/Demasiados intentos/);
      expect(
        screen.getByRole("button", { name: /Podrás pedir otro enlace en 60 s/ }),
      ).toBeDisabled();
      noSignupLink();
    }
    for (const failure of [
      () => sb.reset.mockResolvedValue({ data: null, error: { status: 500 } }),
      () => sb.reset.mockRejectedValue(new Error("network")),
    ]) {
      cleanup();
      failure();
      outcome(200, { status: "confirmed" });
      renderPage();
      submit("persona@example.test");
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "No pudimos procesar la solicitud ahora mismo",
      );
      expect(screen.queryByRole("status")).toBeNull();
      noSignupLink();
      expect(screen.getByRole("button", { name: "Enviar enlace" })).toBeEnabled();
    }
  });

  it("solo «confirmed» dispara el envío: inexistente, sin confirmar, límite y errores NUNCA llaman a resetPasswordForEmail", async () => {
    const cases: Array<() => void> = [
      () => outcome(200, { status: "unregistered" }),
      () => outcome(200, { status: "unconfirmed" }),
      () => outcome(429, { status: "rate_limited", retryAfterSeconds: 30 }),
      () => outcome(502, { status: "error" }),
      () => outcome(200, { status: "quizas" }),
      () => fetchMock.mockRejectedValueOnce(new Error("network")),
    ];
    for (const arrange of cases) {
      cleanup();
      arrange();
      renderPage();
      submit("persona@example.test");
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      // deja que termine la respuesta y se pinte el resultado antes de comprobar
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      fetchMock.mockClear();
    }
    expect(sb.reset).not.toHaveBeenCalled();
  });

  it("el bloqueo de 60 s se mantiene y un segundo envío no llega al servidor; después se puede pedir otro", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sb.reset.mockResolvedValue({ data: {}, error: null });
    outcome(200, { status: "confirmed" });
    renderPage();
    submit("persona@example.test");
    await screen.findByRole("status");
    const form = screen.getByRole("button", { name: /en 60 s/ }).closest("form")!;
    fireEvent.submit(form);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 61; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    expect(screen.getByRole("button", { name: "Enviar enlace" })).toBeEnabled();
  });

  it("correo inexistente: error + mensaje + «Crear cuenta con [correo]» (solo aquí); sin cooldown", async () => {
    outcome(200, { status: "unregistered" });
    renderPage();
    noSignupLink(); // antes de enviar no hay enlace
    submit("nadie@example.test");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("No encontramos una cuenta con este correo");
    expect(alert).toHaveTextContent("Puedes crear una cuenta nueva con este correo");
    const link = screen.getByRole("link", {
      name: "Crear cuenta con nadie@example.test",
    });
    expect(link).toHaveAttribute("href", "/signup");
    // la URL del enlace NO lleva el correo
    expect(link.getAttribute("href")).not.toMatch(/nadie|example|\?/);
    expect(sb.reset).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Enviar enlace" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "Volver a iniciar sesión" })).toHaveAttribute(
      "href",
      "/login",
    );
  });

  it("«Crear cuenta con…» abre /signup con el correo precargado por ESTADO del router (no por la URL) y sin enviar nada", async () => {
    outcome(200, { status: "unregistered" });
    renderPage();
    submit("nadie@example.test");
    fireEvent.click(await screen.findByRole("link", { name: /Crear cuenta con nadie/ }));
    expect(await screen.findByTestId("where")).toHaveTextContent("/signup||");
    expect(await screen.findByLabelText("Email")).toHaveValue("nadie@example.test");
    expect(sb.signUp).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("al editar el correo comprobado deja de ofrecerse «Crear cuenta con…»", async () => {
    outcome(200, { status: "unregistered" });
    renderPage();
    submit("nadie@example.test");
    await screen.findByRole("alert");
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "otro@example.test" },
    });
    expect(screen.queryByRole("alert")).toBeNull();
    noSignupLink();
  });

  it("correo sin confirmar: pantalla propia («todavía no está confirmado»), sin enviar recuperación y reenvío por el flujo oficial", async () => {
    outcome(200, { status: "unconfirmed" });
    renderPage();
    submit("pendiente@example.test");
    expect(
      await screen.findByText(/pendiente@example.test todavía no está confirmado/),
    ).toBeInTheDocument();
    expect(sb.reset).not.toHaveBeenCalled();
    noSignupLink();
    const resend = screen.getByRole("button", { name: "Reenviar correo" });
    fireEvent.click(resend);
    fireEvent.click(resend); // doble clic: un único reenvío
    await waitFor(() => expect(sb.resend).toHaveBeenCalledTimes(1));
    expect(sb.resend.mock.calls[0][0]).toMatchObject({
      type: "signup",
      email: "pendiente@example.test",
    });
    expect(
      await screen.findByText(/Te enviamos el correo de confirmación otra vez/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Podrás reenviarlo en/ })).toBeDisabled();
  });

  it("correo sin confirmar: «Usar otra cuenta» vuelve al formulario", async () => {
    outcome(200, { status: "unconfirmed" });
    renderPage();
    submit("pendiente@example.test");
    fireEvent.click(await screen.findByRole("button", { name: "Usar otra cuenta" }));
    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
  });

  it("límite del servidor: aviso, bloqueo con cuenta atrás (retryAfterSeconds) y sin enlace de registro", async () => {
    outcome(429, { status: "rate_limited", retryAfterSeconds: 30 });
    renderPage();
    submit("persona@example.test");
    expect(await screen.findByRole("alert")).toHaveTextContent(/Demasiados intentos/);
    expect(
      screen.getByRole("button", { name: /Podrás pedir otro enlace en 30 s/ }),
    ).toBeDisabled();
    noSignupLink();
  });

  it.each([
    ["502 del servidor", () => outcome(502, { status: "error" })],
    ["503 del servidor", () => outcome(503, { status: "error" })],
    [
      "cuerpo no JSON",
      () =>
        fetchMock.mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => {
            throw new Error("x");
          },
        }),
    ],
    ["200 con estado desconocido", () => outcome(200, { status: "quizas" })],
    ["200 sin estado", () => outcome(200, {})],
    ["429 sin rate_limited", () => outcome(429, { status: "otra" })],
    ["red caída", () => fetchMock.mockRejectedValueOnce(new Error("network"))],
  ])(
    "error técnico (%s): mensaje de error; NUNCA «no encontramos una cuenta» ni «Crear cuenta»",
    async (_n, arrange) => {
      arrange();
      renderPage();
      submit("persona@example.test");
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("No pudimos procesar la solicitud ahora mismo");
      expect(document.body.textContent).not.toMatch(/No encontramos una cuenta/);
      noSignupLink();
      expect(screen.queryByRole("status")).toBeNull();
      // sin cooldown: se puede reintentar enseguida
      expect(screen.getByRole("button", { name: "Enviar enlace" })).toBeEnabled();
      expect(sb.reset).not.toHaveBeenCalled();
    },
  );

  it("un correo con forma inválida no llega al servidor", async () => {
    renderPage();
    for (const bad of ["", "sin-arroba", "a@b", "a b@c.d"]) {
      submit(bad);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Escribe un correo válido.",
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("un solo envío aunque se pulse dos veces seguidas", async () => {
    let release!: (v: unknown) => void;
    fetchMock.mockImplementation(() => new Promise((r) => (release = r)));
    renderPage();
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "persona@example.test" },
    });
    const form = screen.getByRole("button", { name: "Enviar enlace" }).closest("form")!;
    await act(async () => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => release(reply(200, { status: "unregistered" })));
  });

  it("EN y DE: los textos de «no encontrada» y de «Crear cuenta con…» salen de las traducciones", async () => {
    for (const [locale, title, link, send, label] of [
      [
        "en",
        "We couldn't find an account with this email",
        "Create account with a@b.co",
        "Send link",
        "Email",
      ],
      [
        "de",
        "Wir haben kein Konto mit dieser E-Mail-Adresse gefunden",
        "Konto erstellen mit a@b.co",
        "Link senden",
        "E-Mail",
      ],
    ] as const) {
      cleanup();
      localStorage.setItem("upmina:locale", locale);
      outcome(200, { status: "unregistered" });
      renderPage();
      // espera a que cargue el idioma (el rótulo «Email» también existe en ES)
      await screen.findByRole("heading", {
        name: locale === "en" ? "Reset your password" : "Passwort zurücksetzen",
      });
      fireEvent.change(await screen.findByLabelText(label), {
        target: { value: "a@b.co" },
      });
      fireEvent.click(screen.getByRole("button", { name: send }));
      expect(await screen.findByRole("alert")).toHaveTextContent(title);
      expect(screen.getByRole("link", { name: link })).toHaveAttribute("href", "/signup");
    }
  });
});

describe("con el interruptor APAGADO se conserva el flujo neutro anterior", () => {
  it("no llama al endpoint nuevo: usa resetPasswordForEmail y no muestra «Crear cuenta»", async () => {
    vi.unstubAllEnvs();
    sb.reset.mockResolvedValue({ data: {}, error: null });
    renderPage();
    submit("persona@example.test");
    expect(await screen.findByRole("status")).toHaveTextContent(/Si existe una cuenta/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sb.reset).toHaveBeenCalledTimes(1);
    noSignupLink();
  });
});
