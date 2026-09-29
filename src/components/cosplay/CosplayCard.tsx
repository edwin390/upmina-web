import { Link } from "react-router-dom";
import { useTranslations } from "use-intl";
import type { CosplayPostSummary } from "@/types";
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
 *  hermano posicionado por encima (z-10), nunca un descendiente del Link. */
export default function CosplayCard({ post, onEdit, onDeleted }: Props) {
  const t = useTranslations("cosplay.list");
  const meta = [post.characterName, post.series].filter(Boolean).join(" · ");

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-lg border border-transparent bg-bg-surface transition-[border-color,box-shadow] hover:border-accent-primary/70 hover:shadow-glow-primary focus-within:border-accent-secondary">
      <Link
        to={`/cosplay/${post.slug}`}
        aria-label={post.title}
        className="absolute inset-0 z-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
      />
      <div className="pointer-events-none relative aspect-[4/5] overflow-hidden bg-bg-elevated">
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
            className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white"
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
        <div className="absolute left-2 top-2 z-10">
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
