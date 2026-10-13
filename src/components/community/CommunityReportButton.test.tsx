import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CommunityReportButton from "./CommunityReportButton";
import { ModerationClientError } from "@/lib/moderation-client";

// REP-1: botón + diálogo de reporte. El servidor es la autoridad; aquí se prueba que la UI manda
// lo correcto una sola vez, muestra cada estado y es operable con teclado.

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  navigate: vi.fn(),
  session: { current: { user: { id: "u" } } as unknown },
}));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ session: mocks.session.current, loading: false }),
}));
vi.mock("react-router-dom", async () => ({
  ...(await vi.importActual<typeof import("react-router-dom")>("react-router-dom")),
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/lib/moderation-client", async () => ({
  ...(await vi.importActual("@/lib/moderation-client")),
  submitCommunityReport: mocks.submit,
}));

const OK = { alreadyReported: false, visibilityChanged: false, postStatus: "published" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.current = { user: { id: "u" } };
  localStorage.setItem("upmina:locale", "es");
});

function renderButton() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <CommunityReportButton postId="post-1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const open = () =>
  fireEvent.click(screen.getByRole("button", { name: "Reportar esta publicación" }));
const send = () =>
  fireEvent.click(screen.getByRole("button", { name: "Enviar reporte" }));

describe("CommunityReportButton", () => {
  it("un visitante va al login y no se abre ningún diálogo ni se envía nada", () => {
    mocks.session.current = null;
    renderButton();
    open();
    expect(mocks.navigate).toHaveBeenCalledWith("/login?returnTo=/community");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("abre un diálogo modal con foco en el primer motivo y los 8 motivos ordinarios", () => {
    renderButton();
    open();
    const dialog = screen.getByRole("dialog", { name: "Reportar publicación" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(8);
    expect(radios[0]).toHaveFocus();
    expect(screen.getByRole("group", { name: "Motivo del reporte" })).toBeInTheDocument();
    expect(
      screen.getByText(/formulario de reclamación de copyright/),
    ).toBeInTheDocument();
  });

  it("sin motivo no se envía y se avisa", async () => {
    renderButton();
    open();
    send();
    expect(await screen.findByRole("alert")).toHaveTextContent("Elige un motivo.");
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("la explicación no puede superar 1000 caracteres", async () => {
    renderButton();
    open();
    fireEvent.click(screen.getByRole("radio", { name: "Spam o engaño" }));
    fireEvent.change(screen.getByLabelText("Explicación (opcional)"), {
      target: { value: "a".repeat(1001) },
    });
    send();
    expect(await screen.findByRole("alert")).toHaveTextContent("1000");
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it.each([
    ["es", "Abrir el formulario de copyright"],
    ["en", "Open the copyright claim form"],
    ["de", "Urheberrechtsformular öffnen"],
  ])(
    "%s: el aviso dirige al formulario /copyright sin añadir motivos",
    async (locale, link) => {
      localStorage.setItem("upmina:locale", locale);
      renderButton();
      open();
      const anchor = (await screen.findByRole("link", {
        name: link,
      })) as HTMLAnchorElement;
      expect(anchor.getAttribute("href")).toBe("/copyright");
      expect(anchor.rel).toContain("noopener");
      expect(screen.getAllByRole("radio")).toHaveLength(8);
    },
  );

  it("envía motivo y explicación recortada una sola vez aunque se pulse varias veces", async () => {
    let resolve!: (v: unknown) => void;
    mocks.submit.mockReturnValue(new Promise((r) => (resolve = r)));
    renderButton();
    open();
    fireEvent.click(screen.getByRole("radio", { name: "Otro motivo" }));
    fireEvent.change(screen.getByLabelText("Explicación (opcional)"), {
      target: { value: "  posible copyright  " },
    });
    const form = screen.getByRole("dialog").querySelector("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    expect(mocks.submit.mock.calls[0]!.slice(1)).toEqual([
      "post-1",
      "other",
      "posible copyright",
    ]);
    expect(screen.getByRole("button", { name: "Enviando…" })).toBeDisabled();
    resolve(OK);
    expect(await screen.findByRole("status")).toHaveTextContent("Gracias");
    expect(mocks.submit).toHaveBeenCalledTimes(1);
  });

  it("éxito: el foco pasa a Cerrar y el disparador queda como Reportada", async () => {
    mocks.submit.mockResolvedValue(OK);
    renderButton();
    open();
    fireEvent.click(screen.getByRole("radio", { name: "Contenido sexual" }));
    send();
    const close = await screen.findByRole("button", { name: "Cerrar" });
    await waitFor(() => expect(close).toHaveFocus());
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const trigger = screen.getByRole("button", { name: "Reportada" });
    expect(trigger).toBeDisabled();
  });

  it("ya reportada anteriormente: mensaje propio, sin duplicar", async () => {
    mocks.submit.mockResolvedValue({ ...OK, alreadyReported: true });
    renderButton();
    open();
    fireEvent.click(screen.getByRole("radio", { name: "Spam o engaño" }));
    send();
    expect(await screen.findByRole("status")).toHaveTextContent("Ya habías reportado");
  });

  it.each([
    ["self_report", 403, "No puedes reportar tu propia publicación."],
    ["post_not_found", 404, "Esta publicación ya no existe."],
    ["post_not_reportable", 409, "Esta publicación ya no se puede reportar."],
    ["unauthenticated", 401, "Inicia sesión para reportar."],
    ["internal_failure", 500, "No pudimos enviar el reporte."],
  ])("error %s → mensaje seguro y se puede reintentar", async (code, status, text) => {
    mocks.submit.mockRejectedValue(
      new ModerationClientError("detalle interno", status, code),
    );
    renderButton();
    open();
    fireEvent.click(screen.getByRole("radio", { name: "Spam o engaño" }));
    send();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(text);
    expect(alert).not.toHaveTextContent("detalle interno");
    expect(screen.getByRole("button", { name: "Enviar reporte" })).toBeEnabled();
  });

  it("cuenta incompleta: aviso de AUTH-2 en vez de un error genérico", async () => {
    mocks.submit.mockRejectedValue(
      new ModerationClientError("x", 403, "account_incomplete", "email_unverified"),
    );
    renderButton();
    open();
    fireEvent.click(screen.getByRole("radio", { name: "Spam o engaño" }));
    send();
    expect((await screen.findAllByText(/correo/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText("No pudimos enviar el reporte.")).toBeNull();
  });

  it("Escape cierra y devuelve el foco al disparador; el clic fuera también cierra", async () => {
    renderButton();
    open();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Reportar esta publicación" }),
      ).toHaveFocus(),
    );
  });

  it("Tab no sale del diálogo (foco atrapado)", () => {
    renderButton();
    open();
    const cancel = screen.getByRole("button", { name: "Cancelar" });
    const send = screen.getByRole("button", { name: "Enviar reporte" });
    send.focus();
    fireEvent.keyDown(send, { key: "Tab" });
    expect(screen.getAllByRole("radio")[0]).toHaveFocus();
    screen.getAllByRole("radio")[0]!.focus();
    fireEvent.keyDown(screen.getAllByRole("radio")[0]!, { key: "Tab", shiftKey: true });
    expect(cancel.compareDocumentPosition(send)).toBeTruthy();
    expect(send).toHaveFocus();
  });

  it.each([
    ["en", "Report this post", "Send report", "Choose a reason."],
    ["de", "Diesen Beitrag melden", "Meldung senden", "Wähle einen Grund."],
  ])("localizado en %s", async (locale, trigger, submit, required) => {
    localStorage.setItem("upmina:locale", locale);
    renderButton();
    fireEvent.click(await screen.findByRole("button", { name: trigger }));
    fireEvent.click(screen.getByRole("button", { name: submit }));
    expect(await screen.findByRole("alert")).toHaveTextContent(required);
  });
});
