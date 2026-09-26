import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { usePrivilegedFailureReporter } from "@/hooks/privileged-failure";

// Sección "Redes sociales" de /admin (Bloque 8E). Vive DENTRO del shell ya autorizado por
// GET /api/admin/me: el frontend no decide quién es ADMIN. Las dos llamadas que hace son
// privilegiadas y las resuelve el backend (ADMIN + AAL2):
//   - GET  /api/admin/social-status  → estado de cada conexión (solo el estado, sin tokens).
//   - POST /api/admin/social-connect → { provider } → { authorization_url }; el navegador
//     navega a esa URL. El frontend NO genera `state`, NO construye URLs de autorización y NO
//     envía redirect_uri ni scopes: todo eso es del servidor. Solo comprueba que recibió una
//     https del host oficial de ese proveedor antes de navegar (la seguridad real de la URL
//     sigue siendo server-side).
// Un fallo de carga, de sesión o de MFA NUNCA se presenta como "No conectado".

export type SocialProvider = "instagram" | "tiktok";
export type SocialConnectionStatus = "connected" | "not_connected" | "reauth_required";

const STATUS_ENDPOINT = "/api/admin/social-status";
const CONNECT_ENDPOINT = "/api/admin/social-connect";

const PROVIDERS: { id: SocialProvider; name: string; host: string }[] = [
  { id: "instagram", name: "Instagram", host: "www.instagram.com" },
  { id: "tiktok", name: "TikTok", host: "www.tiktok.com" },
];

const STATUS_LABEL: Record<SocialConnectionStatus, string> = {
  connected: "Conectado",
  not_connected: "No conectado",
  reauth_required: "Requiere autorización",
};

const STATUS_DOT: Record<SocialConnectionStatus, string> = {
  connected: "bg-accent-success",
  not_connected: "bg-text-muted",
  reauth_required: "bg-accent-warning",
};

const MSG_SESSION = "Tu sesión ya no es válida. Inicia sesión de nuevo.";
const MSG_FORBIDDEN =
  "No se pudo autorizar esta acción. Comprueba tu verificación en dos pasos e inténtalo de nuevo.";
const MSG_LOAD = "No se pudo cargar el estado de las conexiones.";
const MSG_CONNECT = "No pudimos iniciar la conexión. Inténtalo de nuevo.";
const MSG_UNAVAILABLE = "Esta conexión solo está disponible en el entorno de producción.";
// Cuerpo EXACTO con el que el servidor rechaza el inicio fuera de Production (403 tras autorizar).
const ENV_UNAVAILABLE_ERROR = "No disponible en este entorno";

const PRIMARY_BUTTON_CLASS =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface disabled:pointer-events-none disabled:opacity-50";

const SECONDARY_BUTTON_CLASS =
  "inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary";

type Connections = Record<SocialProvider, SocialConnectionStatus>;

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; connections: Connections };

function isStatus(value: unknown): value is SocialConnectionStatus {
  return (
    value === "connected" || value === "not_connected" || value === "reauth_required"
  );
}

/** Extrae solo los dos estados; cualquier otra forma se trata como error de carga. */
function parseConnections(body: unknown): Connections | null {
  const raw = (body as { connections?: Record<string, { status?: unknown }> } | null)
    ?.connections;
  const instagram = raw?.instagram?.status;
  const tiktok = raw?.tiktok?.status;
  return isStatus(instagram) && isStatus(tiktok) ? { instagram, tiktok } : null;
}

/** Comprobación mínima: https del host oficial del proveedor. No construye ni modifica la URL. */
function isUsableAuthorizationUrl(value: unknown, provider: SocialProvider): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  const expectedHost = PROVIDERS.find((p) => p.id === provider)?.host;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.host === expectedHost;
  } catch {
    return false;
  }
}

function connectMessage(status: number): string {
  if (status === 401) return MSG_SESSION;
  if (status === 403) return MSG_FORBIDDEN;
  return MSG_CONNECT;
}

/** ¿Es el 403 "no disponible en este entorno"? Solo ese cuerpo exacto; cualquier otro 403 (incluido
 *  step_up_required) o un cuerpo ilegible sigue el camino de autorización. Lee una copia. */
async function isEnvironmentUnavailable(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  try {
    const source = typeof response.clone === "function" ? response.clone() : response;
    const body: unknown = await source.json();
    if (!body || typeof body !== "object") return false;
    const { error, code } = body as { error?: unknown; code?: unknown };
    return error === ENV_UNAVAILABLE_ERROR && code === undefined;
  } catch {
    return false;
  }
}

