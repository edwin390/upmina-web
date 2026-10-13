import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CopyrightClaimDetail,
  CopyrightClaimStatus,
  CopyrightClaimSummary,
} from "@/lib/copyright-contract";

const api = vi.hoisted(() => ({ page: vi.fn(), detail: vi.fn(), review: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: null }));
vi.mock("@/lib/copyright-client", () => ({
  fetchCopyrightClaimPage: api.page,
  fetchCopyrightClaim: api.detail,
  reviewCopyrightClaim: api.review,
}));

import { ModerationClientError } from "@/lib/moderation-client";
import UpminaLocaleProvider from "@/i18n/LocaleProvider";
import CopyrightClaimsPanel from "./CopyrightClaimsPanel";

// Pestaña de copyright (COPY-1 fase 2A). Componente real; el cliente HTTP es un doble. Solo cambia el estado de la reclamación.

const uuid = (n: number) => `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const summary = (
  n: number,
  status: CopyrightClaimStatus = "received",
): CopyrightClaimSummary => ({
  id: uuid(n),
  reference: `CPY-2026-${String(n).padStart(6, "0")}`,
  status,
  version: 1,
  claimantName: `Persona ${n}`,
  relationship: n % 2 ? "owner" : "authorized_representative",
  postFound: n % 2 === 1,
  createdAt: "2026-10-12T10:00:00.000Z",
  updatedAt: "2026-10-12T10:00:00.000Z",
});
const detail = (
  n: number,
  status: CopyrightClaimStatus = "received",
  version = 1,
): CopyrightClaimDetail => ({
  ...summary(n, status),
  version,
  claimantEmail: "ana@example.com",
  organization: "Estudio Ejemplo",
  workDescription: "Ilustración original de 2025",
  infringementDescription: "Copia mi ilustración",
  evidenceUrls: ["https://example.com/portafolio", "https://example.org/otra"],
  claimedPostUrl: `https://upmina.test/community/${uuid(900 + n)}`,
  postId: uuid(900 + n),
  postTextSnapshot: "Texto congelado de la publicación",
  postMediaCount: 2,
  currentPostStatus: "published",
  currentPost: { status: "published", text: "Texto actual", version: 2, mediaCount: 2 },
  statementVersion: "v1",
  signature: "Ana Titular",
  removal: null,
  appeal: null,
  events: [
    {
      kind: "received",
      actorKind: "claimant",
      fromStatus: null,
      toStatus: "received",
      note: null,
      createdAt: "2026-10-12T10:00:00.000Z",
    },
    {
      kind: "note",
      actorKind: "human",
      fromStatus: status,
      toStatus: status,
      note: "Nota de una revisión previa",
      createdAt: "2026-10-12T10:30:00.000Z",
    },
  ],
});
const onAccessError = vi.fn();
function renderPanel() {
  return render(
    <UpminaLocaleProvider>
      <CopyrightClaimsPanel onAccessError={onAccessError} />
    </UpminaLocaleProvider>,
  );
}
async function openFirst(status: CopyrightClaimStatus = "received", version = 1) {
  api.page.mockResolvedValue({ claims: [summary(1, status)], nextCursor: null });
  api.detail.mockResolvedValue(detail(1, status, version));
  renderPanel();
  fireEvent.click(
    await screen.findByRole("button", { name: "Abrir detalles CPY-2026-000001" }),
  );
  return screen.findByRole("region", { name: "Detalles de la reclamación" });
}

beforeEach(() => {
  for (const m of [api.page, api.detail, api.review, onAccessError]) m.mockReset();
  localStorage.clear();
  localStorage.setItem("upmina:locale", "es");
});
afterEach(() => cleanup());

