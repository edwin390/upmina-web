import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeletionAlert } from "@/lib/account-deletion-client";

const client = vi.hoisted(() => ({ alerts: vi.fn(), retry: vi.fn() }));
const failure = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock("@/lib/account-deletion-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/account-deletion-client")>()),
  fetchDeletionAlerts: client.alerts,
  retryAccountDeletion: client.retry,
}));
vi.mock("@/hooks/privileged-failure", () => ({
  usePrivilegedFailureReporter: () => failure.report,
}));

import DeveloperAccountDeletionsSection from "./DeveloperAccountDeletionsSection";

// Alertas de eliminación de cuenta para Developer (DEL-3). Componente real; cliente doble. Sin identidades y sin acciones de restauración.

const ID1 = "33333333-3333-4333-8333-333333333331";
const ID2 = "33333333-3333-4333-8333-333333333332";
const alert = (over: Partial<DeletionAlert> = {}): DeletionAlert => ({
  requestId: ID1,
  status: "cleanup_retry_pending",
  failedStage: "media_gc",
  errorCode: "media_gc_pending",
  lastAttemptAt: "2026-11-14T10:00:00.000Z",
  lastErrorAt: "2026-11-14T10:00:00.000Z",
  nextRetryAt: "2026-11-14T10:05:00.000Z",
  totalAttempts: 3,
  consecutiveFailures: 1,
  manualRequired: false,
  stalled: false,
  pendingStages: ["media_gc", "auth_delete"],
  ...over,
});

beforeEach(() => {
  client.alerts.mockReset();
  client.retry.mockReset();
  failure.report.mockReset();
  localStorage.setItem("upmina:locale", "es");
});
afterEach(() => cleanup());

