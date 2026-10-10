import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// AUTH-1: estado "Check your inbox" compartido por /signup y /login. useAuth y supabase se
// mockean: aquí importa el reenvío (single-flight, cooldown, rate limit), el respaldo acotado
// de sincronización (focus/visibilitychange) y la limpieza de listeners/timers.

const fakes = vi.hoisted(() => ({
  refreshCalls: 0,
  resendCalls: [] as unknown[],
  resendImpl: undefined as (() => Promise<{ error: unknown }>) | undefined,
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    session: null,
    user: null,
    loading: false,
    signOut: async () => {},
    refreshSession: async () => {
      fakes.refreshCalls += 1;
    },
  }),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      async resend(args: unknown) {
        fakes.resendCalls.push(args);
        if (fakes.resendImpl) return fakes.resendImpl();
        return { error: null };
      },
    },
  },
}));

import EmailVerificationPending from "./EmailVerificationPending";

function renderPending(
  props: Partial<React.ComponentProps<typeof EmailVerificationPending>> = {},
) {
  return render(
    <MemoryRouter>
      <EmailVerificationPending email="fan@example.com" source="login" {...props} />
    </MemoryRouter>,
  );
}

async function resendButton() {
  return screen.findByRole("button", { name: /resend/i });
}

beforeEach(() => {
  localStorage.setItem("upmina:locale", "en");
  fakes.refreshCalls = 0;
  fakes.resendCalls = [];
  fakes.resendImpl = undefined;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("EmailVerificationPending — contenido", () => {
  it("signup: muestra el email, el enlace enviado y el aviso de Spam/Junk", async () => {
    renderPending({ source: "signup" });

    expect(await screen.findByText("Check your inbox")).toBeInTheDocument();
    expect(
      screen.getByText(/We sent a confirmation link to fan@example\.com\./),
    ).toBeTruthy();
    expect(screen.getByText(/Check your Spam or Junk folder\./)).toBeTruthy();
    expect(screen.getByText(/Can't find it\?/)).toBeTruthy();
  });

  it("login: explica que el correo todavía no está confirmado y conserva el aviso de Spam", async () => {
    renderPending({ source: "login" });

    expect(
      await screen.findByText(/fan@example\.com hasn't been confirmed yet\./),
    ).toBeTruthy();
    expect(screen.getByText(/Spam or Junk/)).toBeTruthy();
  });

  it("onBack: el pie es un botón que vuelve; sin onBack es un enlace a /login", async () => {
    const onBack = vi.fn();
    const { unmount } = renderPending({ onBack });
    fireEvent.click(
      await screen.findByRole("button", { name: "Use a different account" }),
    );
    expect(onBack).toHaveBeenCalledTimes(1);
    unmount();

    renderPending();
    expect(await screen.findByRole("link", { name: "Back to sign in" })).toHaveAttribute(
      "href",
      "/login",
    );
  });
});

describe("EmailVerificationPending — reenvío", () => {
  it("login: reenvía con type signup y el email, y arranca el cooldown", async () => {
    renderPending({ source: "login" });
    const button = await resendButton();
    expect(button).toBeEnabled();

    await act(async () => {
      fireEvent.click(button);
    });

    expect(fakes.resendCalls).toEqual([
      {
        type: "signup",
        email: "fan@example.com",
        options: { emailRedirectTo: `${window.location.origin}/login` },
      },
    ]);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "We sent the confirmation email again.",
    );
    expect(
      screen.getByRole("button", { name: /resend available in 60s/i }),
    ).toBeDisabled();
  });

  it("signup: el correo acaba de enviarse, así que arranca con cooldown y no permite reenviar", async () => {
    renderPending({ source: "signup" });
    const button = await screen.findByRole("button", {
      name: /resend available in 60s/i,
    });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(fakes.resendCalls).toHaveLength(0);
  });

  it("single-flight: dobles clics con una petición pendiente producen UNA llamada", async () => {
    let resolveResend: (value: { error: null }) => void = () => {};
    fakes.resendImpl = () =>
      new Promise((resolve) => {
        resolveResend = resolve;
      });
    renderPending({ source: "login" });
    const button = await resendButton();

    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    expect(fakes.resendCalls).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sending…" })).toHaveAttribute(
      "aria-busy",
      "true",
    );

    await act(async () => {
      resolveResend({ error: null });
    });
    expect(fakes.resendCalls).toHaveLength(1);
  });

  it("cooldown: cuenta atrás de 1 s en 1 s y rehabilita el botón al llegar a 0", async () => {
    renderPending({ source: "login" });
    const button = await resendButton();
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(
      screen.getByRole("button", { name: /resend available in 60s/i }),
    ).toBeDisabled();

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(
      screen.getByRole("button", { name: /resend available in 59s/i }),
    ).toBeDisabled();

    for (let i = 0; i < 59; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(screen.getByRole("button", { name: "Resend email" })).toBeEnabled();
    // Sin trabajo pendiente: no queda ningún timer vivo tras terminar la cuenta atrás.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rate limit (429 / over_email_send_rate_limit): mensaje seguro y cooldown, sin detalle del proveedor", async () => {
    fakes.resendImpl = async () => ({
      error: Object.assign(new Error("email rate limit exceeded smtp.internal"), {
        status: 429,
        code: "over_email_send_rate_limit",
      }),
    });
    renderPending({ source: "login" });

    const button = await resendButton();
    await act(async () => {
      fireEvent.click(button);
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Too many requests.");
    expect(alert).not.toHaveTextContent(/smtp|exceeded/i);
    expect(screen.getByRole("button", { name: /resend available/i })).toBeDisabled();
  });

  it("error genérico: mensaje seguro y permite reintentar de inmediato (sin cooldown)", async () => {
    fakes.resendImpl = async () => ({ error: new Error("boom secreto interno") });
    renderPending({ source: "login" });

    const button = await resendButton();
    await act(async () => {
      fireEvent.click(button);
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("We couldn't resend the email.");
    expect(alert).not.toHaveTextContent(/boom|secreto/i);
    expect(screen.getByRole("button", { name: "Resend email" })).toBeEnabled();
  });

  it("excepción inesperada: mismo mensaje seguro", async () => {
    fakes.resendImpl = async () => {
      throw new Error("red caída");
    };
    renderPending({ source: "login" });

    const button = await resendButton();
    await act(async () => {
      fireEvent.click(button);
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn't resend the email.",
    );
  });

  it("desmontar con el reenvío pendiente: al resolver no hay errores ni setState", async () => {
    let resolveResend: (value: { error: null }) => void = () => {};
    fakes.resendImpl = () =>
      new Promise((resolve) => {
        resolveResend = resolve;
      });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = renderPending({ source: "login" });
    fireEvent.click(await resendButton());
    unmount();

    await act(async () => {
      resolveResend({ error: null });
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("EmailVerificationPending — respaldo de sincronización", () => {
  it("focus de la ventana relee la sesión (refreshSession)", async () => {
    renderPending();
    await resendButton();

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(fakes.refreshCalls).toBe(1);
  });

  it("visibilitychange a visible relee la sesión; a hidden no", async () => {
    renderPending();
    await resendButton();
    const visibility = vi.spyOn(document, "visibilityState", "get");

    visibility.mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fakes.refreshCalls).toBe(0);

    visibility.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fakes.refreshCalls).toBe(1);
  });

  it("al desmontar se retiran los listeners: focus/visibility ya no hacen nada", async () => {
    const { unmount } = renderPending();
    await resendButton();
    unmount();

    act(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fakes.refreshCalls).toBe(0);
  });

  it("no hay polling: no se crea ningún setInterval", async () => {
    renderPending({ source: "signup" });
    await screen.findByText("Check your inbox");
    // Se instala DESPUÉS de la espera (testing-library usa su propio intervalo al esperar).
    vi.useFakeTimers();
    const intervalSpy = vi.spyOn(window, "setInterval");

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(intervalSpy).not.toHaveBeenCalled();
  });
});
