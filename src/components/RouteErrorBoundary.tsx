import { Component, type ErrorInfo, type ReactNode } from "react";
import { isChunkLoadError, reloadOnceForStaleChunk } from "@/lib/chunk-recovery";

const TEXT = {
  es: { title: "No se pudo cargar esta sección", body: "Recarga la página para continuar.", action: "Recargar" },
  en: { title: "This section could not be loaded", body: "Reload the page to continue.", action: "Reload" },
  de: { title: "Dieser Bereich konnte nicht geladen werden", body: "Lade die Seite neu, um fortzufahren.", action: "Neu laden" },
} as const;

interface Props {
  children: ReactNode;
}
interface State {
  error: unknown;
}

// Evita que un fallo de render o de descarga de un chunk desmonte toda la aplicación (pantalla negra). El header y
// el footer siguen vivos; el límite se reinicia al cambiar de ruta (se usa con `key={location.key}`).
export default class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error ?? new Error("unknown") };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Error al renderizar la ruta", error, info.componentStack);
    if (isChunkLoadError(error)) reloadOnceForStaleChunk();
  }

  render() {
    if (this.state.error === null) return this.props.children;
    const lang = document.documentElement.lang.slice(0, 2);
    const t = TEXT[lang === "en" || lang === "de" ? lang : "es"];
    return (
      <div role="alert" className="mx-auto max-w-xl px-4 py-24 text-center">
        <h1 className="font-display text-3xl text-text-primary">{t.title}</h1>
        <p className="mt-3 text-text-secondary">{t.body}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-6 rounded-lg bg-accent-primary px-5 py-2 font-semibold text-text-inverse"
        >
          {t.action}
        </button>
      </div>
    );
  }
}
