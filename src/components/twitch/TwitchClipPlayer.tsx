import { useEffect, useState } from "react";
import type { TwitchClip } from "@/types";
import { ClipThumbnail } from "./TwitchClip";
import { twitchClipEmbedUrl } from "./twitchUrl";

interface TwitchClipPlayerProps {
  clip: TwitchClip;
}

/**
 * Si el iframe no dispara `load` en este tiempo, se muestra el respaldo. (Un iframe de otro
 * origen no informa de errores HTTP ni de bloqueos; `load` es la única señal fiable.)
 */
export const PLAYER_LOAD_TIMEOUT_MS = 10_000;

/**
 * Reproductor oficial de clips de Twitch dentro del visor: el ÚNICO iframe de clip de la web.
 * El visor lo remonta al cambiar de clip (`key`) y se desmonta al cerrar (deja de sonar).
 *
 * En pantallas táctiles, dos franjas laterales transparentes recogen el swipe horizontal: un
 * iframe de otro origen se queda con todos los toques, así que sin ellas el gesto no llegaría
 * al visor. La zona central (Play) y las barras superior/inferior (controles de Twitch:
 * reproducir, volumen, pantalla completa) siguen siendo del reproductor.
 */
export default function TwitchClipPlayer({ clip }: TwitchClipPlayerProps) {
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const parent = typeof window !== "undefined" ? window.location.hostname : "localhost";

  useEffect(() => {
    if (status !== "loading") return;
    const timer = setTimeout(() => setStatus("failed"), PLAYER_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [status]);

  return (
    <>
      {/* Miniatura mientras carga (y como contenido principal si el reproductor falla). */}
      {status !== "ready" && <ClipThumbnail url={clip.thumbnailUrl} alt="" />}

      {status !== "failed" && (
        <iframe
          src={twitchClipEmbedUrl(clip, parent)}
          title={clip.title ? `Clip de Twitch: ${clip.title}` : "Clip de Twitch"}
          allow="fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          onLoad={() => setStatus("ready")}
          className={`absolute inset-0 h-full w-full border-0 bg-black transition-opacity duration-200 ${
            status === "ready" ? "opacity-100" : "opacity-0"
          }`}
        />
      )}

      {status === "failed" && (
        <p
          role="status"
          className="absolute inset-x-3 bottom-3 rounded-lg bg-black/70 px-3 py-2 text-center text-xs text-text-secondary backdrop-blur-sm"
        >
          No se pudo cargar el reproductor. Puedes verlo en Twitch.
        </p>
      )}

      {status !== "failed" && (
        <>
          <div
            aria-hidden="true"
            data-tw-swipe-zone
            className="absolute bottom-[22%] left-0 top-[14%] hidden w-[14%] touch-none [@media(pointer:coarse)]:block"
          />
          <div
            aria-hidden="true"
            data-tw-swipe-zone
            className="absolute bottom-[22%] right-0 top-[14%] hidden w-[14%] touch-none [@media(pointer:coarse)]:block"
          />
        </>
      )}
    </>
  );
}
