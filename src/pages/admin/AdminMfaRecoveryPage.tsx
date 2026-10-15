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
import { useTranslations } from "use-intl";
import { useLocaleCode } from "@/i18n/useFormat";

// /admin/mfa/recovery — «Perdí mi autenticador» (MFA fase 2). Solo PRESENTA el estado que decide el
// servidor y envía operaciones al endpoint /api/admin/mfa-recovery; la autoridad (rol, credenciales
// recientes, aprobación de otro admin, espera, aviso entregado, instantánea de factores) es siempre
// del backend. Funciona con una sesión aal1: quien perdió el autenticador no puede subir a aal2.
// El desafío del correo llega en un enlace con fragmento (#c=…): se lee una vez, se limpia de la URL
// y NUNCA se guarda en storage ni se registra.

const ENDPOINT = "/api/admin/mfa-recovery";

/** El código del enlace vive solo en memoria de esta pestaña: así se recupera si se pierde. */
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

const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  "pending_email",
  "pending_approval",
  "approved",
  "executing",
  "factors_deleted",
]);
/** Intervalo del refresco automático (solo GET del estado, sin escrituras). */
const RECOVERY_POLL_MS = 15000;

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

function formatWhen(iso: string | null | undefined, locale: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(locale);
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
  const t = useTranslations("admin.recovery");
  const locale = useLocaleCode();
  const tRef = useRef(t);
  tRef.current = t;
  const textFor = (group: "codes" | "readiness", key: string): string | null => {
    const path = `${group}.${key}`;
    return t.has(path as never) ? (t as unknown as (k: string) => string)(path) : null;
  };

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
          return fail(tRef.current("forbiddenTeam"));
        }
        if (!response.ok) return fail(tRef.current("loadStatusError"));
        const body = (await response.json().catch(() => null)) as Recovery | null;
        if (stale()) return null;
        if (!body || typeof body.status !== "string") {
          return fail(tRef.current("loadStatusError"));
        }
        setLoadError(null);
        setNeedsLogin(false);
        setRecovery(body);
        return body;
      } catch {
        return fail(tRef.current("loadStatusError"));
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
        fail(rateLimited ? t("rateLimited") : t("confirmWrong"));
        return;
      }
      if (data.user.id !== current.user.id) {
        fail(t("confirmSession"));
        return;
      }
      const fresh = await load();
      if (!mounted.current) return;
      if (fresh && fresh.recentLogin === false) {
        fail(t("serverNoRecognize"));
      } else if (fresh) {
        setMessage({ kind: "ok", text: t("passwordConfirmed") });
      }
    } catch {
      if (mounted.current) fail(t("confirmRetry"));
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
        setMessage({ kind: "error", text: textFor("codes", key) ?? t("generic") });
        void load();
        return;
      }
      const mail = body?.mail as { status?: string } | undefined;
      if (mail?.status === "failed") {
        setMessage({
          kind: "error",
          text: t("mailFailedAfter"),
        });
      } else if (op === "execute" && body?.status === "executing") {
        setMessage({
          kind: "error",
          text: t("executeNotInvalidated"),
        });
      } else if (okText) {
        setMessage({ kind: "ok", text: okText });
      }
      setCode("");
      clearPendingRecoveryCode(); // el código ya se usó, se reemplazó o dejó de servir
      setConfirmExecute(false);
      await load();
    } catch {
      if (mounted.current) setMessage({ kind: "error", text: t("generic") });
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
      {t("switchAccount")}
    </button>
  );

  const signOutButton = (
    <button type="button" onClick={() => void signOut()} className={`mt-4 ${SECONDARY}`}>
      {t("signOut")}
    </button>
  );

  if (needsLogin) {
    return (
      <AdminAuthCard title={t("title")}>
        {invalidLink ? (
          <p
            role="status"
            className="mb-3 text-sm text-text-secondary"
            data-testid="invalid-link-notice"
          >
            {t("invalidLinkNotice")}
          </p>
        ) : null}
        <p role="status" className="text-sm text-text-secondary">
          {t("loginPrompt")}
        </p>
        <p className="mt-3 text-sm text-text-secondary" data-testid="recovery-code-help">
          {t("codeLostHelp")}
        </p>
        <Link to={RECOVERY_LOGIN_PATH} className={`mt-4 ${PRIMARY}`}>
          {t("signIn")}
        </Link>
      </AdminAuthCard>
    );
  }
  if (loadError) {
    return (
      <AdminAuthCard title={t("title")}>
        {invalidLink ? (
          <p
            role="status"
            className="mb-3 text-sm text-text-secondary"
            data-testid="invalid-link-notice"
          >
            {t("invalidLinkNotice")}
          </p>
        ) : null}
        <p role="alert" className="text-sm text-accent-live">
          {loadError}
        </p>
        <Link
          to="/admin/mfa"
          className="mt-4 inline-flex min-h-11 items-center text-sm underline"
        >
          {t("backToMfa")}
        </Link>
        <div className="mt-2">{switchAccountButton}</div>
      </AdminAuthCard>
    );
  }
  if (!recovery) {
    return (
      <AdminAuthCard title={t("title")}>
        {invalidLink ? (
          <p
            role="status"
            className="mb-3 text-sm text-text-secondary"
            data-testid="invalid-link-notice"
          >
            {t("invalidLinkNotice")}
          </p>
        ) : null}
        <p role="status" className="text-sm text-text-secondary">
          {t("loading")}
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
        {t("completed")}
      </p>
    );
  } else if (closed) {
    body = (
      <>
        {status === "none" && code.trim() !== "" ? (
          <div role="status" className="mb-4 rounded-md border border-border-subtle p-3">
            <p className="text-sm text-text-secondary">{t("strayLink")}</p>
            <div className="mt-2">{switchAccountButton}</div>
          </div>
        ) : null}
        {status === "denied" ? (
          <p className="mb-3 text-sm text-text-secondary">
            {recovery.deniedReason
              ? t("deniedWithReason", { reason: recovery.deniedReason })
              : t("denied")}
          </p>
        ) : status === "cancelled" || status === "expired" ? (
          <p className="mb-3 text-sm text-text-secondary">{t("closedPrevious")}</p>
        ) : null}
        <p className="text-sm text-text-secondary">{t("requestIntro")}</p>
        {recovery.hasApprover === false ? (
          <p role="alert" className="mt-3 text-sm text-accent-live">
            {t("noApprover")}
          </p>
        ) : recovery.mailConfigured === false ? (
          <p role="alert" className="mt-3 text-sm text-accent-live">
            {t("mailNotAvailable")}
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
          onClick={() => void run("request", {}, t("requestSent"))}
        >
          {busy ? t("sending") : t("requestButton")}
        </button>
      </>
    );
  } else if (status === "pending_email") {
    body = (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run("verify", { token: code.trim() }, t("emailVerified"));
        }}
        className="flex flex-col gap-4"
      >
        <p className="text-sm text-text-secondary">{t("pendingIntro")}</p>
        <AdminAuthField
          label={t("emailCode")}
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
            {t("verifyEmail")}
          </button>
          <button
            type="button"
            disabled={busy || locked}
            className={SECONDARY}
            onClick={() => void run("resend", {}, t("resent"))}
          >
            {t("resend")}
          </button>
          <button
            type="button"
            disabled={busy}
            className={SECONDARY}
            onClick={() => void run("cancel", {}, t("cancelled"))}
          >
            {t("cancelRequest")}
          </button>
        </div>
        <p className="text-sm text-text-secondary" data-testid="recovery-code-help">
          {t("codeLostHelp")} {t("otherAccountHelp")}
        </p>
        <div>{switchAccountButton}</div>
      </form>
    );
  } else if (status === "pending_approval") {
    body = (
      <>
        <p role="status" className="text-sm text-text-secondary">
          {t("waitingApproval")}
        </p>
        <button
          type="button"
          disabled={busy}
          className={`mt-4 ${SECONDARY}`}
          onClick={() => void run("cancel", {}, t("cancelled"))}
        >
          {t("cancelRequest")}
        </button>
      </>
    );
  } else if (status === "approved" || status === "executing") {
    const ready = recovery.readiness === "ready" || status === "executing";
    body = (
      <>
        <p className="text-sm text-text-secondary">
          {t("approvedPrefix")}{" "}
          {recovery.readiness ? textFor("readiness", recovery.readiness) : null}
          {recovery.readiness === "waiting" && recovery.readyAt
            ? ` ${t("readyAt", { when: formatWhen(recovery.readyAt, locale) })}`
            : ""}
        </p>
        {status === "executing" ? (
          <p role="alert" className="mt-3 text-sm text-accent-live">
            {t("executionIncomplete")}
          </p>
        ) : null}
        {ready ? (
          confirmExecute ? (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <p className="text-sm text-text-primary">{t("confirmExecute")}</p>
              <button
                type="button"
                disabled={busy || locked}
                className={PRIMARY}
                onClick={() => void run("execute", {})}
              >
                {t("yesInvalidate")}
              </button>
              <button
                type="button"
                disabled={busy}
                className={SECONDARY}
                onClick={() => setConfirmExecute(false)}
              >
                {t("no")}
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={busy || locked}
              className={`mt-4 ${PRIMARY}`}
              onClick={() => setConfirmExecute(true)}
            >
              {t("invalidateButton")}
            </button>
          )
        ) : null}
        {status === "approved" ? (
          <button
            type="button"
            disabled={busy}
            className={`mt-4 ml-3 ${SECONDARY}`}
            onClick={() => void run("cancel", {}, t("cancelled"))}
          >
            {t("cancelRequest")}
          </button>
        ) : null}
      </>
    );
  } else {
    // factors_deleted: el cierre lo hace el servidor al detectar el TOTP nuevo verificado.
    body = (
      <>
        <p role="status" className="text-sm text-text-secondary">
          {t("afterInvalidated")}
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <a
            href="/admin/mfa"
            target="_blank"
            rel="noopener noreferrer"
            className={PRIMARY}
          >
            {t("setupNew")}
          </a>
        </div>
        <p className="mt-3 text-sm text-text-secondary">{t("notDetected")}</p>
        {signOutButton}
      </>
    );
  }

  return (
    <AdminAuthCard title={t("title")}>
      {invalidLink ? (
        <p
          role="status"
          className="mb-3 text-sm text-text-secondary"
          data-testid="invalid-link-notice"
        >
          {t("invalidLinkNotice")}
        </p>
      ) : null}
      {body}
      {feedback}
      {locked ? (
        <form
          onSubmit={(e) => void confirmPassword(e)}
          className="mt-6 flex flex-col gap-3 rounded-md border border-border-subtle p-4"
          aria-label={t("confirmPasswordLabel")}
        >
          <p className="text-sm text-text-secondary">{t("confirmPasswordIntro")}</p>
          <AdminAuthField
            label={t("currentPassword")}
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
            {busy ? t("confirming") : t("confirmContinue")}
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
            {t("refresh")}
          </button>
        ) : null}
        <Link
          to="/admin/mfa"
          className="inline-flex min-h-11 items-center text-sm text-text-secondary underline"
        >
          {" "}
          {t("back")}
        </Link>
      </div>
    </AdminAuthCard>
  );
}
