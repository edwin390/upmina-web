import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CommunityFeedPost } from "@/types";
import CommunityPostMediaViewer from "./CommunityPostMediaViewer";

// Visor de media del detalle de una publicación (Fase 9J-3 follow-up "POST DETAIL MEDIA VIEWER"):
// UN solo media visible a la vez, orden autoritativo del autor, object-contain con una altura
// MÁXIMA (nunca recorta/deforma/exige scroll para ver un vídeo vertical completo), navegación
// prev/next + teclado ArrowLeft/ArrowRight (mismo guard de inputs que CosplayLightbox), pausa del
// vídeo activo al navegar.
//
// Las imágenes de Comunidad usan alt="" (sin columna alt en el modelo, a diferencia de Cosplay):
// un <img alt=""> tiene role implícito "presentation", no "img" — por eso se consultan por
// selector, no por role="img" (mismo criterio que el resto de tests de Comunidad).

function media(overrides: Partial<CommunityFeedPost["media"][number]> = {}) {
  return {
    id: "m1",
    position: 0,
    kind: "image" as const,
    url: "https://example.test/m1.webp",
    width: 1200,
    height: 1600,
    durationSeconds: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("CommunityPostMediaViewer — un solo media", () => {
  it("una sola imagen: sin flechas de navegación ni contador", () => {
    const { container } = render(<CommunityPostMediaViewer media={[media()]} />);
    expect(screen.queryByRole("button", { name: "Anterior" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Siguiente" })).toBeNull();
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.test/m1.webp",
    );
  });

  it("un solo vídeo: sin flechas de navegación", () => {
    const { container } = render(
      <CommunityPostMediaViewer
        media={[media({ kind: "video", url: "https://example.test/m1.mp4" })]}
      />,
    );
    expect(screen.queryByRole("button", { name: "Anterior" })).toBeNull();
    expect(container.querySelectorAll("video")).toHaveLength(1);
  });

  it("imagen usa object-contain con una altura máxima (nunca recorta)", () => {
    const { container } = render(<CommunityPostMediaViewer media={[media()]} />);
    const img = container.querySelector("img")!;
    expect(img.className).toContain("object-contain");
    expect(img.className).not.toContain("object-cover");
    expect(img.className).toMatch(/max-h-\[60vh\]/);
  });

  it("un vídeo vertical usa object-contain + altura máxima efectiva (nunca se renderiza sin acotar)", () => {
    const { container } = render(
      <CommunityPostMediaViewer
        media={[
          media({
            kind: "video",
            url: "https://example.test/vertical.mp4",
            width: 1080,
            height: 1920,
          }),
        ]}
      />,
    );
    const video = container.querySelector("video")!;
    expect(video.className).toContain("object-contain");
    expect(video.className).toMatch(/max-h-\[60vh\]/);
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveProperty("muted", true);
    expect(video).toHaveProperty("playsInline", true);
  });
});

describe("CommunityPostMediaViewer — múltiples items", () => {
  it("varias imágenes: solo una visible a la vez", () => {
    const { container } = render(
      <CommunityPostMediaViewer
        media={[
          media({ id: "m1", url: "https://example.test/m1.webp" }),
          media({ id: "m2", url: "https://example.test/m2.webp" }),
        ]}
      />,
    );
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.test/m1.webp",
    );
  });

  it("mixto imagen/vídeo: solo un item visible a la vez", () => {
    const { container } = render(
      <CommunityPostMediaViewer
        media={[
          media({ id: "m1", kind: "image", url: "https://example.test/m1.webp" }),
          media({ id: "m2", kind: "video", url: "https://example.test/m2.mp4" }),
        ]}
      />,
    );
    expect(container.querySelectorAll("img, video")).toHaveLength(1);
  });

  it("'Siguiente' avanza en el orden original", () => {
    const { container } = render(
      <CommunityPostMediaViewer
        media={[
          media({ id: "m1", url: "https://example.test/m1.webp" }),
          media({ id: "m2", kind: "video", url: "https://example.test/m2.mp4" }),
          media({ id: "m3", url: "https://example.test/m3.webp" }),
        ]}
      />,
    );
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.test/m1.webp",
    );

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    expect(container.querySelector("video")).toHaveAttribute(
      "src",
      "https://example.test/m2.mp4",
    );

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.test/m3.webp",
    );
  });

  it("'Anterior' retrocede en el orden original (con wraparound circular)", () => {
    const { container } = render(
      <CommunityPostMediaViewer
        media={[
          media({ id: "m1", url: "https://example.test/m1.webp" }),
          media({ id: "m2", url: "https://example.test/m2.webp" }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Anterior" }));
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.test/m2.webp",
    );
  });

  it("el indicador de posición se actualiza (ej. 2 / 3)", () => {
    render(
      <CommunityPostMediaViewer
        media={[media({ id: "m1" }), media({ id: "m2" }), media({ id: "m3" })]}
      />,
    );
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
  });

  it("navegar fuera de un vídeo activo lo pausa antes de desmontarse", () => {
    const { container } = render(
      <CommunityPostMediaViewer
        media={[
          media({ id: "m1", kind: "video", url: "https://example.test/m1.mp4" }),
          media({ id: "m2", url: "https://example.test/m2.webp" }),
        ]}
      />,
    );
    const video = container.querySelector("video")!;
    const pauseSpy = vi.spyOn(video, "pause");

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));

    expect(pauseSpy).toHaveBeenCalled();
    expect(container.querySelector("video")).toBeNull();
  });

  it("teclado: ArrowRight avanza y ArrowLeft retrocede", () => {
    const { container } = render(
      <CommunityPostMediaViewer
        media={[
          media({ id: "m1", url: "https://example.test/m1.webp" }),
          media({ id: "m2", url: "https://example.test/m2.webp" }),
        ]}
      />,
    );
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.test/m2.webp",
    );

    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.test/m1.webp",
    );
  });

  it("teclado: no navega si el foco está en un input/textarea (no secuestra la edición)", () => {
    const { container } = render(
      <>
        <input aria-label="campo de prueba" />
        <CommunityPostMediaViewer
          media={[
            media({ id: "m1", url: "https://example.test/m1.webp" }),
            media({ id: "m2", url: "https://example.test/m2.webp" }),
          ]}
        />
      </>,
    );
    const input = screen.getByLabelText("campo de prueba");
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.test/m1.webp",
    );
  });
});