describe("cola", () => {
  it("lista las reclamaciones abiertas con su estado, relación y si se encontró la publicación", async () => {
    api.page.mockResolvedValue({
      claims: [summary(1), summary(2, "in_review")],
      nextCursor: null,
    });
    renderPanel();
    expect(await screen.findByText("CPY-2026-000001")).toBeTruthy();
    expect(screen.getByText("CPY-2026-000002")).toBeTruthy();
    expect(screen.getByText("Recibida")).toBeTruthy();
    expect(screen.getByText("En revisión")).toBeTruthy();
    expect(screen.getByText(/Persona 1 · Titular de los derechos/)).toBeTruthy();
    expect(screen.getByText(/Persona 2 · Representante autorizado/)).toBeTruthy();
    expect(
      screen.getAllByText(/Publicación encontrada|Publicación no encontrada/),
    ).toHaveLength(2);
    expect(api.page).toHaveBeenCalledWith("open", null, expect.any(AbortSignal));
    expect(
      screen.getByText(
        /Revisar una reclamación solo cambia su estado\. La publicación únicamente se oculta con la acción explícita/,
      ),
    ).toBeTruthy();
  });

  it("estados vacíos y cambio a «Cerradas»", async () => {
    api.page.mockResolvedValue({ claims: [], nextCursor: null });
    renderPanel();
    expect(await screen.findByText("No hay reclamaciones abiertas.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cerradas" }));
    expect(
      await screen.findByText("Todavía no hay reclamaciones cerradas."),
    ).toBeTruthy();
    expect(api.page).toHaveBeenLastCalledWith("closed", null, expect.any(AbortSignal));
    expect(
      screen.getByRole("button", { name: "Cerradas" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("un error de carga ofrece reintentar y avisa al contenedor para gestionar sesión/MFA", async () => {
    const error = new ModerationClientError("No autorizado", 403, "step_up_required");
    api.page
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ claims: [summary(1)], nextCursor: null });
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No se pudieron cargar las reclamaciones.",
    );
    expect(onAccessError).toHaveBeenCalledWith(error);
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByText("CPY-2026-000001")).toBeTruthy();
  });

  it("pagina por cursor hacia delante y hacia atrás", async () => {
    api.page.mockImplementation(async (_scope: string, cursor: string | null) =>
      cursor === "c1"
        ? { claims: [summary(2)], nextCursor: null }
        : { claims: [summary(1)], nextCursor: "c1" },
    );
    renderPanel();
    await screen.findByText("CPY-2026-000001");
    fireEvent.click(screen.getByRole("button", { name: "Siguiente página" }));
    expect(await screen.findByText("CPY-2026-000002")).toBeTruthy();
    expect(api.page).toHaveBeenLastCalledWith("open", "c1", expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("button", { name: "←" }));
    expect(await screen.findByText("CPY-2026-000001")).toBeTruthy();
    expect(api.page).toHaveBeenLastCalledWith("open", null, expect.any(AbortSignal));
  });
});

