import { useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslations } from "use-intl";
import CosplayLocaleProvider from "@/i18n/LocaleProvider";
import PrivilegedOnly from "@/components/auth/PrivilegedOnly";
import { useAdminAccess } from "@/hooks/useAdminAccess";
import { useMediaUpload, type MediaQueueItem } from "@/hooks/useMediaUpload";

// Arnés de desarrollo del pipeline de medios (Fase 9I-2B). SOLO existe en un build de
// desarrollo: la ruta que lo monta está protegida por `import.meta.env.DEV` en App.tsx, así que
// ni siquiera está presente en el bundle de producción (no es "un botón oculto" — literalmente no
// se compila ahí). NO es el editor ADMIN real (eso es la Fase 9I-3): solo ejercita
// reservar/subir/procesar/ver el resultado de una foto real, para probar el pipeline en
// localhost.
//
// La autorización sigue siendo 100% server-side (cosplay_admin + MFA reciente, ver
// media-handlers.ts) — PrivilegedOnly aquí es solo presentación, exactamente como en el resto del
// panel /admin. Para poder usar este arnés hace falta una sesión ADMIN real con MFA reciente
// contra el proyecto de Supabase que tengas configurado en tu entorno local (nunca contra
// Production para probar subidas reales — ver las instrucciones de 9I-2C).

function statusLabel(
  t: ReturnType<typeof useTranslations>,
  status: MediaQueueItem["status"],
) {
  return t(`status.${status}`);
}