async function getAccessToken(): Promise<string | null> {
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

interface CardProps {
  name: string;
  status: SocialConnectionStatus;
  pending: boolean;
  disabled: boolean;
  error: string | null;
  onConnect: () => void;
}

/** Tarjeta de una red: estado en texto (no solo color) y, si hace falta, el botón de acción. */
export function SocialConnectionCard({
  name,
  status,
  pending,
  disabled,
  error,
  onConnect,
}: CardProps) {
  const action =
    status === "not_connected"
      ? `Conectar ${name}`
      : status === "reauth_required"
        ? `Reconectar ${name}`
        : null;

  return (
    <li className="min-w-0 rounded-md border border-border-subtle p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold text-text-primary">{name}</h3>
          <p
            className={`mt-1 flex items-center gap-2 text-sm ${
              status === "reauth_required" ? "text-accent-warning" : "text-text-secondary"
            }`}
          >
            <span
              aria-hidden="true"
              className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[status]}`}
            />
            <span>{STATUS_LABEL[status]}</span>
          </p>
        </div>
        {action ? (
          <button
            type="button"
            onClick={onConnect}
            disabled={disabled}
            aria-busy={pending}
            className={PRIMARY_BUTTON_CLASS}
          >
            {pending ? `Conectando ${name}…` : action}
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-accent-live">
          {error}
        </p>
      ) : null}
    </li>
  );
}

interface SectionProps {
  /** Navegación al proveedor; inyectable para pruebas. Por defecto, window.location.assign. */
  navigate?: (url: string) => void;
}

export default function SocialConnectionsSection({
  navigate = (url) => window.location.assign(url),
}: SectionProps) {
  const reportFailure = usePrivilegedFailureReporter();
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [pending, setPending] = useState<SocialProvider | null>(null);
  const [actionError, setActionError] = useState<{
    provider: SocialProvider;
    message: string;
  } | null>(null);

  const isMountedRef = useRef(true);
  const requestRef = useRef(0);
  // Guard síncrono contra doble click (el estado tarda un render en reflejarse).
  const connectLockRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const loadStatus = useCallback(async () => {
    const request = ++requestRef.current;
    const isCurrent = () => isMountedRef.current && requestRef.current === request;
    setLoad({ kind: "loading" });

    const token = await getAccessToken();
    if (!isCurrent()) return;
    if (!token) {
      setLoad({ kind: "error", message: MSG_SESSION });
      return;
    }

    let response: Response;
    try {
      response = await fetch(STATUS_ENDPOINT, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      if (isCurrent()) setLoad({ kind: "error", message: MSG_LOAD });
      return;
    }
    if (!isCurrent()) return;
    // Una respuesta que no es una Response utilizable es un fallo de carga, nunca "no conectado".
    if (!response || typeof response.status !== "number") {
      setLoad({ kind: "error", message: MSG_LOAD });
      return;
    }

    if (response.status === 401) {
      reportFailure(response);
      setLoad({ kind: "error", message: MSG_SESSION });
      return;
    }
    if (response.status === 403) {
      // Sin rol o sin MFA reciente: NO es "no conectado", es falta de autorización.
      reportFailure(response);
      setLoad({ kind: "error", message: MSG_FORBIDDEN });
      return;
    }
    if (!response.ok) {
      setLoad({ kind: "error", message: MSG_LOAD });
      return;
    }

    const body: unknown = await response.json().catch(() => null);
    if (!isCurrent()) return;
    const connections = parseConnections(body);
    setLoad(
      connections ? { kind: "ready", connections } : { kind: "error", message: MSG_LOAD },
    );
  }, [reportFailure]);

  // Al montar (incluye volver a /admin tras el OAuth) y al restaurar la página desde el
  // historial del navegador (bfcache): un único fetch, sin polling.
  useEffect(() => {
    void loadStatus();
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void loadStatus();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [loadStatus]);

  const connect = async (provider: SocialProvider) => {
    if (connectLockRef.current) return;
    connectLockRef.current = true;
    setPending(provider);
    setActionError(null);

    let navigated = false;
    try {
      const token = await getAccessToken();
      if (!token) {
        if (isMountedRef.current) setActionError({ provider, message: MSG_SESSION });
        return;
      }

      const response = await fetch(CONNECT_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider }),
      });

      if (response.status !== 200) {
        // El reporte se mantiene para todo 403/401 (revalida /access); solo cambia el texto local.
        reportFailure(response);
        const unavailable = await isEnvironmentUnavailable(response);
        if (isMountedRef.current) {
          setActionError({
            provider,
            message: unavailable ? MSG_UNAVAILABLE : connectMessage(response.status),
          });
        }
        return;
      }

      const body: unknown = await response.json().catch(() => null);
      const url = (body as { authorization_url?: unknown } | null)?.authorization_url;
      if (!isUsableAuthorizationUrl(url, provider)) {
        if (isMountedRef.current) setActionError({ provider, message: MSG_CONNECT });
        return;
      }

      // El botón queda bloqueado mientras el navegador sale hacia el proveedor.
      navigated = true;
      navigate(url as string);
    } catch {
      if (isMountedRef.current) setActionError({ provider, message: MSG_CONNECT });
    } finally {
      if (!navigated) {
        connectLockRef.current = false;
        if (isMountedRef.current) setPending(null);
      }
    }
  };

  return (
    <section aria-labelledby="admin-social-heading" className="mt-8">
      <h2
        id="admin-social-heading"
        className="font-display text-xl tracking-wide text-text-primary"
      >
        Redes sociales
      </h2>
      <p className="mt-2 text-sm text-text-secondary">
        Las cuentas oficiales que alimentan las secciones de Instagram y TikTok.
      </p>

      {load.kind === "loading" ? (
        <p className="mt-4 text-sm text-text-secondary" role="status">
          Cargando conexiones…
        </p>
      ) : null}

      {load.kind === "error" ? (
        <div className="mt-4">
          <p role="alert" className="text-sm text-accent-live">
            {load.message}
          </p>
          <button
            type="button"
            onClick={() => void loadStatus()}
            className={`${SECONDARY_BUTTON_CLASS} mt-3`}
          >
            Reintentar
          </button>
        </div>
      ) : null}

      {load.kind === "ready" ? (
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {PROVIDERS.map((provider) => (
            <SocialConnectionCard
              key={provider.id}
              name={provider.name}
              status={load.connections[provider.id]}
              pending={pending === provider.id}
              disabled={pending !== null}
              error={actionError?.provider === provider.id ? actionError.message : null}
              onConnect={() => void connect(provider.id)}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
