import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppealContext, AppealSubmitOutcome } from "@/lib/copyright-client";

const client = vi.hoisted(() => ({ context: vi.fn(), submit: vi.fn() }));
const auth = vi.hoisted(() => ({
  session: null as null | { user: { id: string } },
  loading: false,
}));
vi.mock("@/lib/supabase", () => ({ supabase: null }));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    session: auth.session,
    user: auth.session?.user ?? null,
    loading: auth.loading,
  }),
}));
vi.mock("@/lib/copyright-client", () => ({
  fetchAppealContext: client.context,
  submitAppeal: client.submit,
}));

import {
  clearPendingAppealToken,
  readPendingAppealToken,
} from "@/lib/pending-appeal-token";
import CopyrightAppealPage from "./CopyrightAppealPage";

// /copyright/appeal — apelación del autor. Componente real; el cliente HTTP y la sesión son dobles. Solo texto y enlaces.

const TOKEN = "Tt0123456789_-abcdefghijklmnopqrstuvwxyzABC".slice(0, 43);
const REF = "CPY-2026-000001";
const open = (over: Partial<AppealContext> = {}): AppealContext => ({
  reference: REF,
  state: "open",
  reason: "Reproduce la obra identificada",
  removedAt: "2026-10-12T10:00:00.000Z",
  appealDeadline: "2026-10-12T11:00:00.000Z",
  appealStatus: null,
  ...over,
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/copyright/appeal"]}>
      <CopyrightAppealPage />
    </MemoryRouter>,
  );
}
const label = (text: string | RegExp) => screen.findByLabelText(text);
async function fill(over: Record<string, string> = {}) {
  const values: Record<string, string> = {
    "Nombre de contacto": "Autor Original",
    "Correo de contacto": " Autor@Example.com ",
    "Explica por qué la retirada es un error":
      "La ilustración es mía y la publiqué antes",
    "Pruebas (texto)": "Archivo fuente con fechas",
    "Pruebas (enlaces)": "https://example.com/prueba",
    ...over,
  };
  for (const [name, value] of Object.entries(values))
    fireEvent.change(await label(name), { target: { value } });
  fireEvent.change(await label("Razón de la apelación"), {
    target: { value: "own_work" },
  });
  fireEvent.click(await label(/Declaro que la información/));
}
const send = () =>
  fireEvent.click(screen.getByRole("button", { name: "Presentar apelación" }));

beforeEach(() => {
  client.context.mockReset();
  client.submit.mockReset();
  auth.session = { user: { id: "author-1" } };
  auth.loading = false;
  clearPendingAppealToken();
  window.history.replaceState(null, "", "/copyright/appeal");
  localStorage.clear();
  localStorage.setItem("upmina:locale", "es");
});
afterEach(() => cleanup());

describe("token del enlace", () => {
  it("sale de la URL de inmediato y viaja solo en memoria", async () => {
    window.history.replaceState(null, "", `/copyright/appeal#t=${TOKEN}`);
    client.context.mockResolvedValue({ kind: "ok", appeal: open() });
    renderPage();
    await screen.findByLabelText("Nombre de contacto");
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
    expect(client.context).toHaveBeenCalledWith(TOKEN, expect.any(AbortSignal));
    expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN);
  });

  it("sin token (enlace incompleto) o con un token mal formado no consulta nada", async () => {
    renderPage();
    expect(await screen.findByText("Enlace incompleto")).toBeTruthy();
    cleanup();
    window.history.replaceState(null, "", "/copyright/appeal#t=corto");
    renderPage();
    expect(await screen.findByText("Enlace incompleto")).toBeTruthy();
    expect(window.location.hash).toBe("");
    expect(client.context).not.toHaveBeenCalled();
  });

  it("sin sesión pide iniciar sesión con la cuenta autora, conserva el token en memoria y NO consulta al servidor", async () => {
    window.history.replaceState(null, "", `/copyright/appeal#t=${TOKEN}`);
    auth.session = null;
    renderPage();
    expect(await screen.findByText("Inicia sesión con la cuenta autora")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Iniciar sesión" });
    expect(link.getAttribute("href")).toBe("/login?returnTo=/copyright/appeal");
    expect(link.getAttribute("href")).not.toContain(TOKEN);
    expect(readPendingAppealToken()).toBe(TOKEN);
    expect(client.context).not.toHaveBeenCalled();
  });
});

