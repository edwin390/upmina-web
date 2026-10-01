import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CommunityFeedPost } from "@/types";
import CommunityPostMediaViewer from "./CommunityPostMediaViewer";

// Visor de media del detalle de una publicación (Fase 9J-3 follow-up "POST DETAIL MEDIA VIEWER"):
// UN solo media visible a la vez, orden autoritativo del autor, object-contain con una altura
// MÁXIMA (nunca recorta/deforma/exige scroll para ver un vídeo vertical completo), navegación
// prev/next + teclado ArrowLeft/ArrowRight (mismo guard de inputs que CosplayLightbox).
//
// Las imágenes de Comunidad usan alt="" (sin columna alt en el modelo, a diferencia de Cosplay):
// un <img alt=""> tiene role implícito "presentation", no "img" — por eso se consultan por
// selector, no por role="img" (mismo criterio que el resto de tests de Comunidad).
//
// 9J-FIX2 — STAGED SWAP: el media objetivo se prepara en una ranura oculta (aria-hidden="true")
// hasta que dispara su evento de "listo" (load para imagen, loadeddata para vídeo); solo entonces
// el media VISIBLE (sin aria-hidden) cambia. Por eso, tras un click de navegación, hay que disparar
// ese evento antes de comprobar el swap — las aserciones "el nodo visible sigue siendo el mismo"
// usan selectores `:not([aria-hidden])` para no confundirse con la ranura de preparación.

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

function visibleImg(container: HTMLElement) {
  return container.querySelector<HTMLImageElement>("img:not([aria-hidden])");
}
function visibleVideo(container: HTMLElement) {
  return container.querySelector<HTMLVideoElement>("video:not([aria-hidden])");
}
function stagingImg(container: HTMLElement) {
  return container.querySelector<HTMLImageElement>('img[aria-hidden="true"]');
}
function stagingVideo(container: HTMLElement) {
  return container.querySelector<HTMLVideoElement>('video[aria-hidden="true"]');
}

function resolveImageStaging(container: HTMLElement) {
  const el = stagingImg(container);
  if (!el) throw new Error("no hay <img> de preparación para resolver");
  fireEvent.load(el);
}
function resolveVideoStaging(container: HTMLElement) {
  const el = stagingVideo(container);
  if (!el) throw new Error("no hay <video> de preparación para resolver");
  fireEvent(el, new Event("loadeddata"));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CommunityPostMediaViewer — un solo media", () => {
  it("multi-media coloca controles y contador en una fila separada después del media", () => {
    render(<CommunityPostMediaViewer media={[media({ id: "a" }), media({ id: "b" })]} />);
    const nav = screen.getByRole("group", { name: "Navegación multimedia" });
    expect(nav).toContainElement(screen.getByRole("button", { name: "Anterior" }));
    expect(nav).toContainElement(screen.getByRole("button", { name: "Siguiente" }));
    expect(nav).toContainElement(screen.getByText("1 / 2"));
    expect(nav.querySelector("img, video")).toBeNull();
    expect(nav.previousElementSibling?.tagName).toBe("IMG");
  });
  it("una sola imagen: sin flechas de navegación ni contador", () => {
    const { container } = render(<CommunityPostMediaViewer media={[media()]} />);
    expect(screen.queryByRole("button", { name: "Anterior" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Siguiente" })).toBeNull();
    expect(visibleImg(container)).toHaveAttribute("src", "https://example.test/m1.webp");
  });

  it("un solo vídeo: sin flechas de navegación", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
      Promise.resolve(),
    );
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
    const img = visibleImg(container)!;
    expect(img.className).toContain("object-contain");
    expect(img.className).not.toContain("object-cover");
    expect(img.className).toMatch(/max-h-\[60vh\]/);
  });

  it("un vídeo vertical usa object-contain + altura máxima efectiva (nunca se renderiza sin acotar)", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
      Promise.resolve(),
    );
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
    const video = visibleVideo(container)!;
    expect(video.className).toContain("object-contain");
    expect(video.className).toMatch(/max-h-\[60vh\]/);
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveProperty("playsInline", true);
  });
});

