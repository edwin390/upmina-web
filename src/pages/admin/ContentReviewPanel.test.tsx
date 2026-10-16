import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentReviewPage, EditReviewItem, HeldReviewItem, ReviewMedia } from "@/lib/content-review-client";
import { ModerationClientError } from "@/lib/moderation-client";

const client = vi.hoisted(() => ({ page: vi.fn(), decide: vi.fn() }));
vi.mock("@/lib/content-review-client", () => ({
  fetchContentReviewPage: client.page,
  decideContentReview: client.decide,
}));

import ContentReviewPanel from "./ContentReviewPanel";

const media = (assetId: string, extra: Partial<ReviewMedia> = {}): ReviewMedia => ({
  assetId, position: 0, isNew: false, kind: "image", width: 480, height: 320, durationSeconds: null,
  url: `https://media.test/${assetId}?cap=x`, ...extra,
});
const held = (id: string, extra: Partial<HeldReviewItem> = {}): HeldReviewItem => ({
  kind: "held_post", id, postId: id, version: 3, createdAt: "2026-10-01T10:00:00Z", text: `texto ${id}`,
  author: { username: "autora", displayName: "Autora" }, media: [media(`${id}-m1`)], ...extra,
});
const edit = (id: string, extra: Partial<EditReviewItem> = {}): EditReviewItem => ({
  kind: "pending_edit", id, postId: `post-${id}`, version: 5, baseVersion: 5, stale: false, postStatus: "published",
  requestedAt: "2026-10-02T10:00:00Z", author: { username: "otra", displayName: null },
  published: { text: "texto público", media: [media("a1"), media("a2", { position: 1 })] },
  proposed: { text: "texto nuevo", media: [media("a1"), media("a3", { position: 1, isNew: true })] },
  ...extra,
});
const page = (items: ContentReviewPage["items"], nextCursor: string | null = null, counts = { held: items.length, edits: 2 }): ContentReviewPage => ({
  items, nextCursor, counts,
});

const onAccessError = vi.fn();
const renderPanel = () => render(<ContentReviewPanel onAccessError={onAccessError} />);

beforeEach(() => {
  localStorage.setItem("upmina:locale", "es");
  client.page.mockReset();
  client.decide.mockReset();
  onAccessError.mockReset();
});
afterEach(() => cleanup());

