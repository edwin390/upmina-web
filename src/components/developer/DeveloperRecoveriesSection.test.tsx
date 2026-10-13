import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import DeveloperRecoveriesSection from "./DeveloperRecoveriesSection";

// Recuperaciones excepcionales para Developer. Solo PRESENTACIÓN + envío de la decisión: el servidor
// decide. Datos SINTÉTICOS.

const TOKEN = "jwt-sintetico";
const ID1 = "99999999-9999-4999-8999-999999999991";
const ID2 = "99999999-9999-4999-8999-999999999992";
const FACTOR = "fffffff1-ffff-4fff-8fff-fffffffffff1";

const auth = vi.hoisted(() => ({ session: null as null | { access_token: string } }));
const mfa = vi.hoisted(() => ({
  listFactors: vi.fn(),
  challenge: vi.fn(),
  verify: vi.fn(),
}));
const failure = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: auth.session } }), mfa },
  },
}));
vi.mock("@/hooks/privileged-failure", () => ({
  usePrivilegedFailureReporter: () => failure.report,
}));

const fetchMock = vi.fn();
const res = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  username: "unica_admin",
  role: "admin",
  status: "pending_approval",
  requested_at: "2026-11-01T10:00:00.000Z",
  email_verified_at: "2026-11-01T10:01:00.000Z",
  approved_at: null,
  approval_kind: "peer",
  approver_username: null,
  notice_state: null,
  readiness: "not_approved",
  eligible: true,
  closed_reason: null,
  ...over,
});
const posts = () =>
  fetchMock.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([, init]) => JSON.parse(init.body));

function serve(
  list: unknown[],
  post: () => unknown = () =>
    res(200, {
      status: "approved",
      approval_kind: "exceptional",
      notice: { status: "accepted" },
    }),
) {
  fetchMock.mockImplementation(async (_u: string, init?: { method?: string }) =>
    init?.method === "POST" ? post() : res(200, { recoveries: list }),
  );
}