describe("estados", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", `/copyright/appeal#t=${TOKEN}`);
  });

  it("un enlace no válido para la cuenta responde con un mensaje genérico", async () => {
    client.context.mockResolvedValue({ kind: "not_available" });
    renderPage();
    expect(await screen.findByText("Apelación no disponible")).toBeTruthy();
    expect(screen.queryByLabelText("Nombre de contacto")).toBeNull();
  });

  it("un fallo técnico lo dice sin mostrar el formulario", async () => {
    client.context.mockResolvedValue({ kind: "error" });
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /No pudimos completar la operación/,
    );
  });

  it.each([
    ["submitted", "Apelación presentada", { appealStatus: "pending" as const }],
    ["expired", "El plazo para apelar terminó", {}],
    ["closed", "Este caso ya está cerrado", {}],
  ])(
    "estado %s: muestra su explicación y no el formulario",
    async (state, title, extra) => {
      client.context.mockResolvedValue({
        kind: "ok",
        appeal: open({ state: state as AppealContext["state"], ...extra }),
      });
      renderPage();
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.getByText(REF)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Presentar apelación" })).toBeNull();
      if (state === "submitted")
        expect(screen.getByText("Estado: pendiente de resolver.")).toBeTruthy();
    },
  );

  it("abierta: muestra referencia, motivo y plazo, y un formulario SIN subida de archivos ni documentos de identidad", async () => {
    client.context.mockResolvedValue({ kind: "ok", appeal: open() });
    renderPage();
    await screen.findByLabelText("Nombre de contacto");
    expect(screen.getByText("Reproduce la obra identificada")).toBeTruthy();
    expect(screen.getByText("Puedes apelar hasta")).toBeTruthy();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(screen.getByText(/No subas documentos de identidad ni archivos/)).toBeTruthy();
    expect(
      screen.getAllByRole("option").map((o) => (o as HTMLOptionElement).value),
    ).toEqual([
      "",
      "own_work",
      "authorized",
      "not_infringing",
      "legal_exception",
      "mistake",
      "other",
    ]);
  });
});