describe("Revisión de contenido · listados", () => {
  it("muestra la cola de retenidas con autor, fecha, texto, estado, archivos y contadores; sin inventar motivos", async () => {
    client.page.mockResolvedValue(page([held("p1"), held("p2", { text: null, media: [media("x", { url: null })] })], null, { held: 2, edits: 4 }));
    renderPanel();
    expect(await screen.findByText("texto p1")).toBeTruthy();
    expect(client.page).toHaveBeenCalledWith("held", null, expect.any(AbortSignal));
    expect(screen.getAllByText("Autor: @autora")).toHaveLength(2);
    expect(screen.getAllByText("Retenida · sin publicar")).toHaveLength(2);
    expect(screen.getAllByText("Motivo de retención: no registrado.")).toHaveLength(2);
    expect(screen.getByText("Sin texto")).toBeTruthy();
    expect(screen.getByText(/Vista previa no disponible/)).toBeTruthy();
    expect(screen.getByRole("img", { name: /Imagen/ }).getAttribute("src")).toContain("cap=x");
    const tabs = screen.getByRole("navigation", { name: "Tipos de revisión" });
    expect(within(tabs).getByRole("button", { name: /Publicaciones retenidas/ }).textContent).toContain("2");
    expect(within(tabs).getByRole("button", { name: /Ediciones pendientes/ }).textContent).toContain("4");
  });

  it("estados de carga, vacío y error con reintento", async () => {
    let resolve!: (p: ContentReviewPage) => void;
    client.page.mockReturnValueOnce(new Promise<ContentReviewPage>((r) => (resolve = r)));
    renderPanel();
    expect(screen.getByRole("status").textContent).toContain("Cargando");
    resolve(page([], null, { held: 0, edits: 0 }));
    expect(await screen.findByText("No hay publicaciones retenidas pendientes de revisión.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Ediciones pendientes/ }));
    client.page.mockRejectedValueOnce(new ModerationClientError("x", 500));
    fireEvent.click(screen.getByRole("button", { name: /Publicaciones retenidas/ }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    client.page.mockResolvedValueOnce(page([], null, { held: 0, edits: 0 }));
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByText("No hay publicaciones retenidas pendientes de revisión.")).toBeTruthy();
    expect(onAccessError).toHaveBeenCalled();
  });

  it("pagina con 'Cargar más' conservando lo ya cargado", async () => {
    client.page.mockResolvedValueOnce(page([held("p1")], "cursor-1"));
    renderPanel();
    await screen.findByText("texto p1");
    client.page.mockResolvedValueOnce(page([held("p2")], null));
    fireEvent.click(screen.getByRole("button", { name: "Cargar más" }));
    expect(await screen.findByText("texto p2")).toBeTruthy();
    expect(screen.getByText("texto p1")).toBeTruthy();
    expect(client.page).toHaveBeenLastCalledWith("held", "cursor-1", expect.any(AbortSignal));
    expect(screen.queryByRole("button", { name: "Cargar más" })).toBeNull();
  });

  it("ediciones: separa claramente lo publicado de lo pendiente y resume las diferencias", async () => {
    client.page.mockResolvedValue(page([edit("e1")]));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /Ediciones pendientes/ }));
    const published = await screen.findByRole("region", { name: "Publicado actualmente" });
    const proposed = screen.getByRole("region", { name: "Versión propuesta (pendiente)" });
    expect(within(published).getByText("texto público")).toBeTruthy();
    expect(within(proposed).getByText("texto nuevo")).toBeTruthy();
    expect(within(published).getByText("Se retira")).toBeTruthy();
    expect(within(proposed).getByText("Nuevo")).toBeTruthy();
    expect(screen.getByTestId("edit-diff-summary").textContent).toContain("Texto modificado");
    expect(screen.getByTestId("edit-diff-summary").textContent).toContain("1 archivo nuevo");
    expect(screen.getByText("Edición pendiente")).toBeTruthy();
    expect(screen.getByText("Autor: @otra")).toBeTruthy();
  });

  it("una edición obsoleta solo se puede rechazar", async () => {
    client.page.mockResolvedValue(page([edit("e1", { stale: true, baseVersion: 4 })]));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /Ediciones pendientes/ }));
    await screen.findByText(/Obsoleta/);
    expect((screen.getByRole("button", { name: "Aprobar" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Rechazar" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/solo se puede rechazar/)).toBeTruthy();
  });
});

describe("Revisión de contenido · decisiones", () => {
  it("aprobar una retenida pide confirmación, envía la versión vista, informa y recarga la cola", async () => {
    client.page.mockResolvedValueOnce(page([held("p1")])).mockResolvedValueOnce(page([], null, { held: 0, edits: 2 }));
    client.decide.mockResolvedValue(undefined);
    renderPanel();
    await screen.findByText("texto p1");
    fireEvent.click(screen.getByRole("button", { name: "Aprobar" }));
    expect(screen.getByText("¿Aprobar y publicar esta publicación?")).toBeTruthy();
    expect(client.decide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByText("¿Aprobar y publicar esta publicación?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Aprobar" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(client.decide).toHaveBeenCalledWith({ kind: "held_post", id: "p1", decision: "approve", expectedVersion: 3 }));
    expect((await screen.findByRole("status")).textContent).toContain("Publicación aprobada y publicada.");
    expect(client.page).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("No hay publicaciones retenidas pendientes de revisión.")).toBeTruthy();
  });

  it("rechazar una edición no envía versión y avisa de que la versión pública no cambia", async () => {
    client.page.mockResolvedValue(page([edit("e1")]));
    client.decide.mockResolvedValue(undefined);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /Ediciones pendientes/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Rechazar" }));
    expect(screen.getByText("¿Rechazar esta edición? La versión pública no cambia.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(client.decide).toHaveBeenCalledWith({ kind: "pending_edit", id: "e1", decision: "reject", expectedVersion: null }));
    expect(await screen.findByText("Edición rechazada: la versión pública no ha cambiado.")).toBeTruthy();
  });

  it("aprobar una edición envía la versión pública actual", async () => {
    client.page.mockResolvedValue(page([edit("e1")]));
    client.decide.mockResolvedValue(undefined);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /Ediciones pendientes/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Aprobar" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(client.decide).toHaveBeenCalledWith({ kind: "pending_edit", id: "e1", decision: "approve", expectedVersion: 5 }));
  });

  it("evita dobles clics: una sola petición mientras la decisión está en curso", async () => {
    client.page.mockResolvedValue(page([held("p1")]));
    let done!: () => void;
    client.decide.mockReturnValue(new Promise<void>((r) => (done = r)));
    renderPanel();
    await screen.findByText("texto p1");
    fireEvent.click(screen.getByRole("button", { name: "Rechazar" }));
    const confirm = screen.getByRole("button", { name: "Confirmar" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(client.decide).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Procesando…" }) as HTMLButtonElement).disabled).toBe(true);
    done();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Procesando…" })).toBeNull());
  });

  it.each([
    ["version_conflict", "El contenido cambió mientras lo revisabas. La cola se ha actualizado."],
    ["edit_not_pending", "Esta edición ya se había decidido."],
    ["post_not_held", "Esta publicación ya no está retenida."],
    ["asset_not_ready", "Algún archivo de la edición ya no está disponible. Solo se puede rechazar."],
    ["post_copyright_protected", "La publicación tiene una retirada o apelación de copyright activa."],
    ["post_not_editable", "La publicación no está publicada ahora, así que no se puede aplicar la edición."],
  ])("error %s: mensaje claro y la cola se recarga", async (code, message) => {
    client.page.mockResolvedValue(page([held("p1")]));
    client.decide.mockRejectedValue(new ModerationClientError("x", 409, code));
    renderPanel();
    await screen.findByText("texto p1");
    fireEvent.click(screen.getByRole("button", { name: "Aprobar" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(client.page).toHaveBeenCalledTimes(2);
    expect(onAccessError).toHaveBeenCalled();
  });

  it("un error desconocido muestra un mensaje genérico sin detalles del servidor", async () => {
    client.page.mockResolvedValue(page([held("p1")]));
    client.decide.mockRejectedValue(new ModerationClientError("relation secret does not exist", 500));
    renderPanel();
    await screen.findByText("texto p1");
    fireEvent.click(screen.getByRole("button", { name: "Rechazar" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect((await screen.findByRole("alert")).textContent).toBe("No se pudo completar la acción. Inténtalo de nuevo.");
    expect(screen.queryByText(/secret/)).toBeNull();
  });
});

describe("traducciones ES/EN/DE", () => {
  const load = (l: string) => JSON.parse(readFileSync(resolve(`src/i18n/locales/${l}/moderation.json`), "utf8"));
  const leaves = (o: unknown, prefix = ""): Record<string, string> =>
    typeof o === "string"
      ? { [prefix]: o }
      : Object.entries(o as Record<string, unknown>).reduce((acc, [k, v]) => ({ ...acc, ...leaves(v, prefix ? `${prefix}.${k}` : k) }), {});
  it("las tres lenguas tienen las mismas claves, textos no vacíos y los mismos marcadores", () => {
    const es = leaves(load("es").contentReview);
    for (const l of ["en", "de"]) {
      const other = leaves(load(l).contentReview);
      expect(Object.keys(other).sort()).toEqual(Object.keys(es).sort());
      for (const [k, v] of Object.entries(other)) {
        expect(v.length, `${l}.${k}`).toBeGreaterThan(0);
        const vars = (s: string) => [...s.matchAll(/\{(\w+)\s*[,}]/g)].map((m) => m[1]).sort();
        expect(vars(v), `${l}.${k}`).toEqual(vars(es[k]!));
      }
    }
    expect(load("es").copyright.panel.sections.content).toBe("Revisión de contenido");
    expect(load("en").copyright.panel.sections.content).toBe("Content Review");
    expect(load("de").copyright.panel.sections.content).toBe("Inhaltsprüfung");
  });
});