async function confirmWith(code: string) {
  fireEvent.change(screen.getByLabelText("Código del autenticador"), {
    target: { value: code },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
}

beforeEach(() => {
  auth.session = { access_token: TOKEN };
  fetchMock.mockReset();
  failure.report.mockReset();
  mfa.listFactors.mockReset();
  mfa.challenge.mockReset();
  mfa.verify.mockReset();
  mfa.listFactors.mockResolvedValue({ data: { totp: [{ id: FACTOR }] }, error: null });
  mfa.challenge.mockResolvedValue({ data: { id: "challenge-1" }, error: null });
  mfa.verify.mockResolvedValue({ data: {}, error: null });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DeveloperRecoveriesSection — lista", () => {
  it("estado vacío explícito", async () => {
    serve([]);
    render(<DeveloperRecoveriesSection />);
    expect(
      await screen.findByText(
        "No hay solicitudes elegibles para aprobación excepcional.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Sin decisiones recientes.")).toBeInTheDocument();
  });

  it("muestra solo cuenta, rol y estado: sin correos, códigos, hashes ni tokens; una única lectura", async () => {
    serve([item(ID1)]);
    const { container } = render(<DeveloperRecoveriesSection />);
    expect(await screen.findByText(/@unica_admin · admin/)).toBeInTheDocument();
    expect(
      screen.getByText(/Pendiente de aprobación · correo verificado/),
    ).toBeInTheDocument();
    expect(container.textContent).not.toMatch(
      /@[a-z0-9.-]+\.(com|test)|hash|token|cancel/i,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/developer-mfa-recoveries");
  });

  it("separa pendientes de decisión e historial; marca la aprobación excepcional y quién la hizo", async () => {
    serve([
      item(ID1),
      item(ID2, {
        eligible: false,
        status: "approved",
        approval_kind: "exceptional",
        approver_username: "el_dev",
        approved_at: "2026-11-01T10:10:00.000Z",
        notice_state: "delivered",
      }),
    ]);
    render(<DeveloperRecoveriesSection />);
    expect(await screen.findByText("Pendientes de decisión (1)")).toBeInTheDocument();
    expect(screen.getByText("Historial (1)")).toBeInTheDocument();
    expect(screen.getByText(/aprobación excepcional de @el_dev/)).toBeInTheDocument();
    expect(screen.getByText(/aviso entregado/)).toBeInTheDocument();
  });

  it("error de carga y forma inesperada no muestran contenido; 403 se reporta al contenedor", async () => {
    fetchMock.mockResolvedValue(res(403, { error: "No autorizado" }));
    render(<DeveloperRecoveriesSection />);
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo cargar");
    expect(failure.report).toHaveBeenCalledTimes(1);
  });
});

describe("DeveloperRecoveriesSection — aprobar con autorización reforzada", () => {
  it("aprobar pide primero el código del autenticador; sin código no se envía NADA", async () => {
    serve([item(ID1)]);
    render(<DeveloperRecoveriesSection />);
    fireEvent.click(
      await screen.findByRole("button", { name: /^Aprobar de forma excepcional/ }),
    );
    expect(posts()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeDisabled();
    expect(mfa.verify).not.toHaveBeenCalled();
  });

  it("verifica el TOTP en la página y SOLO después envía la aprobación; el código no llega a nuestros endpoints", async () => {
    serve([item(ID1)]);
    render(<DeveloperRecoveriesSection />);
    fireEvent.click(
      await screen.findByRole("button", { name: /^Aprobar de forma excepcional/ }),
    );
    await confirmWith("123456");
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(mfa.verify).toHaveBeenCalledWith({
      factorId: FACTOR,
      challengeId: "challenge-1",
      code: "123456",
    });
    // el cuerpo contiene SOLO la operación y la solicitud (nada del código ni de identidades)
    expect(posts()[0]).toEqual({ op: "approve", recovery_id: ID1 });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("123456");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Recuperación aprobada de forma excepcional.",
    );
    // relee la lista desde el servidor
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3));
  });

  it("código incorrecto: se informa y NO se envía la aprobación", async () => {
    mfa.verify.mockResolvedValue({
      data: null,
      error: { code: "mfa_verification_failed" },
    });
    serve([item(ID1)]);
    render(<DeveloperRecoveriesSection />);
    fireEvent.click(
      await screen.findByRole("button", { name: /^Aprobar de forma excepcional/ }),
    );
    await confirmWith("123456");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Código incorrecto o expirado.",
    );
    expect(posts()).toHaveLength(0);
  });

  it.each([
    [409, "peer_available", /otro administrador elegible/, true],
    [409, "not_eligible", /no admite aprobación excepcional/, true],
    [403, "self_approval", /propia recuperación/, false],
    [409, "not_pending", /ya no admite esta acción/, true],
    [410, "expired", /caducó/, true],
  ])(
    "rechazo %i «%s» del servidor: mensaje controlado (y la lista se relee si cambió)",
    async (status, code, message, reloads) => {
      serve([item(ID1)], () => res(status, { error: "Operación no permitida", code }));
      render(<DeveloperRecoveriesSection />);
      fireEvent.click(
        await screen.findByRole("button", { name: /^Aprobar de forma excepcional/ }),
      );
      await confirmWith("123456");
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      if (reloads) {
        await waitFor(() =>
          expect(
            fetchMock.mock.calls.filter(([, i]) => !i?.method).length,
          ).toBeGreaterThanOrEqual(2),
        );
      }
    },
  );

  it("step_up_required del servidor pide volver a introducir el código (no navega ni reintenta solo)", async () => {
    serve([item(ID1)], () =>
      res(403, { error: "No autorizado", code: "step_up_required" }),
    );
    render(<DeveloperRecoveriesSection />);
    fireEvent.click(
      await screen.findByRole("button", { name: /^Aprobar de forma excepcional/ }),
    );
    await confirmWith("123456");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "no es lo bastante reciente",
    );
    expect(posts()).toHaveLength(1);
    // el formulario sigue abierto para repetir con un código nuevo
    expect(screen.getByLabelText("Código del autenticador")).toBeInTheDocument();
  });

  it("un aviso que no se pudo enviar se advierte, sin ocultar que la aprobación quedó hecha", async () => {
    serve([item(ID1)], () =>
      res(200, {
        status: "approved",
        approval_kind: "exceptional",
        notice: { status: "failed" },
      }),
    );
    render(<DeveloperRecoveriesSection />);
    fireEvent.click(
      await screen.findByRole("button", { name: /^Aprobar de forma excepcional/ }),
    );
    await confirmWith("123456");
    expect(await screen.findByRole("status")).toHaveTextContent(
      /aviso a la persona no se pudo enviar/,
    );
  });

  it("un solo envío aunque se pulse dos veces seguidas", async () => {
    let release!: (v: unknown) => void;
    serve([item(ID1)], () => new Promise((r) => (release = r)) as never);
    render(<DeveloperRecoveriesSection />);
    fireEvent.click(
      await screen.findByRole("button", { name: /^Aprobar de forma excepcional/ }),
    );
    fireEvent.change(screen.getByLabelText("Código del autenticador"), {
      target: { value: "123456" },
    });
    const confirm = screen.getByRole("button", { name: "Confirmar" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(posts()).toHaveLength(1));
    release(res(200, { status: "approved", notice: { status: "accepted" } }));
    await screen.findByRole("status");
    expect(posts()).toHaveLength(1);
    expect(mfa.verify).toHaveBeenCalledTimes(1);
  });
});

