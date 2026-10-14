import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeletionPreviewOutcome } from "@/lib/account-deletion-client";

const client = vi.hoisted(() => ({
  request: vi.fn(),
  preview: vi.fn(),
  confirm: vi.fn(),
}));
const auth = vi.hoisted(() => ({
  session: null as null | { user: { id: string } },
  loading: false,
  signOut: vi.fn(),
}));
const supa = vi.hoisted(() => ({ signOut: vi.fn() }));
const access = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: { auth: { signOut: supa.signOut } } }));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    session: auth.session,
    user: auth.session?.user ?? null,
    loading: auth.loading,
    signOut: auth.signOut,
  }),
}));
vi.mock("@/lib/account-deletion-client", () => ({
  requestAccountDeletion: client.request,
  previewAccountDeletion: client.preview,
  confirmAccountDeletion: client.confirm,
}));
vi.mock("@/lib/admin-access", () => ({ fetchAdminAccess: access.fetch }));

import {
  clearPendingDeletionToken,
  readPendingDeletionToken,
} from "@/lib/pending-deletion-token";
import AccountDeletionPage from "./AccountDeletionPage";

// /account/delete (DEL-3). Componente real; el cliente HTTP, la sesión y el acceso son DOBLES: nada destructivo, ni correo, ni red.

const TOKEN = "Tt0123456789_-abcdefghijklmnopqrstuvwxyzABC".slice(0, 43);
const PATH = "/account/delete";

function Probe() {
  const location = useLocation();
  return <output data-testid="path">{location.pathname + location.search}</output>;
}
function renderPage() {
  return render(
    <MemoryRouter initialEntries={[PATH]}>
      <AccountDeletionPage />
      <Probe />
    </MemoryRouter>,
  );
}
const withToken = (token = TOKEN) =>
  window.history.replaceState(null, "", `${PATH}#t=${token}`);
const ok = (
  state: "valid" | "expired" | "invalid" | "already_deleting",
): DeletionPreviewOutcome => ({
  kind: "ok",
  state,
});
const confirmButton = () =>
  screen.getByRole("button", { name: "Eliminar mi cuenta de forma permanente" });
const tick = () => act(async () => undefined);

beforeEach(() => {
  for (const fn of [
    client.request,
    client.preview,
    client.confirm,
    access.fetch,
    supa.signOut,
    auth.signOut,
  ])
    fn.mockReset();
  supa.signOut.mockResolvedValue({ error: null });
  access.fetch.mockResolvedValue({ role: null, capabilities: [], mfaRecent: false });
  auth.session = { user: { id: "user-1" } };
  auth.loading = false;
  clearPendingDeletionToken();
  window.history.replaceState(null, "", PATH);
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("upmina:locale", "es");
});
afterEach(() => cleanup());

describe("acceso a la pantalla", () => {
  it("sin sesión solo ofrece iniciar sesión (con returnTo seguro): ningún control destructivo y ninguna llamada", async () => {
    auth.session = null;
    renderPage();
    expect(await screen.findByText("Inicia sesión para continuar")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Iniciar sesión" });
    expect(link.getAttribute("href")).toBe("/login?returnTo=/account/delete");
    expect(screen.queryByRole("button")).toBeNull();
    expect(client.request).not.toHaveBeenCalled();
    expect(client.preview).not.toHaveBeenCalled();
    expect(client.confirm).not.toHaveBeenCalled();
  });

  it("una cuenta con rol de equipo ve la explicación del procedimiento separado y ningún botón de solicitud", async () => {
    access.fetch.mockResolvedValue({
      role: "moderator",
      capabilities: ["moderation"],
      mfaRecent: false,
    });
    renderPage();
    expect(
      await screen.findByText(/Las cuentas con rol de equipo siguen otro procedimiento/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Enviarme el correo/ })).toBeNull();
    expect(client.request).not.toHaveBeenCalled();
  });

  it("si el servidor rechaza a una cuenta privilegiada que el aviso temprano no detectó, la pantalla cambia a la explicación", async () => {
    client.request.mockResolvedValue({ kind: "privileged" });
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "Enviarme el correo de confirmación" }),
    );
    expect(await screen.findByText(/siguen otro procedimiento/)).toBeTruthy();
  });

  it("vista inicial: explica irreversibilidad, pérdida de acceso, username libre, conservación restringida y límites; sin plazos inventados", async () => {
    renderPage();
    await screen.findByRole("button", { name: "Enviarme el correo de confirmación" });
    const text = document.body.textContent ?? "";
    for (const piece of [
      "irreversible",
      "Pierdes el acceso",
      "nombre de usuario quedará libre",
      "registros de moderación",
      "copias de seguridad",
    ])
      expect(text.toLowerCase()).toContain(piece.toLowerCase());
    expect(text).not.toMatch(/\b\d+\s*(días|meses|años|days|months|years)\b/i);
    expect(
      screen.getByRole("link", { name: /política de privacidad/ }).getAttribute("href"),
    ).toBe("/privacy");
    expect(client.preview).not.toHaveBeenCalled();
  });
});