describe("lista de alertas", () => {
  it("diferencia reintento, intervención manual y estancadas; traduce etapas y categorías; no muestra identificadores", async () => {
    client.alerts.mockResolvedValue({
      kind: "ok",
      alerts: [
        alert(),
        alert({
          requestId: ID2,
          status: "cleanup_manual_required",
          manualRequired: true,
          failedStage: "auth_delete",
          errorCode: "last_admin_protected",
          nextRetryAt: null,
        }),
        alert({
          requestId: "33333333-3333-4333-8333-333333333333",
          status: "access_blocked",
          stalled: true,
          failedStage: null,
          errorCode: null,
          totalAttempts: 0,
          lastAttemptAt: null,
          nextRetryAt: null,
          pendingStages: ["auth_block"],
        }),
      ],
    });
    render(<DeveloperAccountDeletionsSection />);
    expect(await screen.findByText("En reintento")).toBeTruthy();
    expect(screen.getByText("Intervención manual")).toBeTruthy();
    expect(screen.getByText("Estancada")).toBeTruthy();
    expect(screen.getAllByText("Archivos (recolección de R2)").length).toBeGreaterThan(0);
    expect(screen.getByText("Protección del último administrador")).toBeTruthy();
    expect(screen.getAllByText("Acceso bloqueado")).toHaveLength(3);
    const html = document.body.innerHTML;
    expect(html).not.toContain(ID1);
    expect(html).not.toContain(ID2);
    expect(html).not.toMatch(/@|user_id|userId/);
  });

  it("vacío, carga fallida y actualización", async () => {
    client.alerts
      .mockResolvedValueOnce({ kind: "ok", alerts: [] })
      .mockResolvedValueOnce({ kind: "error" });
    render(<DeveloperAccountDeletionsSection />);
    expect(
      await screen.findByText("No hay eliminaciones pendientes de atención."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /No se pudo cargar la lista/,
    );
  });

  it("un 401/403 del servidor se comunica al contenedor privilegiado (revalidación de acceso / MFA)", async () => {
    const response = { status: 403 } as Response;
    client.alerts.mockResolvedValue({ kind: "failure", response });
    render(<DeveloperAccountDeletionsSection />);
    await screen.findByRole("alert");
    expect(failure.report).toHaveBeenCalledWith(response);
  });

  it("no ofrece ninguna acción de restaurar acceso, desbloquear ni borrar usuarios", async () => {
    client.alerts.mockResolvedValue({ kind: "ok", alerts: [alert()] });
    render(<DeveloperAccountDeletionsSection />);
    await screen.findByText("En reintento");
    const buttons = screen.getAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual(["Actualizar", "Reintentar limpieza"]);
  });
});

describe("reintento", () => {
  it("solo aparece cuando corresponde (no para en curso ni estancadas sin fallo)", async () => {
    client.alerts.mockResolvedValue({
      kind: "ok",
      alerts: [
        alert({ status: "cleanup_in_progress", failedStage: null, errorCode: null }),
        alert({ requestId: ID2, status: "access_blocked", stalled: true }),
      ],
    });
    render(<DeveloperAccountDeletionsSection />);
    await screen.findByText("Estancada");
    expect(screen.queryByRole("button", { name: "Reintentar limpieza" })).toBeNull();
  });

  it("pide confirmación, no envía hasta confirmar y se puede cancelar", async () => {
    client.alerts.mockResolvedValue({ kind: "ok", alerts: [alert()] });
    render(<DeveloperAccountDeletionsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Reintentar limpieza" }));
    expect(screen.getByText("¿Reintentar esta limpieza?")).toBeTruthy();
    expect(client.retry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(client.retry).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Reintentar limpieza" })).toBeTruthy();
  });

  it("envía UNA petición (doble clic síncrono incluido), muestra «solicitado» —nunca «completado»— y recarga la lista", async () => {
    client.alerts.mockResolvedValue({ kind: "ok", alerts: [alert()] });
    let resolve!: (v: unknown) => void;
    client.retry.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<DeveloperAccountDeletionsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Reintentar limpieza" }));
    const confirm = screen.getByRole("button", { name: "Sí, reintentar" });
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    expect(client.retry).toHaveBeenCalledTimes(1);
    expect(client.retry).toHaveBeenCalledWith(ID1);
    expect(
      screen.getByRole("button", { name: "Solicitando…" }).hasAttribute("disabled"),
    ).toBe(true);
    await act(async () => resolve({ kind: "requested" }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/Reintento solicitado/);
    expect(status.textContent).toMatch(/no significa que la limpieza haya terminado/);
    await waitFor(() => expect(client.alerts).toHaveBeenCalledTimes(2));
  });

  it.each([
    [{ kind: "not_applicable" }, /ya no admite reintento/],
    [{ kind: "not_found" }, /La solicitud no existe/],
    [{ kind: "failure", response: { status: 500 } }, /No se pudo solicitar el reintento/],
    [{ kind: "error" }, /No se pudo solicitar el reintento/],
  ])("resultado %j → mensaje real, nada afirmado", async (outcome, message) => {
    client.alerts.mockResolvedValue({ kind: "ok", alerts: [alert()] });
    client.retry.mockResolvedValue(outcome);
    render(<DeveloperAccountDeletionsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Reintentar limpieza" }));
    fireEvent.click(screen.getByRole("button", { name: "Sí, reintentar" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(message);
  });

  it("rol no autorizado o MFA insuficiente (403/401 del servidor): mensaje de permiso y se informa al contenedor", async () => {
    const response = { status: 403 } as Response;
    client.alerts.mockResolvedValue({ kind: "ok", alerts: [alert()] });
    client.retry.mockResolvedValue({ kind: "forbidden", response });
    render(<DeveloperAccountDeletionsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Reintentar limpieza" }));
    fireEvent.click(screen.getByRole("button", { name: "Sí, reintentar" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/No tienes permiso/);
    expect(failure.report).toHaveBeenCalledWith(response);
  });
});

describe("idiomas", () => {
  it.each([
    ["en", "Pending account deletions", "Retry cleanup"],
    ["de", "Ausstehende Kontolöschungen", "Bereinigung wiederholen"],
  ])("renderiza en %s", async (locale, title, retry) => {
    localStorage.setItem("upmina:locale", locale);
    client.alerts.mockResolvedValue({ kind: "ok", alerts: [alert()] });
    render(<DeveloperAccountDeletionsSection />);
    expect(await screen.findByRole("heading", { name: title })).toBeTruthy();
    expect(await screen.findByRole("button", { name: retry })).toBeTruthy();
  });
});