describe("formulario", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", `/copyright/appeal#t=${TOKEN}`);
    client.context.mockResolvedValue({ kind: "ok", appeal: open() });
  });

  it("un envío vacío muestra los errores, enfoca el primero y no llama al servidor", async () => {
    renderPage();
    await screen.findByLabelText("Nombre de contacto");
    send();
    expect(
      (await screen.findAllByText("Este campo es obligatorio.")).length,
    ).toBeGreaterThan(2);
    expect(
      screen.getByText("Debes confirmar la declaración para presentar la apelación."),
    ).toBeTruthy();
    expect(screen.getByText("Aporta pruebas en texto o en enlaces.")).toBeTruthy();
    expect(document.activeElement?.id).toBe("appeal-name");
    expect(client.submit).not.toHaveBeenCalled();
  });

  it("valida los enlaces con mensajes específicos y escribir en un campo limpia su error", async () => {
    renderPage();
    await fill({ "Pruebas (enlaces)": "javascript:alert(1)" });
    send();
    expect(await screen.findByText(/Revisa los enlaces: uno por línea/)).toBeTruthy();
    fireEvent.change(await label("Pruebas (enlaces)"), {
      target: {
        value: Array.from({ length: 6 }, (_, i) => `https://e.example/${i}`).join("\n"),
      },
    });
    send();
    expect(await screen.findByText("Puedes incluir como máximo 5 enlaces.")).toBeTruthy();
    expect(client.submit).not.toHaveBeenCalled();
    fireEvent.change(await label("Nombre de contacto"), { target: { value: "Otro" } });
    expect((await label("Nombre de contacto")).getAttribute("aria-invalid")).toBe(
      "false",
    );
  });

  it("envía el cuerpo NORMALIZADO con el token, muestra la referencia, destruye el token y evita envíos dobles", async () => {
    let resolve!: (v: AppealSubmitOutcome) => void;
    client.submit.mockReturnValue(new Promise<AppealSubmitOutcome>((r) => (resolve = r)));
    renderPage();
    await fill();
    send();
    const sending = await screen.findByRole("button", { name: "Enviando…" });
    expect((sending as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(sending.closest("form")!);
    fireEvent.submit(sending.closest("form")!);
    expect(client.submit).toHaveBeenCalledTimes(1);
    const [token, payload] = client.submit.mock.calls[0]!;
    expect(token).toBe(TOKEN);
    expect(payload).toEqual({
      contactName: "Autor Original",
      contactEmail: "autor@example.com",
      reason: "own_work",
      explanation: "La ilustración es mía y la publiqué antes",
      evidenceText: "Archivo fuente con fechas",
      evidenceUrls: ["https://example.com/prueba"],
      statementVersion: "v1",
      statementAccepted: true,
    });
    resolve({ kind: "submitted", reference: REF });
    expect(await screen.findByText("Apelación presentada")).toBeTruthy();
    expect(screen.getByText(REF)).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Apelación presentada"),
    );
    expect(readPendingAppealToken()).toBeNull();
  });

  it.each([
    ["already_submitted", /Ya se presentó una apelación/],
    ["window_closed", /El plazo para apelar ya terminó/],
    ["not_available", /ya no está disponible/],
    ["invalid", /No pudimos validar el formulario/],
    ["error", /No pudimos completar la operación/],
  ])(
    "un resultado «%s» se explica y conserva lo escrito para reintentar",
    async (kind, text) => {
      client.submit.mockResolvedValue({ kind });
      renderPage();
      await fill();
      send();
      expect(await screen.findByRole("alert")).toHaveTextContent(text);
      expect(((await label("Nombre de contacto")) as HTMLInputElement).value).toBe(
        "Autor Original",
      );
      expect(
        (screen.getByRole("button", { name: "Presentar apelación" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
      expect(screen.queryByText("Apelación presentada")).toBeNull();
    },
  );

  it("si la sesión terminó durante el envío vuelve a pedir iniciar sesión sin perder el token", async () => {
    client.submit.mockResolvedValue({ kind: "unauthenticated" });
    renderPage();
    await fill();
    send();
    expect(await screen.findByText("Inicia sesión con la cuenta autora")).toBeTruthy();
    expect(readPendingAppealToken()).toBe(TOKEN);
  });
});

describe("idiomas", () => {
  it.each([
    ["es", "Apelación de una retirada por copyright", "Presentar apelación"],
    ["en", "Appeal a copyright removal", "Submit appeal"],
    ["de", "Einspruch gegen eine Urheberrechts-Entfernung", "Einspruch einreichen"],
  ])(
    "%s: título y botón traducidos, sin claves sin resolver",
    async (locale, title, button) => {
      localStorage.setItem("upmina:locale", locale);
      window.history.replaceState(null, "", `/copyright/appeal#t=${TOKEN}`);
      client.context.mockResolvedValue({ kind: "ok", appeal: open() });
      renderPage();
      expect(await screen.findByRole("heading", { level: 1, name: title })).toBeTruthy();
      expect(await screen.findByRole("button", { name: button })).toBeTruthy();
      expect(document.body.textContent).not.toMatch(
        /moderation\.copyright|MISSING_MESSAGE|undefined/,
      );
      const labels = Array.from(document.querySelectorAll("label")).map((l) =>
        l.textContent?.trim(),
      );
      expect(labels.every((text) => text && text.length > 1)).toBe(true);
    },
  );
});
