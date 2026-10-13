import { useCallback, useEffect, useId, useRef, useState } from "react";
import { usePrivilegedFailureReporter } from "@/hooks/privileged-failure";
import { supabase } from "@/lib/supabase";

// Autenticadores pendientes de restablecer (MFA fase 1). Cuando se retira el último rol de una
// persona, su acceso se revoca al instante; la invalidación de su(s) autenticador(es) puede quedar
// pendiente si Supabase Auth falló. Esta sección solo PRESENTA esa lista y ofrece el reintento: el
// dashboard la monta únicamente con la capacidad `team_admin`, pero la autoridad es el servidor
// (JWT + AAL2 + ADMIN en cada llamada). Ocultarla NO es una frontera de seguridad. Contrato:
//   - GET  /api/admin/team-members-mfa-cleanups → { cleanups: [{ user_id, previous_role,
//                                                   requested_at, attempts, last_error_class,
//                                                   factor_count, username, email }] }.
//   - POST /api/admin/team-members-mfa-cleanup  → { user_id } → 200 { user_id, mfa_reset: { status } }.
// Si no hay nada pendiente no renderiza nada. El reintento solo envía el user_id: los factores a
// invalidar son siempre los guardados en el servidor.

const LIST_ENDPOINT = "/api/admin/team-members-mfa-cleanups";
const RETRY_ENDPOINT = "/api/admin/team-members-mfa-cleanup";

const MSG_SESSION = "Tu sesión ya no es válida. Inicia sesión de nuevo.";
const MSG_FORBIDDEN =
  "No se pudo autorizar esta acción. Comprueba tu verificación en dos pasos e inténtalo de nuevo.";
const MSG_LOAD = "No se pudo cargar la lista de autenticadores pendientes.";
const MSG_RETRY = "No pudimos reintentar la limpieza. Inténtalo de nuevo.";
const MSG_STILL_PENDING =
  "El autenticador todavía no se pudo restablecer. Puedes reintentarlo más tarde.";
const MSG_DONE = "Autenticador restablecido.";
const MSG_GONE = "Esta limpieza ya no está pendiente. Actualizamos la lista.";

const SECONDARY_BUTTON_CLASS =
  "inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50";

const ERROR_LABEL: Record<string, string> = {
  auth_delete_failed: "no se pudo borrar el autenticador",
  auth_list_failed: "no se pudo comprobar el resultado",
  auth_unavailable: "el servicio de autenticación no respondió",
  factor_still_present: "el autenticador sigue presente",
  record_failed: "no se pudo registrar el resultado",
  cleanup_unavailable: "no se pudo iniciar la limpieza",
};

interface Cleanup {
  user_id: string;
  previous_role: string;
  requested_at: string;
  attempts: number;
  last_error_class: string | null;
  factor_count: number;
  username: string | null;
  email: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nullableString = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === "string" ? v : undefined;

function parseCleanup(raw: unknown): Cleanup | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const username = nullableString(r.username);
  const email = nullableString(r.email);
  const lastError = nullableString(r.last_error_class);
  if (
    typeof r.user_id !== "string" ||
    !UUID.test(r.user_id) ||
    typeof r.previous_role !== "string" ||
    typeof r.requested_at !== "string" ||
    !Number.isInteger(r.attempts) ||
    !Number.isInteger(r.factor_count) ||
    username === undefined ||
    email === undefined ||
    lastError === undefined
  ) {
    return null;
  }
  return {
    user_id: r.user_id,
    previous_role: r.previous_role,
    requested_at: r.requested_at,
    attempts: r.attempts as number,
    last_error_class: lastError,
    factor_count: r.factor_count as number,
    username,
    email,
  };
}

