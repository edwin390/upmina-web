import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRecoveryMark,
  markRecoverySession,
  recoveryMarkMatches,
  RECOVERY_MARK_MAX_AGE_MS,
  startRecoveryTracking,
} from "@/lib/password-recovery";
import ResetPasswordPage from "./ResetPasswordPage";

// /reset-password. Se ejecuta el componente real; supabase.auth y useAuth son dobles. Valores SINTÉTICOS.
// Aquí se prueba el flujo del CLIENTE (marca de enlace, paso TOTP, updateUser, cierre global de sesiones). Que
// Supabase exija aal2 para cambiar la contraseña de una cuenta con MFA NO se puede probar con un doble: ver
// docs/9K-PASSWORD-RECOVERY-AND-REMINDERS.md (verificación pendiente en DEV).

const authState = vi.hoisted(() => ({
  session: null as null | { user: { id: string }; access_token: string },
  loading: false,
}));
const sb = vi.hoisted(() => ({
  aal: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
}));
const totp = vi.hoisted(() => ({ reverify: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      mfa: { getAuthenticatorAssuranceLevel: sb.aal },
      updateUser: sb.updateUser,
      signOut: sb.signOut,
    },
  },
}));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => authState }));
vi.mock("@/lib/totp-reverify", () => ({ reverifyTotp: totp.reverify }));

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
  return (
    <p data-testid="where">
      {l.pathname}
      {l.state && (l.state as { passwordUpdated?: boolean }).passwordUpdated
        ? " passwordUpdated"
        : ""}
    </p>
  );
}
function renderPage(entry = "/reset-password") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/login" element={<Where />} />
        <Route path="/forgot-password" element={<Where />} />
        <Route path="/admin" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}
const markPresent = () =>
  window.sessionStorage.getItem("upmina:password-recovery") !== null;
const noMfa = { data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null };
const withMfa = { data: { currentLevel: "aal1", nextLevel: "aal2" }, error: null };
/** Sesión de recuperación REAL: la marca la pone el evento PASSWORD_RECOVERY atada a ESTA sesión. */
const recoverySession = () => {
  authState.session = sessionOf("u1", SID);
  markRecoverySession(authState.session);
};
const fillPasswords = (a: string, b: string) => {
  fireEvent.change(screen.getByLabelText("Contraseña nueva"), { target: { value: a } });
  fireEvent.change(screen.getByLabelText("Confirmar contraseña"), {
    target: { value: b },
  });
};
const save = () =>
  fireEvent.click(screen.getByRole("button", { name: "Guardar contraseña" }));

beforeEach(() => {
  authState.session = null;
  authState.loading = false;
  sb.aal.mockReset();
  sb.aal.mockResolvedValue(noMfa);
  sb.updateUser.mockReset();
  sb.updateUser.mockResolvedValue({ data: {}, error: null });
  sb.signOut.mockReset();
  sb.signOut.mockResolvedValue({ error: null });
  totp.reverify.mockReset();
  totp.reverify.mockResolvedValue("ok");
  clearRecoveryMark();
  localStorage.clear();
  localStorage.setItem("upmina:locale", "es");
});
afterEach(() => {
  cleanup();
  clearRecoveryMark();
  vi.unstubAllGlobals();
});