function ItemCard({
  item,
  onRetry,
  onRemove,
}: {
  item: MediaQueueItem;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const t = useTranslations("media");
  const progressPercent =
    item.totalUploadBytes > 0
      ? Math.min(100, Math.round((item.uploadedBytes / item.totalUploadBytes) * 100))
      : 0;

  return (
    <li className="rounded-lg border border-border-subtle bg-bg-surface p-4">
      <div className="flex items-center justify-between gap-4">
        <p
          className="truncate text-sm font-medium text-text-primary"
          title={item.fileName}
        >
          {item.fileName}
        </p>
        <p
          role="status"
          className="shrink-0 text-xs font-semibold uppercase text-text-secondary"
        >
          {statusLabel(t, item.status)}
        </p>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-2 text-xs text-text-muted">
        <div>
          <dt className="inline">Origen: </dt>
          <dd className="inline">{(item.sourceBytes / 1024).toFixed(0)} KB</dd>
        </div>
        {item.transportStrategy && (
          <div>
            <dt className="inline">Transporte: </dt>
            <dd className="inline">
              {item.transportStrategy === "pre-shrink"
                ? t("transport.preShrink")
                : t("transport.original")}
              {item.percentSaved !== null && item.percentSaved > 0
                ? ` — ${t("transport.percentSaved", { percent: item.percentSaved })}`
                : ""}
            </dd>
          </div>
        )}
      </dl>

      {item.status === "uploading" && (
        <div className="mt-2">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-elevated">
            <div
              className="h-full bg-accent-primary transition-[width]"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-text-muted">{progressPercent}%</p>
        </div>
      )}

      {item.status === "ready" && item.variants && item.variants.length > 0 && (
        <div className="mt-3 grid grid-cols-3 gap-2">
          {item.variants.map((variant) => (
            <div key={variant.url}>
              <img
                src={variant.url}
                alt=""
                className="aspect-square w-full rounded object-cover"
              />
              {/* Diagnóstico técnico puramente numérico (Fase 9I-2C): sin esta etiqueta, 3
                  miniaturas recortadas al mismo tamaño de una foto vertical son indistinguibles a
                  simple vista aunque sean objetos R2 realmente distintos (variant/dimensiones/
                  bytes/URL, confirmado con hash real) — nunca claves de objeto, URLs completas,
                  assetId ni ningún otro dato sensible. */}
              <p className="mt-1 text-center text-[10px] text-text-muted">
                {variant.variant} · {variant.width}×{variant.height} ·{" "}
                {(variant.bytes / 1024).toFixed(0)} KB
              </p>
            </div>
          ))}
        </div>
      )}

      {item.status === "failed" && (
        <p role="alert" className="mt-2 text-sm text-red-400">
          {item.errorCode
            ? t(`errors.${item.errorCode}` as never)
            : (item.errorMessage ?? t("errors.generic"))}
        </p>
      )}

      <div className="mt-3 flex gap-2">
        {item.status === "failed" && (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border border-border-subtle px-3 py-1 text-xs font-semibold text-text-secondary hover:border-accent-primary/70 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
          >
            {t("actions.retry")}
          </button>
        )}
        <button
          type="button"
          onClick={onRemove}
          className="rounded-md border border-border-subtle px-3 py-1 text-xs font-semibold text-text-secondary hover:border-accent-primary/70 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
        >
          {t("actions.remove")}
        </button>
      </div>
    </li>
  );
}

function MediaHarnessContent() {
  const t = useTranslations("media");
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const navigatedToMfaRef = useRef(false);
  const { items, addFiles, retry, remove } = useMediaUpload({ domain: "cosplay" });

  // Fase 9I-2C: un rechazo canónico step_up_required (MFA vencido mientras el arnés ya estaba
  // abierto) navega al flujo de MFA existente (9G-3, /admin/mfa), reutilizando la MISMA
  // infraestructura de returnTo que ya usan /admin, /account, /cosplay — nunca se construye un
  // segundo sistema de navegación para medios. Se navega como mucho una vez: en cuanto ocurre,
  // este componente se desmonta (cambia de ruta), así que el guard con ref solo evita una
  // llamada doble dentro del mismo render. Tras volver del MFA la cola queda vacía (el componente
  // se remontó) — nunca se reintenta la subida pendiente automáticamente; Edwin decide de nuevo.
  useEffect(() => {
    if (navigatedToMfaRef.current) return;
    const needsStepUp = items.some(
      (item) => item.privilegedFailure === "step_up_required",
    );
    if (!needsStepUp) return;
    navigatedToMfaRef.current = true;
    navigate("/admin/mfa?returnTo=/dev/media-harness");
  }, [items, navigate]);

  return (
    <section className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="font-display text-2xl text-text-primary">
        Media harness (solo desarrollo)
      </h1>
      <p className="mt-2 text-sm text-text-secondary">
        Arnés técnico de la Fase 9I-2B: selecciona fotos reales para ejercitar reserva →
        subida directa a R2 → procesado canónico → variantes públicas.
      </p>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/avif"
        multiple
        className="sr-only"
        onChange={(event) => {
          if (event.target.files && event.target.files.length > 0)
            addFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="mt-4 rounded-md bg-accent-primary px-4 py-2 text-sm font-semibold text-bg-base hover:bg-accent-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
      >
        {t("actions.selectFiles")}
      </button>

      <ul className="mt-6 space-y-3" aria-live="polite">
        {items.map((item) => (
          <ItemCard
            key={item.localId}
            item={item}
            onRetry={() => retry(item.localId)}
            onRemove={() => remove(item.localId)}
          />
        ))}
      </ul>
    </section>
  );
}

function MediaHarnessGate() {
  const { status } = useAdminAccess();

  return (
    <>
      <PrivilegedOnly capability="cosplay_admin">
        <MediaHarnessContent />
      </PrivilegedOnly>
      {status !== "ready" && (
        <section className="mx-auto max-w-3xl px-4 py-12 text-center">
          <p className="text-text-secondary">
            Este arnés exige una sesión ADMIN real con MFA reciente (igual que el editor
            real de 9I-3 lo exigirá). Inicia sesión como ADMIN y completa el paso de MFA
            antes de volver aquí.
          </p>
          <Link
            to="/admin/login"
            className="mt-4 inline-block text-sm font-medium text-accent-primary hover:underline"
          >
            Ir a /admin/login
          </Link>
        </section>
      )}
    </>
  );
}

export default function MediaHarnessPage() {
  return (
    <CosplayLocaleProvider>
      <MediaHarnessGate />
    </CosplayLocaleProvider>
  );
}