function parseList(body: unknown): Cleanup[] | null {
  const list = (body as { cleanups?: unknown } | null)?.cleanups;
  if (!Array.isArray(list)) return null;
  const out: Cleanup[] = [];
  for (const raw of list) {
    const parsed = parseCleanup(raw);
    if (!parsed) return null;
    out.push(parsed);
  }
  return out;
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

function identity(c: Cleanup): string {
  if (c.username) return `@${c.username}`;
  return c.email ?? "Cuenta sin perfil";
}

function message(status: number, generic: string): string {
  if (status === 401) return MSG_SESSION;
  if (status === 403) return MSG_FORBIDDEN;
  return generic;
}

export default function MfaCleanupsSection({ refreshKey = 0 }: { refreshKey?: number }) {
  const headingId = useId();
  const reportFailure = usePrivilegedFailureReporter();
  const [cleanups, setCleanups] = useState<Cleanup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);
  const lockRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    const current = () => mountedRef.current && requestRef.current === request;
    const token = await getAccessToken();
    if (!current()) return;
    if (!token) {
      setError(MSG_SESSION);
      return;
    }
    let response: Response;
    try {
      response = await fetch(LIST_ENDPOINT, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      if (current()) setError(MSG_LOAD);
      return;
    }
    if (!current()) return;
    if (!response.ok) {
      reportFailure(response);
      setError(message(response.status, MSG_LOAD));
      return;
    }
    const parsed = parseList(await response.json().catch(() => null));
    if (!current()) return;
    if (!parsed) {
      setError(MSG_LOAD);
      return;
    }
    setError(null);
    setCleanups(parsed);
  }, [reportFailure]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const retry = async (userId: string) => {
    if (lockRef.current) return; // un solo reintento a la vez
    lockRef.current = true;
    setBusyId(userId);
    setRowError(null);
    setNotice(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        if (mountedRef.current) setRowError({ id: userId, message: MSG_SESSION });
        return;
      }
      const response = await fetch(RETRY_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      });
      if (!mountedRef.current) return;
      if (response.status === 404) {
        setRowError({ id: userId, message: MSG_GONE });
        void load();
        return;
      }
      if (!response.ok) {
        reportFailure(response);
        setRowError({ id: userId, message: message(response.status, MSG_RETRY) });
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      const status = (body as { mfa_reset?: { status?: unknown } } | null)?.mfa_reset
        ?.status;
      if (status === "completed") setNotice(MSG_DONE);
      else setRowError({ id: userId, message: MSG_STILL_PENDING });
      void load();
    } catch {
      if (mountedRef.current) setRowError({ id: userId, message: MSG_RETRY });
    } finally {
      lockRef.current = false;
      if (mountedRef.current) setBusyId(null);
    }
  };

  if (cleanups.length === 0 && !error && !notice) return null;

  return (
    <section aria-labelledby={headingId} className="mt-8" data-testid="mfa-cleanups">
      <h2 id={headingId} className="font-display text-xl tracking-wide text-text-primary">
        Autenticadores pendientes de restablecer
      </h2>
      <p className="mt-2 text-sm text-text-secondary">
        Estas personas ya no tienen acceso, pero su autenticador anterior todavía no se
        pudo invalidar. Hasta que se resuelva no podrán activar una nueva invitación.
      </p>

      {notice ? (
        <p role="status" className="mt-3 text-sm text-accent-success">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-accent-live">
          {error}
        </p>
      ) : null}

      <ul className="mt-4 flex flex-col gap-3">
        {cleanups.map((c) => (
          <li key={c.user_id} className="rounded-md border border-border-subtle p-4">
            <p className="font-semibold text-text-primary">{identity(c)}</p>
            <p className="mt-1 text-sm text-text-secondary">
              {c.factor_count === 1
                ? "1 autenticador por invalidar"
                : `${c.factor_count} autenticadores por invalidar`}
              {" · "}
              {c.attempts === 1 ? "1 intento" : `${c.attempts} intentos`}
              {c.last_error_class
                ? ` · último fallo: ${ERROR_LABEL[c.last_error_class] ?? "error desconocido"}`
                : ""}
            </p>
            {rowError?.id === c.user_id ? (
              <p role="alert" className="mt-2 text-sm text-accent-live">
                {rowError.message}
              </p>
            ) : null}
            <button
              type="button"
              disabled={busyId !== null}
              aria-label={`Reintentar la limpieza de ${identity(c)}`}
              onClick={() => void retry(c.user_id)}
              className={`mt-3 ${SECONDARY_BUTTON_CLASS}`}
            >
              {busyId === c.user_id ? "Reintentando…" : "Reintentar limpieza"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
