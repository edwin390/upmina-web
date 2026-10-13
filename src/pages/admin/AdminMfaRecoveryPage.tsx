import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import AdminAuthCard from "@/components/admin/AdminAuthCard";
import AdminAuthField from "@/components/admin/AdminAuthField";
import {
  capturePendingRecoveryCode,
  clearPendingRecoveryCode,
  extractRecoveryCode,
  parseRecoveryFragment,
  readPendingRecoveryCode,
  RECOVERY_LOGIN_PATH,
} from "@/lib/pending-recovery-code";

// /admin/mfa/recovery — «Perdí mi autenticador» (MFA fase 2). Solo PRESENTA el estado que decide el
// servidor y envía operaciones al endpoint /api/admin/mfa-recovery; la autoridad (rol, credenciales
// recientes, aprobación de otro admin, espera, aviso entregado, instantánea de factores) es siempre
// del backend. Funciona con una sesión aal1: quien perdió el autenticador no puede subir a aal2.
// El desafío del correo llega en un enlace con fragmento (#c=…): se lee una vez, se limpia de la URL
// y NUNCA se guarda en storage ni se registra.

const ENDPOINT = "/api/admin/mfa-recovery";

/** El código del enlace vive solo en memoria de esta pestaña: así se recupera si se pierde. */
const INVALID_LINK_NOTICE =
  "El enlace no contiene un código de verificación válido. Vuelve a abrir el enlace del correo o pega aquí el enlace completo.";
const CODE_LOST_HELP =
  "Por seguridad el código del enlace solo se conserva en esta pestaña. Si recargas la página o abres el enlace en otra pestaña o dispositivo, vuelve a abrir el enlace del correo o pega aquí el enlace completo.";

interface Recovery {
  status: string;
  recoveryId?: string;
  hasApprover?: boolean;
  role?: string;
  recentLogin?: boolean;
  aal?: string;
  mailConfigured?: boolean;
  readiness?: string;
  readyAt?: string | null;
  noticeState?: string | null;
  closedReason?: string | null;
  deniedReason?: string | null;
  expiresAt?: string;
  challengeSends?: number;
  lastErrorClass?: string | null;
}

const CODE_MESSAGES: Record<string, string> = {
  recent_login_required: "Confirma tu contraseña actual para continuar.",
  mail_unavailable:
    "El envío de correos no está disponible ahora mismo. Inténtalo más tarde.",
  active_request: "Ya tienes una solicitud en curso.",
  rate_limited: "Has hecho demasiadas solicitudes. Inténtalo más tarde.",
  no_approver: "No hay otro administrador que pueda aprobar tu solicitud.",
  email_unverified: "Tu correo no está confirmado en la cuenta.",
  invalid_code:
    "El código no es válido. Si abriste el enlace con otra cuenta, cambia de cuenta.",
  no_request:
    "No hay una solicitud en curso para esta cuenta. Si el enlace es de otra cuenta, cambia de cuenta.",
  challenge_expired: "El código caducó. Pide un correo nuevo.",
  locked: "Demasiados intentos. La solicitud se canceló; puedes iniciar otra.",
  too_soon: "Espera un minuto antes de pedir otro correo.",
  send_limit: "Ya no se pueden reenviar más correos para esta solicitud.",
  email_changed: "Tu correo cambió durante el proceso, así que la solicitud se canceló.",
  role_changed: "Tu rol cambió durante el proceso, así que la solicitud se canceló.",
  expired: "La solicitud caducó.",
  waiting: "Todavía no ha pasado la espera de seguridad.",
  notice_pending: "Aún no se confirmó la entrega del aviso de aprobación.",
  notice_failed:
    "No se pudo entregar el aviso de aprobación. Pide a un administrador que lo reenvíe.",
  new_factor_required:
    "Aún no se detecta un autenticador nuevo verificado en esta sesión. Configúralo en la verificación en dos pasos y vuelve a intentarlo.",
  forbidden: "No autorizado.",
};
const GENERIC = "No se pudo completar la operación. Inténtalo de nuevo.";

// Estados con una solicitud EN CURSO: solo entonces se muestra «Actualizar estado» y se consulta
// automáticamente. none/completed/denied/cancelled/expired no consultan nada por su cuenta.
const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  "pending_email",
  "pending_approval",
  "approved",
  "executing",
  "factors_deleted",
]);
/** Intervalo del refresco automático (solo GET del estado, sin escrituras). */
const RECOVERY_POLL_MS = 15000;

