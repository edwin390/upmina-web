import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { usePrivilegedFailureReporter } from "@/hooks/privileged-failure";

// Sección "Redes sociales" de /admin (Bloque 8E, ciclo de vida en la Fase 9H-3). Vive DENTRO del
// shell ya autorizado por GET /api/admin/me: el frontend no decide quién es ADMIN. Las llamadas que
// hace son privilegiadas y las resuelve el backend (ADMIN + social_admin + MFA reciente):
//   - GET  /api/admin/social-status     → estado de cada conexión (solo estado y fecha, sin tokens).
//   - POST /api/admin/social-connect    → { provider } → { authorization_url }; el navegador navega a
//     esa URL. El frontend NO genera `state`, NO construye URLs de autorización y NO envía
//     redirect_uri ni scopes: todo eso es del servidor. Solo comprueba que recibió una https del
//     host oficial de ese proveedor antes de navegar (la seguridad real de la URL es server-side).
//   - POST /api/admin/social-disconnect → { provider } → DESTRUCTIVA. Nunca se ejecuta sola: exige
//     abrir una confirmación y aceptarla. Si el servidor responde `step_up_required` (MFA vencido),
//     el contenedor lleva a /admin/mfa y al volver aquí NO se reproduce nada: esta sección se monta
//     de nuevo sin confirmación abierta y hay que confirmar OTRA VEZ. No se guarda ninguna intención
//     (ni en URL, ni en storage) ni credencial alguna: el backend revalida rol, capacidad y MFA.
// Un fallo de carga, de sesión o de MFA NUNCA se presenta como "No conectado", y un fallo al
// desconectar nunca cambia el estado mostrado: el estado solo cambia si el servidor lo confirma.

export type SocialProvider = "instagram" | "tiktok";
export type SocialConnectionStatus =
  "connected" | "expiring_soon" | "reauth_required" | "not_connected";

interface ConnectionInfo {
  status: SocialConnectionStatus;
  /** ISO de la fecha que gobierna el estado (solo si el servidor la envió y es legible). */
  expiresAt?: string;
}

const STATUS_ENDPOINT = "/api/admin/social-status";
const CONNECT_ENDPOINT = "/api/admin/social-connect";
const DISCONNECT_ENDPOINT = "/api/admin/social-disconnect";

const PROVIDERS: { id: SocialProvider; name: string; host: string }[] = [
  { id: "instagram", name: "Instagram", host: "www.instagram.com" },
  { id: "tiktok", name: "TikTok", host: "www.tiktok.com" },
];

const STATUS_LABEL: Record<SocialConnectionStatus, string> = {
  connected: "Conectado",
  expiring_soon: "Caduca pronto",
  not_connected: "No conectado",
  reauth_required: "Requiere autorización",
};

const STATUS_DOT: Record<SocialConnectionStatus, string> = {
  connected: "bg-accent-success",
  expiring_soon: "bg-accent-warning",
  not_connected: "bg-text-muted",
  reauth_required: "bg-accent-warning",
};

const STATUS_HINT: Partial<Record<SocialConnectionStatus, string>> = {
  expiring_soon:
    "La autorización necesita renovarse pronto: reconecta antes de que caduque.",
  reauth_required:
    "La autorización guardada ya no es válida. Reconecta para que la sección vuelva a mostrar contenido.",
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
  "inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50";

const DANGER_BUTTON_CLASS =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-accent-live/60 px-5 py-2.5 text-sm font-semibold text-accent-live transition-colors duration-200 ease-smooth hover:bg-accent-live/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-live disabled:pointer-events-none disabled:opacity-50";

type Connections = Record<SocialProvider, ConnectionInfo>;

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; connections: Connections };

function isStatus(value: unknown): value is SocialConnectionStatus {
  return (
    value === "connected" ||
    value === "expiring_soon" ||
    value === "not_connected" ||
    value === "reauth_required"
  );
}

function parseInfo(raw: unknown): ConnectionInfo | null {
  const status = (raw as { status?: unknown } | null)?.status;
  if (!isStatus(status)) return null;
  const expiresAt = (raw as { expiresAt?: unknown }).expiresAt;
  return typeof expiresAt === "string" && !Number.isNaN(Date.parse(expiresAt))
    ? { status, expiresAt }
    : { status };
}

/** Extrae solo estado y fecha; cualquier otra forma se trata como error de carga. */
function parseConnections(body: unknown): Connections | null {
  const raw = (body as { connections?: Record<string, unknown> } | null)?.connections;
  const instagram = parseInfo(raw?.instagram);
  const tiktok = parseInfo(raw?.tiktok);
  return instagram && tiktok ? { instagram, tiktok } : null;
}