describe("solicitud del correo", () => {
  it("envía una sola solicitud aunque se pulse dos veces y muestra el estado «correo enviado» sin eliminar nada", async () => {
    let resolve!: (v: unknown) => void;
    client.request.mockReturnValue(new Promise((r) => (resolve = r)));
    renderPage();
    const button = await screen.findByRole("button", {
      name: "Enviarme el correo de confirmación",
    });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Enviando…" }).hasAttribute("disabled"),
    ).toBe(true);
    await act(async () => resolve({ kind: "sent" }));
    expect(await screen.findByText("Revisa tu correo")).toBeTruthy();
    expect(client.confirm).not.toHaveBeenCalled();
  });

  it.each([
    ["mail_failed", /No se pudo enviar el correo\. No se ha eliminado nada/],
    ["rate_limited", /demasiados correos/],
    ["unavailable", /servicio no está disponible/],
    ["already_deleting", /ya está en proceso de eliminación/],
    ["error", /No se pudo procesar la solicitud\. No se ha eliminado nada/],
  ])("fallo %s: mensaje claro, botón de nuevo disponible", async (kind, message) => {
    client.request.mockResolvedValue({ kind });
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "Enviarme el correo de confirmación" }),
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(message);
    expect(
      screen
        .getByRole("button", { name: "Enviarme el correo de confirmación" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("sesión caducada al solicitar: pide iniciar sesión", async () => {
    client.request.mockResolvedValue({ kind: "unauthenticated" });
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "Enviarme el correo de confirmación" }),
    );
    expect(await screen.findByText("Inicia sesión para continuar")).toBeTruthy();
  });
});

describe("token del enlace", () => {
  it("sale de la URL de inmediato, vive solo en memoria y la vista previa NO confirma ni elimina", async () => {
    withToken();
    client.preview.mockResolvedValue(ok("valid"));
    renderPage();
    await screen.findByText("Confirma la eliminación definitiva");
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
    expect(client.preview).toHaveBeenCalledWith(TOKEN, expect.any(AbortSignal));
    expect(client.confirm).not.toHaveBeenCalled(); // montar y validar jamás son destructivos
    expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN);
    expect(document.documentElement.outerHTML).not.toContain(TOKEN);
    expect(document.cookie).not.toContain(TOKEN);
  });

  it("conserva ruta y parámetros no sensibles al retirar el fragmento", async () => {
    window.history.replaceState(null, "", `${PATH}?x=1#t=${TOKEN}&otro=2`);
    client.preview.mockResolvedValue(ok("valid"));
    renderPage();
    await screen.findByText("Confirma la eliminación definitiva");
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      `${PATH}?x=1#otro=2`,
    );
  });

  it("un token mal formado es un enlace inválido: no consulta nada ni lo guarda", async () => {
    window.history.replaceState(null, "", `${PATH}#t=corto`);
    renderPage();
    expect(await screen.findByText("No pudimos validar este enlace")).toBeTruthy();
    expect(client.preview).not.toHaveBeenCalled();
    expect(readPendingDeletionToken()).toBeNull();
    expect(window.location.hash).toBe("");
  });

  it("sin sesión conserva el token en memoria para volver tras iniciar sesión, sin consultar al servidor", async () => {
    withToken();
    auth.session = null;
    renderPage();
    await screen.findByText("Inicia sesión para continuar");
    expect(readPendingDeletionToken()).toBe(TOKEN);
    expect(client.preview).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain(TOKEN);
  });

  it.each([
    ["expired", "El enlace ha caducado"],
    ["invalid", "No pudimos validar este enlace"],
  ] as const)(
    "token %s: mensaje seguro sin revelar la cuenta asociada",
    async (state, title) => {
      withToken();
      client.preview.mockResolvedValue(ok(state));
      renderPage();
      expect(await screen.findByText(title)).toBeTruthy();
      expect(client.confirm).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toMatch(/@|user-1/);
    },
  );

  it("sesión de otra cuenta: el aviso es el mismo que token inválido y ofrece cerrar sesión", async () => {
    withToken();
    client.preview.mockResolvedValue(ok("invalid"));
    renderPage();
    await screen.findByText("No pudimos validar este enlace");
    expect(document.body.textContent).toMatch(/pertenece a otra cuenta/);
    fireEvent.click(
      screen.getByRole("button", { name: "Cerrar sesión y usar otra cuenta" }),
    );
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(readPendingDeletionToken()).toBeNull();
  });

  it("sesión rechazada en la vista previa: pide iniciar sesión", async () => {
    withToken();
    client.preview.mockResolvedValue({ kind: "unauthenticated" });
    renderPage();
    expect(await screen.findByText("Inicia sesión para continuar")).toBeTruthy();
  });

  it("error al validar: no afirma nada y permite reintentar la comprobación", async () => {
    withToken();
    client.preview
      .mockResolvedValueOnce({ kind: "error" })
      .mockResolvedValueOnce(ok("valid"));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Comprobar de nuevo" }));
    expect(await screen.findByText("Confirma la eliminación definitiva")).toBeTruthy();
  });

  it("ya en eliminación (la vista previa lo informa): pantalla final coherente", async () => {
    withToken();
    client.preview.mockResolvedValue(ok("already_deleting"));
    renderPage();
    expect(
      await screen.findByText("Tu cuenta ha sido bloqueada y se está eliminando"),
    ).toBeTruthy();
  });
});