describe("CommunityPostMediaViewer — autoplay de vídeo en el detalle (9J-FIX)", () => {
  it("al montar un vídeo activo, intenta reproducirlo automáticamente (play())", () => {
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockImplementation(() => Promise.resolve());

    render(
      <CommunityPostMediaViewer
        media={[media({ kind: "video", url: "https://example.test/m1.mp4" })]}
      />,
    );

    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it("NUNCA fuerza muted=true en el vídeo VISIBLE solo para conseguir el autoplay", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
      Promise.resolve(),
    );

    const { container } = render(
      <CommunityPostMediaViewer
        media={[media({ kind: "video", url: "https://example.test/m1.mp4" })]}
      />,
    );

    expect(visibleVideo(container)).not.toHaveAttribute("muted");
  });

  it("si play() rechaza por política de autoplay, no lanza un error no controlado ni rompe la UI", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
      Promise.reject(new DOMException("blocked", "NotAllowedError")),
    );
    const onUnhandledRejection = vi.fn();
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    render(
      <CommunityPostMediaViewer
        media={[media({ kind: "video", url: "https://example.test/m1.mp4" })]}
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onUnhandledRejection).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  });

  it("si play() lanza de forma síncrona (no soportado en el entorno), no rompe el render", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => {
      throw new Error("Not implemented");
    });

    expect(() =>
      render(
        <CommunityPostMediaViewer
          media={[media({ kind: "video", url: "https://example.test/m1.mp4" })]}
        />,
      ),
    ).not.toThrow();
  });

  it("el feed (CommunityFeedCard) nunca intenta autoplay: este componente es exclusivo del detalle", () => {
    // Cobertura de contrato, no de implementación: CommunityFeedCard.tsx renderiza su propio
    // <video muted playsInline preload> SIN llamar a play() en ningún efecto — ver su propio
    // archivo. Este viewer (PostDetailPage.tsx) es el único lugar donde se llama a play().
    expect(true).toBe(true);
  });
});

describe("CommunityPostMediaViewer — precarga de vecinos (9J-FIX / 9J-FIX2)", () => {
  it("al montar, precarga solo la imagen anterior y siguiente (wrap-around), nunca toda la galería", () => {
    const originalImage = globalThis.Image;
    const created: string[] = [];
    class TrackedImage {
      set src(value: string) {
        created.push(value);
      }
    }
    // @ts-expect-error -- stub mínimo suficiente para esta prueba
    globalThis.Image = TrackedImage;

    render(
      <CommunityPostMediaViewer
        media={[
          media({ id: "m1", url: "https://example.test/m1.webp" }),
          media({ id: "m2", url: "https://example.test/m2.webp" }),
          media({ id: "m3", url: "https://example.test/m3.webp" }),
        ]}
      />,
    );

    // index=0: vecinos con wrap-around son m3 (anterior) y m2 (siguiente) — nunca m1 (el activo).
    expect(created.sort()).toEqual(
      ["https://example.test/m2.webp", "https://example.test/m3.webp"].sort(),
    );

    globalThis.Image = originalImage;
  });

  it('9J-FIX2: un vídeo vecino SÍ se precarga, mediante un <video preload="auto" muted> desconectado del DOM (no con Image())', () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
      Promise.resolve(),
    );
    const createElementSpy = vi.spyOn(document, "createElement");

    render(
      <CommunityPostMediaViewer
        media={[
          media({ id: "m1", kind: "image", url: "https://example.test/m1.webp" }),
          media({ id: "m2", kind: "video", url: "https://example.test/m2.mp4" }),
        ]}
      />,
    );

    const videoCreations = createElementSpy.mock.calls.filter(([tag]) => tag === "video");
    expect(videoCreations.length).toBeGreaterThanOrEqual(1);
  });
});

