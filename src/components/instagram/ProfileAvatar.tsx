import { useState } from "react";

interface ProfileAvatarProps {
  /** Foto de perfil real (Meta); si falta o no carga se usa el fallback. */
  url?: string;
  /** Username, para la inicial del fallback. */
  name?: string;
  /** Tamaño Tailwind del círculo (por defecto h-9 w-9). */
  className?: string;
}

/** Avatar circular: foto real o, sin ella, círculo degradado con la inicial. */
export default function ProfileAvatar({
  url,
  name,
  className = "h-9 w-9",
}: ProfileAvatarProps) {
  // Se recuerda la URL que falló: si llega otra distinta, se vuelve a intentar.
  const [failedUrl, setFailedUrl] = useState<string>();

  if (url && url !== failedUrl) {
    return (
      <img
        src={url}
        alt=""
        aria-hidden="true"
        loading="lazy"
        onError={() => setFailedUrl(url)}
        className={`${className} shrink-0 rounded-full border border-border-strong object-cover`}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={`${className} grid shrink-0 place-items-center rounded-full bg-gradient-accent text-sm font-bold uppercase text-text-inverse`}
    >
      {(name ?? "I").charAt(0)}
    </span>
  );
}
