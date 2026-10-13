import { useCallback, useEffect, useId, useRef, useState } from "react";
import { usePrivilegedFailureReporter } from "@/hooks/privileged-failure";
import { supabase } from "@/lib/supabase";

// Limpiezas de MFA pendientes (MFA fase 1) — SOLO LECTURA para Developer. Presenta lo que devuelve
// GET /api/admin/developer-mfa-cleanups; no hay ninguna acción: el reintento manual sigue en el panel
// de Admin y el procesamiento automático no se toca. Ocultar o mostrar esta sección NO es una frontera
// de seguridad: el servidor exige rol Developer + MFA reciente en cada llamada. No se muestran ids de
// factores, hashes, tokens ni correos completos (el servidor envía el correo ya enmascarado).

const ENDPOINT = "/api/admin/developer-mfa-cleanups";

const SECONDARY =
  "inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50";

interface Cleanup {
  status: "pending" | "completed";
  previous_role: string;
  requested_at: string;
  completed_at: string | null;
  attempts: number;
  last_attempt_at: string | null;
  last_error_class: string | null;
  factor_count: number;
  factors_deleted: number | null;
  username: string | null;
  email_masked: string | null;
}

const ROLE_LABEL: Record<string, string> = {
  admin: "ADMIN",
  moderator: "MODERADOR",
  developer: "DEVELOPER",
};
const ERROR_LABEL: Record<string, string> = {
  auth_delete_failed: "Falló el borrado en el proveedor de autenticación",
  auth_list_failed: "No se pudo comprobar la lista de factores",
  auth_unavailable: "Proveedor de autenticación no disponible",
  factor_still_present: "El factor seguía presente tras el borrado",
  record_failed: "Los factores se borraron pero no se pudo registrar",
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("es", { dateStyle: "medium", timeStyle: "short" });
}

function parse(raw: unknown): Cleanup[] | null {
  const list = (raw as { cleanups?: unknown } | null)?.cleanups;
  if (!Array.isArray(list)) return null;
  const out: Cleanup[] = [];
  for (const r of list as Record<string, unknown>[]) {
    if (
      !r ||
      (r.status !== "pending" && r.status !== "completed") ||
      typeof r.previous_role !== "string" ||
      typeof r.requested_at !== "string" ||
      typeof r.attempts !== "number" ||
      typeof r.factor_count !== "number"
    ) {
      return null;
    }
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    out.push({
      status: r.status,
      previous_role: r.previous_role,
      requested_at: r.requested_at,
      completed_at: str(r.completed_at),
      attempts: r.attempts,
      last_attempt_at: str(r.last_attempt_at),
      last_error_class: str(r.last_error_class),
      factor_count: r.factor_count,
      factors_deleted: typeof r.factors_deleted === "number" ? r.factors_deleted : null,
      username: str(r.username),
      email_masked: str(r.email_masked),
    });
  }
  return out;
}

async function token(): Promise<string | null> {
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

export default function DeveloperCleanupsSection() {
  const headingId = useId();
  const reportFailure = usePrivilegedFailureReporter();
  const [items, setItems] = useState<Cleanup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);
  const request = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const mine = ++request.current;
    const current = () => mounted.current && request.current === mine;
    setLoading(true);
    try {
      const jwt = await token();
      if (!current()) return;
      if (!jwt) {
        setError("Tu sesión ya no es válida. Inicia sesión de nuevo.");
        return;
      }
      const response = await fetch(ENDPOINT, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!current()) return;
      if (!response.ok) {
        reportFailure(response);
        setError("No se pudo cargar la lista de limpiezas.");
        return;
      }
      const parsed = parse(await response.json().catch(() => null));
      if (!current()) return;
      if (!parsed) {
        setError("No se pudo cargar la lista de limpiezas.");
        return;
      }
      setError(null);
      setItems(parsed);
    } catch {
      if (current()) setError("No se pudo cargar la lista de limpiezas.");
    } finally {
      if (current()) setLoading(false);
    }
  }, [reportFailure]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = (items ?? []).filter((i) => i.status === "pending");
  const history = (items ?? []).filter((i) => i.status === "completed");

  const renderItem = (c: Cleanup, key: string) => {
    const name = c.username ? `@${c.username}` : "Cuenta sin perfil";
    return (
      <li key={key} className="rounded-md border border-border-subtle p-4">
        <p className="font-semibold text-text-primary">
          {name}
          <span className="ml-2 text-sm font-normal text-text-secondary">
            {ROLE_LABEL[c.previous_role] ?? c.previous_role} anterior
          </span>
        </p>
        {c.email_masked ? (
          <p className="mt-1 text-sm text-text-secondary">{c.email_masked}</p>
        ) : null}
        <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div>
            <dt className="inline text-text-muted">Estado: </dt>
            <dd className="inline text-text-primary">
              {c.status === "pending" ? "Pendiente de limpiar" : "Completada"}
            </dd>
          </div>
          <div>
            <dt className="inline text-text-muted">Factores: </dt>
            <dd className="inline text-text-primary">
              {c.status === "completed" && c.factors_deleted !== null
                ? `${c.factors_deleted} de ${c.factor_count} eliminados`
                : `${c.factor_count} por eliminar`}
            </dd>
          </div>
          <div>
            <dt className="inline text-text-muted">Intentos: </dt>
            <dd className="inline text-text-primary">{c.attempts}</dd>
          </div>
          <div>
            <dt className="inline text-text-muted">Último intento: </dt>
            <dd className="inline text-text-primary">{formatDate(c.last_attempt_at)}</dd>
          </div>
          <div>
            <dt className="inline text-text-muted">Solicitada: </dt>
            <dd className="inline text-text-primary">{formatDate(c.requested_at)}</dd>
          </div>
          {c.status === "completed" ? (
            <div>
              <dt className="inline text-text-muted">Completada: </dt>
              <dd className="inline text-text-primary">{formatDate(c.completed_at)}</dd>
            </div>
          ) : null}
        </dl>
        {c.status === "pending" && c.last_error_class ? (
          <p className="mt-2 text-sm text-accent-live">
            Último error: {ERROR_LABEL[c.last_error_class] ?? c.last_error_class}
          </p>
        ) : null}
      </li>
    );
  };

  return (
    <section
      aria-labelledby={headingId}
      className="mt-8"
      data-testid="developer-cleanups"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          id={headingId}
          className="font-display text-xl tracking-wide text-text-primary"
        >
          Limpiezas de MFA pendientes
        </h2>
        <button
          type="button"
          className={SECONDARY}
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? "Actualizando…" : "Actualizar"}
        </button>
      </div>
      <p className="mt-2 text-sm text-text-secondary">
        Supervisión de solo lectura. El reintento manual sigue en el panel de Admin; esta
        vista no ejecuta limpiezas ni modifica factores.
      </p>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-accent-live">
          {error}
        </p>
      ) : null}
      {items && !error ? (
        <>
          <h3 className="mt-4 text-sm font-semibold text-text-primary">
            Pendientes ({pending.length})
          </h3>
          {pending.length === 0 ? (
            <p className="mt-2 text-sm text-text-secondary">
              No hay limpiezas pendientes.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-3">
              {pending.map((c, i) => renderItem(c, `p-${i}`))}
            </ul>
          )}
          <h3 className="mt-6 text-sm font-semibold text-text-primary">
            Historial reciente ({history.length})
          </h3>
          {history.length === 0 ? (
            <p className="mt-2 text-sm text-text-secondary">Sin limpiezas completadas.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-3">
              {history.map((c, i) => renderItem(c, `h-${i}`))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}
