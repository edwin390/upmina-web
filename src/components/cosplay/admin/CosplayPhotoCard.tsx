import { useTranslations } from "use-intl";
import type { EditorPhoto } from "@/hooks/useCosplayEditor";

// Tarjeta de UNA foto del editor (Fase 9I-3, checkpoint 3, sección 8/19; simplificada en el
// ajuste UX posterior: sin Alt/Caption/Decorativa manuales — ver useCosplayEditor.ts). Cubre
// tanto una foto recién subida EN ESTA sesión (con su estado real de useMediaUpload: preparando/
// subiendo/procesando/lista/fallida) como una foto YA adjunta cargada del servidor ("existing").
// Botones de mover arriba/abajo con nombre accesible que incluye la posición (nunca solo una
// flecha muda); portada comunicada semánticamente (aria-pressed, nunca solo color).

const SMALL_BUTTON =
  "inline-flex min-h-9 items-center rounded-md border border-border-subtle px-2.5 py-1 text-xs font-semibold text-text-secondary transition-colors hover:border-accent-primary/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50";
const DANGER_SMALL =
  "inline-flex min-h-9 items-center rounded-md border border-accent-live/60 px-2.5 py-1 text-xs font-semibold text-accent-live transition-colors hover:bg-accent-live/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-live disabled:pointer-events-none disabled:opacity-50";

interface Props {
  photo: EditorPhoto;
  index: number;
  total: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onSetCover: () => void;
  onRemove: () => void;
  onRetry: () => void;
  pendingDetach: boolean;
  onConfirmDetach: () => void;
  onCancelDetach: () => void;
  detaching: boolean;
  detachFailed: boolean;
}

export default function CosplayPhotoCard({
  photo,
  index,
  total,
  onMoveUp,
  onMoveDown,
  onSetCover,
  onRemove,
  onRetry,
  pendingDetach,
  onConfirmDetach,
  onCancelDetach,
  detaching,
  detachFailed,
}: Props) {
  const t = useTranslations("cosplay.admin.photos");
  const name = photo.fileName ?? `#${index + 1}`;
  const isReady = photo.uploadStatus === "ready" || photo.uploadStatus === "existing";
  const isFailed = photo.uploadStatus === "failed";

  return (
    <li className="min-w-0 rounded-md border border-border-subtle p-3">
      <div className="flex gap-3">
        <div className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded bg-bg-elevated">
          {photo.url ? (
            <img src={photo.url} alt="" className="h-full w-full object-cover" />
          ) : (
            <span role="status" className="px-1 text-center text-[10px] text-text-muted">
              {t(
                `status.${photo.uploadStatus === "existing" ? "ready" : photo.uploadStatus}` as never,
              )}
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text-primary">{name}</p>

          {isFailed && (
            <p role="alert" className="mt-1 text-xs text-accent-live">
              {photo.uploadErrorMessage ?? t("status.failed")}
            </p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onMoveUp}
              disabled={index === 0}
              aria-label={t("moveUp", { name })}
              className={SMALL_BUTTON}
            >
              ↑
            </button>
            <button
              type="button"
              onClick={onMoveDown}
              disabled={index === total - 1}
              aria-label={t("moveDown", { name })}
              className={SMALL_BUTTON}
            >
              ↓
            </button>
            <button
              type="button"
              onClick={onSetCover}
              disabled={!isReady}
              aria-pressed={photo.isCover}
              aria-label={t("setCover", { name })}
              className={SMALL_BUTTON}
            >
              {photo.isCover ? `★ ${t("isCover")}` : `☆ ${t("cover")}`}
            </button>
            {isFailed && (
              <button type="button" onClick={onRetry} className={SMALL_BUTTON}>
                {t("retry")}
              </button>
            )}
            {!pendingDetach && (
              <button
                type="button"
                onClick={onRemove}
                aria-label={t("remove", { name })}
                className={DANGER_SMALL}
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </div>

      {pendingDetach && (
        <div
          role="group"
          aria-label={t("removeConfirmHeading")}
          className="mt-3 rounded-md border border-accent-live/40 p-3"
        >
          <p className="text-sm font-semibold text-text-primary">
            {t("removeConfirmHeading")}
          </p>
          <p className="mt-1 text-sm text-text-secondary">{t("removeConfirmBody")}</p>
          {detachFailed && (
            <p role="alert" className="mt-2 text-sm text-accent-live">
              {t("removeConfirmBody")}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onConfirmDetach}
              disabled={detaching}
              aria-busy={detaching}
              className={DANGER_SMALL}
            >
              {t("removeConfirmAction")}
            </button>
            <button
              type="button"
              onClick={onCancelDetach}
              disabled={detaching}
              className={SMALL_BUTTON}
            >
              {t("removeCancel")}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
