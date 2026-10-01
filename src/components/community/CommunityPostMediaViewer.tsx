import { useEffect, useRef, useState } from "react";
import type { CommunityFeedPost } from "@/types";

// Visor de media del detalle de una publicación (Fase 9J-3 follow-up "POST DETAIL MEDIA VIEWER"):
// antes (PostDetailPage.tsx) TODA la media de un post se apilaba verticalmente a ancho completo,
// así que un vídeo/imagen vertical (9:16) podía ocupar varias pantallas de alto. Se inspeccionó el
// visor existente de Cosplay (CosplayLightbox.tsx) para reutilizar su patrón de interacción
// (prev/next, contador, teclado ArrowLeft/ArrowRight con el mismo guard de inputs) — pero NO se
// reutiliza el componente en sí: CosplayLightbox está fuertemente acoplado a CosplayImage (sin
// noción de vídeo), es un <dialog> a pantalla completa abierto por clic sobre una miniatura, y aquí
// hace falta un visor SIEMPRE visible e inline dentro del detalle (nunca un paso adicional de
// "abrir"). Por eso este componente es específico de Comunidad.
//
// Solo UN media visible a la vez (nunca todos apilados); mantiene el orden definido por el autor.
// object-contain + una altura MÁXIMA (nunca fija) evita que un archivo vertical requiera scroll.
//
// Corte IMAGEN → IMAGEN en Production (9J-FIX): el <img> tenía `key={item.id}`, forzando remount
// en cada navegación. Corregido quitando el `key` fijo (ver más abajo: ahora la clave ES el id del
// item, pero compartida entre roles — ver siguiente nota).
//
// Corte IMAGEN ↔ VÍDEO en Production (9J-FIX2): el visor renderizaba directamente el item OBJETIVO
// en la única ranura visible, desmontándolo inmediatamente al pulsar Siguiente, antes de que el
// nuevo tuviera nada que pintar. Se introdujo STAGED SWAP: `index` (objetivo solicitado, mueve el
// contador al instante) separado de `displayIndex` (lo realmente pintado). El objetivo se prepara
// en una ranura oculta hasta su evento "listo" (load / loadeddata) y solo entonces se promueve a
// visible.
//
// Corte OCASIONAL en navegación RÁPIDA/en ráfaga (9J-FIX3): con FIX2, cada vez que el objetivo
// cambiaba de tipo (imagen↔vídeo) la ranura de PREPARACIÓN usaba una key `staging-${id}` distinta
// de la key `${id}` de la ranura VISIBLE — aunque lógicamente fueran "el mismo item" en dos
// momentos distintos (primero preparándose, luego visible), React las trataba como DOS elementos
// sin relación. Al promoverse, el objetivo montaba un <video>/<img> COMPLETAMENTE NUEVO (nuevo
// decodificador, preload desde cero) en vez de heredar el que ya llevaba un rato calentándose en
// segundo plano — para vídeo esto podía mostrar un frame negro/vacío inicial pese a que la ranura
// de preparación YA tenía loadeddata disparado. Fix: MediaSlot usa la MISMA key (el id del item,
// sin prefijo de rol) tanto en la ranura visible como en la de preparación. Cuando un item pasa de
// "preparándose" a "visible", React lo reconoce como EL MISMO elemento de una lista con clave (el
// div contenedor pasa un array, no dos ramas de JSX fijas) y reutiliza el nodo DOM real — mismo
// <video> ya con su primer frame decodificado, solo le cambian los atributos (controls, muted,
// clases) — nunca un remount, nunca un frame negro de arranque.
//
// Además (9J-FIX3): identidad de navegación explícita — cada llamada a goTo() incrementa
// `generationRef` de forma SÍNCRONA (inmune a cómo React agrupe los renders posteriores). El
// manejador de "listo" de la ranura de preparación captura la generación Y el índice vigentes EN EL
// RENDER en que se creó; solo aplica el swap si esa generación sigue siendo la actual cuando el
// evento realmente llega — cualquier resultado de una navegación ya abandonada (ráfagas de
// Siguiente/Anterior antes de que el primero resuelva, en cualquier orden) se ignora. Gana siempre
// la navegación más reciente. Volver al item YA visible (index === displayIndex) simplemente deja
// de renderizar la ranura de preparación: el item visible nunca se toca, sin flash ni re-espera.
const NAV_BUTTON =
  "grid h-11 w-11 shrink-0 place-items-center rounded-full border-2 border-accent-secondary bg-bg-base/90 text-xl text-accent-secondary shadow-glow-secondary transition-colors hover:bg-accent-secondary hover:text-text-inverse focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary";