const READINESS_TEXT: Record<string, string> = {
  notice_pending: "Esperando la confirmación de entrega del aviso de aprobación…",
  notice_failed:
    "No se pudo entregar el aviso de aprobación. Pide a un administrador que lo reenvíe.",
  waiting: "En espera de seguridad.",
};

const PRIMARY =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface disabled:pointer-events-none disabled:opacity-50";
const SECONDARY =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary disabled:pointer-events-none disabled:opacity-50";

async function accessToken(): Promise<string | null> {
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("es");
}

export default function AdminMfaRecoveryPage() {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  // El código puede venir del enlace (fragmento) o de una visita anterior dentro de esta pestaña
  // (recuperación -> login -> recuperación), conservado solo en memoria.
  const [code, setCode] = useState(() => readPendingRecoveryCode() ?? "");
  // Sin sesión activa (nunca iniciada, caducada o cerrada): se ofrece iniciar sesión y volver aquí.
  const [needsLogin, setNeedsLogin] = useState(false);
  const [confirmExecute, setConfirmExecute] = useState(false);
  const [password, setPassword] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const lock = useRef(false);
  // Orden y concurrencia de las consultas de estado: gana siempre la ÚLTIMA iniciada (una respuesta
  // antigua nunca pisa a una reciente) y el refresco automático no se solapa con otra consulta.
  const loadSeq = useRef(0);
  const inFlight = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // El desafío llega en el fragmento del enlace del correo: se lee UNA vez y se borra de la URL. Ocurre
  // al montar y también cuando, con la página ya abierta, cambia solo el fragmento (evento
  // `hashchange`, p. ej. al pegar un enlace nuevo en la misma pestaña). La URL se limpia ANTES de hacer
  // nada más: un segundo disparo (StrictMode, montaje + evento) ya no encuentra el código y no lo
  // procesa dos veces. El código solo se conserva en memoria (ver pending-recovery-code.ts).
  const [hashTick, setHashTick] = useState(0);
  // Un fragmento con `c` pero sin un código de forma válida (vacío, corto, largo…): se retira igual y se
  // avisa de forma discreta; el valor se descarta sin guardarlo ni enviarlo a ninguna parte.
  const [invalidLink, setInvalidLink] = useState(false);
  const consumeHash = useCallback((fromEvent: boolean) => {
    if (typeof window === "undefined") return;
    const parsed = parseRecoveryFragment(window.location.hash);
    // Un fragmento ajeno a la recuperación (#seccion, #x=1) no se toca.
    if (!parsed.present) return;
    // La URL se limpia ANTES de validar o procesar nada (solo se quita `c`; el resto se conserva).
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + window.location.search + parsed.remainder,
    );
    if (parsed.code === null) {
      setInvalidLink(true);
      return;
    }
    setInvalidLink(false);
    capturePendingRecoveryCode(parsed.code);
    setCode(parsed.code);
    // Con la página ya abierta se revalida el estado (puede haber una solicitud nueva).
    if (fromEvent) setHashTick((n) => n + 1);
  }, []);
  useEffect(() => {
    consumeHash(false);
    const onHashChange = () => consumeHash(true);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [consumeHash]);

  const load = useCallback(
    async (options: { silent?: boolean } = {}): Promise<Recovery | null> => {
      // `silent` (refresco automático): un fallo transitorio NO sustituye la pantalla por un error.
      const silent = options.silent === true;
      const seq = ++loadSeq.current;
      inFlight.current += 1;
      setRefreshing(true);
      const stale = () => !mounted.current || seq !== loadSeq.current;
      const fail = (text: string) => {
        if (!silent && !stale()) setLoadError(text);
        return null;
      };
      try {
        const token = await accessToken();
        if (!token) {
          if (!stale()) setNeedsLogin(true);
          return null;
        }
        const response = await fetch(ENDPOINT, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (stale()) return null;
        if (response.status === 401) {
          setNeedsLogin(true);
          return null;
        }
        if (response.status === 403) {
          return fail("Esta función es solo para miembros del equipo.");
        }
        if (!response.ok) return fail("No se pudo cargar el estado de la solicitud.");
        const body = (await response.json().catch(() => null)) as Recovery | null;
        if (stale()) return null;
        if (!body || typeof body.status !== "string") {
          return fail("No se pudo cargar el estado de la solicitud.");
        }
        setLoadError(null);
        setNeedsLogin(false);
        setRecovery(body);
        return body;
      } catch {
        return fail("No se pudo cargar el estado de la solicitud.");
      } finally {
        inFlight.current -= 1;
        if (mounted.current && inFlight.current === 0) setRefreshing(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (hashTick > 0) void load({ silent: true });
  }, [hashTick, load]);

  // Refresco automático mientras haya una solicitud EN CURSO. La dependencia es el booleano `active`
  // (no el objeto de estado): el intervalo no se reinicia en cada actualización ni en cada render.
  // Solo hace GET del estado: nunca reenvía, verifica, ejecuta ni modifica nada. Se detiene al llegar
  // a un estado terminal y al desmontar, y se PAUSA con la pestaña oculta (al volver consulta al
  // instante y reanuda).
  const active = recovery !== null && ACTIVE_STATUSES.has(recovery.status);
  const currentStatus = recovery?.status;
  useEffect(() => {
    // Solicitud cancelada, caducada, aprobada…: el código del correo ya no sirve y no se conserva.
    // «none» NO lo descarta: esta cuenta puede no ser la del enlace y hay que poder cambiar de cuenta
    // conservándolo (el TTL de 15 min lo acota igualmente).
    if (
      currentStatus !== undefined &&
      currentStatus !== "pending_email" &&
      currentStatus !== "none"
    ) {
      clearPendingRecoveryCode();
    }
  }, [currentStatus]);
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      if (inFlight.current > 0) return; // sin consultas simultáneas
      void load({ silent: true });
    };
    const start = () => {
      if (timer === null) timer = setInterval(tick, RECOVERY_POLL_MS);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        stop();
      } else {
        start();
        tick();
      }
    };
    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, load]);

  // Confirmar la contraseña SIN salir del flujo. Se usa la API de Supabase Auth desde el navegador
  // (signInWithPassword con el correo de la propia sesión): crea una sesión nueva de la MISMA cuenta
  // cuyo JWT lleva `amr: password` con la marca de tiempo actual, que es la evidencia que comprueba el
  // servidor. La contraseña nunca se envía a nuestros endpoints, no se guarda y se borra del estado
  // antes de la llamada. No se pide TOTP (la sesión resultante es aal1, justo lo que necesita quien
  // perdió el autenticador).
  const confirmPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (lock.current || !supabase) return;
    const typed = password;
    setPassword("");
    if (typed.length === 0) return;
    lock.current = true;
    setBusy(true);
    setMessage(null);
    const fail = (text: string) => setMessage({ kind: "error", text });
    try {
      const { data: current, error: userError } = await supabase.auth.getUser();
      const email = current?.user?.email;
      if (userError || !email || !current.user) {
        setNeedsLogin(true);
        return;
      }
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password: typed,
      });
      if (error || !data?.user) {
        const rateLimited =
          (error as { status?: number; code?: string } | null)?.status === 429 ||
          (error as { code?: string } | null)?.code === "over_request_rate_limit";
        fail(
          rateLimited
            ? "Demasiados intentos. Espera unos minutos e inténtalo de nuevo."
            : "No se pudo confirmar. Revisa tu contraseña e inténtalo de nuevo.",
        );
        return;
      }
      if (data.user.id !== current.user.id) {
        fail("No se pudo confirmar. Cierra sesión e inicia sesión de nuevo.");
        return;
      }
      const fresh = await load();
      if (!mounted.current) return;
      if (fresh && fresh.recentLogin === false) {
        fail(
          "El servidor no reconoció la confirmación. Cierra sesión e inicia sesión de nuevo.",
        );
      } else if (fresh) {
        setMessage({ kind: "ok", text: "Contraseña confirmada. Ya puedes continuar." });
      }
    } catch {
      if (mounted.current) fail("No se pudo confirmar. Inténtalo de nuevo.");
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const run = async (
    op: string,
    extra: Record<string, unknown> = {},
    okText?: string,
  ) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const token = await accessToken();
      if (!token) {
        setNeedsLogin(true);
        return;
      }
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ op, ...extra }),
      });
      const body = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (!mounted.current) return;
      if (response.status === 401) {
        setNeedsLogin(true); // la sesión caducó durante el flujo: se inicia sesión y se continúa
        return;
      }
      if (!response.ok) {
        const key = typeof body?.code === "string" ? body.code : "";
        setMessage({ kind: "error", text: CODE_MESSAGES[key] ?? GENERIC });
        void load();
        return;
      }
      const mail = body?.mail as { status?: string } | undefined;
      if (mail?.status === "failed") {
        setMessage({
          kind: "error",
          text: "La solicitud se registró, pero no se pudo enviar el correo. Pide un correo nuevo.",
        });
      } else if (op === "execute" && body?.status === "executing") {
        setMessage({
          kind: "error",
          text: "No se pudo invalidar el autenticador todavía. Puedes reintentarlo.",
        });
      } else if (okText) {
        setMessage({ kind: "ok", text: okText });
      }
      setCode("");
      clearPendingRecoveryCode(); // el código ya se usó, se reemplazó o dejó de servir
      setConfirmExecute(false);
      await load();
    } catch {
      if (mounted.current) setMessage({ kind: "error", text: GENERIC });
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const feedback = message ? (
    <p
      role={message.kind === "error" ? "alert" : "status"}
      className={`mt-4 text-sm ${message.kind === "error" ? "text-accent-live" : "text-accent-success"}`}
    >
      {message.text}
    </p>
  ) : null;

  // Cambio de cuenta EXPLÍCITO: cierra la sesión actual y lleva a iniciar sesión con otra; el código
  // pendiente (solo memoria) se conserva para la cuenta correcta y el retorno vuelve a esta página.
  const switchAccount = async () => {
    try {
      await signOut();
    } finally {
      navigate(RECOVERY_LOGIN_PATH);
    }
  };
  const switchAccountButton = (
    <button type="button" onClick={() => void switchAccount()} className={SECONDARY}>
      Cambiar de cuenta
    </button>
  );

  const signOutButton = (
    <button type="button" onClick={() => void signOut()} className={`mt-4 ${SECONDARY}`}>
      Cerrar sesión
    </button>
  );

  if (needsLogin) {
    return (
      <AdminAuthCard title="Restablecer autenticador">
        {invalidLink ? (
          <p
            role="status"
            className="mb-3 text-sm text-text-secondary"
            data-testid="invalid-link-notice"
          >
            {INVALID_LINK_NOTICE}
          </p>
        ) : null}
        <p role="status" className="text-sm text-text-secondary">
          Inicia sesión para continuar con la recuperación de tu autenticador. Volverás
          aquí automáticamente y tu solicitud seguirá donde estaba.
        </p>
        <p className="mt-3 text-sm text-text-secondary" data-testid="recovery-code-help">
          {CODE_LOST_HELP}
        </p>
        <Link to={RECOVERY_LOGIN_PATH} className={`mt-4 ${PRIMARY}`}>
          Iniciar sesión
        </Link>
      </AdminAuthCard>
    );
  }
  if (loadError) {
    return (
      <AdminAuthCard title="Restablecer autenticador">
        {invalidLink ? (
          <p
            role="status"
            className="mb-3 text-sm text-text-secondary"
            data-testid="invalid-link-notice"
          >
            {INVALID_LINK_NOTICE}
          </p>
        ) : null}
        <p role="alert" className="text-sm text-accent-live">
          {loadError}
        </p>
        <Link
          to="/admin/mfa"
          className="mt-4 inline-flex min-h-11 items-center text-sm underline"
        >
          Volver a la verificación en dos pasos
        </Link>
        <div className="mt-2">{switchAccountButton}</div>
      </AdminAuthCard>
    );
  }
  if (!recovery) {
    return (
      <AdminAuthCard title="Restablecer autenticador">
        {invalidLink ? (
          <p
            role="status"
            className="mb-3 text-sm text-text-secondary"
            data-testid="invalid-link-notice"
          >
            {INVALID_LINK_NOTICE}
          </p>
        ) : null}
        <p role="status" className="text-sm text-text-secondary">
          Cargando…
        </p>
      </AdminAuthCard>
    );
  }

  const { status } = recovery;
  // Sin inicio de sesión con contraseña reciente (según el servidor) las acciones que avanzan el
  // proceso quedan bloqueadas hasta confirmar la contraseña aquí mismo.
  const locked = recovery.recentLogin === false && status !== "completed";
  const closed = ["cancelled", "denied", "expired", "none", "completed"].includes(status);
  let body: React.ReactNode;

  if (status === "completed") {
    body = (
      <p role="status" className="text-sm text-text-secondary">
        Tu autenticador se restableció. Ya puedes usar las herramientas de tu rol.
      </p>
    );
  } else if (closed) {
    body = (
      <>
        {status === "none" && code.trim() !== "" ? (
          <div role="status" className="mb-4 rounded-md border border-border-subtle p-3">
            <p className="text-sm text-text-secondary">
              Abriste un enlace de verificación, pero esta cuenta no tiene una solicitud
              en curso. Si el enlace es de otra cuenta, cambia de cuenta: el código se
              conserva mientras inicias sesión.
            </p>
            <div className="mt-2">{switchAccountButton}</div>
          </div>
        ) : null}
        {status === "denied" ? (
          <p className="mb-3 text-sm text-text-secondary">
            Un administrador rechazó tu solicitud anterior
            {recovery.deniedReason ? `: ${recovery.deniedReason}` : "."}
          </p>
        ) : status === "cancelled" || status === "expired" ? (
          <p className="mb-3 text-sm text-text-secondary">
            Tu solicitud anterior se cerró.
          </p>
        ) : null}
        <p className="text-sm text-text-secondary">
          Si perdiste el acceso a tu app autenticadora, puedes pedir que se restablezca.
          Te enviaremos un correo para verificarlo y otro administrador tendrá que
          aprobarlo. Tu rol no cambia.
        </p>
        {recovery.hasApprover === false ? (
          <p role="alert" className="mt-3 text-sm text-accent-live">
            No hay otro administrador ni un Developer que pueda aprobarlo. Contacta con el
            propietario del proyecto, que realiza la recuperación desde los controles de
            Supabase.
          </p>
        ) : recovery.mailConfigured === false ? (
          <p role="alert" className="mt-3 text-sm text-accent-live">
            El envío de correos no está disponible todavía.
          </p>
        ) : null}
        <button
          type="button"
          className={`mt-4 ${PRIMARY}`}
          disabled={
            busy ||
            locked ||
            recovery.hasApprover === false ||
            recovery.mailConfigured === false
          }
          onClick={() =>
            void run("request", {}, "Te enviamos un correo para verificar la solicitud.")
          }
        >
          {busy ? "Enviando…" : "Solicitar restablecimiento"}
        </button>
      </>
    );
  } else if (status === "pending_email") {
    body = (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            "verify",
            { token: code.trim() },
            "Correo verificado. Falta la aprobación de un administrador.",
          );
        }}
        className="flex flex-col gap-4"
      >
        <p className="text-sm text-text-secondary">
          Te enviamos un correo con un enlace. Ábrelo con esta sesión iniciada o pega aquí
          el código del enlace (lo que sigue a «#c=»).
        </p>
        <AdminAuthField
          label="Código del correo"
          id="recovery-code"
          name="code"
          type="text"
          autoComplete="off"
          required
          value={code}
          onChange={(e) => setCode(extractRecoveryCode(e.target.value) ?? e.target.value)}
          disabled={busy}
        />
        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            disabled={busy || locked || code.trim().length === 0}
            className={PRIMARY}
          >
            Verificar correo
          </button>
          <button
            type="button"
            disabled={busy || locked}
            className={SECONDARY}
            onClick={() => void run("resend", {}, "Te enviamos un correo nuevo.")}
          >
            Reenviar correo
          </button>
          <button
            type="button"
            disabled={busy}
            className={SECONDARY}
            onClick={() => void run("cancel", {}, "Solicitud cancelada.")}
          >
            Cancelar solicitud
          </button>
        </div>
        <p className="text-sm text-text-secondary" data-testid="recovery-code-help">
          {CODE_LOST_HELP} ¿Abriste el enlace con otra cuenta? Cambia de cuenta.
        </p>
        <div>{switchAccountButton}</div>
      </form>
    );
  } else if (status === "pending_approval") {
    body = (
      <>
        <p role="status" className="text-sm text-text-secondary">
          Correo verificado. Esperando la aprobación de un administrador. Aún no se ha
          eliminado ningún autenticador.
        </p>
        <button
          type="button"
          disabled={busy}
          className={`mt-4 ${SECONDARY}`}
          onClick={() => void run("cancel", {}, "Solicitud cancelada.")}
        >
          Cancelar solicitud
        </button>
      </>
    );
  } else if (status === "approved" || status === "executing") {
    const ready = recovery.readiness === "ready" || status === "executing";
    body = (
      <>
        <p className="text-sm text-text-secondary">
          Un administrador aprobó tu solicitud.{" "}
          {recovery.readiness && READINESS_TEXT[recovery.readiness]}
          {recovery.readiness === "waiting" && recovery.readyAt
            ? ` Podrás continuar a partir de ${formatWhen(recovery.readyAt)}.`
            : ""}
        </p>
        {status === "executing" ? (
          <p role="alert" className="mt-3 text-sm text-accent-live">
            La invalidación no terminó. Puedes reintentarla.
          </p>
        ) : null}
        {ready ? (
          confirmExecute ? (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <p className="text-sm text-text-primary">
                Esto elimina tu autenticador actual. Tendrás que configurar uno nuevo.
              </p>
              <button
                type="button"
                disabled={busy || locked}
                className={PRIMARY}
                onClick={() => void run("execute", {})}
              >
                Sí, invalidar mi autenticador
              </button>
              <button
                type="button"
                disabled={busy}
                className={SECONDARY}
                onClick={() => setConfirmExecute(false)}
              >
                No
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={busy || locked}
              className={`mt-4 ${PRIMARY}`}
              onClick={() => setConfirmExecute(true)}
            >
              Invalidar mi autenticador actual
            </button>
          )
        ) : null}
        {status === "approved" ? (
          <button
            type="button"
            disabled={busy}
            className={`mt-4 ml-3 ${SECONDARY}`}
            onClick={() => void run("cancel", {}, "Solicitud cancelada.")}
          >
            Cancelar solicitud
          </button>
        ) : null}
      </>
    );
  } else {
    // factors_deleted: el cierre lo hace el servidor al detectar el TOTP nuevo verificado.
    body = (
      <>
        <p role="status" className="text-sm text-text-secondary">
          Tu autenticador anterior quedó invalidado. Configura uno nuevo: abre la
          verificación en dos pasos en una pestaña nueva, escanea el código y verifícalo.
          Esta página lo detecta sola y completa la recuperación; no tienes que pulsar
          nada más. Si tu sesión se cerró, inicia sesión de nuevo.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <a
            href="/admin/mfa"
            target="_blank"
            rel="noopener noreferrer"
            className={PRIMARY}
          >
            Configurar autenticador nuevo
          </a>
        </div>
        <p className="mt-3 text-sm text-text-secondary">
          Aún no se detecta un autenticador nuevo verificado en esta sesión.
        </p>
        {signOutButton}
      </>
    );
  }

  return (
    <AdminAuthCard title="Restablecer autenticador">
      {invalidLink ? (
        <p
          role="status"
          className="mb-3 text-sm text-text-secondary"
          data-testid="invalid-link-notice"
        >
          {INVALID_LINK_NOTICE}
        </p>
      ) : null}
      {body}
      {feedback}
      {locked ? (
        <form
          onSubmit={(e) => void confirmPassword(e)}
          className="mt-6 flex flex-col gap-3 rounded-md border border-border-subtle p-4"
          aria-label="Confirmar contraseña"
        >
          <p className="text-sm text-text-secondary">
            Por seguridad, confirma tu contraseña actual para continuar. No necesitas tu
            autenticador.
          </p>
          <AdminAuthField
            label="Contraseña actual"
            id="recovery-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
          <button
            type="submit"
            disabled={busy || password.length === 0}
            className={`self-start ${PRIMARY}`}
          >
            {busy ? "Confirmando…" : "Confirmar y continuar"}
          </button>
        </form>
      ) : null}
      <div className="mt-6 flex flex-wrap gap-3">
        {active ? (
          <button
            type="button"
            disabled={busy || refreshing}
            aria-busy={refreshing}
            className={SECONDARY}
            onClick={() => void load()}
          >
            Actualizar estado
          </button>
        ) : null}
        <Link
          to="/admin/mfa"
          className="inline-flex min-h-11 items-center text-sm text-text-secondary underline"
        >
          Volver
        </Link>
      </div>
    </AdminAuthCard>
  );
}