describe("enlace y sesión", () => {
  it("sin enlace de recuperación (aunque haya sesión normal): «enlace no válido», sin formulario y sin llamar a nada", async () => {
    authState.session = sessionOf("u1", SID); // sesión normal, sin marca de recuperación
    renderPage();
    expect(await screen.findByText("Este enlace no es válido")).toBeInTheDocument();
    expect(screen.queryByLabelText("Contraseña nueva")).toBeNull();
    expect(sb.updateUser).not.toHaveBeenCalled();
    expect(sb.aal).not.toHaveBeenCalled();
  });

  it("REGRESIÓN 3P-D: una marca ANTIGUA no muestra el formulario con una sesión ORDINARIA posterior (otro session_id) y se limpia", async () => {
    markRecoverySession(sessionOf("u1", SID)); // enlace abierto antes y abandonado
    authState.session = sessionOf("u1", OTHER_SID); // inicio de sesión normal después
    renderPage();
    expect(await screen.findByText("Este enlace no es válido")).toBeInTheDocument();
    expect(screen.queryByLabelText("Contraseña nueva")).toBeNull();
    expect(sb.updateUser).not.toHaveBeenCalled();
    expect(sb.aal).not.toHaveBeenCalled();
    expect(markPresent()).toBe(false);
  });

  it("REGRESIÓN 3P-D: la marca de OTRA cuenta no vale para esta sesión", async () => {
    markRecoverySession(sessionOf("u1", SID));
    authState.session = sessionOf("u2", SID);
    renderPage();
    expect(await screen.findByText("Este enlace no es válido")).toBeInTheDocument();
    expect(sb.updateUser).not.toHaveBeenCalled();
    expect(markPresent()).toBe(false);
  });

  it("REGRESIÓN 3P-D: una marca CADUCADA (15 min) no muestra el formulario", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      recoverySession();
      vi.setSystemTime(Date.now() + RECOVERY_MARK_MAX_AGE_MS);
      renderPage();
      expect(await screen.findByText("Este enlace no es válido")).toBeInTheDocument();
      expect(sb.updateUser).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("REGRESIÓN 3P-D: una recarga legítima (misma sesión, mismo sessionStorage) conserva el formulario", async () => {
    recoverySession();
    const first = renderPage();
    await screen.findByLabelText("Contraseña nueva");
    first.unmount(); // la recarga destruye el estado de React, no el sessionStorage de la pestaña
    renderPage();
    expect(await screen.findByLabelText("Contraseña nueva")).toBeInTheDocument();
  });

  it("REGRESIÓN 3P-D: otra pestaña (sin la marca de ESTA pestaña) con la misma sesión no ve el formulario", async () => {
    recoverySession();
    window.sessionStorage.clear(); // sessionStorage es por pestaña
    renderPage();
    expect(await screen.findByText("Este enlace no es válido")).toBeInTheDocument();
    expect(sb.updateUser).not.toHaveBeenCalled();
  });

  it("REGRESIÓN 3P-D: al cerrar sesión (SIGNED_OUT de supabase-js) la marca se limpia y ya no hay formulario", async () => {
    let emit!: (event: string, s: unknown) => void;
    startRecoveryTracking({
      onAuthStateChange: (cb) => {
        emit = cb as typeof emit;
        return { data: { subscription: {} } };
      },
    });
    emit("PASSWORD_RECOVERY", sessionOf("u1", SID)); // el evento real crea la marca
    authState.session = sessionOf("u1", SID);
    expect(recoveryMarkMatches(authState.session)).toBe(true);
    emit("SIGNED_OUT", null);
    renderPage();
    expect(await screen.findByText("Este enlace no es válido")).toBeInTheDocument();
    expect(markPresent()).toBe(false);
  });

  it("REGRESIÓN 3P-D: un enlace de otra cuenta que reemplaza la sesión invalida la marca anterior", async () => {
    recoverySession();
    authState.session = sessionOf("u2", OTHER_SID); // la sesión pasó a otra cuenta
    renderPage();
    expect(await screen.findByText("Este enlace no es válido")).toBeInTheDocument();
    expect(markPresent()).toBe(false);
  });

  it("con la marca pero sin sesión (caducó o se cerró): enlace no válido y opción de pedir uno nuevo", async () => {
    markRecoverySession(sessionOf("u1", SID)); // marca sin sesión (caducó o se cerró)
    renderPage();
    expect(await screen.findByText("Este enlace no es válido")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pedir un enlace nuevo" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
  });

  it("un enlace caducado/usado según el proveedor (#error_code=otp_expired) es «no válido» y el fragmento se borra de la URL", async () => {
    recoverySession();
    renderPage("/reset-password#error=access_denied&error_code=otp_expired");
    expect(await screen.findByText("Este enlace no es válido")).toBeInTheDocument();
    expect(screen.queryByLabelText("Contraseña nueva")).toBeNull();
    expect(sb.updateUser).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/otp_expired|access_denied/);
    expect(markPresent()).toBe(false); // un enlace inválido invalida también la marca previa
  });

  it("mientras se resuelve la sesión inicial no muestra nada privilegiado", async () => {
    authState.loading = true;
    renderPage();
    expect(await screen.findByRole("status")).toHaveTextContent("Comprobando el enlace…");
    expect(screen.queryByLabelText("Contraseña nueva")).toBeNull();
  });

  it("si no se puede leer el nivel de aseguramiento (fail closed) → enlace no válido", async () => {
    recoverySession();
    sb.aal.mockResolvedValue({ data: null, error: { code: "x" } });
    renderPage();
    expect(await screen.findByText("Este enlace no es válido")).toBeInTheDocument();
    sb.aal.mockRejectedValue(new Error("red"));
    cleanup();
    renderPage();
    expect(await screen.findByText("Este enlace no es válido")).toBeInTheDocument();
  });
});

describe("cuenta SIN verificación en dos pasos", () => {
  it("valida el formulario sin llamar a Supabase; la contraseña nunca se envía vacía ni distinta", async () => {
    recoverySession();
    renderPage();
    await screen.findByLabelText("Contraseña nueva");
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Completa los dos campos.",
    );
    fillPasswords("una-contrasena-1", "otra-distinta-2");
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent("no coinciden");
    expect(sb.updateUser).not.toHaveBeenCalled();
  });

  it("guarda con updateUser({password}) SOLO, cierra TODAS las sesiones (global), limpia la marca y vuelve a /login", async () => {
    recoverySession();
    renderPage();
    await screen.findByLabelText("Contraseña nueva");
    fillPasswords("una-contrasena-1", "una-contrasena-1");
    save();
    await waitFor(() => expect(sb.updateUser).toHaveBeenCalledTimes(1));
    expect(sb.updateUser).toHaveBeenCalledWith({ password: "una-contrasena-1" });
    await waitFor(() => expect(sb.signOut).toHaveBeenCalledWith({ scope: "global" }));
    expect(await screen.findByTestId("where")).toHaveTextContent(
      "/login passwordUpdated",
    );
    expect(markPresent()).toBe(false);
    // no se pidió ningún TOTP ni se tocó /admin
    expect(totp.reverify).not.toHaveBeenCalled();
    expect(screen.queryByText("/admin")).toBeNull();
  });

  it("aunque el cierre global falle, la contraseña ya cambió y se vuelve a /login", async () => {
    sb.signOut.mockRejectedValue(new Error("red"));
    recoverySession();
    renderPage();
    await screen.findByLabelText("Contraseña nueva");
    fillPasswords("una-contrasena-1", "una-contrasena-1");
    save();
    expect(await screen.findByTestId("where")).toHaveTextContent(
      "/login passwordUpdated",
    );
  });

  it.each([
    ["same_password", /distinta de la anterior/],
    ["weak_password", /requisitos de seguridad/],
    ["unexpected_failure", /No se pudo guardar la contraseña/],
  ])(
    "error de Supabase «%s» → mensaje controlado sin cerrar sesión ni limpiar la marca",
    async (code, text) => {
      sb.updateUser.mockResolvedValue({
        data: null,
        error: { code, message: "detalle interno" },
      });
      recoverySession();
      renderPage();
      await screen.findByLabelText("Contraseña nueva");
      fillPasswords("una-contrasena-1", "una-contrasena-1");
      save();
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(text);
      expect(alert).not.toHaveTextContent("detalle interno");
      expect(sb.signOut).not.toHaveBeenCalled();
      expect(markPresent()).toBe(true);
    },
  );

  it("sesión caducada al guardar (401/session_not_found) → enlace no válido", async () => {
    sb.updateUser.mockResolvedValue({
      data: null,
      error: { code: "session_not_found", status: 401 },
    });
    recoverySession();
    renderPage();
    await screen.findByLabelText("Contraseña nueva");
    fillPasswords("una-contrasena-1", "una-contrasena-1");
    save();
    expect(await screen.findByText("Este enlace no es válido")).toBeInTheDocument();
  });

  it("un solo envío aunque se pulse dos veces", async () => {
    let release!: (v: unknown) => void;
    sb.updateUser.mockImplementation(() => new Promise((r) => (release = r)));
    recoverySession();
    renderPage();
    await screen.findByLabelText("Contraseña nueva");
    fillPasswords("una-contrasena-1", "una-contrasena-1");
    const form = screen
      .getByRole("button", { name: "Guardar contraseña" })
      .closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(sb.updateUser).toHaveBeenCalledTimes(1));
    release({ data: {}, error: null });
    await screen.findByTestId("where");
  });

  it("cancelar cierra SOLO la sesión local, limpia la marca y vuelve a /login sin cambiar nada", async () => {
    recoverySession();
    renderPage();
    await screen.findByLabelText("Contraseña nueva");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(await screen.findByTestId("where")).toHaveTextContent("/login");
    expect(sb.signOut).toHaveBeenCalledTimes(1);
    // SOLO la sesión local: cancelar no cierra las demás sesiones de la persona
    expect(sb.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(sb.updateUser).not.toHaveBeenCalled();
    expect(markPresent()).toBe(false);
  });
});