describe("DeveloperRecoveriesSection — rechazo, reenvío y reversión", () => {
  it("rechazar exige motivo y código; envía el motivo y la operación", async () => {
    serve([item(ID1)], () =>
      res(200, { status: "denied", notice: { status: "accepted" } }),
    );
    render(<DeveloperRecoveriesSection />);
    fireEvent.click(
      await screen.findByRole("button", { name: /^Rechazar la recuperación/ }),
    );
    // sin motivo no se envía nada
    await confirmWith("123456");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Escribe el motivo del rechazo.",
    );
    expect(posts()).toHaveLength(0);
    expect(mfa.verify).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Motivo del rechazo"), {
      target: { value: "No reconozco la petición" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({
      op: "deny",
      recovery_id: ID1,
      reason: "No reconozco la petición",
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Recuperación rechazada.",
    );
  });

  it("una aprobación excepcional se puede revertir y su aviso reenviar mientras no esté entregado", async () => {
    const approved = item(ID2, {
      eligible: false,
      status: "approved",
      approval_kind: "exceptional",
      approver_username: "el_dev",
      approved_at: "2026-11-01T10:10:00.000Z",
      notice_state: "failed",
    });
    serve([approved], () =>
      res(200, { status: "approved", notice: { status: "accepted" } }),
    );
    render(<DeveloperRecoveriesSection />);
    const li = (await screen.findByText(/aprobación excepcional de @el_dev/)).closest(
      "li",
    )!;
    fireEvent.click(within(li).getByRole("button", { name: /^Reenviar el aviso/ }));
    await confirmWith("123456");
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({ op: "resend_notice", recovery_id: ID2 });
    expect(
      within(li).getByRole("button", { name: /^Revertir la aprobación/ }),
    ).toBeInTheDocument();
  });

  it("con el aviso entregado se ofrece «Reenviar aviso» (recordatorio); una aprobación entre administradores no se puede tocar", async () => {
    serve(
      [
        item(ID1, {
          eligible: false,
          status: "approved",
          approval_kind: "exceptional",
          notice_state: "delivered",
          approver_username: "el_dev",
        }),
        item(ID2, {
          eligible: false,
          status: "approved",
          approval_kind: "peer",
          notice_state: "failed",
        }),
      ],
      () =>
        res(200, {
          status: "approved",
          approval_kind: "exceptional",
          reminder: { status: "accepted" },
        }),
    );
    render(<DeveloperRecoveriesSection />);
    await screen.findByText("Historial (2)");
    // solo la aprobación EXCEPCIONAL ofrece reenviar; la de pares no
    expect(screen.getAllByRole("button", { name: /^Reenviar el aviso/ })).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: /^Revertir la aprobación/ }),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /^Reenviar el aviso/ }));
    await confirmWith("123456");
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({ op: "resend_notice", recovery_id: ID1 });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Recordatorio enviado a la persona.",
    );
  });

  it.each([
    [429, "too_soon", /Espera al menos un minuto/],
    [429, "reminder_limit", /3 recordatorios permitidos/],
    [409, "notice_not_delivered", /todavía no consta como entregado/],
  ])("recordatorio rechazado %i «%s» → mensaje claro", async (status, code, text) => {
    serve(
      [
        item(ID1, {
          eligible: false,
          status: "approved",
          approval_kind: "exceptional",
          notice_state: "delivered",
        }),
      ],
      () => res(status, { error: "x", code }),
    );
    render(<DeveloperRecoveriesSection />);
    await screen.findByText("Historial (1)");
    fireEvent.click(screen.getByRole("button", { name: /^Reenviar el aviso/ }));
    await confirmWith("123456");
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });

  it("no ofrece NINGUNA acción de borrado de factores", async () => {
    serve([item(ID1)]);
    render(<DeveloperRecoveriesSection />);
    await screen.findByText(/@unica_admin/);
    expect(
      screen.queryByRole("button", { name: /eliminar|borrar|invalidar|ejecutar/i }),
    ).toBeNull();
  });
});

