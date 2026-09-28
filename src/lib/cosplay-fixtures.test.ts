import { describe, expect, it } from "vitest";
import {
  COSPLAY_FIXTURE_LIST,
  COSPLAY_FIXTURE_POSTS,
  findCosplayFixtureBySlug,
} from "./cosplay-fixtures";
import { isValidSlugFormat, validatePublishReadiness } from "./cosplay-domain";

// Los fixtures de localhost (Fase 9I-1) deben representar publicaciones REALMENTE publicables
// (para que el layout que se revisa en localhost coincida con lo que el dominio aceptaría), y
// cubrir a propósito los casos límite que pide la sección "Fixture images" del checkpoint.

describe("COSPLAY_FIXTURE_POSTS", () => {
  it("cada slug es válido y único", () => {
    const slugs = COSPLAY_FIXTURE_POSTS.map((p) => p.slug);
    for (const slug of slugs) expect(isValidSlugFormat(slug)).toBe(true);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("cada post es publicable según el dominio: exactamente una portada y alt en toda imagen no decorativa", () => {
    for (const post of COSPLAY_FIXTURE_POSTS) {
      const errors = validatePublishReadiness(
        { title: post.title },
        post.gallery.map((image) => ({
          id: image.id,
          status: "ready" as const,
          isCover: image.isCover,
          decorative: image.decorative,
          alt: image.alt,
        })),
      );
      expect(errors, `post ${post.slug}: ${JSON.stringify(errors)}`).toEqual([]);
    }
  });

  it("photoCount coincide con el tamaño real de la galería", () => {
    for (const post of COSPLAY_FIXTURE_POSTS) {
      expect(post.photoCount).toBe(post.gallery.length);
    }
  });

  it("al menos una publicación tiene un campo opcional (series/event/shotOn/photographerCredit) ausente", () => {
    expect(
      COSPLAY_FIXTURE_POSTS.some(
        (p) => p.series === null || p.event === null || p.shotOn === null,
      ),
    ).toBe(true);
  });

  it("al menos una publicación tiene más de una imagen y al menos una tiene exactamente una", () => {
    expect(COSPLAY_FIXTURE_POSTS.some((p) => p.gallery.length > 1)).toBe(true);
    expect(COSPLAY_FIXTURE_POSTS.some((p) => p.gallery.length === 1)).toBe(true);
  });

  it("al menos una imagen está marcada como decorativa (alt vacío intencional)", () => {
    const allImages = COSPLAY_FIXTURE_POSTS.flatMap((p) => p.gallery);
    expect(allImages.some((img) => img.decorative)).toBe(true);
  });

  it("al menos un título es deliberadamente largo (prueba el recorte visual)", () => {
    expect(COSPLAY_FIXTURE_POSTS.some((p) => p.title.length > 80)).toBe(true);
  });

  it("todas las imágenes son data: URI (SVG generado), nunca una URL externa ni un archivo real", () => {
    for (const post of COSPLAY_FIXTURE_POSTS) {
      for (const image of post.gallery) {
        expect(image.url.startsWith("data:image/svg+xml,")).toBe(true);
      }
    }
  });

  it("todo el texto editorial está marcado como [fixture] (nunca pasa por contenido real)", () => {
    for (const post of COSPLAY_FIXTURE_POSTS) {
      expect(post.title).toContain("[fixture]");
    }
  });
});

describe("COSPLAY_FIXTURE_LIST", () => {
  it("está ordenada por publishedAt descendente (más reciente primero)", () => {
    const dates = COSPLAY_FIXTURE_LIST.map((p) => p.publishedAt);
    const sorted = [...dates].sort().reverse();
    expect(dates).toEqual(sorted);
  });

  it("no expone campos de detalle (descripción, galería completa, crédito)", () => {
    for (const item of COSPLAY_FIXTURE_LIST) {
      expect(item).not.toHaveProperty("gallery");
      expect(item).not.toHaveProperty("description");
      expect(item).not.toHaveProperty("photographerCredit");
    }
  });

  it("tiene el mismo número de elementos que COSPLAY_FIXTURE_POSTS", () => {
    expect(COSPLAY_FIXTURE_LIST).toHaveLength(COSPLAY_FIXTURE_POSTS.length);
  });
});

describe("findCosplayFixtureBySlug", () => {
  it("devuelve el post correcto por slug", () => {
    const first = COSPLAY_FIXTURE_POSTS[0]!;
    expect(findCosplayFixtureBySlug(first.slug)?.id).toBe(first.id);
  });

  it("slug desconocido → null", () => {
    expect(findCosplayFixtureBySlug("no-existe-en-los-fixtures")).toBeNull();
  });
});
