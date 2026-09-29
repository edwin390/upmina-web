// /comunidad (Fase 9J-1C UX follow-up): cascarón presentacional MÍNIMO hasta que llegue el
// checkpoint del feed real de Comunidad. Sustituye el prototipo legado (EditsFeed/UploadEditForm,
// que consultaba una tabla `edits` inexistente — nunca llegó a funcionar) en vez de intentar
// repararlo o mantenerlo: la creación de contenido de Comunidad vive EXCLUSIVAMENTE en /account
// (CommunityPostsSection, 9J-1C) — esta página nunca vuelve a tener un formulario de subida.
//
// Sin datos inventados: "Recientes"/"Populares" son solo las etiquetas congeladas del producto
// (nunca "Top semanal", el nombre legado) — no son pestañas funcionales todavía porque no hay
// ninguna fuente de datos pública que mostrar en este checkpoint (9J-1C no implementa lectura
// pública de community_posts). El feed real, con datos reales, es un checkpoint futuro.
export default function CommunitySection() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-16">
      <h1 className="mb-6 font-display text-3xl tracking-wide text-text-primary">
        Comunidad
      </h1>

      <div className="mb-6 flex gap-2">
        <span className="rounded-md bg-accent-primary px-3 py-1.5 text-sm font-semibold text-text-inverse">
          Recientes
        </span>
        <span className="rounded-md bg-bg-elevated px-3 py-1.5 text-sm text-text-secondary">
          Populares
        </span>
      </div>

      <p className="text-text-secondary" role="status" aria-live="polite">
        Todavía no hay publicaciones que mostrar.
      </p>
    </section>
  );
}