describe("DeveloperRecoveriesSection — espera de seguridad tras convertirse en Developer", () => {
  const waiting = (seconds: number) => ({
    ready: false,
    ready_at: "2026-11-02T11:00:00.000Z",
    remaining_seconds: seconds,
    cooldown_minutes: 60,
  });
  const ready = {
    ready: true,
    ready_at: null,
    remaining_seconds: 0,
    cooldown_minutes: 60,
  };
  const serveWith = (
    list: unknown[],
    cooldown: unknown,
    post: () => unknown = () =>
      res(200, { status: "approved", notice: { status: "accepted" } }),
  ) =>
    fetchMock.mockImplementation(async (_u: string, init?: { method?: string }) =>
      init?.method === "POST" ? post() : res(200, { recoveries: list, cooldown }),
    );

  it("durante la espera: mensaje claro con el tiempo restante, «Aprobar» deshabilitado y «Rechazar» disponible", async () => {
    serveWith([item(ID1)], waiting(1800));
    render(<DeveloperRecoveriesSection />);
    const note = await screen.findByTestId("developer-cooldown");
    expect(note).toHaveTextContent("Acabas de convertirte en Developer");
    expect(note).toHaveTextContent("dentro de 30 minutos");
    expect(note).toHaveTextContent("puedes revisarlas y rechazarlas");
    expect(
      screen.getByRole("button", { name: /^Aprobar de forma excepcional/ }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /^Rechazar la recuperación/ }),
    ).toBeEnabled();
  });

  it.each([
    [45, "dentro de 1 minuto"],
    [90 * 60, "dentro de 1 hora y 30 minutos"],
    [120 * 60, "dentro de 2 horas"],
  ])(
    "el tiempo restante se explica en lenguaje sencillo (%i s)",
    async (seconds, text) => {
      serveWith([item(ID1)], waiting(seconds));
      render(<DeveloperRecoveriesSection />);
      expect(await screen.findByTestId("developer-cooldown")).toHaveTextContent(text);
    },
  );

  it("sin espera pendiente no hay aviso y se puede aprobar", async () => {
    serveWith([item(ID1)], ready);
    render(<DeveloperRecoveriesSection />);
    await screen.findByText(/@unica_admin/);
    expect(screen.queryByTestId("developer-cooldown")).toBeNull();
    expect(
      screen.getByRole("button", { name: /^Aprobar de forma excepcional/ }),
    ).toBeEnabled();
  });

  it("rechazar sigue funcionando durante la espera", async () => {
    serveWith([item(ID1)], waiting(600), () =>
      res(200, { status: "denied", notice: { status: "accepted" } }),
    );
    render(<DeveloperRecoveriesSection />);
    fireEvent.click(
      await screen.findByRole("button", { name: /^Rechazar la recuperación/ }),
    );
    fireEvent.change(screen.getByLabelText("Motivo del rechazo"), {
      target: { value: "No lo reconozco" },
    });
    await confirmWith("123456");
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ op: "deny", recovery_id: ID1 });
  });

  it("si el servidor rechaza con cooldown_active (la espera la decide la base) se explica y se relee", async () => {
    let waitingNow = false;
    fetchMock.mockImplementation(async (_u: string, init?: { method?: string }) =>
      init?.method === "POST"
        ? res(409, {
            error: "Operación no permitida",
            code: "cooldown_active",
            remaining_seconds: 900,
          })
        : res(200, {
            recoveries: [item(ID1)],
            cooldown: waitingNow ? waiting(900) : ready,
          }),
    );
    render(<DeveloperRecoveriesSection />);
    fireEvent.click(
      await screen.findByRole("button", { name: /^Aprobar de forma excepcional/ }),
    );
    waitingNow = true; // el servidor ya lo sabe aunque la pantalla aún no
    await confirmWith("123456");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /convirtió en Developer hace poco/,
    );
    expect(await screen.findByTestId("developer-cooldown")).toHaveTextContent(
      "dentro de 15 minutos",
    );
    expect(
      screen.getByRole("button", { name: /^Aprobar de forma excepcional/ }),
    ).toBeDisabled();
  });

  it("al terminar la espera confirma con el servidor y habilita «Aprobar» (sin recargar la página)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      let calls = 0;
      fetchMock.mockImplementation(async () =>
        res(200, {
          recoveries: [item(ID1)],
          cooldown: calls++ === 0 ? waiting(20) : ready,
        }),
      );
      render(<DeveloperRecoveriesSection />);
      await vi.waitFor(() =>
        expect(screen.getByTestId("developer-cooldown")).toBeInTheDocument(),
      );
      expect(
        screen.getByRole("button", { name: /^Aprobar de forma excepcional/ }),
      ).toBeDisabled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30000);
      });
      await vi.waitFor(() =>
        expect(screen.queryByTestId("developer-cooldown")).toBeNull(),
      );
      expect(
        screen.getByRole("button", { name: /^Aprobar de forma excepcional/ }),
      ).toBeEnabled();
      expect(calls).toBe(2); // una lectura inicial y UNA de confirmación
    } finally {
      vi.useRealTimers();
    }
  });

  it("limpia el temporizador al desmontar", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      serveWith([item(ID1)], waiting(3600));
      const view = render(<DeveloperRecoveriesSection />);
      await vi.waitFor(() =>
        expect(screen.getByTestId("developer-cooldown")).toBeInTheDocument(),
      );
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      view.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