describe("detalle", () => {
  it("muestra los datos del expediente, la copia congelada y el historial", async () => {
    const region = await openFirst();
    expect(within(region).getByText("ana@example.com")).toBeTruthy();
    expect(within(region).getByText("Estudio Ejemplo")).toBeTruthy();
    expect(within(region).getByText("Ilustración original de 2025")).toBeTruthy();
    expect(within(region).getByText("Texto congelado de la publicación")).toBeTruthy();
    expect(within(region).getByText("published")).toBeTruthy();
    expect(within(region).getByText("Reclamación recibida")).toBeTruthy();
    expect(within(region).getByText("Nota de una revisión previa")).toBeTruthy();
    expect(api.detail).toHaveBeenCalledWith(uuid(1), expect.any(AbortSignal));
  });

  it("los enlaces de prueba se abren en otra pestaña sin referrer ni opener", async () => {
    const region = await openFirst();
    const links = within(region).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "https://example.com/portafolio",
      "https://example.org/otra",
    ]);
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    }
  });

  it("si la publicación ya no existe lo indica; un fallo de carga muestra un aviso", async () => {
    api.page.mockResolvedValue({ claims: [summary(1)], nextCursor: null });
    api.detail.mockResolvedValue({ ...detail(1), currentPostStatus: null });
    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: "Abrir detalles CPY-2026-000001" }),
    );
    expect(await screen.findByText("La publicación ya no existe")).toBeTruthy();
    cleanup();
    api.detail.mockRejectedValue(new ModerationClientError("x", 500));
    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: "Abrir detalles CPY-2026-000001" }),
    );
    expect(await screen.findByText("No se pudo cargar la reclamación.")).toBeTruthy();
  });

  it("cerrar el detalle devuelve el foco al botón que lo abrió", async () => {
    await openFirst();
    const opener = screen.getByRole("button", { name: "Abrir detalles CPY-2026-000001" });
    fireEvent.click(screen.getByRole("button", { name: "Cerrar detalles" }));
    expect(
      screen.queryByRole("region", { name: "Detalles de la reclamación" }),
    ).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("ubicación del detalle", () => {
  for (const scope of ["open", "closed"] as const) {
    it(`en «${scope === "open" ? "Abiertas" : "Cerradas"}» el detalle aparece DENTRO de la reclamación abierta, antes de la siguiente, y nunca duplicado`, async () => {
      api.page.mockResolvedValue({
        claims: [summary(1), summary(2), summary(3)],
        nextCursor: null,
      });
      api.detail.mockImplementation(async (id: string) =>
        detail(Number(id.slice(-3)), "received"),
      );
      renderPanel();
      if (scope === "closed")
        fireEvent.click(await screen.findByRole("button", { name: "Cerradas" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Abrir detalles CPY-2026-000002" }),
      );
      const region = await screen.findByRole("region", {
        name: "Detalles de la reclamación",
      });
      const items = screen
        .getAllByRole("listitem")
        .filter((li) => li.querySelector("span.font-mono"));
      expect(items).toHaveLength(3);
      // El detalle vive dentro del <li> de la reclamación 2 y de ninguna otra.
      expect(items[1]!.contains(region)).toBe(true);
      expect(items[0]!.contains(region)).toBe(false);
      expect(items[2]!.contains(region)).toBe(false);
      expect(
        screen.getAllByRole("region", { name: "Detalles de la reclamación" }),
      ).toHaveLength(1);
      expect(document.querySelectorAll("#copyright-claim-detail")).toHaveLength(1);
      // Al abrir otra reclamación, el detalle se mueve debajo de ella.
      fireEvent.click(
        screen.getByRole("button", { name: "Abrir detalles CPY-2026-000003" }),
      );
      const moved = await screen.findByRole("region", {
        name: "Detalles de la reclamación",
      });
      await waitFor(() => expect(items[2]!.contains(moved)).toBe(true));
      expect(items[1]!.contains(moved)).toBe(false);
      expect(document.querySelectorAll("#copyright-claim-detail")).toHaveLength(1);
    });
  }
});

describe("acciones de revisión", () => {
  const names = (region: HTMLElement) =>
    within(region)
      .getAllByRole("button")
      .map((b) => b.textContent)
      // La retirada (fase 2B) tiene su propia sección y sus propios tests (CopyrightRemovalSection.test.tsx).
      .filter((t) => t !== "Cerrar detalles" && t !== "Revisar y retirar…");

  it.each([
    [
      "received",
      [
        "Iniciar revisión",
        "Descartar reclamación",
        "Registrar retirada del reclamante",
        "Añadir nota",
      ],
    ],
    [
      "in_review",
      [
        "Pedir más información",
        "Descartar reclamación",
        "Registrar retirada del reclamante",
        "Añadir nota",
      ],
    ],
    [
      "needs_info",
      [
        "Reanudar revisión",
        "Descartar reclamación",
        "Registrar retirada del reclamante",
        "Añadir nota",
      ],
    ],
  ] as const)("en %s ofrece solo las acciones permitidas", async (status, expected) => {
    const region = await openFirst(status);
    expect(names(region)).toEqual(expected);
  });

  it.each(["dismissed", "withdrawn"] as const)(
    "%s está cerrada: sin acciones ni campo de nota",
    async (status) => {
      const region = await openFirst(status);
      expect(
        within(region).getByText("Esta reclamación está cerrada y ya no admite cambios."),
      ).toBeTruthy();
      expect(names(region)).toEqual([]);
      expect(within(region).queryByLabelText("Nota de revisión")).toBeNull();
    },
  );

  it("ninguna acción de REVISIÓN oculta, restaura ni elimina la publicación (la retirada es una acción aparte con segunda confirmación)", async () => {
    for (const status of ["received", "in_review", "needs_info"] as const) {
      const region = await openFirst(status);
      for (const name of names(region))
        expect(name).not.toMatch(/restaur|ocult|elimin|purg|borrar/i);
      cleanup();
    }
  });

  it("iniciar la revisión no exige nota, usa la versión mostrada y recarga cola y detalle", async () => {
    const region = await openFirst("received", 3);
    api.review.mockResolvedValue({
      id: uuid(1),
      reference: "CPY-2026-000001",
      status: "in_review",
      version: 4,
      updatedAt: "2026-10-12T11:00:00.000Z",
    });
    api.detail.mockResolvedValue(detail(1, "in_review", 4));
    fireEvent.click(within(region).getByRole("button", { name: "Iniciar revisión" }));
    expect(await screen.findByText("Revisión registrada.")).toBeTruthy();
    expect(api.review).toHaveBeenCalledWith({
      id: uuid(1),
      action: "start_review",
      expectedVersion: 3,
      note: undefined,
    });
    await waitFor(() => expect(api.detail).toHaveBeenCalledTimes(2));
    expect(api.page.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(
      await screen.findByRole("button", { name: "Pedir más información" }),
    ).toBeTruthy();
  });

  it("descartar exige nota: sin ella no se llama al servidor; con ella se envía recortada", async () => {
    const region = await openFirst("in_review");
    fireEvent.click(
      within(region).getByRole("button", { name: "Descartar reclamación" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Escribe una nota para esta acción.",
    );
    expect(api.review).not.toHaveBeenCalled();
    fireEvent.change(within(region).getByLabelText("Nota de revisión"), {
      target: { value: "   " },
    });
    fireEvent.click(
      within(region).getByRole("button", { name: "Descartar reclamación" }),
    );
    expect(api.review).not.toHaveBeenCalled();
    api.review.mockResolvedValue({
      id: uuid(1),
      reference: "CPY-2026-000001",
      status: "dismissed",
      version: 2,
      updatedAt: "2026-10-12T11:00:00.000Z",
    });
    api.detail.mockResolvedValue(detail(1, "dismissed", 2));
    fireEvent.change(within(region).getByLabelText("Nota de revisión"), {
      target: { value: "  Sin fundamento tras revisar  " },
    });
    fireEvent.click(
      within(region).getByRole("button", { name: "Descartar reclamación" }),
    );
    await screen.findByText("Revisión registrada.");
    expect(api.review).toHaveBeenCalledWith({
      id: uuid(1),
      action: "dismiss",
      expectedVersion: 1,
      note: "Sin fundamento tras revisar",
    });
  });

  it("una nota con caracteres de control o demasiado larga no se envía", async () => {
    const region = await openFirst("in_review");
    for (const bad of ["texto\u0007malo", "x".repeat(1001)]) {
      fireEvent.change(within(region).getByLabelText("Nota de revisión"), {
        target: { value: bad },
      });
      fireEvent.click(within(region).getByRole("button", { name: "Añadir nota" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("La nota no es válida");
    }
    expect(api.review).not.toHaveBeenCalled();
  });

  it("un conflicto de versión recarga el detalle y avisa, sin dar la acción por hecha", async () => {
    const region = await openFirst("received", 1);
    api.review.mockRejectedValue(new ModerationClientError("x", 409, "version_conflict"));
    api.detail.mockResolvedValue(detail(1, "in_review", 2));
    fireEvent.click(within(region).getByRole("button", { name: "Iniciar revisión" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "La reclamación cambió mientras la revisabas",
    );
    expect(screen.queryByText("Revisión registrada.")).toBeNull();
    await waitFor(() => expect(api.detail).toHaveBeenCalledTimes(2));
  });

  it("una transición ya imposible, un fallo genérico y un error de acceso se tratan sin éxito falso", async () => {
    const region = await openFirst("received");
    api.review.mockRejectedValueOnce(
      new ModerationClientError("x", 409, "invalid_transition"),
    );
    fireEvent.click(within(region).getByRole("button", { name: "Iniciar revisión" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Esa acción ya no es posible en el estado actual.",
    );
    const denied = new ModerationClientError("No autorizado", 403, "step_up_required");
    api.review.mockRejectedValueOnce(denied);
    fireEvent.click(within(region).getByRole("button", { name: "Iniciar revisión" }));
    await waitFor(() => expect(onAccessError).toHaveBeenCalledWith(denied));
    api.review.mockRejectedValueOnce(new Error("red caída"));
    fireEvent.click(within(region).getByRole("button", { name: "Iniciar revisión" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No se pudo registrar la revisión.",
    );
    expect(screen.queryByText("Revisión registrada.")).toBeNull();
  });

  it("mientras se guarda, las acciones quedan bloqueadas y no se duplican", async () => {
    const region = await openFirst("received");
    let resolve!: (v: unknown) => void;
    api.review.mockReturnValue(new Promise((r) => (resolve = r)));
    api.detail.mockResolvedValue(detail(1, "in_review", 2));
    fireEvent.click(within(region).getByRole("button", { name: "Iniciar revisión" }));
    const buttons = await within(region).findAllByRole("button", { name: "Guardando…" });
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect((b as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(buttons[0]!);
    expect(api.review).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve({
        id: uuid(1),
        reference: "CPY-2026-000001",
        status: "in_review",
        version: 2,
        updatedAt: "2026-10-12T11:00:00.000Z",
      });
    });
    await screen.findByText("Revisión registrada.");
  });
});

describe("idiomas", () => {
  it.each([
    ["en", "Copyright claims", "Open"],
    ["de", "Urheberrechtsbeschwerden", "Offen"],
  ])("%s: textos de la pestaña traducidos", async (locale, title, scope) => {
    localStorage.setItem("upmina:locale", locale);
    api.page.mockResolvedValue({ claims: [summary(1)], nextCursor: null });
    renderPanel();
    expect(await screen.findByRole("heading", { name: title })).toBeTruthy();
    expect(screen.getByRole("button", { name: scope })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(
      /moderation\.copyright|MISSING_MESSAGE/,
    );
  });
});
