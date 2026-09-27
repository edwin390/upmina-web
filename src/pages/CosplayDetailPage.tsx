import { useParams } from "react-router-dom";
import CosplayLocaleProvider from "@/i18n/LocaleProvider";
import CosplayDetail from "@/components/cosplay/CosplayDetail";

export default function CosplayDetailPage() {
  const { slug } = useParams<{ slug: string }>();

  return (
    <CosplayLocaleProvider>
      {/* slug ausente no debería ocurrir (la ruta es /cosplay/:slug), pero CosplayDetail lo trata
          como "no encontrado" en vez de quedarse cargando para siempre. */}
      <CosplayDetail slug={slug} />
    </CosplayLocaleProvider>
  );
}