const MEDIA_CLASS =
  "max-h-[60vh] w-auto max-w-full object-contain sm:max-h-[65vh] md:max-h-[70vh]";

// Fuera de pantalla pero SÍ renderizada (nunca display:none): los navegadores siguen cargando
// <img>/<video> con esta técnica, que es justo el punto — solo queremos que sea invisible e
// inerte para el usuario mientras se prepara.
const STAGING_CLASS = "absolute left-0 top-0 h-px w-px overflow-hidden opacity-0";

type MediaItem = CommunityFeedPost["media"][number];

// Un único item de media, renderizado en su rol VISIBLE o de PREPARACIÓN. La key la pone SIEMPRE
// quien invoca este componente (el id del item, sin prefijo) — ver la nota de cabecera: es lo que
// permite que React reutilice el mismo nodo DOM cuando el rol cambia de "staging" a "display".
function MediaSlot({
  item,
  display,
  videoRef,
  onReady,
}: {
  item: MediaItem;
  display: boolean;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  onReady?: () => void;
}) {
  if (item.kind === "video") {
    return (
      <video
        ref={display ? videoRef : undefined}
        src={item.url}
        controls={display}
        muted={!display}
        playsInline
        preload="auto"
        aria-hidden={display ? undefined : "true"}
        tabIndex={display ? undefined : -1}
        className={display ? MEDIA_CLASS : STAGING_CLASS}
        onLoadedData={onReady}
        onError={onReady}
      />
    );
  }
  return (
    <img
      src={item.url}
      alt=""
      aria-hidden={display ? undefined : "true"}
      className={display ? MEDIA_CLASS : STAGING_CLASS}
      onLoad={onReady}
      onError={onReady}
    />
  );
}

