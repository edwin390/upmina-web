import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CopyrightActionResult,
  CopyrightClaimDetail,
  CopyrightClaimStatus,
  CopyrightRemovalInfo,
} from "@/lib/copyright-contract";

const api = vi.hoisted(() => ({
  remove: vi.fn(),
  resend: vi.fn(),
  resolve: vi.fn(),
  purge: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({ supabase: null }));
vi.mock("@/lib/copyright-client", () => ({
  removeCopyrightClaim: api.remove,
  resendCopyrightNotice: api.resend,
  resolveCopyrightAppeal: api.resolve,
  purgeCopyrightClaim: api.purge,
}));

import UpminaLocaleProvider from "@/i18n/LocaleProvider";
import { ModerationClientError } from "@/lib/moderation-client";
import CopyrightRemovalSection from "./CopyrightRemovalSection";

// Retirada, apelación y eliminación manual en la interfaz (COPY-1 fase 2B). Componente real; el cliente HTTP es un doble. La interfaz
// solo REFLEJA las condiciones: el servidor y la RPC las repiten.

const ID = "0f000000-0000-4000-8000-0000000000c1";
const REF = "CPY-2026-000001";
const REASON = "El contenido reproduce la obra identificada sin autorización";

const removalInfo = (over: Partial<CopyrightRemovalInfo> = {}): CopyrightRemovalInfo => ({
  removedAt: "2026-10-12T10:00:00.000Z",
  reason: REASON,
  windowMinutes: 60,
  notifiedAt: "2026-10-12T10:01:00.000Z",
  appealDeadline: "2026-10-12T11:01:00.000Z",
  notifyAttempts: 0,
  notifyLastError: null,
  resolutionNoticePending: false,
  resolutionNotifiedAt: null,
  restoredAt: null,
  purgedAt: null,
  purgeAssetsPending: null,
  purgeBlockers: [],
  ...over,
});
const claim = (
  status: CopyrightClaimStatus,
  over: Partial<CopyrightClaimDetail> = {},
): CopyrightClaimDetail => ({
  id: ID,
  reference: REF,
  status,
  version: 4,
  claimantName: "Ana Titular",
  relationship: "owner",
  postFound: true,
  createdAt: "2026-10-12T09:00:00.000Z",
  updatedAt: "2026-10-12T09:00:00.000Z",
  claimantEmail: "ana@example.com",
  organization: null,
  workDescription: "Ilustración original",
  infringementDescription: "Copia mi ilustración",
  evidenceUrls: ["https://example.com/obra"],
  claimedPostUrl: "https://upmina.test/community/x",
  postId: "0f000000-0000-4000-8000-0000000003e9",
  postTextSnapshot: "Texto congelado",
  postMediaCount: 2,
  currentPostStatus: "published",
  currentPost: {
    status: "published",
    text: "Texto actual de la publicación",
    version: 7,
    mediaCount: 2,
  },
  statementVersion: "v1",
  signature: "Ana Titular",
  removal: null,
  appeal: null,
  events: [],
  ...over,
});
const appeal = (status: "pending" | "accepted" | "rejected" = "pending") => ({
  status,
  reason: "own_work" as const,
  explanation: "La ilustración es mía",
  evidenceText: "Archivo fuente",
  evidenceUrls: ["https://example.com/prueba"],
  contactName: "Autor Original",
  contactEmail: "autor@example.com",
  createdAt: "2026-10-12T10:30:00.000Z",
  resolvedAt: status === "pending" ? null : "2026-10-12T10:40:00.000Z",
  resolutionNote: status === "pending" ? null : "Decisión motivada",
});
const result = (over: Partial<CopyrightActionResult> = {}): CopyrightActionResult => ({
  id: ID,
  reference: REF,
  status: "removed",
  version: 5,
  updatedAt: "2026-10-12T10:00:00.000Z",
  notice: "sent",
  noticeError: null,
  assetsMarked: null,
  assetsRetained: null,
  postDeleted: null,
  ...over,
});

const onChanged = vi.fn(async () => undefined);
const onAccessError = vi.fn();
function renderSection(c: CopyrightClaimDetail) {
  return render(
    <UpminaLocaleProvider>
      <CopyrightRemovalSection
        claim={c}
        onChanged={onChanged}
        onAccessError={onAccessError}
      />
    </UpminaLocaleProvider>,
  );
}
const button = (name: string | RegExp) => screen.findByRole("button", { name });

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  onChanged.mockClear();
  onAccessError.mockReset();
  localStorage.clear();
  localStorage.setItem("upmina:locale", "es");
});
afterEach(() => cleanup());

