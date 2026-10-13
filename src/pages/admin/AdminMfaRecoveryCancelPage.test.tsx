import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AdminMfaRecoveryCancelPage from "./AdminMfaRecoveryCancelPage";

// Cancelación de una recuperación de MFA desde el enlace del correo. Pública, solo cancela. SINTÉTICO.

const TOKEN = "Z".repeat(43);
const fetchMock = vi.fn();
const res = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const calls = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));

function open(hash: string | null = `#t=${TOKEN}`) {
  window.history.replaceState(null, "", `/admin/mfa/recovery/cancel${hash ?? ""}`);
  return render(
    <MemoryRouter>
      <AdminMfaRecoveryCancelPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AdminMfaRecoveryCancelPage", () => {
  it("abrir el enlace solo COMPRUEBA y muestra la confirmación: no cancela y limpia el fragmento", async () => {
    fetchMock.mockResolvedValue(res(200, { valid: true }));
    open();
    expect(
      await screen.findByRole("button", { name: "Cancelar la recuperación" }),
    ).toBeInTheDocument();
    expect(calls()).toEqual([{ op: "check", token: TOKEN }]); // nunca «cancel» sin pulsar
    expect(window.location.hash).toBe("");
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it("solo al pulsar se envía «cancel» y se confirma sin revelar datos de la cuenta", async () => {
    fetchMock.mockImplementation(async (_u: string, init: { body: string }) =>
      JSON.parse(init.body).op === "check"
        ? res(200, { valid: true })
        : res(200, { status: "cancelled" }),
    );
    open();
    fireEvent.click(
      await screen.findByRole("button", { name: "Cancelar la recuperación" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      /se canceló y ya no puede ejecutarse/,
    );
    expect(calls()).toEqual([
      { op: "check", token: TOKEN },
      { op: "cancel", token: TOKEN },
    ]);
    expect(screen.queryByRole("button", { name: "Cancelar la recuperación" })).toBeNull();
  });

  it("enlace inválido, usado o caducado → mensaje único; sin fragmento no hay ninguna petición", async () => {
    fetchMock.mockResolvedValue(res(404, { code: "invalid_link" }));
    const first = open();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no es válido, ya se usó o caducó/,
    );
    first.unmount();
    fetchMock.mockReset();
    open(null);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no es válido, ya se usó o caducó/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("un fallo al cancelar permite reintentar sin perder el token", async () => {
    let cancels = 0;
    fetchMock.mockImplementation(async (_u: string, init: { body: string }) => {
      if (JSON.parse(init.body).op === "check") return res(200, { valid: true });
      cancels += 1;
      return cancels === 1 ? res(500, {}) : res(200, { status: "cancelled" });
    });
    open();
    fireEvent.click(
      await screen.findByRole("button", { name: "Cancelar la recuperación" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Reintentar la cancelación" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/se canceló/),
    );
    expect(calls().filter((c) => c.op === "cancel")).toHaveLength(2);
  });
});