export default function CommunityPostMediaViewer({
  media,
}: {
  media: CommunityFeedPost["media"];
}) {
  const [index, setIndex] = useState(0);
  const [displayIndex, setDisplayIndex] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const total = media.length;
  const canNavigate = total > 1;
  const displayItem = media[Math.min(displayIndex, total - 1)];
  const targetItem = media[Math.min(index, total - 1)];
  const isStaging = total > 0 && index !== displayIndex && !!targetItem && !!displayItem;

  // Identidad de navegación (9J-FIX3): se incrementa de forma SÍNCRONA en cada goTo(), antes de
  // programar el cambio de estado — inmune a cómo/cuándo React agrupe los renders posteriores.
  const generationRef = useRef(0);

  const goTo = (updater: number | ((current: number) => number)) => {
    generationRef.current += 1;
    setIndex(updater);
  };
  // Actualizaciones funcionales: el siguiente/anterior índice se deriva del valor de estado MÁS
  // RECIENTE que React tenga en el momento de aplicar la actualización, nunca de un `index`
  // capturado en el closure del render en que se creó el botón — elimina cualquier duda sobre
  // agrupamiento de eventos consecutivos calculando el destino desde un valor desactualizado.
  const goPrev = () => goTo((current) => (current - 1 + total) % total);
  const goNext = () => goTo((current) => (current + 1) % total);

  // El media objetivo de ESTA navegación (capturada por generación + índice en el momento en que
  // se montó su ranura de preparación) ya está listo para pintarse. Si para cuando el evento
  // realmente llega la generación actual ya avanzó (el usuario navegó de nuevo antes de que esto
  // resolviera), se ignora sin más: nunca se promueve un resultado obsoleto, sin importar el orden
  // real en que resuelvan distintas preparaciones en vuelo.
  const handleStagingReady = (readyGeneration: number, readyIndex: number) => {
    if (generationRef.current !== readyGeneration) return;
    videoRef.current?.pause();
    setDisplayIndex(readyIndex);
  };

  // Precarga la imagen/vídeo anterior y siguiente (con wrap-around), nunca la galería completa:
  // para imágenes, un objeto Image() calienta la caché del navegador. Para vídeo, un <video>
  // desconectado del DOM con preload="auto" + muted deja bytes ya en caché antes de que el usuario
  // ni siquiera pulse. Esto es puro CALENTAMIENTO DE CACHÉ — deliberadamente SIN callbacks que
  // toquen index/displayIndex/generación: nunca decide qué se muestra, solo adelanta trabajo de
  // red para cuando la ranura de preparación real (arriba) lo necesite.
  useEffect(() => {
    if (total <= 1) return;
    const neighborIndexes = [(index - 1 + total) % total, (index + 1) % total];
    const detachedVideos: HTMLVideoElement[] = [];
    for (const neighborIndex of neighborIndexes) {
      const neighbor = media[neighborIndex];
      if (!neighbor) continue;
      if (neighbor.kind === "image") {
        const preloadImage = new Image();
        preloadImage.src = neighbor.url;
      } else {
        const preloadVideo = document.createElement("video");
        preloadVideo.preload = "auto";
        preloadVideo.muted = true;
        preloadVideo.src = neighbor.url;
        detachedVideos.push(preloadVideo);
      }
    }
    return () => {
      for (const preloadVideo of detachedVideos) {
        preloadVideo.removeAttribute("src");
        preloadVideo.load();
      }
    };
  }, [index, media, total]);

  // Intenta reproducir el vídeo VISIBLE automáticamente CON sonido, una vez que realmente pasa a
  // estar en pantalla (nunca en el feed, ver CommunityFeedCard.tsx; y nunca la ranura de
  // preparación, que jamás recibe `videoRef` — ver MediaSlot). No se usa muted=true solo para
  // conseguir el autoplay: si el navegador rechaza play() (política real de autoplay, sin gesto
  // reciente del usuario), el rechazo se ignora en silencio. "Listo para mostrarse"
  // (handleStagingReady) y "reproducción permitida" (este efecto) son estados distintos: el swap
  // visual nunca espera a que autoplay tenga éxito.
  useEffect(() => {
    if (displayItem?.kind !== "video") return;
    const videoEl = videoRef.current;
    if (!videoEl) return;
    try {
      const playAttempt = videoEl.play();
      if (playAttempt && typeof playAttempt.catch === "function") {
        playAttempt.catch(() => {
          // Autoplay bloqueado por el navegador: se deja al usuario reproducir con los controles.
        });
      }
    } catch {
      // Algunos entornos (p. ej. jsdom en tests) lanzan de forma síncrona en vez de rechazar
      // la Promise. Mismo criterio: nunca un error de aplicación, los controles siguen ahí.
    }
  }, [displayItem?.id, displayItem?.kind]);

  const goPrevRef = useRef(goPrev);
  const goNextRef = useRef(goNext);
  const canNavigateRef = useRef(canNavigate);
  useEffect(() => {
    goPrevRef.current = goPrev;
    goNextRef.current = goNext;
    canNavigateRef.current = canNavigate;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (!canNavigateRef.current) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target as Element | null;
      if (target?.closest?.("input, textarea, select, [contenteditable]")) return;

      event.preventDefault();
      if (event.key === "ArrowLeft") goPrevRef.current();
      else goNextRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  if (total === 0 || !displayItem) return null;

  // Ambos slots (visible + preparación, si aplica) viven en el MISMO array de hijos con clave: es
  // lo que permite a React reconocer y reutilizar el nodo real de un item cuando pasa de
  // "preparándose" a "visible", en vez de desmontar uno y montar otro desde cero (la causa del
  // corte en ráfaga, ver la nota de cabecera).
  const readyGeneration = generationRef.current;
  const readyIndex = index;
  const slots = [
    <MediaSlot key={displayItem.id} item={displayItem} display videoRef={videoRef} />,
  ];
  if (isStaging && targetItem.id !== displayItem.id) {
    slots.push(
      <MediaSlot
        key={targetItem.id}
        item={targetItem}
        display={false}
        onReady={() => handleStagingReady(readyGeneration, readyIndex)}
      />,
    );
  }

  return (
    <div className="relative mt-4 flex w-full flex-col items-center justify-center overflow-hidden rounded-lg bg-black">
      {slots}

      {canNavigate ? (
        <div
          role="group"
          aria-label="Navegación multimedia"
          className="flex w-full items-center justify-center gap-3 bg-bg-base px-2 py-3"
        >
          <button
            type="button"
            onClick={goPrev}
            aria-label="Anterior"
            className={NAV_BUTTON}
          >
            ‹
          </button>
          <button
            type="button"
            onClick={goNext}
            aria-label="Siguiente"
            className={`${NAV_BUTTON} order-3`}
          >
            ›
          </button>
          <p
            aria-live="polite"
            className="order-2 rounded-full bg-bg-base/90 px-3 py-1 text-xs text-text-secondary"
          >
            {index + 1} / {total}
          </p>
        </div>
      ) : null}
    </div>
  );
}