describe("retirar", () => {
  it("solo aparece en una reclamación EN REVISIÓN y pide el motivo; sin motivo válido no avanza a la confirmación", async () => {
    renderSection(claim("in_review"));
    fireEvent.click(await button("Revisar y retirar…"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(
      screen.getByLabelText(/Motivo de la retirada/).getAttribute("aria-invalid"),
    ).toBe("true");
    fireEvent.change(screen.getByLabelText(/Motivo de la retirada/), {
      target: { value: "corto" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Revisar y retirar…" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.remove).not.toHaveBeenCalled();
  });

  it.each(["received", "needs_info", "dismissed"] as const)(
    "en estado %s no se ofrece la retirada",
    async (status) => {
      renderSection(claim(status));
      expect(screen.queryByRole("button", { name: "Revisar y retirar…" })).toBeNull();
    },
  );

  it("la segunda confirmación muestra la publicación y el motivo, y NO retira hasta confirmar; cancelar no hace nada", async () => {
    renderSection(claim("in_review"));
    await screen.findByLabelText(/Motivo de la retirada/);
    fireEvent.change(screen.getByLabelText(/Motivo de la retirada/), {
      target: { value: `  ${REASON}  ` },
    });
    fireEvent.click(screen.getByRole("button", { name: "Revisar y retirar…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Confirmar la retirada")).toBeTruthy();
    expect(within(dialog).getByText(REF)).toBeTruthy();
    expect(within(dialog).getByText("Texto actual de la publicación")).toBeTruthy();
    expect(within(dialog).getByText(REASON)).toBeTruthy();
    expect(within(dialog).getByText(/No se elimina nada/)).toBeTruthy();
    expect(within(dialog).getByText(/2 archivos adjuntos/)).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Confirmar la retirada"),
    );
    expect(api.remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.remove).not.toHaveBeenCalled();
  });

  it("confirmar envía la versión de la reclamación y de la publicación VISTAS, la referencia y el motivo recortado, y recarga", async () => {
    api.remove.mockResolvedValue(result());
    renderSection(claim("in_review"));
    await screen.findByLabelText(/Motivo de la retirada/);
    fireEvent.change(screen.getByLabelText(/Motivo de la retirada/), {
      target: { value: `  ${REASON}  ` },
    });
    fireEvent.click(screen.getByRole("button", { name: "Revisar y retirar…" }));
    fireEvent.click(await button("Confirmar retirada"));
    await waitFor(() => expect(api.remove).toHaveBeenCalledTimes(1));
    expect(api.remove).toHaveBeenCalledWith({
      id: ID,
      expectedVersion: 4,
      expectedPostVersion: 7,
      confirmReference: REF,
      reason: REASON,
    });
    expect(
      await screen.findByText(
        "Publicación retirada. El autor ha sido avisado por correo.",
      ),
    ).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("si el aviso al autor falla, la retirada se conserva y se avisa de que queda pendiente de reenvío", async () => {
    api.remove.mockResolvedValue(
      result({ notice: "failed", noticeError: "provider_unavailable" }),
    );
    renderSection(claim("in_review"));
    await screen.findByLabelText(/Motivo de la retirada/);
    fireEvent.change(screen.getByLabelText(/Motivo de la retirada/), {
      target: { value: REASON },
    });
    fireEvent.click(screen.getByRole("button", { name: "Revisar y retirar…" }));
    fireEvent.click(await button("Confirmar retirada"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /La decisión se ha guardado, pero el aviso al autor no se pudo enviar \(proveedor de correo no disponible\)/,
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it("no se ofrece retirar si la publicación no se localizó o no está publicada", async () => {
    const { unmount } = renderSection(claim("in_review", { currentPost: null }));
    expect(await screen.findByText(/la publicación no se ha localizado/)).toBeTruthy();
    expect(screen.queryByLabelText(/Motivo de la retirada/)).toBeNull();
    unmount();
    renderSection(
      claim("in_review", {
        currentPost: { status: "hidden", text: "x", version: 3, mediaCount: 0 },
      }),
    );
    expect(
      await screen.findByText(/no está publicada \(estado actual: hidden\)/),
    ).toBeTruthy();
  });

  it.each([
    ["post_version_conflict", /La publicación cambió desde que la viste/],
    ["version_conflict", /El caso cambió mientras lo revisabas/],
    ["post_state_conflict", /La publicación ya no está en el estado esperado/],
    ["confirmation_mismatch", /La confirmación no coincide/],
    ["post_not_found", /La publicación ya no existe/],
  ])(
    "el rechazo del servidor (%s) se explica y los conflictos de versión recargan los datos",
    async (code, text) => {
      api.remove.mockRejectedValue(new ModerationClientError("x", 409, code));
      renderSection(claim("in_review"));
      await screen.findByLabelText(/Motivo de la retirada/);
      fireEvent.change(screen.getByLabelText(/Motivo de la retirada/), {
        target: { value: REASON },
      });
      fireEvent.click(screen.getByRole("button", { name: "Revisar y retirar…" }));
      fireEvent.click(await button("Confirmar retirada"));
      expect(await screen.findByRole("alert")).toHaveTextContent(text);
      if (code.endsWith("version_conflict")) expect(onChanged).toHaveBeenCalled();
      expect(onAccessError).toHaveBeenCalled();
    },
  );
});

describe("aviso al autor", () => {
  it("si el aviso inicial no se envió, lo dice, bloquea el plazo y permite reintentarlo con un solo clic", async () => {
    api.resend.mockResolvedValue(result());
    renderSection(
      claim("removed", {
        removal: removalInfo({
          notifiedAt: null,
          appealDeadline: null,
          notifyAttempts: 2,
          notifyLastError: "timeout",
          purgeBlockers: ["notification_pending"],
        }),
      }),
    );
    expect(await screen.findByText(/no se ha enviado todavía/)).toBeTruthy();
    expect(screen.getByText(/Intentos fallidos: 2/)).toBeTruthy();
    expect(screen.getByText(/tiempo de espera agotado/)).toBeTruthy();
    expect(
      screen.getByText("Empieza cuando se confirme el envío del aviso inicial."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reintentar el aviso al autor" }));
    await waitFor(() =>
      expect(api.resend).toHaveBeenCalledWith({ id: ID, kind: "removal" }),
    );
    expect(await screen.findByText("Aviso enviado al autor.")).toBeTruthy();
  });

  it("un aviso de resolución pendiente se reintenta con el tipo que corresponde a la decisión", async () => {
    api.resend.mockResolvedValue(result());
    for (const [status, kind] of [
      ["accepted", "appeal_accepted"],
      ["rejected", "appeal_rejected"],
    ] as const) {
      renderSection(
        claim(status === "accepted" ? "restored" : "removed", {
          removal: removalInfo({
            resolutionNoticePending: true,
            purgeBlockers: ["resolution_notice_pending"],
          }),
          appeal: appeal(status),
        }),
      );
      fireEvent.click(await button("Reintentar el aviso de resolución"));
      await waitFor(() => expect(api.resend).toHaveBeenLastCalledWith({ id: ID, kind }));
      cleanup();
    }
  });
});

describe("apelación", () => {
  const pending = () =>
    claim("appeal_pending", {
      removal: removalInfo({ purgeBlockers: ["appeal_pending"] }),
      appeal: appeal("pending"),
    });

  it("muestra los datos de la apelación (texto y enlaces seguros) y exige justificación para resolver", async () => {
    renderSection(pending());
    expect(await screen.findByText("Apelación del autor")).toBeTruthy();
    expect(screen.getByText("La ilustración es mía")).toBeTruthy();
    expect(screen.getByText("Es obra propia")).toBeTruthy();
    const link = screen.getByRole("link", { name: "https://example.com/prueba" });
    expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(link.getAttribute("target")).toBe("_blank");
    fireEvent.click(
      screen.getByRole("button", { name: "Aceptar apelación y restaurar" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Escribe la justificación/,
    );
    fireEvent.click(screen.getByRole("button", { name: "Rechazar apelación" }));
    expect(api.resolve).not.toHaveBeenCalled();
  });

  it.each([
    ["Aceptar apelación y restaurar", "accept", /la publicación se ha restaurado/],
    ["Rechazar apelación", "reject", /la publicación sigue oculta/],
  ])(
    "%s envía la decisión con la versión vigente y la justificación",
    async (label, decision, message) => {
      api.resolve.mockResolvedValue(
        result({ status: decision === "accept" ? "restored" : "removed" }),
      );
      renderSection(pending());
      fireEvent.change(
        await screen.findByLabelText(/Justificación de la decisión \(obligatoria/),
        {
          target: { value: "  Decisión motivada  " },
        },
      );
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() =>
        expect(api.resolve).toHaveBeenCalledWith({
          id: ID,
          expectedVersion: 4,
          decision,
          note: "Decisión motivada",
        }),
      );
      expect(await screen.findByText(message)).toBeTruthy();
      expect(onChanged).toHaveBeenCalled();
    },
  );

  it("restore_unsafe se explica y deja la apelación pendiente", async () => {
    api.resolve.mockRejectedValue(new ModerationClientError("x", 409, "restore_unsafe"));
    renderSection(pending());
    fireEvent.change(
      await screen.findByLabelText(/Justificación de la decisión \(obligatoria/),
      {
        target: { value: "nota" },
      },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Aceptar apelación y restaurar" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /No se puede restaurar con seguridad/,
    );
  });

  it("una apelación ya resuelta no ofrece resolverla otra vez", async () => {
    renderSection(
      claim("removed", { removal: removalInfo(), appeal: appeal("rejected") }),
    );
    expect(await screen.findByText("Decisión motivada")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rechazar apelación" })).toBeNull();
  });
});

describe("eliminación definitiva manual", () => {
  it.each([
    [
      ["notification_pending"],
      /aviso inicial al autor aún no se ha enviado correctamente/,
    ],
    [["window_open"], /plazo de apelación sigue abierto/],
    [["appeal_pending", "window_open"], /apelación pendiente de resolver/],
    [["resolution_notice_pending"], /aviso de resolución al autor está pendiente/],
  ] as const)(
    "con %j el botón está deshabilitado y explica por qué",
    async (blockers, text) => {
      renderSection(
        claim("removed", { removal: removalInfo({ purgeBlockers: [...blockers] }) }),
      );
      expect(await screen.findByText(text)).toBeTruthy();
      expect(
        (
          screen.getByRole("button", {
            name: "Eliminar definitivamente",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(api.purge).not.toHaveBeenCalled();
    },
  );

  it("cumplidas todas las condiciones se habilita, pide confirmación con la publicación y una nota, y entonces elimina", async () => {
    api.purge.mockResolvedValue(
      result({
        status: "purged",
        notice: "none",
        assetsMarked: 2,
        assetsRetained: 1,
        postDeleted: true,
      }),
    );
    renderSection(
      claim("removed", {
        removal: removalInfo({ purgeBlockers: [] }),
        currentPost: {
          status: "hidden",
          text: "Texto oculto",
          version: 8,
          mediaCount: 3,
        },
      }),
    );
    const open = (await screen.findByRole("button", {
      name: "Eliminar definitivamente",
    })) as HTMLButtonElement;
    expect(open.disabled).toBe(false);
    fireEvent.click(open);
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Confirmar la eliminación definitiva")).toBeTruthy();
    expect(within(dialog).getByText("Texto oculto")).toBeTruthy();
    expect(within(dialog).getByText(REF)).toBeTruthy();
    expect(within(dialog).getByText(/No se puede deshacer/)).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Eliminar definitivamente" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Escribe la justificación o la nota/,
    );
    expect(api.purge).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(/Nota de la eliminación/), {
      target: { value: "  Eliminación confirmada  " },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Eliminar definitivamente" }),
    );
    await waitFor(() =>
      expect(api.purge).toHaveBeenCalledWith({
        id: ID,
        expectedVersion: 4,
        confirmReference: REF,
        note: "Eliminación confirmada",
      }),
    );
    expect(
      await screen.findByText(/2 archivos marcados para su borrado; 1 conservados/),
    ).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
  });

  it("aunque el botón estuviera habilitado, si el servidor rechaza la eliminación (purge_blocked) se informa", async () => {
    api.purge.mockRejectedValue(new ModerationClientError("x", 409, "purge_blocked"));
    renderSection(claim("removed", { removal: removalInfo({ purgeBlockers: [] }) }));
    fireEvent.click(await button("Eliminar definitivamente"));
    fireEvent.change(await screen.findByLabelText(/Nota de la eliminación/), {
      target: { value: "nota" },
    });
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Eliminar definitivamente",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Todavía no se cumplen las condiciones/,
    );
  });

  it("no ofrece eliminar en una reclamación que no está retirada, restaurada o ya eliminada", async () => {
    for (const status of ["restored", "purged"] as const) {
      renderSection(
        claim(status, {
          removal: removalInfo({
            restoredAt: status === "restored" ? "2026-10-12T12:00:00.000Z" : null,
            purgedAt: status === "purged" ? "2026-10-12T12:00:00.000Z" : null,
            purgeAssetsPending: status === "purged" ? 2 : null,
          }),
        }),
      );
      expect(
        screen.queryByRole("button", { name: "Eliminar definitivamente" }),
      ).toBeNull();
      cleanup();
    }
  });

  it("tras eliminar indica cuántos archivos esperan al borrado de almacenamiento", async () => {
    const view = renderSection(
      claim("purged", {
        removal: removalInfo({
          purgedAt: "2026-10-12T12:00:00.000Z",
          purgeAssetsPending: 2,
        }),
      }),
    );
    expect(await screen.findByText(/Publicación eliminada el/)).toBeTruthy();
    expect(screen.getByText(/2 archivos esperan al proceso de limpieza/)).toBeTruthy();
    view.unmount();
    renderSection(
      claim("purged", {
        removal: removalInfo({
          purgedAt: "2026-10-12T12:00:00.000Z",
          purgeAssetsPending: 0,
        }),
      }),
    );
    expect(
      await screen.findByText("Todos los archivos marcados ya se han eliminado."),
    ).toBeTruthy();
  });

  it("la restauración tras apelación se muestra en el historial", async () => {
    renderSection(
      claim("restored", {
        removal: removalInfo({ restoredAt: "2026-10-12T12:00:00.000Z" }),
        appeal: appeal("accepted"),
      }),
    );
    expect(await screen.findByText(/Publicación restaurada el/)).toBeTruthy();
  });
});

describe("idiomas", () => {
  it.each([
    ["en", "Removal, appeal and deletion", "Review and remove…"],
    ["de", "Entfernung, Einspruch und Löschung", "Prüfen und entfernen…"],
  ])("%s: textos traducidos y sin claves sin resolver", async (locale, title, review) => {
    localStorage.setItem("upmina:locale", locale);
    renderSection(claim("in_review"));
    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.getByRole("button", { name: review })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(
      /moderation\.copyright|MISSING_MESSAGE|undefined/,
    );
  });

  it.each([
    ["en", "Delete permanently"],
    ["de", "Endgültig löschen"],
  ])("%s: la eliminación y sus condiciones están traducidas", async (locale, label) => {
    localStorage.setItem("upmina:locale", locale);
    renderSection(
      claim("removed", {
        removal: removalInfo({ purgeBlockers: ["window_open", "notification_pending"] }),
      }),
    );
    expect(await screen.findByRole("button", { name: label })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(
      /moderation\.copyright|MISSING_MESSAGE|undefined/,
    );
  });
});
