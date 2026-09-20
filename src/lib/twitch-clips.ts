// Obtiene los clips MÁS RECIENTES de un canal. Vive fuera de `api/` por la
// misma razón que twitch-shared.ts (Vercel expone cada archivo de `api/` como
// ruta pública).
//
// Por qué no basta con `GET /helix/clips?first=12`: Helix devuelve los clips
// SIEMPRE ordenados por `view_count` descendente y no ofrece ningún parámetro
// para ordenar por fecha. Sin ventana temporal se obtienen los más vistos de
// toda la historia, no los más recientes. Además:
//   - con solo `started_at`, Twitch limita el resultado a una semana; hay que
//     enviar siempre `started_at` y `ended_at`;
//   - la paginación (`after`) puede devolver clips repetidos entre páginas y un
//     cursor incluso cuando la página trae menos de `first` elementos, así que
//     se deduplica por id y se corta por límites explícitos, no por el tamaño
//     de la página;
//   - medido contra Twitch real, el listado de una ventana AMPLIA es incompleto
//     y no determinista (con 24 h/12 h/6 h faltaban entre un 15 % y un 20 % de
//     los clips, precisamente los recientes con 1 vista), mientras que las
//     ventanas de pocas horas devuelven el listado completo y estable. Por eso
//     se empieza con ventanas pequeñas y solo se amplía si hacen falta más.
//
// Estrategia: ventanas disjuntas de lo más reciente a lo más antiguo. Dentro de
// cada ventana se pagina y se deduplica; en cuanto hay al menos MAX_CLIPS clips
// se detiene la búsqueda (todo clip de una ventana más reciente es más nuevo
// que cualquiera de una ventana anterior, así que las siguientes no pueden
// desplazar a ninguno de los ya encontrados). El resultado final se ordena
// explícitamente por fecha de creación descendente; `view_count` nunca decide.
// Limitación conocida: la incompletitud de Helix en ventanas amplias no es
// eliminable desde el cliente; en un canal con muy poca actividad reciente el
// conjunto puede variar ligeramente entre consultas (la caché de 5 min lo
// amortigua), pero el orden devuelto siempre es por fecha descendente.
import type { TwitchClipApiItem } from "../types/api.js";
import { fetchTwitchHelix, TwitchApiError } from "./twitch-shared.js";

export const MAX_CLIPS = 12;

const PAGE_SIZE = 100;
// Límites duros para no encadenar llamadas a Helix sin control.
const MAX_PAGES_PER_WINDOW = 3;
export const MAX_HELIX_CALLS = 12;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// Fronteras (tiempo hacia atrás desde "ahora") de las ventanas sucesivas:
// [0,3h] → [3h,6h] → [6h,12h] → [12h,24h] → [1d,3d] → [3d,7d] → [7d,30d] →
// [30d,90d] → [90d,365d] → [365d,3 años] → [inicio de los clips, 3 años].
const WINDOW_BOUNDARIES_MS = [
  0,
  3 * HOUR_MS,
  6 * HOUR_MS,
  12 * HOUR_MS,
  DAY_MS,
  3 * DAY_MS,
  7 * DAY_MS,
  30 * DAY_MS,
  90 * DAY_MS,
  365 * DAY_MS,
  1095 * DAY_MS,
] as const;
const CLIPS_EPOCH = "2016-01-01T00:00:00Z";

interface ClipsPage {
  data?: TwitchClipApiItem[];
  pagination?: { cursor?: string };
}

// RFC 3339 sin milisegundos, como espera Helix.
function toRfc3339(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function createdAtMs(clip: TwitchClipApiItem): number {
  return Date.parse(clip.created_at);
}

// Sin `id` no se puede embeber el clip y sin una fecha válida no se puede
// ordenar: se descartan en lugar de romper la respuesta completa.
function isUsableClip(
  clip: TwitchClipApiItem | null | undefined,
): clip is TwitchClipApiItem {
  return (
    !!clip &&
    typeof clip.id === "string" &&
    clip.id !== "" &&
    Number.isFinite(createdAtMs(clip))
  );
}

export async function getRecentClips(
  broadcasterId: string,
  now: Date = new Date(),
): Promise<TwitchClipApiItem[]> {
  const clipsById = new Map<string, TwitchClipApiItem>();
  let calls = 0;

  for (
    let w = 0;
    w < WINDOW_BOUNDARIES_MS.length &&
    clipsById.size < MAX_CLIPS &&
    calls < MAX_HELIX_CALLS;
    w++
  ) {
    const endedAt = new Date(now.getTime() - (WINDOW_BOUNDARIES_MS[w] ?? 0));
    const olderBoundary = WINDOW_BOUNDARIES_MS[w + 1];
    const startedAt =
      olderBoundary === undefined
        ? CLIPS_EPOCH
        : toRfc3339(new Date(now.getTime() - olderBoundary));

    let cursor: string | undefined;
    let pages = 0;
    do {
      const params = new URLSearchParams({
        broadcaster_id: broadcasterId,
        first: String(PAGE_SIZE),
        started_at: startedAt,
        ended_at: toRfc3339(endedAt),
      });
      if (cursor) params.set("after", cursor);

      const response = await fetchTwitchHelix(`clips?${params.toString()}`);
      calls++;
      pages++;
      if (!response.ok) {
        throw new TwitchApiError("Twitch no pudo consultar los clips", 502);
      }

      const page = (await response.json()) as ClipsPage;
      for (const clip of page.data ?? []) {
        if (isUsableClip(clip)) clipsById.set(clip.id, clip);
      }

      const nextCursor = page.pagination?.cursor;
      // Un cursor repetido indicaría un bucle; se corta igualmente por los
      // límites duros de páginas y de llamadas.
      cursor = nextCursor && nextCursor !== cursor ? nextCursor : undefined;
    } while (cursor && pages < MAX_PAGES_PER_WINDOW && calls < MAX_HELIX_CALLS);
  }

  return [...clipsById.values()]
    .sort((a, b) => createdAtMs(b) - createdAtMs(a) || (a.id < b.id ? 1 : -1))
    .slice(0, MAX_CLIPS);
}
