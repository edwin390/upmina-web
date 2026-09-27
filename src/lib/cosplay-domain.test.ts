import { describe, expect, it } from "vitest";
import {
  generateUniqueSlug,
  isValidSlugFormat,
  mapImageRow,
  mapPostRowToDetail,
  mapPostRowToSummary,
  resolveEditorial,
  resolveRequiredEditorial,
  slugify,
  validatePublishReadiness,
  type PublishReadinessImage,
} from "./cosplay-domain";
import type { CosplayPostImageRow, CosplayPostRow } from "@/types";

// ────────────────────────────────────────────────────────────────────────────────────────────
describe("isValidSlugFormat", () => {
  it.each(["abc", "kirito-sao", "a1-b2-c3", "x".repeat(80)])("%s es válido", (slug) => {
    expect(isValidSlugFormat(slug)).toBe(true);
  });

  it.each([
    ["muy corto", "ab"],
    ["muy largo (81)", "x".repeat(81)],
    ["mayúsculas", "Kirito-Sao"],
    ["guion inicial", "-kirito"],
    ["guion final", "kirito-"],
    ["guion doble", "kirito--sao"],
    ["espacio", "kirito sao"],
    ["acento", "kirité"],
    ["vacío", ""],
    ["solo guiones", "---"],
    ["barra", "kirito/sao"],
    ["punto", "kirito.sao"],
  ])("%s → inválido", (_name, slug) => {
    expect(isValidSlugFormat(slug)).toBe(false);
  });
});

describe("slugify", () => {
  it.each([
    ["Kirito de Sword Art Online", "kirito-de-sword-art-online"],
    ["  Ciri  ", "ciri"],
    ["Ñandú & Épico!!", "nandu-epico"],
    ["Über-Cosplay", "uber-cosplay"],
    ["2B (NieR: Automata)", "2b-nier-automata"],
    ["___", "cosplay"],
    ["日本語のタイトル", "cosplay"],
    ["múltiples---guiones   seguidos", "multiples-guiones-seguidos"],
  ])("%s → %s", (title, expected) => {
    expect(slugify(title)).toBe(expected);
  });

  it("el resultado siempre es un slug válido según isValidSlugFormat", () => {
    for (const title of ["a", "A", "日本語", "!!!", "Kirito", "x".repeat(500)]) {
      expect(isValidSlugFormat(slugify(title))).toBe(true);
    }
  });

  it("recorta títulos largos a 80 caracteres sin dejar un guion colgando", () => {
    const long = Array.from({ length: 30 }, (_, i) => `palabra${i}`).join(" ");
    const result = slugify(long);
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result.endsWith("-")).toBe(false);
    expect(isValidSlugFormat(result)).toBe(true);
  });

  it("nunca lanza con entradas hostiles", () => {
    for (const value of ["", " ", "\u0000", "😀".repeat(50), "a".repeat(10_000)]) {
      expect(() => slugify(value)).not.toThrow();
    }
  });
});

