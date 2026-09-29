import { Link } from "react-router-dom";
import { useTranslations } from "use-intl";
import type { CosplayPostSummary } from "@/types";
import { useAdminAccess } from "@/hooks/useAdminAccess";
import PrivilegedOnly from "@/components/auth/PrivilegedOnly";
import CosplayCardAdminMenu from "./admin/CosplayCardAdminMenu";

interface Props {
  post: CosplayPostSummary;
  onEdit: (postId: string) => void;
  onDeleted: () => void;
}

/** El título es contenido editorial de Mina: se muestra idéntico sin importar el idioma de la UI
 *  (corrección de producto, Fase 9I-3 — ver types/index.ts).
 *
 *  La tarjeta ya NO es un único <a> envolviendo todo (ajuste UX posterior a 9I-3): un <button> de
 *  menú ADMIN anidado dentro de un <a> es HTML inválido y confunde el enrutado de clics. En su
 *  lugar, el <Link> es una capa invisible absolute inset-0 (mismo href/anillo de foco de siempre)
 *  y el contenido visual (imagen/título) queda con pointer-events-none para que el clic caiga a
 *  través de él hacia el Link — visualmente IDÉNTICO a la tarjeta anterior. El menú ADMIN es un
 *  hermano posicionado por encima (z-20), nunca un descendiente del Link.
 *
 *  Pulido posterior (mismo release): el trigger "⋯" vive en la esquina SUPERIOR DERECHA (antes
 *  flotaba en la izquierda, sin relación visual con nada) — el mismo sitio que ya usa la insignia
 *  de photoCount. Para NO taparla nunca (y sin mover un píxel la tarjeta para USER, que jamás ve
 *  el trigger): SOLO cuando cosplay_admin está activo, la insignia baja un poco (top-2 → top-12)
 *  para dejar el trigger encima con espacio propio; para USER/visitante la insignia no cambia en
 *  absoluto. `overflow-hidden` se retiró del contenedor exterior (y se movió a la imagen, con
 *  `rounded-t-lg` propio) porque recortaba el menú desplegable del ⋯ contra el borde de la
 *  tarjeta — el recorte de zoom en hover de la imagen sigue intacto, ahora en su propia caja. */
export default function CosplayCard({ post, onEdit, onDeleted }: Props) {
  const t = useTranslations("cosplay.list");
  const meta = [post.characterName, post.series].filter(Boolean).join(" · ");
  const { status, access } = useAdminAccess();
  const isCosplayAdmin =
    status === "ready" && Boolean(access?.capabilities.includes("cosplay_admin"));

  return (
    <div className="group relative flex flex-col rounded-lg border border-transparent bg-bg-surface transition-[border-color,box-shadow] hover:border-accent-primary/70 hover:shadow-glow-primary focus-within:border-accent-secondary">
      <Link
        to={`/cosplay/${post.slug}`}
        aria-label={post.title}
        className="absolute inset-0 z-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
      />
      <div className="pointer-events-none relative aspect-[4/5] overflow-hidden rounded-t-lg bg-bg-elevated">
        {post.cover && (
          <img
            src={post.cover.url}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform group-hover:scale-105"
          />
        )}
        {post.photoCount > 1 && (
          <span
            aria-hidden="true"
            className={`absolute right-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white ${isCosplayAdmin ? "top-12" : "top-2"}`}
          >
            {t("photoCount", { count: post.photoCount })}
          </span>
        )}
      </div>
      <div className="pointer-events-none relative flex flex-1 flex-col gap-1 p-3">
        <h3 className="line-clamp-2 font-display text-base tracking-wide text-text-primary">
          {post.title}
        </h3>
        {meta && <p className="line-clamp-1 text-sm text-text-secondary">{meta}</p>}
      </div>

      <PrivilegedOnly capability="cosplay_admin">
        <div className="absolute right-2 top-2 z-20">
          <CosplayCardAdminMenu
            postId={post.id}
            postTitle={post.title}
            onEdit={onEdit}
            onDeleted={onDeleted}
          />
        </div>
      </PrivilegedOnly>
    </div>
  );
}
