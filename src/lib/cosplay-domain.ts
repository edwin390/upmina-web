import type {
  CosplayImage,
  CosplayPostDetail,
  CosplayPostImageRow,
  CosplayPostRow,
  CosplayPostSummary,
} from "../types/index.js";
import type { Locale } from "../i18n/locale-core.js";

// Dominio de Cosplay (Fase 9I-1): funciones PURAS, sin I/O, compartidas entre los handlers de
// servidor (src/lib/cosplay-handlers.ts) y, más adelante, el editor ADMIN (Fase 9I-3). Nada aquí
// llama a Supabase, a R2 ni al navegador — por eso se prueba sin fakes ni red.

// ────────────────────────────────────────────────────────────────────────────────────────────
// Slug

const SLUG_MAX_LENGTH = 80;
const SLUG_MIN_LENGTH = 3;
const SLUG_FORMAT = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Si tras normalizar no queda nada útil (título solo con símbolos, emoji, CJK sin
 *  transliteración ASCII, etc.), esta es la base: nunca se publica un slug vacío. */
const SLUG_FALLBACK_BASE = "cosplay";

/** Mismo patrón que exige la migración (`cosplay_posts_slug_format`): 3–80 caracteres, minúsculas
 *  y dígitos ASCII separados por un solo guion, sin guion inicial/final ni dobles. */
export function isValidSlugFormat(slug: string): boolean {
  return (
    slug.length >= SLUG_MIN_LENGTH &&
    slug.length <= SLUG_MAX_LENGTH &&
    SLUG_FORMAT.test(slug)
  );
}

/** Deriva un slug candidato del título en español: minúsculas, sin acentos/diacríticos, símbolos
 *  y espacios colapsados a un solo guion, recortado a 80 caracteres sin cortar a mitad de
 *  palabra cuando es posible. Nunca lanza: un título sin ningún carácter ASCII alfanumérico cae
 *  en SLUG_FALLBACK_BASE (p. ej. un título solo en japonés). El resultado es un CANDIDATO: quien
 *  llama debe resolver colisiones con generateUniqueSlug antes de guardarlo. */
export function slugify(titleEs: string): string {
  const normalized = titleEs
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // quita diacríticos (á→a, ñ→n vía NFD+combining tilde)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  // Menos de 3 caracteres útiles (p. ej. título "A" o "42"): se combina con la base de reserva
  // en vez de dejar un slug de 1-2 caracteres, que violaría el mínimo de la migración.
  const withMinLength =
    normalized.length === 0
      ? SLUG_FALLBACK_BASE
      : normalized.length < SLUG_MIN_LENGTH
        ? `${normalized}-${SLUG_FALLBACK_BASE}`
        : normalized;
  const base = withMinLength;

  if (base.length <= SLUG_MAX_LENGTH) return base;
  // Recorta sin dejar un guion colgando ni una palabra a medias si hay un guion cerca del límite.
  const truncated = base.slice(0, SLUG_MAX_LENGTH);
  const lastDash = truncated.lastIndexOf("-");
  const trimmed = lastDash >= SLUG_MIN_LENGTH ? truncated.slice(0, lastDash) : truncated;
  return trimmed.replace(/-+$/g, "") || SLUG_FALLBACK_BASE.slice(0, SLUG_MAX_LENGTH);
}

const MAX_SLUG_ATTEMPTS = 1000;

/** Añade `-2`, `-3`, … hasta encontrar un slug libre en `existingSlugs`. Determinista: el mismo
 *  `base` y el mismo conjunto de slugs existentes siempre producen el mismo resultado. Recorta
 *  el sufijo si el resultado excediera 80 caracteres. */
