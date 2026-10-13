import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import DeveloperCleanupsSection from "./DeveloperCleanupsSection";

// Limpiezas de MFA para Developer: SOLO LECTURA. Sintético.

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
const row = (over: Record<string, unknown> = {}) => ({
  status: "pending",
  previous_role: "moderator",
  requested_at: "2026-11-01T10:00:00.000Z",
  completed_at: null,
  attempts: 3,
  last_attempt_at: "2026-11-01T10:05:00.000Z",
  last_error_class: "auth_delete_failed",
  factor_count: 2,
  factors_deleted: null,
  username: "mina",
  email_masked: "m***@e***.com",
  ...over,
});

beforeEach(() => {
  auth.session = { access_token: "jwt-sintetico" };
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DeveloperCleanupsSection", () => {
  it("muestra estado, intentos, error, fechas, factores y el correo enmascarado; separa pendientes e historial", async () => {
    fetchMock.mockResolvedValue(
      res(200, {
        cleanups: [
          row(),
          row({
            status: "completed",
            completed_at: "2026-11-01T11:00:00.000Z",
            factors_deleted: 1,
            factor_count: 1,
            attempts: 1,
            last_error_class: null,
            username: "ana",
          }),
        ],
      }),
    );
    render(<DeveloperCleanupsSection />);
    expect(await screen.findByText("Pendientes (1)")).toBeInTheDocument();
    expect(screen.getByText("Historial reciente (1)")).toBeInTheDocument();
    expect(screen.getByText("@mina")).toBeInTheDocument();
    expect(screen.getAllByText("m***@e***.com")).toHaveLength(2);
    expect(screen.getByText("Pendiente de limpiar")).toBeInTheDocument();
    expect(screen.getByText("2 por eliminar")).toBeInTheDocument();
    expect(
      screen.getByText(/Falló el borrado en el proveedor de autenticación/),
    ).toBeInTheDocument();
    expect(screen.getByText("Completada")).toBeInTheDocument();
    expect(screen.getByText("1 de 1 eliminados")).toBeInTheDocument();
  });

  it("es de SOLO LECTURA: ninguna acción de reintento ni de borrado y una única petición GET con Bearer", async () => {
    fetchMock.mockResolvedValue(res(200, { cleanups: [row()] }));
    render(<DeveloperCleanupsSection />);
    await screen.findByText("@mina");
    expect(screen.queryByRole("button", { name: /reintentar/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /eliminar|borrar|limpiar/i })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/developer-mfa-cleanups");
    expect(init).toEqual({ headers: { Authorization: "Bearer jwt-sintetico" } });
    expect(init.method).toBeUndefined();
  });

  it("no muestra identificadores de factores, hashes ni correos completos aunque el servidor los enviara", async () => {
    fetchMock.mockResolvedValue(
      res(200, {
        cleanups: [
          {
            ...row(),
            factor_ids: ["fffffff1-ffff-4fff-8fff-fffffffffff1"],
            email: "mina@example.test",
            user_id: "22222222-2222-4222-8222-222222222222",
          },
        ],
      }),
    );
    const { container } = render(<DeveloperCleanupsSection />);
    await screen.findByText("@mina");
    expect(container.textContent).not.toContain("fffffff1");
    expect(container.textContent).not.toContain("mina@example.test");
    expect(container.textContent).not.toContain("22222222");
  });

  it("estados vacío, error y respuesta con forma inesperada", async () => {
    fetchMock.mockResolvedValueOnce(res(200, { cleanups: [] }));
    const first = render(<DeveloperCleanupsSection />);
    expect(await screen.findByText("No hay limpiezas pendientes.")).toBeInTheDocument();
    first.unmount();

    fetchMock.mockResolvedValueOnce(res(500));
    const second = render(<DeveloperCleanupsSection />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No se pudo cargar la lista de limpiezas.",
    );
    second.unmount();

    fetchMock.mockResolvedValueOnce(res(200, { cleanups: [{ status: "raro" }] }));
    render(<DeveloperCleanupsSection />);
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo cargar");
  });

  it("sin sesión no consulta y pide iniciar sesión; «Actualizar» vuelve a leer", async () => {
    auth.session = null;
    const view = render(<DeveloperCleanupsSection />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Tu sesión ya no es válida",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    view.unmount();

    auth.session = { access_token: "jwt-sintetico" };
    fetchMock.mockResolvedValue(res(200, { cleanups: [] }));
    render(<DeveloperCleanupsSection />);
    await screen.findByText("No hay limpiezas pendientes.");
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
