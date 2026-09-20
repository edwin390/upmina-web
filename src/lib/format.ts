/**
 * Convierte una duración ISO 8601 (PT#H#M#S), como la que devuelve
 * la YouTube Data API v3, a formato legible HH:MM:SS o MM:SS.
 */
export function parseIsoDuration(iso: string): string {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return "0:00";

  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);

  const pad = (n: number) => String(n).padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${minutes}:${pad(seconds)}`;
}

/**
 * Convierte la duración de un VOD de Twitch (formato propio de Twitch,
 * p. ej. "3h8m33s" o "45m2s" o "58s" — NO es ISO 8601, a diferencia de
 * YouTube) a formato legible HH:MM:SS o MM:SS.
 */
export function parseTwitchDuration(duration: string): string {
  const match = duration.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match || !duration) return "0:00";

  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);

  const pad = (n: number) => String(n).padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${minutes}:${pad(seconds)}`;
}

/**
 * Sustituye los placeholders de tamaño de una URL de thumbnail de Twitch
 * (`{width}`/`{height}` en streams, `%{width}`/`%{height}` en videos) por
 * las dimensiones dadas. Twitch no siempre incluye `thumbnail_url` (streams
 * recién iniciados, VODs todavía procesándose, etc.), así que esta función
 * es explícita sobre esa posibilidad en vez de asumir que el campo existe.
 */
export function applyThumbnailSize(
  template: string | undefined | null,
  width: number,
  height: number,
): string | undefined {
  if (!template) return undefined;
  return template
    .replace(/%?\{width\}/, String(width))
    .replace(/%?\{height\}/, String(height));
}

/**
 * Devuelve una fecha relativa en español ("Hace 3 días").
 */
export function formatRelativeDate(dateInput: string | Date): string {
  const date = typeof dateInput === "string" ? new Date(dateInput) : dateInput;
  const diffMs = Date.now() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);

  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["week", 60 * 60 * 24 * 7],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
  ];

  const rtf = new Intl.RelativeTimeFormat("es", { numeric: "auto" });

  for (const [unit, secondsInUnit] of units) {
    if (diffSeconds >= secondsInUnit) {
      const value = Math.floor(diffSeconds / secondsInUnit);
      return rtf.format(-value, unit);
    }
  }
  return "Hace instantes";
}
