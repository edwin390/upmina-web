import { Link } from "react-router-dom";
import { useTranslations } from "use-intl";
import type { CosplayPostSummary } from "@/types";
import { formatDateOnly, useUpminaLocale } from "@/i18n/useUpminaLocale";

interface MetaItem {
  label: string;
  value: string;
}

/** Fila de metadata opcional: igual patrón que MetaRow en CosplayDetail.tsx (campo ausente = no
 *  se renderiza, nunca un placeholder/guion). */
function MetaRow({ label, value }: MetaItem) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="truncate text-text-secondary">{value}</dd>
    </div>
  );
}

/** Publicación destacada del listado (la más reciente): panel grande con la fotografía como
 *  protagonista clara. Fotografía de cosplay, que suele ser VERTICAL — ya no se fuerza a un
 *  banner horizontal ancho que la recortaba de forma agresiva.
 *
 *  Mobile: una sola imagen apilada arriba, proporción real vía aspect-ratio (width/height del
 *  cover, siempre presentes en CosplayImage) — sin cambios respecto al hero portrait anterior.
 *
 *  Desktop (≥sm, bloque distinto — nunca el mismo <img> reescalado con media queries): la zona
 *  izquierda (~55-60% del hero) es una composición de DOS imágenes superpuestas, nunca una sola
 *  imagen estirada:
 *    1. Fondo decorativo: la MISMA foto, ampliada + blur + oscurecida, rellena todo el panel
 *       (antes quedaba negro alrededor de una foto vertical angosta). alt="" + aria-hidden: nunca
 *       debe generar un segundo elemento de imagen para lectores de pantalla.
 *    2. Primer plano: la foto ORIGINAL completa, con su aspect-ratio real (mismo mecanismo que en
 *       mobile: estilo aspectRatio calculado de antemano, sin esperar a que cargue la imagen —
 *       evita layout shift) y object-contain — cero recorte, nunca compite con el fondo porque
 *       éste queda difuminado/oscurecido detrás.
 *
 *  Puramente presentacional, sin lógica propia de "qué es lo destacado" (la decide CosplaySection
 *  con la primera del array, ya ordenado por published_at desde el servidor). El título es
 *  contenido editorial de Mina: se muestra idéntico sin importar el idioma de la UI (corrección
 *  de producto, Fase 9I-3 — ver types/index.ts). */
export default function CosplayHero({ post }: { post: CosplayPostSummary }) {
  const t = useTranslations("cosplay.list");
  // Mismas etiquetas de metadata que ya usa la página de detalle (cosplay.detail): nunca se
  // duplican como literales nuevos. Solo campos ya disponibles en CosplayPostSummary — la
  // descripción vive únicamente en CosplayPostDetail (la publicación individual) y no se expone
  // aquí sin tocar el contrato del listado público, fuera de alcance de este ajuste.
  const tDetail = useTranslations("cosplay.detail");
  const { locale } = useUpminaLocale();
  const metaItems: MetaItem[] = [
    { label: tDetail("character"), value: post.characterName },
    { label: tDetail("series"), value: post.series },
    { label: tDetail("event"), value: post.event },
    {
      label: tDetail("shotOn"),
      value: post.shotOn && formatDateOnly(post.shotOn, locale),
    },
  ].filter((item): item is MetaItem => Boolean(item.value));
  const coverAspectRatio = post.cover
    ? { aspectRatio: `${post.cover.width} / ${post.cover.height}` }
    : undefined;

  return (
    <Link
      to={`/cosplay/${post.slug}`}
      className="group mb-8 flex flex-col overflow-hidden rounded-xl border border-border-subtle bg-bg-surface transition-colors hover:border-accent-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary sm:flex-row"
    >
      {post.cover && (
        <div
          className="relative w-full shrink-0 overflow-hidden bg-bg-elevated sm:hidden"
          style={coverAspectRatio}
        >
          <img
            src={post.cover.url}
            alt=""
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        </div>
      )}

      {post.cover && (
        <div className="relative hidden shrink-0 items-center justify-center overflow-hidden bg-bg-elevated sm:flex sm:h-[560px] sm:w-[58%]">
          <img
            src={post.cover.url}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 h-full w-full scale-110 object-cover opacity-50 blur-2xl"
          />
          <div aria-hidden="true" className="absolute inset-0 bg-black/35" />
          <img
            src={post.cover.url}
            alt=""
            style={coverAspectRatio}
            className="relative z-10 h-full max-w-full object-contain drop-shadow-2xl transition-transform duration-500 group-hover:scale-[1.02]"
          />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col justify-center gap-3 p-4 sm:p-8">
        <span className="inline-block w-fit rounded-full bg-accent-primary/90 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-text-inverse">
          {t("heroLabel")}
        </span>
        <h2 className="font-display text-2xl tracking-wide text-text-primary sm:text-4xl">
          {post.title}
        </h2>
        {metaItems.length > 0 && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:max-w-sm">
            {metaItems.map((item) => (
              <MetaRow key={item.label} label={item.label} value={item.value} />
            ))}
          </dl>
        )}
      </div>
    </Link>
  );
}