/** Fecha legible y determinista (UTC): nunca depende de la zona horaria del navegador. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("es", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
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

function disconnectMessage(status: number, name: string): string {
  if (status === 401) return MSG_SESSION;
  if (status === 403) return MSG_FORBIDDEN;
  return `No pudimos desconectar ${name}. Inténtalo de nuevo.`;
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

interface DisconnectControls {
  /** ¿Está abierta la confirmación de esta red? */
  confirming: boolean;
  /** ¿Hay una desconexión en vuelo para esta red? */
  busy: boolean;
  onRequest: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

interface CardProps {
  name: string;
  status: SocialConnectionStatus;
  expiresAt?: string;
  pending: boolean;
  disabled: boolean;
  error: string | null;
  notice?: string | null;
  onConnect: () => void;
  /** Sin este objeto la tarjeta no ofrece desconexión (uso aislado y pruebas). */
  disconnect?: DisconnectControls;
}

/** Tarjeta de una red: estado en texto (no solo color) y las acciones que corresponden. */
export function SocialConnectionCard({
  name,
  status,
  expiresAt,
  pending,
  disabled,
  error,
  notice,
  onConnect,
  disconnect,
}: CardProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const wasConfirmingRef = useRef(false);
  const confirming = disconnect?.confirming ?? false;

  // Foco: al abrir la confirmación va a "Cancelar" (la opción segura); al cerrarla vuelve al botón
  // que la abrió (que desaparece mientras se confirma).
  useEffect(() => {
    if (confirming) {
      cancelRef.current?.focus();
    } else if (wasConfirmingRef.current) {
      triggerRef.current?.focus();
    }
    wasConfirmingRef.current = confirming;
  }, [confirming]);

  const action =
    status === "not_connected"
      ? `Conectar ${name}`
      : status === "reauth_required" || status === "expiring_soon"
        ? `Reconectar ${name}`
        : null;
  const hint = STATUS_HINT[status];
  const canDisconnect = disconnect !== undefined && status !== "not_connected";
  const warn = status === "reauth_required" || status === "expiring_soon";

  // Jerarquía estructural fija (contenido → acción → estado), IGUAL para Instagram y TikTok
  // porque ambas comparten este mismo componente: antes, contenido y acción vivían en la MISMA
  // fila con flex-wrap+justify-between, así que el botón quedaba al lado o debajo según cuánto
  // contenido tuviera esa tarjeta en ESE momento (fecha de caducidad, aviso…) — nunca una
  // diferencia real entre proveedores, solo una consecuencia accidental del ancho disponible.
  // Separar contenido y acción en bloques apilados hace la jerarquía determinista en cualquier
  // viewport, para las dos tarjetas por igual.
  return (
    <li className="min-w-0 rounded-md border border-border-subtle p-4">
      <div className="min-w-0">
        <h3 className="font-semibold text-text-primary">{name}</h3>
        <p
          className={`mt-1 flex items-center gap-2 text-sm ${
            warn ? "text-accent-warning" : "text-text-secondary"
          }`}
        >
          <span
            aria-hidden="true"
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[status]}`}
          />
          <span>{STATUS_LABEL[status]}</span>
        </p>
        {expiresAt && (status === "connected" || status === "expiring_soon") ? (
          <p className="mt-1 text-xs text-text-muted">
            {status === "expiring_soon" ? "Caduca el" : "Vigente hasta el"}{" "}
            <time dateTime={expiresAt}>{formatDate(expiresAt)}</time>
          </p>
        ) : null}
        {hint ? <p className="mt-2 text-sm text-text-secondary">{hint}</p> : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
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
        {canDisconnect && !confirming ? (
          <button
            ref={triggerRef}
            type="button"
            onClick={disconnect.onRequest}
            disabled={disabled}
            className={DANGER_BUTTON_CLASS}
          >
            Desconectar {name}
          </button>
        ) : null}
      </div>

      {canDisconnect && confirming ? (
        <div
          role="group"
          aria-label={`Confirmar desconexión de ${name}`}
          className="mt-4 rounded-md border border-accent-live/40 p-3"
        >
          <p className="text-sm text-text-secondary">
            ¿Desconectar {name}? El sitio dejará de mostrar contenido de esta cuenta hasta
            que la vuelvas a conectar.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={disconnect.onConfirm}
              disabled={disconnect.busy}
              aria-busy={disconnect.busy}
              className={DANGER_BUTTON_CLASS}
            >
              {disconnect.busy
                ? `Desconectando ${name}…`
                : `Confirmar desconexión de ${name}`}
            </button>
            <button
              ref={cancelRef}
              type="button"
              onClick={disconnect.onCancel}
              disabled={disconnect.busy}
              className={SECONDARY_BUTTON_CLASS}
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : null}

      {status === "not_connected" && !notice ? (
        <p role="status" className="mt-3 text-sm text-text-secondary">
          {name} está desconectado
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-3 text-sm text-text-secondary">
          {notice}
        </p>
      ) : null}
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
  const [confirming, setConfirming] = useState<SocialProvider | null>(null);
  const [disconnecting, setDisconnecting] = useState<SocialProvider | null>(null);
  const [actionError, setActionError] = useState<{
    provider: SocialProvider;
    message: string;
  } | null>(null);
  const [notice, setNotice] = useState<{
    provider: SocialProvider;
    message: string;
  } | null>(null);

  const isMountedRef = useRef(true);
  const requestRef = useRef(0);
  // Guardas síncronas contra doble click (el estado tarda un render en reflejarse).
  const connectLockRef = useRef(false);
  const disconnectLockRef = useRef(false);

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

  // Al montar (incluye volver a /admin tras el OAuth o tras un MFA) y al restaurar la página desde
  // el historial del navegador (bfcache): un único fetch, sin polling.
  useEffect(() => {
    void loadStatus();
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void loadStatus();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [loadStatus]);

  const connect = async (provider: SocialProvider) => {
    if (connectLockRef.current || disconnectLockRef.current) return;
    connectLockRef.current = true;
    setPending(provider);
    setActionError(null);
    setNotice(null);
    setConfirming(null);

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

  const requestDisconnect = (provider: SocialProvider) => {
    if (connectLockRef.current || disconnectLockRef.current) return;
    setActionError(null);
    setNotice(null);
    setConfirming(provider);
  };

  const cancelDisconnect = () => {
    if (disconnectLockRef.current) return; // con una petición en vuelo no se puede cancelar
    setConfirming(null);
  };

  const disconnect = async (provider: SocialProvider) => {
    // Solo la confirmación explícita de ESTA red ejecuta la operación.
    if (confirming !== provider) return;
    if (disconnectLockRef.current || connectLockRef.current) return;
    disconnectLockRef.current = true;
    setDisconnecting(provider);
    setActionError(null);
    const name = PROVIDERS.find((p) => p.id === provider)?.name ?? provider;

    try {
      const token = await getAccessToken();
      if (!token) {
        if (isMountedRef.current) {
          setConfirming(null);
          setActionError({ provider, message: MSG_SESSION });
        }
        return;
      }

      const response = await fetch(DISCONNECT_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider }),
      });
      if (!isMountedRef.current) return;

      if (response.status === 200) {
        // Sin actualización optimista: se cierra la confirmación y se RELEE lo que el servidor
        // confirmó (si la relectura falla se muestra el error de carga, nunca "desconectado").
        setConfirming(null);
        setNotice({ provider, message: `${name} desconectado.` });
        void loadStatus();
        return;
      }

      // Cualquier rechazo cierra la confirmación: reintentar exige abrirla y confirmar de nuevo.
      // step_up_required lo maneja el contenedor (lleva a MFA); nada se reproduce después.
      reportFailure(response);
      const unavailable = await isEnvironmentUnavailable(response);
      if (!isMountedRef.current) return;
      setConfirming(null);
      setActionError({
        provider,
        message: unavailable ? MSG_UNAVAILABLE : disconnectMessage(response.status, name),
      });
    } catch {
      if (isMountedRef.current) {
        setConfirming(null);
        setActionError({ provider, message: disconnectMessage(0, name) });
      }
    } finally {
      disconnectLockRef.current = false;
      if (isMountedRef.current) setDisconnecting(null);
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
              status={load.connections[provider.id].status}
              expiresAt={load.connections[provider.id].expiresAt}
              pending={pending === provider.id}
              disabled={pending !== null || disconnecting !== null}
              error={actionError?.provider === provider.id ? actionError.message : null}
              notice={notice?.provider === provider.id ? notice.message : null}
              onConnect={() => void connect(provider.id)}
              disconnect={{
                confirming: confirming === provider.id,
                busy: disconnecting === provider.id,
                onRequest: () => requestDisconnect(provider.id),
                onConfirm: () => void disconnect(provider.id),
                onCancel: cancelDisconnect,
              }}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