describe("generateUniqueSlug", () => {
  it("sin colisión: devuelve la base tal cual", () => {
    expect(generateUniqueSlug("kirito", new Set())).toBe("kirito");
  });

  it("con una colisión: añade -2", () => {
    expect(generateUniqueSlug("kirito", new Set(["kirito"]))).toBe("kirito-2");
  });

  it("con varias colisiones: usa el primer sufijo libre", () => {
    expect(
      generateUniqueSlug("kirito", new Set(["kirito", "kirito-2", "kirito-3"])),
    ).toBe("kirito-4");
  });

  it("es determinista: mismo input → mismo resultado siempre", () => {
    const existing = new Set(["kirito", "kirito-2"]);
    expect(generateUniqueSlug("kirito", existing)).toBe(
      generateUniqueSlug("kirito", existing),
    );
  });

  it("respeta el tope de 80 caracteres al añadir el sufijo", () => {
    const base = "x".repeat(80);
    const result = generateUniqueSlug(base, new Set([base]));
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result.endsWith("-2")).toBe(true);
  });

  it("lanza si se agotan los intentos razonables (caso patológico)", () => {
    const existing = new Set(
      Array.from({ length: 1000 }, (_, i) => (i === 0 ? "kirito" : `kirito-${i + 1}`)),
    );
    expect(() => generateUniqueSlug("kirito", existing)).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────
describe("resolveEditorial", () => {
  const full = { es: "Título ES", en: "Title EN", de: "Titel DE" };
  const esOnly = { es: "Solo ES", en: null, de: null };
  const nothing = { es: null, en: null, de: null };

  it("locale es: siempre devuelve el texto en español, lang es", () => {
    expect(resolveEditorial(full, "es")).toEqual({ text: "Título ES", lang: "es" });
  });

  it("locale en con traducción disponible: usa EN, lang en", () => {
    expect(resolveEditorial(full, "en")).toEqual({ text: "Title EN", lang: "en" });
  });

  it("locale de con traducción disponible: usa DE, lang de", () => {
    expect(resolveEditorial(full, "de")).toEqual({ text: "Titel DE", lang: "de" });
  });

  it("locale en SIN traducción: cae a ES con lang es (no lang en)", () => {
    expect(resolveEditorial(esOnly, "en")).toEqual({ text: "Solo ES", lang: "es" });
  });

  it("locale de SIN traducción: cae a ES con lang es", () => {
    expect(resolveEditorial(esOnly, "de")).toEqual({ text: "Solo ES", lang: "es" });
  });

  it("un string de solo espacios cuenta como ausente (cae a ES)", () => {
    expect(resolveEditorial({ es: "Solo ES", en: "   ", de: null }, "en")).toEqual({
      text: "Solo ES",
      lang: "es",
    });
  });

  it("sin nada en ningún idioma: text null", () => {
    expect(resolveEditorial(nothing, "en")).toEqual({ text: null, lang: "es" });
    expect(resolveEditorial(nothing, "es")).toEqual({ text: null, lang: "es" });
  });
});

describe("resolveRequiredEditorial", () => {
  it("nunca devuelve null: cae a title_es", () => {
    expect(resolveRequiredEditorial({ es: "Kirito", en: null, de: null }, "de")).toEqual({
      text: "Kirito",
      lang: "es",
    });
  });

  it("usa la traducción cuando existe", () => {
    expect(
      resolveRequiredEditorial({ es: "Kirito", en: "Kirito EN", de: null }, "en"),
    ).toEqual({ text: "Kirito EN", lang: "en" });
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────
function imageRow(overrides: Partial<CosplayPostImageRow> = {}): CosplayPostImageRow {
  return {
    id: "img-1",
    position: 0,
    is_cover: true,
    decorative: false,
    alt_es: "Kirito posando",
    alt_en: null,
    alt_de: null,
    caption_es: null,
    caption_en: null,
    caption_de: null,
    media_assets: {
      id: "asset-1",
      status: "ready",
      width: 1600,
      height: 2400,
      storage_key: "cosplay/asset-1/w1600.webp",
    },
    ...overrides,
  };
}

describe("mapImageRow", () => {
  const buildUrl = (key: string) => `https://media.example/${key}`;

  it("mapea una imagen ready correctamente", () => {
    expect(mapImageRow(imageRow(), buildUrl)).toEqual({
      id: "img-1",
      url: "https://media.example/cosplay/asset-1/w1600.webp",
      width: 1600,
      height: 2400,
      position: 0,
      isCover: true,
      decorative: false,
      altEs: "Kirito posando",
      altEn: null,
      altDe: null,
      captionEs: null,
      captionEn: null,
      captionDe: null,
    });
  });

  it("media_assets ausente → null (fila huérfana, defensa en profundidad)", () => {
    expect(mapImageRow(imageRow({ media_assets: null }), buildUrl)).toBeNull();
  });

  it.each(["reserved", "deleting"] as const)(
    "media_assets con status=%s (no ready) → null aunque el SQL ya debería filtrarlo",
    (status) => {
      expect(
        mapImageRow(
          imageRow({ media_assets: { ...imageRow().media_assets!, status } }),
          buildUrl,
        ),
      ).toBeNull();
    },
  );
});

function postRow(overrides: Partial<CosplayPostRow> = {}): CosplayPostRow {
  return {
    id: "post-1",
    slug: "kirito-sao",
    status: "published",
    title_es: "Kirito",
    title_en: "Kirito",
    title_de: null,
    description_es: "Descripción",
    description_en: null,
    description_de: null,
    character_name: "Kirito",
    series: "Sword Art Online",
    event: null,
    shot_on: "2026-03-01",
    photographer_credit: null,
    published_at: "2026-03-02T10:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

describe("mapPostRowToSummary / mapPostRowToDetail", () => {
  const buildUrl = (key: string) => `https://media.example/${key}`;
  const images = [
    mapImageRow(imageRow({ id: "img-1", position: 1, is_cover: false }), buildUrl)!,
    mapImageRow(
      imageRow({
        id: "img-2",
        position: 0,
        is_cover: true,
        media_assets: { ...imageRow().media_assets!, id: "asset-2", storage_key: "k2" },
      }),
      buildUrl,
    )!,
  ];

  it("published_at ausente → null (fail closed, nunca se construye un resumen sin fecha)", () => {
    expect(mapPostRowToSummary(postRow({ published_at: null }), images)).toBeNull();
    expect(mapPostRowToDetail(postRow({ published_at: null }), images)).toBeNull();
  });

  it("elige la portada (is_cover=true), no la primera del array", () => {
    const summary = mapPostRowToSummary(postRow(), images);
    expect(summary?.cover?.id).toBe("img-2");
  });

  it("sin ninguna portada marcada, usa la primera imagen como respaldo", () => {
    const noCover = images.map((img) => ({ ...img, isCover: false }));
    const summary = mapPostRowToSummary(postRow(), noCover);
    expect(summary?.cover?.id).toBe(noCover[0]!.id);
  });

  it("sin imágenes: cover null, photoCount 0", () => {
    const summary = mapPostRowToSummary(postRow(), []);
    expect(summary).toMatchObject({ cover: null, photoCount: 0 });
  });

  it("photoCount refleja el total de imágenes ready", () => {
    expect(mapPostRowToSummary(postRow(), images)?.photoCount).toBe(2);
  });

  it("el detalle ordena la galería por position", () => {
    const detail = mapPostRowToDetail(postRow(), images);
    expect(detail?.gallery.map((i) => i.id)).toEqual(["img-2", "img-1"]);
  });

  it("el detalle incluye descripciones y crédito, el resumen no los expone", () => {
    const detail = mapPostRowToDetail(postRow(), images);
    expect(detail).toMatchObject({
      descriptionEs: "Descripción",
      photographerCredit: null,
    });
    const summary = mapPostRowToSummary(postRow(), images);
    expect(summary).not.toHaveProperty("descriptionEs");
    expect(summary).not.toHaveProperty("gallery");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────
function readyImage(
  overrides: Partial<PublishReadinessImage> = {},
): PublishReadinessImage {
  return {
    id: "img-1",
    status: "ready",
    isCover: true,
    decorative: false,
    altEs: "Alt",
    ...overrides,
  };
}

describe("validatePublishReadiness", () => {
  it("publicación válida: sin errores", () => {
    expect(validatePublishReadiness({ titleEs: "Kirito" }, [readyImage()])).toEqual([]);
  });

  it("título vacío → missing_title_es", () => {
    const errors = validatePublishReadiness({ titleEs: "   " }, [readyImage()]);
    expect(errors).toContainEqual({ code: "missing_title_es" });
  });

  it("sin ninguna imagen ready → no_ready_images (aunque haya reservadas)", () => {
    const errors = validatePublishReadiness({ titleEs: "Kirito" }, [
      readyImage({ status: "reserved" }),
    ]);
    expect(errors).toEqual([{ code: "no_ready_images" }]);
  });

  it("cero portadas entre las ready → no_cover", () => {
    const errors = validatePublishReadiness({ titleEs: "Kirito" }, [
      readyImage({ isCover: false }),
    ]);
    expect(errors).toContainEqual({ code: "no_cover" });
  });

  it("dos portadas → multiple_covers", () => {
    const errors = validatePublishReadiness({ titleEs: "Kirito" }, [
      readyImage({ id: "a", isCover: true }),
      readyImage({ id: "b", isCover: true }),
    ]);
    expect(errors).toContainEqual({ code: "multiple_covers" });
  });

  it("imagen no decorativa sin alt_es → missing_alt_es con el id de la imagen", () => {
    const errors = validatePublishReadiness({ titleEs: "Kirito" }, [
      readyImage({ id: "img-9", decorative: false, altEs: null }),
    ]);
    expect(errors).toContainEqual({ code: "missing_alt_es", imageId: "img-9" });
  });

  it("imagen decorativa sin alt_es: válida (decorative exime del requisito)", () => {
    const errors = validatePublishReadiness({ titleEs: "Kirito" }, [
      readyImage({ decorative: true, altEs: null }),
    ]);
    expect(errors).toEqual([]);
  });

  it("alt_es de solo espacios cuenta como ausente", () => {
    const errors = validatePublishReadiness({ titleEs: "Kirito" }, [
      readyImage({ altEs: "   " }),
    ]);
    expect(errors).toContainEqual({ code: "missing_alt_es", imageId: "img-1" });
  });

  it("una imagen reservada (no ready) nunca cuenta para el requisito de alt/portada", () => {
    const errors = validatePublishReadiness({ titleEs: "Kirito" }, [
      readyImage(),
      readyImage({ id: "img-2", status: "reserved", altEs: null, isCover: true }),
    ]);
    // La reservada con isCover no cuenta como segunda portada ni exige alt: solo hay 1 ready.
    expect(errors).toEqual([]);
  });

  it("acumula varios errores a la vez", () => {
    const errors = validatePublishReadiness({ titleEs: "" }, []);
    expect(errors).toEqual(
      expect.arrayContaining([{ code: "missing_title_es" }, { code: "no_ready_images" }]),
    );
    expect(errors).toHaveLength(2);
  });
});
