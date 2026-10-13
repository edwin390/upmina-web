import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CopyrightClaimDetail,
  CopyrightStrikeApplyResult,
  CopyrightStrikeState,
} from "@/lib/copyright-contract";

const api = vi.hoisted(() => ({ state: vi.fn(), apply: vi.fn(), resend: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: null }));
vi.mock("@/lib/copyright-client", () => ({
  fetchCopyrightStrikeState: api.state,
  applyCopyrightStrike: api.apply,
  resendCopyrightStrikeNotice: api.resend,
}));

import UpminaLocaleProvider from "@/i18n/LocaleProvider";
import { ModerationClientError } from "@/lib/moderation-client";
import CopyrightStrikeSection from "./CopyrightStrikeSection";

// Strike MANUAL de Copyright (solo tras `purged`). Componente real; el cliente HTTP es un doble. El nivel, la elegibilidad y el estado
// del aviso los calcula el servidor: la interfaz solo los refleja y pide una confirmación explícita con motivo.

const ID = "0f000000-0000-4000-8000-0000000000c1";
const REF = "CPY-2026-000001";
const REASON = "Infringement confirmed after the permanent deletion.";

const claim = {
  id: ID,
  reference: REF,
  status: "purged",
  version: 7,
} as CopyrightClaimDetail;
const eligible = (level: 1 | 2 | 3 = 2): CopyrightStrikeState => ({
  eligible: true,
  blocker: null,
  nextLevel: level,
  strike: null,
  notice: null,
});
const applied = (
  notice: "sent" | "pending" | "failed" = "pending",
  over: Partial<NonNullable<CopyrightStrikeState["strike"]>> = {},
): CopyrightStrikeState => ({
  eligible: false,
  blocker: "strike_already_issued",
  nextLevel: null,
  strike: {
    id: "0f000000-0000-4000-8000-0000000000d1",
    level: 2,
    permanent: false,
    startsAt: "2026-10-14T10:00:00.000Z",
    endsAt: "2026-11-14T10:00:00.000Z",
    reason: REASON,
    revokedAt: null,
    ...over,
  },
  notice: {
    status: notice,
    attempts: notice === "failed" ? 1 : 0,
    error: notice === "failed" ? "provider_unavailable" : null,
  },
});
const applyResult = (
  over: Partial<CopyrightStrikeApplyResult> = {},
): CopyrightStrikeApplyResult => ({
  strikeId: "0f000000-0000-4000-8000-0000000000d1",
  claimId: ID,
  reference: REF,
  level: 2,
  permanent: false,
  endsAt: "2026-11-14T10:00:00.000Z",
  notice: "sent",
  noticeError: null,
  ...over,
});

const onChanged = vi.fn(async () => undefined);
const onAccessError = vi.fn();
function renderSection() {
  return render(
    <UpminaLocaleProvider>
      <CopyrightStrikeSection
        claim={claim}
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

describe("estado", () => {
  it("al cargar solo LEE el estado: no aplica nada y el botón exige una acción explícita", async () => {
    api.state.mockResolvedValue(eligible());
    renderSection();
    expect(await button("Aplicar strike…")).toBeTruthy();
    expect(api.state).toHaveBeenCalledWith(ID);
    expect(api.apply).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/Motivo del strike/)).toBeNull();
  });

  it.each([
    [
      "claim_not_purged",
      /solo puede aplicarse cuando la publicación ha sido eliminada definitivamente/,
    ],
    ["author_unavailable", /la cuenta del autor ya no está disponible/],
    ["self_strike_forbidden", /No puedes aplicar un strike sobre tu propio contenido/],
  ] as const)(
    "no elegible (%s): muestra el motivo y NO ofrece el botón",
    async (blocker, text) => {
      api.state.mockResolvedValue({
        eligible: false,
        blocker,
        nextLevel: null,
        strike: null,
        notice: null,
      });
      renderSection();
      expect(await screen.findByText(text)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Aplicar strike…" })).toBeNull();
    },
  );

  it("con un strike ya aplicado muestra nivel, motivo y aviso, y no ofrece aplicar otro", async () => {
    api.state.mockResolvedValue(applied("sent"));
    renderSection();
    expect(await screen.findByText("Strike aplicado")).toBeTruthy();
    expect(
      screen.getByText(
        /2 \/ 3 · Bloquea nuevas publicaciones y ediciones de Community durante 1 mes/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(REASON)).toBeTruthy();
    expect(screen.getByText("Enviado por correo.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Aplicar strike…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reenviar aviso" })).toBeNull();
  });

  it("un strike permanente (nivel 3) y uno revocado se muestran como tales", async () => {
    api.state.mockResolvedValue(
      applied("sent", {
        level: 3,
        permanent: true,
        endsAt: null,
        revokedAt: "2026-10-15T10:00:00.000Z",
      }),
    );
    renderSection();
    expect(await screen.findByText("Permanente")).toBeTruthy();
    expect(screen.getByText(/Revocado el/)).toBeTruthy();
  });

  it("un fallo de carga ofrece reintentar y avisa al contenedor", async () => {
    api.state.mockRejectedValueOnce(new ModerationClientError("x", 500));
    api.state.mockResolvedValueOnce(eligible());
    renderSection();
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /No se pudo cargar el estado del strike/,
    );
    expect(onAccessError).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await button("Aplicar strike…")).toBeTruthy();
  });
});

