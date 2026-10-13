import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import MfaRecoveriesSection from "./MfaRecoveriesSection";

// Solicitudes de recuperación de autenticador (MFA fase 2) para ADMIN. Solo presentación. SINTÉTICO.

const TOKEN = "jwt-sintetico-de-prueba";
const ID1 = "99999999-9999-4999-8999-999999999991";
const ID2 = "99999999-9999-4999-8999-999999999992";
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
const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  username: "mina",
  role: "moderator",
  status: "pending_approval",
  requested_at: "2026-10-11T10:00:00.000Z",
  email_verified_at: "2026-10-11T10:01:00.000Z",
  notice_state: null,
  readiness: "not_approved",
  ...over,
});
const posts = () =>
  fetchMock.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([, init]) => JSON.parse(init.body));

function serve(
  list: unknown[],
  post: () => unknown = () =>
    res(200, { status: "approved", notice: { status: "accepted" } }),
) {
  fetchMock.mockImplementation(async (_u: string, init?: { method?: string }) =>
    init?.method === "POST" ? post() : res(200, { recoveries: list }),
  );
}

beforeEach(() => {
  auth.session = { access_token: TOKEN };
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MfaRecoveriesSection", () => {
  it("sin solicitudes muestra un estado vacío explícito", async () => {
    serve([]);
    render(<MfaRecoveriesSection />);
    expect(await screen.findByText("No hay solicitudes pendientes.")).toBeInTheDocument();
  });

  it("lista cuenta, rol y estado sin correos, códigos ni hashes", async () => {
    serve([item(ID1)]);
    const { container } = render(<MfaRecoveriesSection />);
    expect(await screen.findByText(/@mina · moderator/)).toBeInTheDocument();
    expect(
      screen.getByText(/Pendiente de aprobación · correo verificado/),
    ).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/@example|hash|token/i);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("aprobar envía solo {op, recovery_id} y avisa si el aviso al titular falló", async () => {
    serve([item(ID1)], () =>
      res(200, { status: "approved", notice: { status: "failed" } }),
    );
    render(<MfaRecoveriesSection />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Aprobar la recuperación de @mina" }),
    );
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({ op: "approve", recovery_id: ID1 });
    expect(await screen.findByRole("status")).toHaveTextContent(
      /aviso al titular no se pudo enviar/,
    );
  });

  it("rechazar exige un motivo y lo envía", async () => {
    serve([item(ID1)], () =>
      res(200, { status: "denied", notice: { status: "accepted" } }),
    );
    render(<MfaRecoveriesSection />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Rechazar la recuperación de @mina" }),
    );
    expect(screen.getByRole("button", { name: "Confirmar rechazo" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Motivo del rechazo"), {
      target: { value: " No lo reconozco " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar rechazo" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({
      op: "deny",
      recovery_id: ID1,
      reason: "No lo reconozco",
    });
  });

  it("«Reenviar aviso» aparece en toda solicitud APROBADA (con el aviso entregado envía un recordatorio) y no se puede aprobar de nuevo", async () => {
    serve([
      item(ID1, { status: "approved", notice_state: "failed" }),
      item(ID2, { status: "approved", notice_state: "delivered", username: "otro" }),
    ]);
    render(<MfaRecoveriesSection />);
    expect(
      await screen.findByRole("button", { name: "Reenviar el aviso a @mina" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reenviar el aviso a @otro" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Aprobar la recuperación/ })).toBeNull();
    expect(screen.getByText(/aviso NO entregado/)).toBeInTheDocument();
    expect(screen.getByText(/aviso entregado/)).toBeInTheDocument();
  });

  it("con el aviso entregado «Reenviar aviso» envía un recordatorio: mismo op, mensaje propio y sin tocar nada más", async () => {
    serve([item(ID1, { status: "approved", notice_state: "delivered" })], () =>
      res(200, { status: "approved", reminder: { status: "accepted" } }),
    );
    render(<MfaRecoveriesSection />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Reenviar el aviso a @mina" }),
    );
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({ op: "resend_notice", recovery_id: ID1 });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Recordatorio enviado al titular.",
    );
  });

  it("si el recordatorio no se pudo enviar lo dice; sin entrega previa mantiene el mensaje de reenvío", async () => {
    serve([item(ID1, { status: "approved", notice_state: "delivered" })], () =>
      res(200, { status: "approved", reminder: { status: "failed" } }),
    );
    render(<MfaRecoveriesSection />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Reenviar el aviso a @mina" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(/no se pudo enviar/);
    cleanup();
    fetchMock.mockReset();
    serve([item(ID1, { status: "approved", notice_state: "failed" })], () =>
      res(200, { status: "approved", notice: { status: "accepted" } }),
    );
    render(<MfaRecoveriesSection />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Reenviar el aviso a @mina" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Aviso reenviado.");
  });

  it.each([
    [429, "too_soon", /Espera al menos un minuto/],
    [429, "reminder_limit", /3 recordatorios permitidos/],
    [409, "notice_not_delivered", /todavía no consta como entregado/],
    [503, "mail_unavailable", /envío de correos no está disponible/],
  ])("recordatorio rechazado %i «%s» → mensaje claro", async (status, code, text) => {
    serve([item(ID1, { status: "approved", notice_state: "delivered" })], () =>
      res(status, { error: "x", code }),
    );
    render(<MfaRecoveriesSection />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Reenviar el aviso a @mina" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });

  it.each([
    [401, /sesión ya no es válida/],
    [403, /verificación en dos pasos/],
    [409, /ya no admite esta acción/],
    [500, /No se pudo completar/],
  ])("HTTP %i al decidir → mensaje controlado", async (status, text) => {
    serve([item(ID1)], () => res(status, { error: "x" }));
    render(<MfaRecoveriesSection />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Aprobar la recuperación/ }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });

  it("forma inesperada o sin sesión → error, sin datos ajenos", async () => {
    fetchMock.mockResolvedValue(res(200, { recoveries: [{ id: 1 }] }));
    const first = render(<MfaRecoveriesSection />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/No se pudo cargar/);
    first.unmount();
    auth.session = null;
    render(<MfaRecoveriesSection />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/sesión ya no es válida/);
  });
});
