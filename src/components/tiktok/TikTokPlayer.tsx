import { useEffect, useState } from "react";
import TikTokCover from "./TikTokCover";
import { tikTokPlayerUrl } from "./tiktokUrl";

interface TikTokPlayerProps {
  videoId: string;
  title: string;
  /** Portada: se ve mientras carga el reproductor y como respaldo si falla. */
  coverUrl: string;
}

/**
 * Si el iframe no dispara `load` en este tiempo, se muestra el respaldo. (Un iframe de otro
 * origen no informa de errores HTTP ni de bloqueos; `load` es la única señal fiable.)
 */
export const PLAYER_LOAD_TIMEOUT_MS = 10_000;

/**
 * Reproductor oficial de TikTok dentro del área 9:16 del visor. Llena el contenedor
 * (`absolute inset-0`), sin recortes ni escalados. Solo hay UNO montado a la vez: el visor
 * lo remonta al cambiar de vídeo y se desmonta al cerrar (deja de sonar).
 *
 * En pantallas táctiles, dos franjas laterales transparentes recogen el swipe vertical: un
 * iframe de otro origen se queda con todos los toques, así que sin ellas el gesto no llegaría
 * al visor. La zona central (Play) y las barras superior/inferior siguen siendo del reproductor.
 */
export default function TikTokPlayer({ videoId, title, coverUrl }: TikTokPlayerProps) {
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    if (status !== "loading") return;
    const timer = setTimeout(() => setStatus("failed"), PLAYER_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [status]);

  return (
    <>
      {/* Portada mientras carga (y como contenido principal si el reproductor falla). */}
      {status !== "ready" && <TikTokCover url={coverUrl} alt="" />}

      {status !== "failed" && (
        <iframe
          src={tikTokPlayerUrl(videoId)}
          title={title ? `Reproductor de TikTok: ${title}` : "Reproductor de TikTok"}
          // Sin allow-top-navigation: el reproductor no puede sacar al usuario de la web.
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
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
          No se pudo cargar el reproductor. Puedes verlo en TikTok.
        </p>
      )}

      {status !== "failed" && (
        <>
          <div
            aria-hidden="true"
            data-tt-swipe-zone
            className="absolute bottom-[10%] left-0 top-[9%] hidden w-[16%] touch-none [@media(pointer:coarse)]:block"
          />
          <div
            aria-hidden="true"
            data-tt-swipe-zone
            className="absolute bottom-[10%] right-0 top-[9%] hidden w-[16%] touch-none [@media(pointer:coarse)]:block"
          />
        </>
      )}
    </>
  );
}
