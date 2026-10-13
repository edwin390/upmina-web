import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import MfaCleanupsSection from "./MfaCleanupsSection";

// Autenticadores pendientes de restablecer (MFA fase 1). Solo presentación: el servidor decide.
// Datos SINTÉTICOS. Se comprueba el contrato, que no se renderice nada si no hay pendientes, que el
// reintento envíe únicamente { user_id } y los mensajes de resultado.

const TOKEN = "jwt-sintetico-de-prueba";
const U1 = "22222222-2222-4222-8222-222222222222";
const U2 = "33333333-3333-4333-8333-333333333333";

const auth = vi.hoisted(() => ({ session: null as null | { access_token: string } }));
vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: auth.session } }) } },
}));

const fetchMock = vi.fn();
const res = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const item = (user_id: string, over: Record<string, unknown> = {}) => ({
  user_id,
  previous_role: "moderator",
  requested_at: "2026-10-11T10:00:00.000Z",
  attempts: 1,
  last_error_class: "auth_delete_failed",
  factor_count: 1,
  username: "mina_mod",
  email: "mina@example.invalid",
  ...over,
});

beforeEach(() => {
  auth.session = { access_token: TOKEN };
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const retries = () =>
  fetchMock.mock.calls.filter(([url]) => url === "/api/admin/team-members-mfa-cleanup");

describe("MfaCleanupsSection", () => {
  it("sin pendientes no renderiza nada", async () => {
    fetchMock.mockResolvedValue(res(200, { cleanups: [] }));
    const { container } = render(<MfaCleanupsSection />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("lista a quien tiene el autenticador pendiente, con el motivo del último fallo", async () => {
    fetchMock.mockResolvedValue(
      res(200, {
        cleanups: [
          item(U1),
          item(U2, {
            username: null,
            factor_count: 2,
            attempts: 3,
            last_error_class: "factor_still_present",
          }),
        ],
      }),
    );
    render(<MfaCleanupsSection />);
    expect(await screen.findByText("@mina_mod")).toBeInTheDocument();
    expect(
      screen.getByText(
        /1 autenticador por invalidar · 1 intento · último fallo: no se pudo borrar el autenticador/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("mina@example.invalid")).toBeInTheDocument();
    expect(
      screen.getByText(
        /2 autenticadores por invalidar · 3 intentos · último fallo: el autenticador sigue presente/,
      ),
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("el reintento envía SOLO { user_id }, relee la lista y confirma cuando se resuelve", async () => {
    let served = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/admin/team-members-mfa-cleanups") {
        served++;
        return res(200, { cleanups: served === 1 ? [item(U1)] : [] });
      }
      return res(200, {
        user_id: U1,
        mfa_reset: { status: "completed", factors_deleted: 1 },
      });
    });
    render(<MfaCleanupsSection />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Reintentar la limpieza de @mina_mod" }),
    );
    await waitFor(() => expect(retries()).toHaveLength(1));
    expect(JSON.parse(retries()[0][1].body)).toEqual({ user_id: U1 });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Autenticador restablecido.",
    );
    await waitFor(() => expect(screen.queryByText("@mina_mod")).toBeNull());
  });

  it("si Auth sigue fallando se dice sin dar por resuelto nada y la fila permanece", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/admin/team-members-mfa-cleanups"
        ? res(200, { cleanups: [item(U1)] })
        : res(200, {
            user_id: U1,
            mfa_reset: { status: "pending", error_class: "auth_delete_failed" },
          }),
    );
    render(<MfaCleanupsSection />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Reintentar la limpieza/ }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /todavía no se pudo restablecer/,
    );
    expect(screen.getByText("@mina_mod")).toBeInTheDocument();
  });

  it.each([
    [401, /sesión ya no es válida/],
    [403, /verificación en dos pasos/],
    [500, /No pudimos reintentar/],
  ])("el reintento con HTTP %i muestra un mensaje controlado", async (status, text) => {
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/admin/team-members-mfa-cleanups"
        ? res(200, { cleanups: [item(U1)] })
        : res(status, { error: "x" }),
    );
    render(<MfaCleanupsSection />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Reintentar la limpieza/ }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });

  it("un 404 (ya no está pendiente) actualiza la lista; un solo reintento a la vez", async () => {
    let release!: (v: unknown) => void;
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/admin/team-members-mfa-cleanups"
        ? res(200, { cleanups: [item(U1), item(U2, { username: "otro" })] })
        : new Promise((r) => (release = r)),
    );
    render(<MfaCleanupsSection />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Reintentar la limpieza de @mina_mod" }),
    );
    await waitFor(() => expect(retries()).toHaveLength(1));
    expect(
      screen.getByRole("button", { name: "Reintentar la limpieza de @otro" }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Reintentar la limpieza de @otro" }),
    );
    expect(retries()).toHaveLength(1);
    release(res(404, { error: "No encontrado" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/ya no está pendiente/);
  });

  it("forma inesperada o fallo de red al listar → error controlado, sin datos ajenos", async () => {
    fetchMock.mockResolvedValue(res(200, { cleanups: [{ user_id: "x" }] }));
    const first = render(<MfaCleanupsSection />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/No se pudo cargar/);
    first.unmount();
    fetchMock.mockRejectedValue(new Error("red"));
    render(<MfaCleanupsSection />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/No se pudo cargar/);
  });

  it("sin sesión → mensaje de sesión y no se llama a la API", async () => {
    auth.session = null;
    render(<MfaCleanupsSection />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/sesión ya no es válida/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshKey vuelve a pedir la lista", async () => {
    fetchMock.mockResolvedValue(res(200, { cleanups: [] }));
    const view = render(<MfaCleanupsSection refreshKey={0} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    view.rerender(<MfaCleanupsSection refreshKey={1} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
