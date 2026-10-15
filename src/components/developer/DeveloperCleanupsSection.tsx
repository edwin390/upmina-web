import { useCallback, useEffect, useId, useRef, useState } from "react";
import { usePrivilegedFailureReporter } from "@/hooks/privileged-failure";
import { supabase } from "@/lib/supabase";
import { useTranslations } from "use-intl";
import { useLocaleCode } from "@/i18n/useFormat";

// Limpiezas de MFA pendientes (MFA fase 1) para Developer. Presenta lo que devuelve
// GET /api/admin/developer-mfa-cleanups y permite SOLICITAR el reintento (POST sin cuerpo: el servidor
// decide a quién; es idempotente). El procesamiento automático no se toca. Ocultar o mostrar esta sección NO es una frontera
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

// Mensajes como marcadores `i18n:<clave>`; se traducen al renderizar.
const MSG_SESSION = "i18n:session";
const MSG_LIST = "i18n:listError";
const MSG_RETRY = "i18n:retryError";

function formatDate(value: string | null, locale: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
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
  const t = useTranslations("developer.cleanups");
  const locale = useLocaleCode();
  const label = (group: "role" | "errors", key: string): string => {
    const path = `${group}.${key}`;
    return t.has(path as never) ? (t as unknown as (k: string) => string)(path) : key;
  };
  const resolveMessage = (message: string): string =>
    message.startsWith("i18n:")
      ? (t as unknown as (k: string) => string)(`msg.${message.slice(5)}`)
      : message;

  const headingId = useId();
  const reportFailure = usePrivilegedFailureReporter();
  const [items, setItems] = useState<Cleanup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
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
        setError(MSG_SESSION);
        return;
      }
      const response = await fetch(ENDPOINT, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!current()) return;
      if (!response.ok) {
        reportFailure(response);
        setError(MSG_LIST);
        return;
      }
      const parsed = parse(await response.json().catch(() => null));
      if (!current()) return;
      if (!parsed) {
        setError(MSG_LIST);
        return;
      }
      setError(null);
      setItems(parsed);
    } catch {
      if (current()) setError(MSG_LIST);
    } finally {
      if (current()) setLoading(false);
    }
  }, [reportFailure]);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    setNotice(null);
    try {
      const jwt = await token();
      if (!jwt) {
        setError(MSG_SESSION);
        return;
      }
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!response.ok) {
        reportFailure(response);
        if (mounted.current) setError(MSG_RETRY);
        return;
      }
      const body = (await response.json().catch(() => null)) as {
        completed?: unknown;
        pending?: unknown;
      } | null;
      if (!mounted.current) return;
      setNotice(
        typeof body?.completed === "number" && typeof body?.pending === "number"
          ? t("retryDone", { completed: body.completed, pending: body.pending })
          : t("retryDoneSimple"),
      );
      await load();
    } catch {
      if (mounted.current) setError(MSG_RETRY);
    } finally {
      if (mounted.current) setRetrying(false);
    }
  }, [retrying, reportFailure, load, t]);

  const pending = (items ?? []).filter((i) => i.status === "pending");
  const history = (items ?? []).filter((i) => i.status === "completed");

  const renderItem = (c: Cleanup, key: string) => {
    const name = c.username ? `@${c.username}` : t("noProfile");
    return (
      <li key={key} className="rounded-md border border-border-subtle p-4">
        <p className="font-semibold text-text-primary">
          {name}
          <span className="ml-2 text-sm font-normal text-text-secondary">
            {t("previousRole", { role: label("role", c.previous_role) })}
          </span>
        </p>
        {c.email_masked ? (
          <p className="mt-1 text-sm text-text-secondary">{c.email_masked}</p>
        ) : null}
        <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div>
            <dt className="inline text-text-muted">{t("state")}</dt>
            <dd className="inline text-text-primary">
              {c.status === "pending" ? t("statePending") : t("stateCompleted")}
            </dd>
          </div>
          <div>
            <dt className="inline text-text-muted">{t("factors")}</dt>
            <dd className="inline text-text-primary">
              {c.status === "completed" && c.factors_deleted !== null
                ? t("factorsDone", { done: c.factors_deleted, total: c.factor_count })
                : t("factorsTodo", { total: c.factor_count })}
            </dd>
          </div>
          <div>
            <dt className="inline text-text-muted">{t("attempts")}</dt>
            <dd className="inline text-text-primary">{c.attempts}</dd>
          </div>
          <div>
            <dt className="inline text-text-muted">{t("lastAttempt")}</dt>
            <dd className="inline text-text-primary">
              {formatDate(c.last_attempt_at, locale)}
            </dd>
          </div>
          <div>
            <dt className="inline text-text-muted">{t("requested")}</dt>
            <dd className="inline text-text-primary">
              {formatDate(c.requested_at, locale)}
            </dd>
          </div>
          {c.status === "completed" ? (
            <div>
              <dt className="inline text-text-muted">{t("completed")}</dt>
              <dd className="inline text-text-primary">
                {formatDate(c.completed_at, locale)}
              </dd>
            </div>
          ) : null}
        </dl>
        {c.status === "pending" && c.last_error_class ? (
          <p className="mt-2 text-sm text-accent-live">
            {t("lastError", { error: label("errors", c.last_error_class) })}
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
          {t("heading")}
        </h2>
        <button
          type="button"
          className={SECONDARY}
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? t("refreshing") : t("refresh")}
        </button>
      </div>
      <p className="mt-2 text-sm text-text-secondary">{t("intro")}</p>
      {pending.length > 0 ? (
        <button
          type="button"
          className={`${SECONDARY} mt-3`}
          disabled={retrying || loading}
          onClick={() => void retry()}
        >
          {retrying ? t("retrying") : t("retryPending")}
        </button>
      ) : null}
      {notice ? (
        <p role="status" className="mt-3 text-sm text-text-secondary">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-accent-live">
          {" "}
          {resolveMessage(error)}
        </p>
      ) : null}
      {items && !error ? (
        <>
          <h3 className="mt-4 text-sm font-semibold text-text-primary">
            {t("pendingHeading", { count: pending.length })}
          </h3>
          {pending.length === 0 ? (
            <p className="mt-2 text-sm text-text-secondary">{t("noPending")}</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-3">
              {pending.map((c, i) => renderItem(c, `p-${i}`))}
            </ul>
          )}
          <h3 className="mt-6 text-sm font-semibold text-text-primary">
            {t("historyHeading", { count: history.length })}
          </h3>
          {history.length === 0 ? (
            <p className="mt-2 text-sm text-text-secondary">{t("noHistory")}</p>
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
