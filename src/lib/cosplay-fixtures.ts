import type {
  CosplayImage,
  CosplayPostDetail,
  CosplayPostSummary,
} from "../types/index.js";

// Fixtures de /cosplay para localhost (Fase 9I-1, VITE_DEMO_MODE=true — ver useCosplayList.ts /
// useCosplayPost.ts). Contenido inventado y marcado como tal en cada texto, NUNCA fotos reales
// de Mina: el objetivo es ejercitar el layout (hero, tarjetas, metadatos, traducciones, galería,
// lightbox, título largo, campos opcionales ausentes, varias imágenes, imagen decorativa), no
// simular contenido real. Nunca se insertan en Supabase ni se piden por red: viven solo en este
// módulo y solo se usan si isDemoMode es true (ver src/lib/runtime.ts).
//
// Imágenes: SVG generado en memoria (data URI), nunca un archivo de imagen real ni descargado.
// Sin binarios que revisar ni pesar en el repo.

function placeholderImage(
  seed: number,
  width: number,
  height: number,
  label: string,
): string {
  const hue = (seed * 47) % 360;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="hsl(${hue},45%,22%)"/>` +
    `<stop offset="100%" stop-color="hsl(${(hue + 60) % 360},55%,12%)"/>` +
    `</linearGradient></defs>` +
    `<rect width="100%" height="100%" fill="url(#g)"/>` +
    `<text x="50%" y="50%" fill="rgba(255,255,255,0.55)" font-family="sans-serif" font-size="${Math.round(width / 14)}" text-anchor="middle" dominant-baseline="middle">${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function image(
  overrides: Partial<CosplayImage> & Pick<CosplayImage, "id" | "position">,
): CosplayImage {
  const width = 1600;
  const height = 2400;
  return {
    url: placeholderImage(
      overrides.id.length + overrides.position,
      width,
      height,
      `FIXTURE ${overrides.position + 1}`,
    ),
    width,
    height,
    isCover: overrides.position === 0,
    decorative: false,
    altEs: `[fixture] Foto de prueba ${overrides.position + 1}`,
    altEn: `[fixture] Test photo ${overrides.position + 1}`,
    altDe: `[fixture] Testfoto ${overrides.position + 1}`,
    captionEs: null,
    captionEn: null,
    captionDe: null,
    ...overrides,
  };
}

// Publicación 1: la más reciente (hero), con galería completa de 6 fotos, traducciones EN/DE
// completas y todos los campos opcionales presentes.
const galleryOne: CosplayImage[] = [
  image({ id: "fx-1-0", position: 0 }),
  image({ id: "fx-1-1", position: 1, captionEs: "[fixture] Con luces de neón" }),
  image({ id: "fx-1-2", position: 2 }),
  image({ id: "fx-1-3", position: 3, decorative: true, altEs: "" }),
  image({ id: "fx-1-4", position: 4 }),
  image({ id: "fx-1-5", position: 5 }),
];

const postOne: CosplayPostDetail = {
  id: "fx-post-1",
  slug: "fixture-personaje-de-prueba",
  titleEs: "[fixture] Personaje de prueba",
  titleEn: "[fixture] Test character",
  titleDe: "[fixture] Testcharakter",
  descriptionEs:
    "[fixture] Descripción de ejemplo en español, con varias líneas para comprobar el ajuste " +
    "de texto en la página de detalle y confirmar que un párrafo largo no rompe el diseño.",
  descriptionEn:
    "[fixture] Sample English description, shorter than the Spanish one on purpose.",
  descriptionDe: null, // a propósito ausente: prueba el fallback a ES en alemán.
  characterName: "[fixture] Nombre del personaje",
  series: "[fixture] Serie o franquicia de ejemplo",
  event: "[fixture] Convención de ejemplo 2026",
  shotOn: "2026-03-15",
  photographerCredit: "[fixture] Fotografía de prueba",
  publishedAt: "2026-03-20T18:00:00.000Z",
  cover: galleryOne[0]!,
  photoCount: galleryOne.length,
  gallery: galleryOne,
};

// Publicación 2: título deliberadamente largo, sin traducciones EN/DE (prueba el fallback), sin
// evento ni crédito de fotógrafo (campos opcionales ausentes), galería de 2 fotos.
const galleryTwo: CosplayImage[] = [
  image({ id: "fx-2-0", position: 0 }),
  image({ id: "fx-2-1", position: 1 }),
];

const postTwo: CosplayPostSummary &
  Pick<
    CosplayPostDetail,
    "descriptionEs" | "descriptionEn" | "descriptionDe" | "photographerCredit" | "gallery"
  > = {
  id: "fx-post-2",
  slug: "fixture-titulo-largo",
  titleEs:
    "[fixture] Un título deliberadamente muy largo para comprobar cómo se recorta o ajusta en " +
    "la tarjeta del listado y en la cabecera de la página de detalle",
  titleEn: null,
  titleDe: null,
  descriptionEs: null,
  descriptionEn: null,
  descriptionDe: null,
  characterName: "[fixture] Otro personaje",
  series: null,
  event: null,
  shotOn: null,
  photographerCredit: null,
  publishedAt: "2026-03-10T12:00:00.000Z",
  cover: galleryTwo[0]!,
  photoCount: galleryTwo.length,
  gallery: galleryTwo,
};

// Publicación 3: una sola foto, portada decorativa marcada, sirve para probar el caso mínimo
// (una publicación publicable con el mínimo de contenido exigido).
const galleryThree: CosplayImage[] = [image({ id: "fx-3-0", position: 0 })];

const postThree: CosplayPostSummary &
  Pick<
    CosplayPostDetail,
    "descriptionEs" | "descriptionEn" | "descriptionDe" | "photographerCredit" | "gallery"
  > = {
  id: "fx-post-3",
  slug: "fixture-una-sola-foto",
  titleEs: "[fixture] Publicación con una sola foto",
  titleEn: "[fixture] Single-photo post",
  titleDe: "[fixture] Beitrag mit einem Foto",
  descriptionEs:
    "[fixture] El caso mínimo: una publicación válida solo necesita una foto.",
  descriptionEn: null,
  descriptionDe: null,
  characterName: null,
  series: "[fixture] Serie de ejemplo",
  event: null,
  shotOn: "2026-02-01",
  photographerCredit: null,
  publishedAt: "2026-02-05T09:30:00.000Z",
  cover: galleryThree[0]!,
  photoCount: galleryThree.length,
  gallery: galleryThree,
};

/** Detalle completo por slug (usado por CosplayDetail en modo demo). */
export const COSPLAY_FIXTURE_POSTS: CosplayPostDetail[] = [
  postOne,
  postTwo as CosplayPostDetail,
  postThree as CosplayPostDetail,
];

/** Resúmenes para el listado, ya en orden de publicación (más reciente primero), como los
 *  devolvería la API real. */
export const COSPLAY_FIXTURE_LIST: CosplayPostSummary[] = [...COSPLAY_FIXTURE_POSTS]
  .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))
  .map(
    ({
      gallery: _gallery,
      descriptionEs: _de,
      descriptionEn: _den,
      descriptionDe: _dde,
      photographerCredit: _pc,
      ...summary
    }) => summary,
  );

export function findCosplayFixtureBySlug(slug: string): CosplayPostDetail | null {
  return COSPLAY_FIXTURE_POSTS.find((post) => post.slug === slug) ?? null;
}
