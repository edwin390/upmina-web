import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimPayload } from "@/lib/copyright-claim";
import type { ClaimSubmitOutcome } from "@/lib/copyright-client";

const client = vi.hoisted(() => ({ submit: vi.fn() }));
vi.mock("@/lib/copyright-client", () => ({ submitCopyrightClaim: client.submit }));

import CopyrightClaimPage from "./CopyrightClaimPage";

// /copyright — formulario público (COPY-1 fase 2A). Se ejecuta el componente real; el cliente HTTP es un doble. No hay red ni correo.

const POST = "0f000000-0000-4000-8000-0000000003e9";
function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/copyright"]}>
      <CopyrightClaimPage />
    </MemoryRouter>,
  );
}
const label = (text: string) => screen.findByLabelText(text);
async function fill(over: Record<string, string> = {}) {
  const values: Record<string, string> = {
    "Nombre completo": "Ana Titular",
    "Correo de contacto": "ana@example.com",
    "Describe la obra": "Ilustración original publicada en mi portafolio",
    "Enlace de la publicación": `https://upmina.test/community/${POST}`,
    "Qué parte de la publicación la infringe": "La publicación reutiliza mi ilustración",
    "Enlaces que demuestren tu titularidad": "https://example.com/obra",
    "Firma (tu nombre completo)": "Ana Titular",
    ...over,
  };
  for (const [name, value] of Object.entries(values))
    fireEvent.change(await label(name), { target: { value } });
  fireEvent.change(await label("Tu relación con la obra"), {
    target: { value: "owner" },
  });
  if (!("noAccept" in over))
    fireEvent.click(await screen.findByLabelText("Confirmo estas declaraciones"));
}
const send = () =>
  fireEvent.click(screen.getByRole("button", { name: "Enviar reclamación" }));
const received = (reference: string | null = "CPY-2026-000042"): ClaimSubmitOutcome => ({
  kind: "received",
  reference,
});

beforeEach(() => {
  client.submit.mockReset();
  localStorage.clear();
  localStorage.setItem("upmina:locale", "es");
});
afterEach(() => cleanup());