describe("confirmación irreversible", () => {
  async function validScreen() {
    withToken();
    client.preview.mockResolvedValue(ok("valid"));
    renderPage();
    await screen.findByText("Confirma la eliminación definitiva");
  }

  it("exige la casilla de reconocimiento: sin ella no se envía nada", async () => {
    await validScreen();
    fireEvent.click(confirmButton());
    expect(client.confirm).not.toHaveBeenCalled();
    expect((await screen.findByRole("alert")).textContent).toMatch(/Marca la casilla/);
  });

  it("202: bloquea doble envío, llama UNA vez con el token, limpia la sesión local, el token y muestra el estado final sin redirigir", async () => {
    await validScreen();
    let resolve!: (v: unknown) => void;
    client.confirm.mockReturnValue(new Promise((r) => (resolve = r)));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(confirmButton());
    fireEvent.click(screen.getByRole("button", { name: "Procesando la eliminación…" }));
    expect(client.confirm).toHaveBeenCalledTimes(1);
    expect(client.confirm).toHaveBeenCalledWith(TOKEN);
    expect(supa.signOut).not.toHaveBeenCalled(); // no se cierra sesión antes de que el backend procese
    await act(async () => resolve({ kind: "accepted" }));
    expect(
      await screen.findByText("Tu cuenta ha sido bloqueada y se está eliminando"),
    ).toBeTruthy();
    expect(supa.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(readPendingDeletionToken()).toBeNull();
    // No hay botón de cancelar ni de restaurar.
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.body.textContent).not.toMatch(
      /restaurar mi cuenta|cancelar la eliminación/i,
    );
    expect(screen.getByTestId("path").textContent).toBe(PATH);
  });

  it("dos clics síncronos sobre el botón (antes de que React repinte) envían una sola confirmación", async () => {
    await validScreen();
    client.confirm.mockReturnValue(new Promise(() => undefined));
    fireEvent.click(screen.getByRole("checkbox"));
    const button = confirmButton();
    await act(async () => {
      button.click();
      button.click();
    });
    expect(client.confirm).toHaveBeenCalledTimes(1);
  });

  it("aunque la sesión desaparezca después (el backend ya la rechaza), la pantalla final sigue estable: sin consultas y sin redirecciones", async () => {
    await validScreen();
    client.confirm.mockResolvedValue({ kind: "accepted" });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(confirmButton());
    await screen.findByText("Tu cuenta ha sido bloqueada y se está eliminando");
    const previewCalls = client.preview.mock.calls.length;
    const accessCalls = access.fetch.mock.calls.length;
    auth.session = null; // el AuthProvider refleja el signOut local
    await act(async () => {
      cleanup();
    });
    renderPage(); // un remontaje con sesión nula vuelve a pedir iniciar sesión (nuevo montaje); el desmontado no rompe nada
    expect(client.preview.mock.calls.length).toBe(previewCalls);
    expect(access.fetch.mock.calls.length).toBe(accessCalls);
    expect(client.confirm).toHaveBeenCalledTimes(1);
  });

  it("already_deleting al confirmar: estado de eliminación en curso coherente", async () => {
    await validScreen();
    client.confirm.mockResolvedValue({ kind: "already_deleting" });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(confirmButton());
    expect(
      await screen.findByText("Tu cuenta ha sido bloqueada y se está eliminando"),
    ).toBeTruthy();
  });

  it.each([
    ["invalid_token", "No pudimos validar este enlace"],
    ["expired", "El enlace ha caducado"],
    ["privileged", "Las cuentas con rol de equipo siguen otro procedimiento"],
  ] as const)(
    "respuesta %s: pantalla correspondiente, sin cerrar sesión",
    async (kind, title) => {
      await validScreen();
      client.confirm.mockResolvedValue({ kind });
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(confirmButton());
      expect(await screen.findByText(title)).toBeTruthy();
      expect(supa.signOut).not.toHaveBeenCalled();
    },
  );

  it("error de red / timeout / 5xx / sesión rechazada: resultado DESCONOCIDO, nunca «eliminada» ni «no eliminada»", async () => {
    for (const kind of ["ambiguous", "unauthenticated"] as const) {
      cleanup();
      client.confirm.mockReset();
      client.preview.mockReset();
      clearPendingDeletionToken();
      await validScreen();
      client.confirm.mockResolvedValue({ kind });
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(confirmButton());
      expect(await screen.findByText("No pudimos confirmar el resultado")).toBeTruthy();
      expect(document.body.textContent).toMatch(
        /No afirmamos que la cuenta se haya eliminado ni que no/,
      );
      expect(
        screen.queryByText("Tu cuenta ha sido bloqueada y se está eliminando"),
      ).toBeNull();
      expect(supa.signOut).not.toHaveBeenCalled();
    }
  });

  it("comprobar de nuevo tras un resultado desconocido: si la cuenta ya está bloqueada pasa al estado final; si el enlace sigue válido, vuelve a la confirmación", async () => {
    await validScreen();
    client.confirm.mockResolvedValue({ kind: "ambiguous" });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(confirmButton());
    await screen.findByText("No pudimos confirmar el resultado");
    client.preview
      .mockResolvedValueOnce({ kind: "error" })
      .mockResolvedValueOnce(ok("already_deleting"));
    fireEvent.click(screen.getByRole("button", { name: "Comprobar de nuevo" }));
    await tick();
    expect(screen.getByText("No pudimos confirmar el resultado")).toBeTruthy(); // sigue sin poder comprobarse
    fireEvent.click(screen.getByRole("button", { name: "Comprobar de nuevo" }));
    expect(
      await screen.findByText("Tu cuenta ha sido bloqueada y se está eliminando"),
    ).toBeTruthy();
  });

  it("otro error del servidor: se mantiene en la confirmación con un aviso que no afirma el resultado y se puede reintentar", async () => {
    await validScreen();
    client.confirm.mockResolvedValue({ kind: "error" });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(confirmButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(
      /No tenemos constancia de que la cuenta se haya eliminado/,
    );
    await waitFor(() => expect(confirmButton().hasAttribute("disabled")).toBe(false));
  });
});

describe("idiomas", () => {
  it.each([
    ["en", "Delete my account"],
    ["de", "Mein Konto löschen"],
    ["es", "Eliminar mi cuenta"],
  ])("renderiza el título en %s", async (locale, title) => {
    localStorage.setItem("upmina:locale", locale);
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: title })).toBeTruthy();
    if (locale === "en")
      expect(await screen.findByText("Email me the confirmation link")).toBeTruthy();
    if (locale === "de")
      expect(await screen.findByText("Bestätigungslink per E-Mail senden")).toBeTruthy();
  });
});
