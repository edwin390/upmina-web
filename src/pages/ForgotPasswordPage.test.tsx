import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRecoveryMark, markRecoverySession } from "@/lib/password-recovery";
import ForgotPasswordPage from "./ForgotPasswordPage";

// /forgot-password. Se ejecuta el componente real; supabase.auth es un doble. No se envía ningún correo.

const authState = vi.hoisted(() => ({
  session: null as null | { user: { id: string }; access_token: string },
  loading: false,
}));
const sb = vi.hoisted(() => ({ reset: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { resetPasswordForEmail: sb.reset } },
}));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => authState }));

const SID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_SID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const b64 = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fakeJwt = (sessionId: string) =>
  `${b64({ alg: "ES256" })}.${b64({ session_id: sessionId })}.SENTINEL-SIGNATURE`;
const sessionOf = (userId: string, sessionId: string) => ({
  user: { id: userId },
  access_token: fakeJwt(sessionId),
});

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname}</p>;
}
function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/forgot-password"]}>
      <Routes>
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/account" element={<Where />} />
        <Route path="/login" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}
const submit = (email: string) => {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: "Enviar enlace" }));
};

beforeEach(() => {
  authState.session = null;
  authState.loading = false;
  sb.reset.mockReset();
  sb.reset.mockResolvedValue({ data: {}, error: null });
  localStorage.clear();
  localStorage.setItem("upmina:locale", "es");
});
afterEach(() => {
  cleanup();
  clearRecoveryMark();
  vi.useRealTimers();
});