describe("aplicar", () => {
  async function openConfirmation(level: 1 | 2 | 3 = 2) {
    api.state.mockResolvedValue(eligible(level));
    renderSection();
    fireEvent.click(await button("Aplicar strike…"));
    return screen.findByLabelText(/Motivo del strike/);
  }

  it("la confirmación muestra la reclamación y el nivel calculado por el servidor", async () => {
    await openConfirmation(3);
    expect(screen.getByText(REF)).toBeTruthy();
    expect(screen.getByText(/3 \/ 3 · Bloquea permanentemente/)).toBeTruthy();
    expect(
      screen.getByText(/correo en inglés con el nivel, la duración y este motivo/),
    ).toBeTruthy();
    expect(screen.getByText(/No hay apelación nueva/)).toBeTruthy();
  });

  it("sin motivo no se envía nada", async () => {
    await openConfirmation();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar strike" }));
    expect(api.apply).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Motivo del strike/).getAttribute("aria-invalid")).toBe(
      "true",
    );
    fireEvent.change(screen.getByLabelText(/Motivo del strike/), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar strike" }));
    expect(api.apply).not.toHaveBeenCalled();
  });

  it("cancelar descarta el motivo y no aplica nada", async () => {
    const field = await openConfirmation();
    fireEvent.change(field, { target: { value: REASON } });
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(api.apply).not.toHaveBeenCalled();
    fireEvent.click(await button("Aplicar strike…"));
    expect(
      (screen.getByLabelText(/Motivo del strike/) as HTMLTextAreaElement).value,
    ).toBe("");
  });

  it("confirma con el motivo y el nivel mostrado; el doble clic envía UNA sola petición", async () => {
    let finish!: (r: CopyrightStrikeApplyResult) => void;
    api.apply.mockReturnValue(
      new Promise<CopyrightStrikeApplyResult>((resolve) => (finish = resolve)),
    );
    const field = await openConfirmation(2);
    fireEvent.change(field, { target: { value: `  ${REASON}  ` } });
    const submit = screen.getByRole("button", { name: "Confirmar strike" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(api.apply).toHaveBeenCalledTimes(1);
    expect(api.apply).toHaveBeenCalledWith({ id: ID, reason: REASON, expectedLevel: 2 });
    expect(
      (await screen.findByRole("button", { name: "Aplicando…" })).hasAttribute(
        "disabled",
      ),
    ).toBe(true);
    api.state.mockResolvedValue(applied("sent"));
    finish(applyResult());
    expect(await screen.findByText("Strike aplicado.")).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Aplicar strike…" })).toBeNull(),
    );
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(api.apply).toHaveBeenCalledTimes(1);
  });

  it("si el aviso por correo falló lo indica, ofrece reenviarlo y el reenvío actualiza el estado", async () => {
    api.apply.mockResolvedValue(
      applyResult({ notice: "failed", noticeError: "provider_unavailable" }),
    );
    const field = await openConfirmation();
    fireEvent.change(field, { target: { value: REASON } });
    api.state.mockResolvedValue(applied("failed"));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar strike" }));
    expect(
      await screen.findByText(/el aviso por correo falló: puedes reenviarlo/),
    ).toBeTruthy();
    expect(screen.getByText(/El envío falló \(provider_unavailable\)/)).toBeTruthy();
    api.resend.mockResolvedValue({ notice: "sent", noticeError: null });
    api.state.mockResolvedValue(applied("sent"));
    fireEvent.click(screen.getByRole("button", { name: "Reenviar aviso" }));
    await waitFor(() => expect(api.resend).toHaveBeenCalledWith(ID));
    expect(await screen.findByText("Enviado por correo.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reenviar aviso" })).toBeNull();
  });

  it("si el nivel cambió mientras se confirmaba, vuelve al estado real y pide confirmar de nuevo", async () => {
    api.apply.mockRejectedValue(new ModerationClientError("x", 409, "level_changed"));
    const field = await openConfirmation(1);
    fireEvent.change(field, { target: { value: REASON } });
    api.state.mockResolvedValue(eligible(2));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar strike" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /El nivel cambió mientras confirmabas/,
    );
    expect(screen.queryByLabelText(/Motivo del strike/)).toBeNull();
    fireEvent.click(await button("Aplicar strike…"));
    expect(screen.getByText(/2 \/ 3/)).toBeTruthy();
  });

  it("si ya existía un strike (otra sesión) lo muestra y no ofrece otro", async () => {
    api.apply.mockRejectedValue(
      new ModerationClientError("x", 409, "strike_already_issued"),
    );
    const field = await openConfirmation();
    fireEvent.change(field, { target: { value: REASON } });
    api.state.mockResolvedValue(applied("pending"));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar strike" }));
    expect(await screen.findByText("Strike aplicado")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Aplicar strike…" })).toBeNull();
  });

  it("un error genérico mantiene la confirmación abierta, sin duplicar y avisando al contenedor", async () => {
    api.apply.mockRejectedValue(new ModerationClientError("x", 500));
    const field = await openConfirmation();
    fireEvent.change(field, { target: { value: REASON } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar strike" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /No se pudo completar la acción/,
    );
    expect(onAccessError).toHaveBeenCalled();
    expect(screen.getByLabelText(/Motivo del strike/)).toBeTruthy();
    expect(api.apply).toHaveBeenCalledTimes(1);
  });
});