export function generateUniqueSlug(
  base: string,
  existingSlugs: ReadonlySet<string>,
): string {
  if (!existingSlugs.has(base)) return base;

  for (let n = 2; n <= MAX_SLUG_ATTEMPTS; n++) {
    const suffix = `-${n}`;
    const candidate =
      base.length + suffix.length <= SLUG_MAX_LENGTH
        ? `${base}${suffix}`
        : `${base.slice(0, SLUG_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!existingSlugs.has(candidate)) return candidate;
  }
  throw new Error(
    `No se encontró un slug libre para "${base}" tras ${MAX_SLUG_ATTEMPTS} intentos`,
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Fallback editorial ES → idioma solicitado

export interface EditorialField {
  es: string | null;
  en: string | null;
  de: string | null;
}

export interface ResolvedEditorial {
  text: string | null;
  /** Idioma REAL del texto devuelto (puede no ser el `locale` pedido: fallback a ES). Los
   *  componentes deben usarlo como `lang="…"` del elemento cuando difiera del idioma activo,
   *  para que un lector de pantalla no pronuncie español con reglas de inglés/alemán. */
  lang: Locale;
}

/** title_en/description_en/etc. ausente o vacío → se trata como ausente (cae a ES). Un string de
 *  solo espacios no cuenta como traducción real. */
function isBlank(value: string | null): value is null {
  return value === null || value.trim().length === 0;
}

/** Resuelve un campo editorial OPCIONAL (puede no tener ni siquiera texto en español, p. ej.
 *  description). Español → el propio texto (o null si tampoco hay ES). Inglés/alemán → el
 *  texto en ese idioma si existe; si no, cae a español (con `lang` marcado como "es"). */
export function resolveEditorial(
  field: EditorialField,
  locale: Locale,
): ResolvedEditorial {
  if (locale === "es") return { text: isBlank(field.es) ? null : field.es, lang: "es" };

  const requested = locale === "en" ? field.en : field.de;
  if (!isBlank(requested)) return { text: requested, lang: locale };
  return { text: isBlank(field.es) ? null : field.es, lang: "es" };
}

/** Igual que resolveEditorial, pero para un campo que la base de datos garantiza NOT NULL en
 *  español (hoy solo title_es): el resultado nunca es null. */
export function resolveRequiredEditorial(
  field: { es: string; en: string | null; de: string | null },
  locale: Locale,
): { text: string; lang: Locale } {
  const resolved = resolveEditorial(field, locale);
  return { text: resolved.text ?? field.es, lang: resolved.lang };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Mapeo fila cruda de Supabase → contrato público (usado por el servidor Y por los fixtures de
// localhost, para que ambos caminos pasen por exactamente la misma forma).

/** `null` si el activo no existe o no está `ready`: una imagen reservada o borrándose nunca debe
 *  aparecer en una galería pública, aunque el filtro SQL ya la excluya (defensa en profundidad —
 *  ver "no depender del filtrado del frontend", 9I-1 sección 29). */
export function mapImageRow(
  row: CosplayPostImageRow,
  buildUrl: (storageKey: string) => string,
): CosplayImage | null {
  const asset = row.media_assets;
  if (!asset || asset.status !== "ready") return null;

  return {
    id: row.id,
    url: buildUrl(asset.storage_key),
    width: asset.width,
    height: asset.height,
    position: row.position,
    isCover: row.is_cover,
    decorative: row.decorative,
    altEs: row.alt_es,
    altEn: row.alt_en,
    altDe: row.alt_de,
    captionEs: row.caption_es,
    captionEn: row.caption_en,
    captionDe: row.caption_de,
  };
}

function pickCover(images: CosplayImage[]): CosplayImage | null {
  return images.find((image) => image.isCover) ?? images[0] ?? null;
}

export function mapPostRowToSummary(
  row: CosplayPostRow,
  images: CosplayImage[],
): CosplayPostSummary | null {
  // Una publicación pública SIEMPRE tiene published_at (la migración lo exige para
  // status='published'); si faltara sería una fila corrupta o un borrador filtrado por error —
  // en ambos casos, fail closed: no se construye un resumen sin fecha de publicación.
  if (!row.published_at) return null;

  return {
    id: row.id,
    slug: row.slug,
    titleEs: row.title_es,
    titleEn: row.title_en,
    titleDe: row.title_de,
    characterName: row.character_name,
    series: row.series,
    event: row.event,
    shotOn: row.shot_on,
    publishedAt: row.published_at,
    cover: pickCover(images),
    photoCount: images.length,
  };
}

export function mapPostRowToDetail(
  row: CosplayPostRow,
  images: CosplayImage[],
): CosplayPostDetail | null {
  const summary = mapPostRowToSummary(row, images);
  if (!summary) return null;

  return {
    ...summary,
    descriptionEs: row.description_es,
    descriptionEn: row.description_en,
    descriptionDe: row.description_de,
    photographerCredit: row.photographer_credit,
    gallery: [...images].sort((a, b) => a.position - b.position),
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Validación de "lista para publicar" (Fase 9I-3 la invocará antes de aceptar una publicación).
// Vive aquí, no como CHECK de base de datos, porque abarca varias filas (cosplay_post_images) y
// depende del ESTADO de publicación deseado, no del estado actual de cada fila por separado: un
// borrador con imágenes sin alt es válido mientras siga siendo borrador.

export type PublishValidationErrorCode =
  | "missing_title_es"
  | "no_ready_images"
  | "no_cover"
  | "multiple_covers"
  | "missing_alt_es";

export interface PublishValidationError {
  code: PublishValidationErrorCode;
  /** Solo presente para missing_alt_es: qué imagen falla (para que el editor la señale). */
  imageId?: string;
}

export interface PublishReadinessImage {
  id: string;
  status: "reserved" | "ready" | "deleting";
  isCover: boolean;
  decorative: boolean;
  altEs: string | null;
}

/** Lista CERRADA de errores (vacía = lista para publicar). Nunca lanza: el llamador decide cómo
 *  presentar cada código. El orden no importa; el editor los agrupará como convenga. */
export function validatePublishReadiness(
  post: { titleEs: string },
  images: readonly PublishReadinessImage[],
): PublishValidationError[] {
  const errors: PublishValidationError[] = [];

  if (post.titleEs.trim().length === 0) errors.push({ code: "missing_title_es" });

  const ready = images.filter((image) => image.status === "ready");
  if (ready.length === 0) {
    errors.push({ code: "no_ready_images" });
  } else {
    const covers = ready.filter((image) => image.isCover);
    if (covers.length === 0) errors.push({ code: "no_cover" });
    if (covers.length > 1) errors.push({ code: "multiple_covers" });

    for (const image of ready) {
      if (!image.decorative && isBlank(image.altEs)) {
        errors.push({ code: "missing_alt_es", imageId: image.id });
      }
    }
  }

  return errors;
}