describe("/forgot-password", () => {
  it("un correo con forma inválida se rechaza en el cliente sin llamar a Supabase", async () => {
    renderPage();
    for (const bad of ["", "   ", "sin-arroba", "a@b", "a b@c.d"]) {
      submit(bad);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Escribe un correo válido.",
      );
    }
    expect(sb.reset).not.toHaveBeenCalled();
  });

  it("usa resetPasswordForEmail con el correo recortado y la redirección propia /reset-password; no repite el correo", async () => {
    renderPage();
    submit("  persona@example.test  ");
    await waitFor(() => expect(sb.reset).toHaveBeenCalledTimes(1));
    expect(sb.reset).toHaveBeenCalledWith("persona@example.test", {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/Si existe una cuenta con ese correo/);
    expect(document.body.textContent).not.toContain("persona@example.test");
  });

  it("SIN ENUMERACIÓN: éxito, error del proveedor (incl. su espera por usuario) y excepción dan EXACTAMENTE la misma respuesta", async () => {
    const outcomes: Array<() => Promise<unknown>> = [
      async () => ({ data: {}, error: null }),
      async () => ({
        data: null,
        error: { code: "over_email_send_rate_limit", status: 429 },
      }),
      async () => ({ data: null, error: { code: "user_not_found", status: 400 } }),
      async () => {
        throw new Error("network");
      },
    ];
    const texts: string[] = [];
    for (const outcome of outcomes) {
      cleanup();
      sb.reset.mockReset();
      sb.reset.mockImplementation(outcome);
      renderPage();
      submit("alguien@example.test");
      const status = await screen.findByRole("status");
      texts.push(status.textContent ?? "");
      expect(screen.queryByRole("alert")).toBeNull();
    }
    expect(new Set(texts).size).toBe(1);
  });

  it("tras enviar bloquea 60 s (cuenta atrás), un segundo envío no llega a Supabase y después se puede pedir otro", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPage();
    submit("alguien@example.test");
    await screen.findByRole("status");
    const button = screen.getByRole("button", {
      name: /Podrás pedir otro enlace en 60 s/,
    });
    expect(button).toBeDisabled();
    fireEvent.submit(button.closest("form")!);
    expect(sb.reset).toHaveBeenCalledTimes(1);
    const tick = async (seconds: number) => {
      for (let i = 0; i < seconds; i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
      }
    };
    await tick(30);
    expect(screen.getByRole("button", { name: /en 30 s/ })).toBeDisabled();
    await tick(31);
    expect(screen.getByRole("button", { name: "Enviar enlace" })).toBeEnabled();
  });

  it("un solo envío aunque se pulse dos veces seguidas", async () => {
    let release!: (v: unknown) => void;
    sb.reset.mockImplementation(() => new Promise((r) => (release = r)));
    renderPage();
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "alguien@example.test" },
    });
    const form = screen.getByRole("button", { name: "Enviar enlace" }).closest("form")!;
    await act(async () => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(sb.reset).toHaveBeenCalledTimes(1);
    await act(async () => release({ data: {}, error: null }));
  });

  it("quien ya tiene sesión va a /account; la sesión de recuperación sí puede pedir otro enlace", async () => {
    authState.session = sessionOf("u1", SID);
    renderPage();
    expect(await screen.findByTestId("where")).toHaveTextContent("/account");
    cleanup();
    // sesión de recuperación REAL (marca atada a su session_id): puede pedir otro enlace
    markRecoverySession(sessionOf("u1", SID));
    renderPage();
    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
    cleanup();
    // una marca antigua NO vale para una sesión ordinaria posterior (otro session_id) ni de otra cuenta
    authState.session = sessionOf("u1", OTHER_SID);
    renderPage();
    expect(await screen.findByTestId("where")).toHaveTextContent("/account");
    cleanup();
    markRecoverySession(sessionOf("u1", SID));
    authState.session = sessionOf("u2", SID);
    renderPage();
    expect(await screen.findByTestId("where")).toHaveTextContent("/account");
  });

  it("los textos salen del sistema de traducciones (EN) y no hay cadenas fijas en español", async () => {
    localStorage.setItem("upmina:locale", "en");
    renderPage();
    expect(
      await screen.findByRole("heading", { name: "Reset your password" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send link" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute(
      "href",
      "/login",
    );
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "alguien@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send link" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      /If an account exists for that email/,
    );
  });

  const noSignupLink = () => {
    expect(
      screen.queryByRole("link", { name: /crear cuenta|create account|konto/i }),
    ).toBeNull();
    expect(document.querySelector('a[href^="/signup"]')).toBeNull();
  };

  it("NO hay enlace permanente «Crear cuenta»: ni antes de enviar, ni con un correo inválido, ni tras enviar el enlace; «Volver a iniciar sesión» sí", async () => {
    renderPage();
    noSignupLink();
    expect(screen.getByRole("link", { name: "Volver a iniciar sesión" })).toHaveAttribute(
      "href",
      "/login",
    );
    submit("sin-arroba");
    await screen.findByRole("alert");
    noSignupLink();
    submit("alguien@example.test");
    await screen.findByRole("status");
    noSignupLink();
    expect(
      screen.getByRole("link", { name: "Volver a iniciar sesión" }),
    ).toBeInTheDocument();
  });

  it("tras enviar indica revisar Spam y comprobar la dirección; antes de enviar y con un correo inválido no aparece", async () => {
    renderPage();
    expect(screen.queryByText(/Spam/)).toBeNull();
    submit("sin-arroba");
    await screen.findByRole("alert");
    expect(screen.queryByText(/Spam/)).toBeNull();
    submit("alguien@example.test");
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/Spam o Correo no deseado/);
    expect(status).toHaveTextContent(/dirección que escribiste es correcta/);
  });

  it("(comportamiento actual, hasta que exista la comprobación del servidor) la pantalla tras enviar es idéntica para éxito, error y excepción y nunca ofrece registrarse", async () => {
    const outcomes: Array<() => Promise<unknown>> = [
      async () => ({ data: {}, error: null }),
      async () => ({ data: null, error: { code: "user_not_found", status: 400 } }),
      async () => ({
        data: null,
        error: { code: "over_email_send_rate_limit", status: 429 },
      }),
      async () => {
        throw new Error("network");
      },
    ];
    const screens: string[] = [];
    for (const outcome of outcomes) {
      cleanup();
      sb.reset.mockReset();
      sb.reset.mockImplementation(outcome);
      renderPage();
      submit("alguien@example.test");
      await screen.findByRole("status");
      screens.push(document.body.textContent ?? "");
      noSignupLink();
      expect(screen.queryByRole("alert")).toBeNull();
    }
    expect(new Set(screens).size).toBe(1);
  });

  it("el botón sigue bloqueado 60 s con el aviso presente", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPage();
    submit("alguien@example.test");
    await screen.findByRole("status");
    expect(
      screen.getByRole("button", { name: /Podrás pedir otro enlace en 60 s/ }),
    ).toBeDisabled();
    noSignupLink();
  });

  it("EN y DE: el aviso de Spam sale de las traducciones y tampoco hay «Create account» / «Konto erstellen»", async () => {
    for (const [locale, hint, send] of [
      ["en", /Spam or Junk folder/, "Send link"],
      ["de", /Spam-Ordner/, "Link senden"],
    ] as const) {
      cleanup();
      localStorage.setItem("upmina:locale", locale);
      renderPage();
      expect(
        await screen.findByLabelText(locale === "en" ? "Email" : "E-Mail"),
      ).toBeVisible();
      noSignupLink();
      fireEvent.change(screen.getByLabelText(locale === "en" ? "Email" : "E-Mail"), {
        target: { value: "alguien@example.test" },
      });
      fireEvent.click(screen.getByRole("button", { name: send }));
      expect(await screen.findByRole("status")).toHaveTextContent(hint);
    }
  });

  it("no llama a ninguna API propia: solo a Supabase Auth", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      renderPage();
      submit("alguien@example.test");
      await screen.findByRole("status");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
