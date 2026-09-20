import { useState } from "react";

interface TikTokCoverProps {
  url: string;
  /** Texto alternativo; vacío si el contexto ya describe el vídeo. */
  alt?: string;
  /** Solo hover/transición de la tarjeta; el tamaño lo da el contenedor 9:16. */
  className?: string;
}

/**
 * Portada de un TikTok que rellena su contenedor (object-cover, sin deformar). Las
 * portadas de TikTok caducan: si falla la carga se usa un fondo degradado neon.
 */
export default function TikTokCover({ url, alt = "", className = "" }: TikTokCoverProps) {
  // Se recuerda la URL que falló: si llega otra distinta, se vuelve a intentar.
  const [failedUrl, setFailedUrl] = useState<string>();

  if (url && url !== failedUrl) {
    return (
      <img
        src={url}
        alt={alt}
        loading="lazy"
        draggable={false}
        onError={() => setFailedUrl(url)}
        className={`h-full w-full object-cover ${className}`}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className="block h-full w-full bg-gradient-to-br from-accent-primary/30 via-bg-elevated to-accent-secondary/30"
    />
  );
}
