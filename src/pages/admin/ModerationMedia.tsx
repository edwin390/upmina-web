import { useState } from "react";
import { useTranslations } from "use-intl";
import type { CommunityFeedMediaItem } from "@/types";

// R5-H: medio de un caso de moderación con carga, error accesible y reintento. Un medio roto no
// afecta al resto del caso. Nunca se muestran el nombre del archivo ni la URL en los mensajes y no
// se escribe nada en consola. No cambia la política de acceso: reutiliza la URL ya entregada por el
// servidor; «reintentar» vuelve a pedirla al navegador con un elemento nuevo. El contrato no trae
// poster para vídeo: hasta que llegan los metadatos se muestra un fallback visual neutro.
const retryClass =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-border-subtle px-4 py-2 text-sm font-semibold text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary";

export default function ModerationMedia({
  item,
  position,
  total,
}: {
  item: CommunityFeedMediaItem;
  position: number;
  total: number;
}) {
  const t = useTranslations("moderation.media");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const isImage = item.kind === "image";
  const label = t(isImage ? "image" : "video", { position, total });
  if (state === "error")
    return (
      <div
        role="group"
        aria-label={label}
        className="flex min-h-24 min-w-0 max-w-full flex-col items-start gap-2 rounded border border-border-subtle bg-bg-elevated p-3 text-sm"
      >
        <p role="alert">{t(isImage ? "imageError" : "videoError")}</p>
        <p className="text-xs text-text-muted">{t("retryHint")}</p>
        <button
          type="button"
          className={retryClass}
          onClick={() => {
            setState("loading");
            setAttempt((n) => n + 1);
          }}
        >
          {t("retry")}
        </button>
      </div>
    );
  const ratio =
    item.width > 0 && item.height > 0 ? `${item.width} / ${item.height}` : "4 / 3";
  return (
    <div
      className="relative h-48 max-w-full overflow-hidden rounded bg-bg-elevated"
      style={{ aspectRatio: ratio }}
      aria-busy={state === "loading"}
    >
      {isImage ? (
        <img
          key={attempt}
          src={item.url}
          alt={label}
          onLoad={() => setState("ready")}
          onError={() => setState("error")}
          className="h-full w-full object-contain"
        />
      ) : (
        <video
          key={attempt}
          src={item.url}
          controls
          preload="metadata"
          aria-label={label}
          onLoadedMetadata={() => setState("ready")}
          onError={() => setState("error")}
          className="h-full w-full"
        />
      )}
      {state === "loading" && (
        <div
          role="status"
          className="pointer-events-none absolute inset-0 flex items-center justify-center bg-bg-elevated text-xs text-text-muted"
        >
          {isImage ? t("loading") : t("videoFallback")}
        </div>
      )}
    </div>
  );
}