describe("cuenta CON verificación en dos pasos (incluye privilegiadas)", () => {
  it("antes de pedir la contraseña nueva exige el código TOTP; un código incorrecto no avanza", async () => {
    sb.aal.mockResolvedValue(withMfa);
    totp.reverify.mockResolvedValue("invalid_code");
    recoverySession();
    renderPage();
    expect(await screen.findByText("Verifica tu identidad")).toBeInTheDocument();
    expect(screen.queryByLabelText("Contraseña nueva")).toBeNull();
    const verify = screen.getByRole("button", { name: "Verificar código" });
    expect(verify).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Código de 6 dígitos"), {
      target: { value: "12ab34" },
    });
    expect(screen.getByLabelText("Código de 6 dígitos")).toHaveValue("1234");
    fireEvent.change(screen.getByLabelText("Código de 6 dígitos"), {
      target: { value: "123456" },
    });
    fireEvent.click(verify);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Código incorrecto o expirado.",
    );
    expect(screen.queryByLabelText("Contraseña nueva")).toBeNull();
    expect(sb.updateUser).not.toHaveBeenCalled();
  });

  it.each([
    ["no_factor", /No encontramos una app autenticadora verificada/],
    ["failed", /No se pudo verificar el código/],
  ])(
    "«%s»: mensaje claro y el formulario de contraseña NO aparece (sin autenticador no se restablece desde aquí)",
    async (result, text) => {
      sb.aal.mockResolvedValue(withMfa);
      totp.reverify.mockResolvedValue(result);
      recoverySession();
      renderPage();
      await screen.findByText("Verifica tu identidad");
      fireEvent.change(screen.getByLabelText("Código de 6 dígitos"), {
        target: { value: "123456" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Verificar código" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(text);
      expect(screen.queryByLabelText("Contraseña nueva")).toBeNull();
    },
  );

  it("con el código correcto pasa a la contraseña nueva y solo entonces llama a updateUser; el código no se conserva ni viaja a updateUser", async () => {
    sb.aal.mockResolvedValue(withMfa);
    recoverySession();
    renderPage();
    await screen.findByText("Verifica tu identidad");
    fireEvent.change(screen.getByLabelText("Código de 6 dígitos"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verificar código" }));
    await screen.findByLabelText("Contraseña nueva");
    expect(totp.reverify).toHaveBeenCalledWith("123456");
    expect(sb.updateUser).not.toHaveBeenCalled();
    fillPasswords("una-contrasena-1", "una-contrasena-1");
    save();
    await waitFor(() =>
      expect(sb.updateUser).toHaveBeenCalledWith({ password: "una-contrasena-1" }),
    );
    expect(JSON.stringify(sb.updateUser.mock.calls)).not.toContain("123456");
    await waitFor(() => expect(sb.signOut).toHaveBeenCalledWith({ scope: "global" }));
    expect(await screen.findByTestId("where")).toHaveTextContent(
      "/login passwordUpdated",
    );
  });

  it("si Supabase responde insufficient_aal al guardar (no se asume que aal1 baste) vuelve al paso del código sin conservar la contraseña", async () => {
    sb.aal.mockResolvedValue(noMfa); // el cliente creía que no hacía falta
    sb.updateUser.mockResolvedValue({ data: null, error: { code: "insufficient_aal" } });
    recoverySession();
    renderPage();
    await screen.findByLabelText("Contraseña nueva");
    fillPasswords("una-contrasena-1", "una-contrasena-1");
    save();
    expect(await screen.findByText("Verifica tu identidad")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Hace falta verificar de nuevo tu código",
    );
    expect(screen.queryByLabelText("Contraseña nueva")).toBeNull();
    expect(sb.signOut).not.toHaveBeenCalled();
  });
});

describe("tokens, aislamiento y traducciones", () => {
  it("no lee ni muestra tokens, no llama a ninguna API propia y no registra nada en consola", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    recoverySession();
    renderPage("/reset-password#access_token=SENTINEL&type=recovery");
    await screen.findByLabelText("Contraseña nueva");
    fillPasswords("una-contrasena-1", "una-contrasena-1");
    save();
    await screen.findByTestId("where");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("SENTINEL");
    const logged = JSON.stringify([log.mock.calls, warn.mock.calls, err.mock.calls]);
    expect(logged).not.toMatch(/SENTINEL|una-contrasena-1/);
    expect(
      JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]),
    ).not.toMatch(/SENTINEL|una-contrasena-1/);
    log.mockRestore();
    warn.mockRestore();
    err.mockRestore();
  });

  it("los textos salen del sistema de traducciones (EN)", async () => {
    localStorage.setItem("upmina:locale", "en");
    recoverySession();
    renderPage();
    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save password" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Choose a new password" }),
    ).toBeInTheDocument();
  });
});