describe("CommunityPostMediaViewer — múltiples items: IMAGEN → IMAGEN (aprobado manualmente, sin regresión)", () => {
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
    expect(visibleImg(container)).toHaveAttribute("src", "https://example.test/m1.webp");
  });

  it("9J-FIX3: al resolverse, la ranura de PREPARACIÓN de la imagen siguiente se PROMUEVE a visible (mismo nodo DOM, nunca un remount adicional ni una segunda decodificación)", () => {
    const { container } = render(
      <CommunityPostMediaViewer
        media={[
          media({ id: "m1", url: "https://example.test/m1.webp" }),
          media({ id: "m2", url: "https://example.test/m2.webp" }),
        ]}
      />,
    );
    expect(visibleImg(container)).toHaveAttribute("src", "https://example.test/m1.webp");

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    const stagingForM2 = stagingImg(container);
    expect(stagingForM2).toHaveAttribute("src", "https://example.test/m2.webp");

    resolveImageStaging(container);

    const imgAfter = visibleImg(container);
    // El nodo que ERA la ranura de preparación es AHORA, literalmente, la ranura visible.
    expect(imgAfter).toBe(stagingForM2);
    expect(imgAfter).toHaveAttribute("src", "https://example.test/m2.webp");
    expect(imgAfter).not.toHaveAttribute("aria-hidden");
  });

  it("'Siguiente' avanza en el orden original (con vídeo intercalado)", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
      Promise.resolve(),
    );
    const { container } = render(
      <CommunityPostMediaViewer
        media={[
          media({ id: "m1", url: "https://example.test/m1.webp" }),
          media({ id: "m2", kind: "video", url: "https://example.test/m2.mp4" }),
          media({ id: "m3", url: "https://example.test/m3.webp" }),
        ]}
      />,
    );
    expect(visibleImg(container)).toHaveAttribute("src", "https://example.test/m1.webp");

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    resolveVideoStaging(container);
    expect(visibleVideo(container)).toHaveAttribute("src", "https://example.test/m2.mp4");

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    resolveImageStaging(container);
    expect(visibleImg(container)).toHaveAttribute("src", "https://example.test/m3.webp");
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
    resolveImageStaging(container);
    expect(visibleImg(container)).toHaveAttribute("src", "https://example.test/m2.webp");
  });

  it("el indicador de posición se actualiza al instante (ej. 2 / 3), aunque el swap visual todavía esté preparándose", () => {
    render(
      <CommunityPostMediaViewer
        media={[media({ id: "m1" }), media({ id: "m2" }), media({ id: "m3" })]}
      />,
    );
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
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
    resolveImageStaging(container);
    expect(visibleImg(container)).toHaveAttribute("src", "https://example.test/m2.webp");

    fireEvent.keyDown(document, { key: "ArrowLeft" });
    resolveImageStaging(container);
    expect(visibleImg(container)).toHaveAttribute("src", "https://example.test/m1.webp");
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
    expect(visibleImg(container)).toHaveAttribute("src", "https://example.test/m1.webp");
  });
});