describe("formulario", () => {
  it("ofrece todos los campos etiquetados, sin ninguna subida de archivos", async () => {
    renderPage();
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Reclamación de derechos de autor",
      }),
    ).toBeTruthy();
    for (const text of [
      "Nombre completo",
      "Correo de contacto",
      "Organización (opcional)",
      "Tu relación con la obra",
      "Describe la obra",
      "Qué parte de la publicación la infringe",
      "Enlaces que demuestren tu titularidad",
      "Enlace de la publicación",
      "Firma (tu nombre completo)",
      "Confirmo estas declaraciones",
    ])
      expect(await label(text)).toBeTruthy();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(
      screen.getByText(/no retira ni oculta ninguna publicación de forma automática/i),
    ).toBeTruthy();
    const options = screen
      .getAllByRole("option")
      .map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(["", "owner", "authorized_representative"]);
  });

  it("el señuelo anti-bots es invisible para las personas y para los lectores de pantalla", async () => {
    renderPage();
    await screen.findByRole("heading", { level: 1 });
    const decoy = document.getElementById("copyright-website") as HTMLInputElement;
    expect(decoy.tabIndex).toBe(-1);
    expect(decoy.closest("[aria-hidden='true']")).not.toBeNull();
  });

  it("un envío vacío muestra los errores, enfoca el primero y no llama al servidor", async () => {
    renderPage();
    await screen.findByRole("heading", { level: 1 });
    send();
    expect(
      (await screen.findAllByText("Este campo es obligatorio.")).length,
    ).toBeGreaterThan(3);
    expect(
      screen.getByText("Debes confirmar las declaraciones para enviar la reclamación."),
    ).toBeTruthy();
    expect(document.activeElement?.id).toBe("copyright-name");
    expect(screen.getByLabelText("Nombre completo").getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(client.submit).not.toHaveBeenCalled();
  });

  it("escribir en un campo limpia su error", async () => {
    renderPage();
    await screen.findByRole("heading", { level: 1 });
    send();
    await screen.findAllByText("Este campo es obligatorio.");
    fireEvent.change(screen.getByLabelText("Nombre completo"), {
      target: { value: "Ana Titular" },
    });
    expect(screen.getByLabelText("Nombre completo").getAttribute("aria-invalid")).toBe(
      "false",
    );
  });

  it("mensajes específicos para los enlaces de prueba", async () => {
    renderPage();
    await fill({ "Enlaces que demuestren tu titularidad": "javascript:alert(1)" });
    send();
    expect(await screen.findByText(/Revisa los enlaces: uno por línea/)).toBeTruthy();
    fireEvent.change(await label("Enlaces que demuestren tu titularidad"), {
      target: {
        value: Array.from({ length: 6 }, (_, i) => `https://e.example/${i}`).join("\n"),
      },
    });
    send();
    expect(await screen.findByText("Puedes incluir como máximo 5 enlaces.")).toBeTruthy();
    expect(client.submit).not.toHaveBeenCalled();
  });

  it("envía el cuerpo NORMALIZADO con el señuelo vacío y muestra la referencia", async () => {
    client.submit.mockResolvedValue(received());
    renderPage();
    await fill({ "Correo de contacto": "  ANA@Example.com " });
    send();
    expect(await screen.findByText("Reclamación recibida")).toBeTruthy();
    expect(screen.getByText("CPY-2026-000042")).toBeTruthy();
    const [payload, honeypot] = client.submit.mock.calls[0] as [ClaimPayload, string];
    expect(honeypot).toBe("");
    expect(payload).toMatchObject({
      claimantName: "Ana Titular",
      claimantEmail: "ana@example.com",
      organization: null,
      relationship: "owner",
      postId: POST,
      statementVersion: "v1",
      statementsAccepted: true,
      evidenceUrls: ["https://example.com/obra"],
    });
    expect(screen.queryByRole("button", { name: "Enviar reclamación" })).toBeNull();
    // El foco pasa al título del resultado.
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Reclamación recibida"),
    );
  });

  it("una recepción sin referencia (p. ej. señuelo) muestra el agradecimiento sin inventarla", async () => {
    client.submit.mockResolvedValue(received(null));
    renderPage();
    await fill();
    send();
    expect(await screen.findByText("Reclamación recibida")).toBeTruthy();
    expect(screen.queryByText(/CPY-/)).toBeNull();
  });

  it("si un bot rellena el señuelo, el valor viaja al servidor para que lo descarte", async () => {
    client.submit.mockResolvedValue(received(null));
    renderPage();
    await fill();
    fireEvent.change(document.getElementById("copyright-website")!, {
      target: { value: "http://spam.example" },
    });
    send();
    await screen.findByText("Reclamación recibida");
    expect(client.submit.mock.calls[0]![1]).toBe("http://spam.example");
  });

  it("evita envíos dobles mientras se envía", async () => {
    let resolve!: (v: ClaimSubmitOutcome) => void;
    client.submit.mockReturnValue(new Promise<ClaimSubmitOutcome>((r) => (resolve = r)));
    renderPage();
    await fill();
    send();
    const button = await screen.findByRole("button", { name: "Enviando…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(button.closest("form")!);
    fireEvent.submit(button.closest("form")!);
    expect(client.submit).toHaveBeenCalledTimes(1);
    resolve(received());
    await screen.findByText("Reclamación recibida");
  });

  it("límite: indica los minutos de espera y conserva lo escrito", async () => {
    client.submit.mockResolvedValue({ kind: "rate_limited", retryAfterSeconds: 3500 });
    renderPage();
    await fill();
    send();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Inténtalo de nuevo en 59 min.",
    );
    expect((screen.getByLabelText("Nombre completo") as HTMLInputElement).value).toBe(
      "Ana Titular",
    );
    expect(
      (screen.getByRole("button", { name: "Enviar reclamación" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("un fallo técnico NUNCA se presenta como recibida, conserva los datos y permite reintentar", async () => {
    client.submit
      .mockResolvedValueOnce({ kind: "error" })
      .mockResolvedValueOnce(received());
    renderPage();
    await fill();
    send();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No pudimos enviar la reclamación",
    );
    expect(screen.queryByText("Reclamación recibida")).toBeNull();
    expect(
      (screen.getByLabelText("Describe la obra") as HTMLTextAreaElement).value,
    ).toContain("Ilustración original");
    send();
    expect(await screen.findByText("Reclamación recibida")).toBeTruthy();
    expect(client.submit).toHaveBeenCalledTimes(2);
  });

  it("un rechazo del servidor (400) pide revisar los datos", async () => {
    client.submit.mockResolvedValue({ kind: "invalid" });
    renderPage();
    await fill();
    send();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No pudimos validar el formulario",
    );
  });
});

describe("idiomas", () => {
  it.each([
    ["es", "Reclamación de derechos de autor", "Enviar reclamación"],
    ["en", "Copyright claim", "Send claim"],
    ["de", "Urheberrechtsbeschwerde", "Beschwerde senden"],
  ])(
    "%s: título y botón traducidos, sin claves sin resolver",
    async (locale, title, button) => {
      localStorage.setItem("upmina:locale", locale);
      renderPage();
      expect(await screen.findByRole("heading", { level: 1, name: title })).toBeTruthy();
      expect(screen.getByRole("button", { name: button })).toBeTruthy();
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