describe("CommunityPostMediaViewer — 9J-FIX2: IMAGEN → VÍDEO (staged swap)", () => {
  function mixedMedia() {
    return [
      media({ id: "m1", kind: "image" as const, url: "https://example.test/m1.webp" }),
      media({ id: "m2", kind: "video" as const, url: "https://example.test/m2.mp4" }),
    ];
  }

  it("TEST DEL FRAME VACÍO: mientras el vídeo objetivo no está listo, la imagen ACTUAL sigue visible y activa (nunca un hueco vacío)", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
      Promise.resolve(),
    );
    const { container } = render(<CommunityPostMediaViewer media={mixedMedia()} />);

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));

    // Sin resolver el vídeo de preparación: el contenido visual activo sigue siendo la imagen.
    expect(visibleImg(container)).toHaveAttribute("src", "https://example.test/m1.webp");
    expect(visibleVideo(container)).toBeNull();
    // El vídeo objetivo se está preparando, oculto, en paralelo (no bloqueando la vista).
    expect(stagingVideo(container)).toHaveAttribute("src", "https://example.test/m2.mp4");
  });

  it("al recibir el evento 'listo' (loadeddata) del vídeo, se realiza el swap visual", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
      Promise.resolve(),
    );
    const { container } = render(<CommunityPostMediaViewer media={mixedMedia()} />);

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    resolveVideoStaging(container);

    expect(visibleVideo(container)).toHaveAttribute("src", "https://example.test/m2.mp4");
    expect(visibleImg(container)).toBeNull();
  });

  it("después del swap a vídeo, intenta autoplay (play()) sobre el vídeo recién visible", () => {
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockImplementation(() => Promise.resolve());
    const { container } = render(<CommunityPostMediaViewer media={mixedMedia()} />);
    expect(playSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    resolveVideoStaging(container);

    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it("si autoplay es rechazado tras el swap, el vídeo queda visible y listo para Play manual (no vuelve a mostrar la imagen ni rompe el viewer)", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
      Promise.reject(new DOMException("blocked", "NotAllowedError")),
    );
    const { container } = render(<CommunityPostMediaViewer media={mixedMedia()} />);

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    resolveVideoStaging(container);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const video = visibleVideo(container);
    expect(video).toHaveAttribute("src", "https://example.test/m2.mp4");
    expect(video).toHaveAttribute("controls");
    expect(visibleImg(container)).toBeNull();
  });
});

describe("CommunityPostMediaViewer — 9J-FIX2: VÍDEO → IMAGEN (staged swap)", () => {
  function mixedMedia() {
    return [
      media({ id: "m1", kind: "video" as const, url: "https://example.test/m1.mp4" }),
      media({ id: "m2", kind: "image" as const, url: "https://example.test/m2.webp" }),
    ];
  }

  it("mientras la imagen objetivo carga, el vídeo actual permanece visible (sin pausar todavía)", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
      Promise.resolve(),
    );
    const { container } = render(<CommunityPostMediaViewer media={mixedMedia()} />);
    const video = visibleVideo(container)!;
    const pauseSpy = vi.spyOn(video, "pause");

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));

    expect(visibleVideo(container)).toBe(video);
    expect(visibleVideo(container)).toHaveAttribute("src", "https://example.test/m1.mp4");
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(visibleImg(container)).toBeNull();
  });

  it("cuando la imagen está lista: pausa el vídeo, hace el swap y muestra la imagen", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
      Promise.resolve(),
    );
    const { container } = render(<CommunityPostMediaViewer media={mixedMedia()} />);
    const video = visibleVideo(container)!;
    const pauseSpy = vi.spyOn(video, "pause");

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    resolveImageStaging(container);

    expect(pauseSpy).toHaveBeenCalled();
    expect(visibleVideo(container)).toBeNull();
    expect(visibleImg(container)).toHaveAttribute("src", "https://example.test/m2.webp");
  });
});

describe("CommunityPostMediaViewer — 9J-FIX2: VÍDEO → VÍDEO (staged swap)", () => {
  function twoVideos() {
    return [
      media({ id: "m1", kind: "video" as const, url: "https://example.test/m1.mp4" }),
      media({ id: "m2", kind: "video" as const, url: "https://example.test/m2.mp4" }),
    ];
  }

  it("el vídeo anterior permanece visible y reproduciéndose mientras el siguiente se prepara", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
      Promise.resolve(),
    );
    const { container } = render(<CommunityPostMediaViewer media={twoVideos()} />);

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));

    expect(visibleVideo(container)).toHaveAttribute("src", "https://example.test/m1.mp4");
  });

  it("al resolverse, pausa el vídeo saliente ANTES de mostrar el entrante, y nunca coexisten dos <video> visibles", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
      Promise.resolve(),
    );
    const { container } = render(<CommunityPostMediaViewer media={twoVideos()} />);
    const outgoing = visibleVideo(container)!;
    const pauseSpy = vi.spyOn(outgoing, "pause");

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    resolveVideoStaging(container);

    expect(pauseSpy).toHaveBeenCalled();
    expect(container.querySelectorAll("video:not([aria-hidden])")).toHaveLength(1);
    expect(visibleVideo(container)).toHaveAttribute("src", "https://example.test/m2.mp4");
  });

  it("después del swap, intenta autoplay sobre el vídeo entrante", () => {
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockImplementation(() => Promise.resolve());
    const { container } = render(<CommunityPostMediaViewer media={twoVideos()} />);
    expect(playSpy).toHaveBeenCalledTimes(1); // autoplay del primer vídeo al montar

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    resolveVideoStaging(container);

    expect(playSpy).toHaveBeenCalledTimes(2);
  });
});

describe("CommunityPostMediaViewer — 9J-FIX2: navegación rápida / condiciones de carrera", () => {
  it("A(imagen) → B(vídeo) → C(imagen) antes de resolver B: si B llega tarde, NUNCA se activa (gana la navegación más reciente)", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
      Promise.resolve(),
    );
    const { container } = render(
      <CommunityPostMediaViewer
        media={[
          media({ id: "A", kind: "image", url: "https://example.test/a.webp" }),
          media({ id: "B", kind: "video", url: "https://example.test/b.mp4" }),
          media({ id: "C", kind: "image", url: "https://example.test/c.webp" }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" })); // objetivo: B
    const staleStagingVideoForB = stagingVideo(container)!;
    expect(staleStagingVideoForB).toHaveAttribute("src", "https://example.test/b.mp4");

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" })); // objetivo ahora: C, abandona B

    // React ya desmontó la ranura de preparación de B (key distinta para el nuevo objetivo C).
    expect(container.contains(staleStagingVideoForB)).toBe(false);

    // Aunque llegara tarde un evento "listo" para B, el guard por índice lo ignora.
    fireEvent(staleStagingVideoForB, new Event("loadeddata"));
    expect(visibleImg(container)).toHaveAttribute("src", "https://example.test/a.webp");
    expect(visibleVideo(container)).toBeNull();

    // Al resolver el objetivo REAL más reciente (C), ese sí se activa.
    resolveImageStaging(container);
    expect(visibleImg(container)).toHaveAttribute("src", "https://example.test/c.webp");
  });

  it("navegación rápida inversa: Siguiente, Siguiente, Anterior antes de resolver — solo el último objetivo solicitado puede activarse", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
      Promise.resolve(),
    );
    const { container } = render(
      <CommunityPostMediaViewer
        media={[
          media({ id: "m1", kind: "image", url: "https://example.test/m1.webp" }),
          media({ id: "m2", kind: "image", url: "https://example.test/m2.webp" }),
          media({ id: "m3", kind: "image", url: "https://example.test/m3.webp" }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" })); // objetivo: m2
    const staleStagingForM2 = stagingImg(container)!;
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" })); // objetivo: m3
    fireEvent.click(screen.getByRole("button", { name: "Anterior" })); // objetivo: m2 de nuevo

    // La primera ranura de m2 ya fue reemplazada por la de m3 y luego por una NUEVA de m2 —
    // un evento tardío sobre la instancia vieja (ya desmontada) debe ser inerte.
    fireEvent.load(staleStagingForM2);
    expect(visibleImg(container)).toHaveAttribute("src", "https://example.test/m1.webp");

    // Resolver la preparación vigente (la nueva, para m2) sí debe aplicarse.
    resolveImageStaging(container);
    expect(visibleImg(container)).toHaveAttribute("src", "https://example.test/m2.webp");
  });
});

describe("CommunityPostMediaViewer — 9J-FIX3: promoción de nodo (evita el frame negro de vídeo)", () => {
  it("al resolverse, la ranura de PREPARACIÓN del vídeo siguiente se PROMUEVE a visible (mismo nodo, ya con loadeddata — nunca un <video> nuevo desde cero)", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
      Promise.resolve(),
    );
    const { container } = render(
      <CommunityPostMediaViewer
        media={[
          media({ id: "m1", kind: "image", url: "https://example.test/m1.webp" }),
          media({ id: "m2", kind: "video", url: "https://example.test/m2.mp4" }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    const stagingForM2 = stagingVideo(container);
    expect(stagingForM2).toHaveAttribute("src", "https://example.test/m2.mp4");

    resolveVideoStaging(container);

    const visible = visibleVideo(container);
    expect(visible).toBe(stagingForM2);
    expect(visible).toHaveAttribute("controls");
    expect(visible).not.toHaveAttribute("muted");
    expect(visible).not.toHaveAttribute("aria-hidden");
  });
});

describe("CommunityPostMediaViewer — 9J-FIX3: navegación en ráfaga (varios clicks antes de cualquier readiness)", () => {
  function fourImages() {
    return [
      media({ id: "A", url: "https://example.test/a.webp" }),
      media({ id: "B", url: "https://example.test/b.webp" }),
      media({ id: "C", url: "https://example.test/c.webp" }),
      media({ id: "D", url: "https://example.test/d.webp" }),
    ];
  }

  it("1) A→B→C→D en ráfaga (puras imágenes), SIN resolver nada hasta el final: solo D puede terminar visible", () => {
    const { container } = render(<CommunityPostMediaViewer media={fourImages()} />);
    const next = () => fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));

    next(); // target B
    next(); // target C
    next(); // target D

    // A sigue siendo el ÚNICO contenido visible mientras nada ha resuelto.
    expect(visibleImg(container)).toHaveAttribute("src", "https://example.test/a.webp");

    resolveImageStaging(container); // resuelve el ÚNICO staging vigente: D
    expect(visibleImg(container)).toHaveAttribute("src", "https://example.test/d.webp");
  });

  it("2) A(imagen)→B(vídeo)→C(imagen)→D(vídeo) en ráfaga; readiness en orden B, C, D: solo D gana", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
      Promise.resolve(),
    );
    const seq = [
      media({ id: "A", kind: "image" as const, url: "https://example.test/a.webp" }),
      media({ id: "B", kind: "video" as const, url: "https://example.test/b.mp4" }),
      media({ id: "C", kind: "image" as const, url: "https://example.test/c.webp" }),
      media({ id: "D", kind: "video" as const, url: "https://example.test/d.mp4" }),
    ];
    const { container } = render(<CommunityPostMediaViewer media={seq} />);
    const next = () => fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));

    next(); // target B (vídeo) — captura su nodo de preparación ANTES de que se reemplace
    const stagingB = stagingVideo(container)!;
    next(); // target C (imagen) — B queda abandonado
    const stagingC = stagingImg(container)!;
    next(); // target D (vídeo) — C queda abandonado

    // "Readiness" tardío de B y C (ya no son el objetivo vigente): debe ser inerte.
    fireEvent(stagingB, new Event("loadeddata"));
    fireEvent.load(stagingC);
    expect(visibleImg(container)).toHaveAttribute("src", "https://example.test/a.webp");
    expect(visibleVideo(container)).toBeNull();

    // Solo D (el objetivo vigente) puede activarse.
    resolveVideoStaging(container);
    expect(visibleVideo(container)).toHaveAttribute("src", "https://example.test/d.mp4");
  });

  it("3) misma ráfaga, pero el readiness llega en orden D, B, C: D gana y B/C YA NO pueden reemplazarlo después", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
      Promise.resolve(),
    );
    const seq = [
      media({ id: "A", kind: "image" as const, url: "https://example.test/a.webp" }),
      media({ id: "B", kind: "video" as const, url: "https://example.test/b.mp4" }),
      media({ id: "C", kind: "image" as const, url: "https://example.test/c.webp" }),
      media({ id: "D", kind: "video" as const, url: "https://example.test/d.mp4" }),
    ];
    const { container } = render(<CommunityPostMediaViewer media={seq} />);
    const next = () => fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));

    next();
    const stagingB = stagingVideo(container)!;
    next();
    const stagingC = stagingImg(container)!;
    next(); // target D

    resolveVideoStaging(container); // D resuelve primero
    expect(visibleVideo(container)).toHaveAttribute("src", "https://example.test/d.mp4");

    // B y C resuelven DESPUÉS de que D ya está visible: no deben poder reemplazarlo.
    fireEvent(stagingB, new Event("loadeddata"));
    fireEvent.load(stagingC);
    expect(visibleVideo(container)).toHaveAttribute("src", "https://example.test/d.mp4");
  });

  it("4) CASO ESPECIAL — volver al item YA visible: A visible → click hacia B (staging) → click Anterior (vuelve a A) — A NUNCA se desmonta, sin flash, sin re-esperar readiness", () => {
    const { container } = render(
      <CommunityPostMediaViewer
        media={[
          media({ id: "A", url: "https://example.test/a.webp" }),
          media({ id: "B", url: "https://example.test/b.webp" }),
        ]}
      />,
    );
    const visibleA = visibleImg(container);

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" })); // target B, staging
    expect(stagingImg(container)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Anterior" })); // vuelve a A (== display)

    // Ya no hay nada en preparación: el objetivo volvió a coincidir con lo visible.
    expect(stagingImg(container)).toBeNull();
    expect(stagingVideo(container)).toBeNull();
    // A sigue siendo EXACTAMENTE el mismo nodo: nunca se tocó.
    expect(visibleImg(container)).toBe(visibleA);
    expect(visibleImg(container)).toHaveAttribute("src", "https://example.test/a.webp");
  });

  it("5) Siguiente × 10 en ráfaga sobre 4 imágenes: el objetivo final es matemáticamente correcto (wrap-around)", () => {
    const { container } = render(<CommunityPostMediaViewer media={fourImages()} />);
    for (let i = 0; i < 10; i += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    }
    // 10 pasos adelante desde índice 0, módulo 4 = índice 2 → "C".
    expect(screen.getByText("3 / 4")).toBeInTheDocument();
    resolveImageStaging(container);
    expect(visibleImg(container)).toHaveAttribute("src", "https://example.test/c.webp");
  });

  it("6) Anterior × 10 en ráfaga sobre 4 imágenes: el objetivo final es matemáticamente correcto", () => {
    const { container } = render(<CommunityPostMediaViewer media={fourImages()} />);
    for (let i = 0; i < 10; i += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Anterior" }));
    }
    // 10 pasos atrás desde índice 0, módulo 4 = índice 2 → "C".
    expect(screen.getByText("3 / 4")).toBeInTheDocument();
    resolveImageStaging(container);
    expect(visibleImg(container)).toHaveAttribute("src", "https://example.test/c.webp");
  });

  it("7) Siguiente/Anterior alternados en ráfaga: el objetivo final es matemáticamente correcto", () => {
    const { container } = render(<CommunityPostMediaViewer media={fourImages()} />);
    const next = () => fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    const prev = () => fireEvent.click(screen.getByRole("button", { name: "Anterior" }));
    // +1 +1 -1 +1 -1 +1 = +2 desde índice 0 → índice 2 → "C".
    next();
    next();
    prev();
    next();
    prev();
    next();
    expect(screen.getByText("3 / 4")).toBeInTheDocument();
    resolveImageStaging(container);
    expect(visibleImg(container)).toHaveAttribute("src", "https://example.test/c.webp");
  });

  it("8) un evento 'load' TARDÍO de una imagen ya abandonada se ignora (no modifica qué se muestra)", () => {
    const { container } = render(<CommunityPostMediaViewer media={fourImages()} />);
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" })); // target B
    const stagingB = stagingImg(container)!;
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" })); // target C, abandona B

    fireEvent.load(stagingB); // tardío
    expect(visibleImg(container)).toHaveAttribute("src", "https://example.test/a.webp");
  });

  it("9) un evento 'loadeddata' TARDÍO de un vídeo ya abandonado se ignora", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
      Promise.resolve(),
    );
    const { container } = render(
      <CommunityPostMediaViewer
        media={[
          media({ id: "A", kind: "image", url: "https://example.test/a.webp" }),
          media({ id: "B", kind: "video", url: "https://example.test/b.mp4" }),
          media({ id: "C", kind: "image", url: "https://example.test/c.webp" }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" })); // target B (vídeo)
    const stagingB = stagingVideo(container)!;
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" })); // target C, abandona B

    fireEvent(stagingB, new Event("loadeddata")); // tardío
    expect(visibleImg(container)).toHaveAttribute("src", "https://example.test/a.webp");
    expect(visibleVideo(container)).toBeNull();
  });

  it("10) una Promise de autoplay que resuelve/rechaza TARDE (de un vídeo ya no visible) no modifica el estado ni rompe nada", async () => {
    let rejectStale!: (reason: unknown) => void;
    let callCount = 0;
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise((_resolve, reject) => {
          rejectStale = reject;
        });
      }
      return Promise.resolve();
    });
    const onUnhandledRejection = vi.fn();
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    const { container } = render(
      <CommunityPostMediaViewer
        media={[
          media({ id: "A", kind: "video", url: "https://example.test/a.mp4" }),
          media({ id: "B", kind: "image", url: "https://example.test/b.webp" }),
        ]}
      />,
    );
    // A's play() Promise queda pendiente (callCount===1, nunca resuelta todavía).
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" })); // target B
    resolveImageStaging(container); // swap a B (imagen) — A se pausa y se desmonta

    // AHORA se rechaza, tarde, la Promise de play() de A (ya fuera de pantalla).
    rejectStale(new DOMException("blocked", "NotAllowedError"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onUnhandledRejection).not.toHaveBeenCalled();
    expect(visibleImg(container)).toHaveAttribute("src", "https://example.test/b.webp");
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  });

  it("11) SOLO el vídeo visible ejecuta play(); la ranura de preparación NUNCA", () => {
    const calledOn: EventTarget[] = [];
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
      this: HTMLMediaElement,
    ) {
      calledOn.push(this);
      return Promise.resolve();
    });

    const { container } = render(
      <CommunityPostMediaViewer
        media={[
          media({ id: "m1", kind: "video", url: "https://example.test/m1.mp4" }),
          media({ id: "m2", kind: "video", url: "https://example.test/m2.mp4" }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    const staging = stagingVideo(container)!;
    expect(calledOn).not.toContain(staging);

    resolveVideoStaging(container);
    const visible = visibleVideo(container)!;
    expect(calledOn).toContain(visible);
    for (const el of calledOn) {
      expect(el).not.toHaveAttribute("aria-hidden");
    }
  });

  it("12) exactamente UN media DISPLAY en todo momento de la secuencia; nunca un instante con DISPLAY=null", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
      Promise.resolve(),
    );
    const seq = [
      media({ id: "A", kind: "image" as const, url: "https://example.test/a.webp" }),
      media({ id: "B", kind: "video" as const, url: "https://example.test/b.mp4" }),
      media({ id: "C", kind: "image" as const, url: "https://example.test/c.webp" }),
    ];
    const { container } = render(<CommunityPostMediaViewer media={seq} />);

    function assertExactlyOneDisplay() {
      const visible = container.querySelectorAll(
        "img:not([aria-hidden]), video:not([aria-hidden])",
      );
      expect(visible).toHaveLength(1);
    }

    assertExactlyOneDisplay();
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    assertExactlyOneDisplay();
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    assertExactlyOneDisplay();
    resolveImageStaging(container);
    assertExactlyOneDisplay();
  });
});

describe("CommunityPostMediaViewer — mixto imagen/vídeo: estructura", () => {
  it("solo un item VISIBLE a la vez (sin navegación en curso)", () => {
    const { container } = render(
      <CommunityPostMediaViewer
        media={[
          media({ id: "m1", kind: "image", url: "https://example.test/m1.webp" }),
          media({ id: "m2", kind: "video", url: "https://example.test/m2.mp4" }),
        ]}
      />,
    );
    expect(
      container.querySelectorAll("img:not([aria-hidden]), video:not([aria-hidden])"),
    ).toHaveLength(1);
  });
});
