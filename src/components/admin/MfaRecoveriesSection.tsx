import { useCallback, useEffect, useId, useRef, useState } from "react";
import { usePrivilegedFailureReporter } from "@/hooks/privileged-failure";
import { supabase } from "@/lib/supabase";
import { useTranslations } from "use-intl";

// Solicitudes de recuperación de autenticador (MFA fase 2) pendientes de revisar. Solo PRESENTA la
// lista y envía la decisión: la autoridad es el servidor (JWT + MFA reciente + rol ADMIN en cada
// llamada, y la base impide la autoaprobación). Ocultar o mostrar esta sección NO es una frontera de
// seguridad. No se muestra ningún código, correo ni secreto: solo cuenta, rol y estado.
//   GET  /api/admin/mfa-recovery-admin → { recoveries: [{ id, username, role, status, requested_at,
//                                         email_verified_at, notice_state, readiness }] }
//   POST /api/admin/mfa-recovery-admin → { op: approve|deny|cancel|resend_notice, recovery_id, reason? }

const ENDPOINT = "/api/admin/mfa-recovery-admin";

const SECONDARY =
  "inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50";

interface Item {
  id: string;
  username: string | null;
  role: string;
  status: string;
  requested_at: string;
  email_verified_at: string | null;
  notice_state: string | null;
  readiness: string;
}

// Mensajes como marcadores `i18n:<clave>`; se traducen al renderizar (resolveMessage).
const MSG_SESSION = "i18n:e401";
const MSG_LIST = "i18n:listError";
const MSG_GENERIC = "i18n:generic";
const STATUS_ERRORS: ReadonlySet<number> = new Set([401, 403, 404, 409, 410]);
const REMINDER_CODES: ReadonlySet<string> = new Set([
  "too_soon",
  "reminder_limit",
  "notice_not_delivered",
  "mail_unavailable",
]);
const statusMarker = (status: number): string | null =>
  STATUS_ERRORS.has(status) ? `i18n:e${status}` : null;
const reminderMarker = (code: string): string | null =>
  REMINDER_CODES.has(code) ? `i18n:r_${code}` : null;

function parse(raw: unknown): Item[] | null {
  const list = (raw as { recoveries?: unknown } | null)?.recoveries;
  if (!Array.isArray(list)) return null;
  const out: Item[] = [];
  for (const r of list as Record<string, unknown>[]) {
    if (
      !r ||
      typeof r.id !== "string" ||
      typeof r.role !== "string" ||
      typeof r.status !== "string" ||
      typeof r.requested_at !== "string"
    ) {
      return null;
    }
    out.push({
      id: r.id,
      username: typeof r.username === "string" ? r.username : null,
      role: r.role,
      status: r.status,
      requested_at: r.requested_at,
      email_verified_at:
        typeof r.email_verified_at === "string" ? r.email_verified_at : null,
      notice_state: typeof r.notice_state === "string" ? r.notice_state : null,
      readiness: typeof r.readiness === "string" ? r.readiness : "",
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

export default function MfaRecoveriesSection({
  refreshKey = 0,
}: {
  refreshKey?: number;
}) {
  const t = useTranslations("admin.recoveries");
  const label = (group: "status" | "notice", key: string): string => {
    const path = `${group}.${key}`;
    return t.has(path as never) ? (t as unknown as (k: string) => string)(path) : key;
  };
  const resolveMessage = (message: string): string =>
    message.startsWith("i18n:")
      ? (t as unknown as (k: string) => string)(`msg.${message.slice(5)}`)
      : message;
  const headingId = useId();
  const reportFailure = usePrivilegedFailureReporter();
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [denying, setDenying] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const lock = useRef(false);
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
    const jwt = await token();
    if (!current()) return;
    if (!jwt) {
      setError(MSG_SESSION);
      return;
    }
    try {
      const response = await fetch(ENDPOINT, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!current()) return;
      if (!response.ok) {
        reportFailure(response);
        setError(statusMarker(response.status) ?? MSG_LIST);
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
    }
  }, [reportFailure]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const act = async (
    id: string,
    op: string,
    extra: Record<string, unknown>,
    done: string,
  ) => {
    if (lock.current) return;
    lock.current = true;
    setBusyId(id);
    setNotice(null);
    setActionError(null);
    try {
      const jwt = await token();
      if (!jwt) {
        setActionError(MSG_SESSION);
        return;
      }
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ op, recovery_id: id, ...extra }),
      });
      if (!mounted.current) return;
      if (!response.ok) {
        reportFailure(response);
        const errBody = (await response.json().catch(() => null)) as {
          code?: unknown;
        } | null;
        const key = typeof errBody?.code === "string" ? errBody.code : "";
        setActionError(
          reminderMarker(key) ?? statusMarker(response.status) ?? MSG_GENERIC,
        );
        void load();
        return;
      }
      const body = (await response.json().catch(() => null)) as {
        notice?: { status?: string };
        reminder?: { status?: string };
      } | null;
      const failedNotice =
        body?.notice?.status === "failed" || body?.reminder?.status === "failed";
      setNotice(failedNotice ? `${done} ${t("failedNotice")}` : done);
      setDenying(null);
      setReason("");
      void load();
    } catch {
      if (mounted.current) setActionError(MSG_GENERIC);
    } finally {
      lock.current = false;
      if (mounted.current) setBusyId(null);
    }
  };

  return (
    <section aria-labelledby={headingId} className="mt-8" data-testid="mfa-recoveries">
      <h2 id={headingId} className="font-display text-xl tracking-wide text-text-primary">
        {t("heading")}
      </h2>
      <p className="mt-2 text-sm text-text-secondary">{t("intro")}</p>
      {notice ? (
        <p role="status" className="mt-3 text-sm text-accent-success">
          {notice}
        </p>
      ) : null}
      {actionError ? (
        <p role="alert" className="mt-3 text-sm text-accent-live">
          {" "}
          {resolveMessage(actionError)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-accent-live">
          {" "}
          {resolveMessage(error)}
        </p>
      ) : null}
      {items && items.length === 0 && !error ? (
        <p className="mt-3 text-sm text-text-secondary">{t("empty")}</p>
      ) : null}
      <ul className="mt-4 flex flex-col gap-3">
        {(items ?? []).map((i) => {
          const name = i.username ? `@${i.username}` : t("noProfile");
          // «Reenviar aviso» está disponible mientras esté aprobada: con el aviso entregado envía un recordatorio.
          const noticeDelivered = i.notice_state === "delivered";
          const canResend = i.status === "approved";
          return (
            <li key={i.id} className="rounded-md border border-border-subtle p-4">
              <p className="font-semibold text-text-primary">
                {name} · {i.role}
              </p>
              <p className="mt-1 text-sm text-text-secondary">
                {label("status", i.status)}
                {i.status === "pending_approval" && i.email_verified_at
                  ? ` · ${t("emailVerified")}`
                  : ""}
                {i.status === "approved"
                  ? ` · ${i.notice_state ? label("notice", i.notice_state) : t("noticeUnregistered")}`
                  : ""}
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                {i.status === "pending_approval" ? (
                  <button
                    type="button"
                    disabled={busyId !== null}
                    className={SECONDARY}
                    aria-label={t("approveAria", { name })}
                    onClick={() => void act(i.id, "approve", {}, t("approvedDone"))}
                  >
                    {t("approve")}
                  </button>
                ) : null}
                {canResend ? (
                  <button
                    type="button"
                    disabled={busyId !== null}
                    className={SECONDARY}
                    aria-label={t("resendAria", { name })}
                    onClick={() =>
                      void act(
                        i.id,
                        "resend_notice",
                        {},
                        noticeDelivered ? t("reminderSent") : t("noticeResent"),
                      )
                    }
                  >
                    {t("resend")}
                  </button>
                ) : null}
                {i.status !== "executing" ? (
                  <button
                    type="button"
                    disabled={busyId !== null}
                    className={SECONDARY}
                    aria-label={t("rejectAria", { name })}
                    onClick={() => {
                      setDenying(denying === i.id ? null : i.id);
                      setReason("");
                    }}
                  >
                    {t("reject")}
                  </button>
                ) : null}
              </div>
              {denying === i.id ? (
                <form
                  className="mt-3 flex flex-col gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(i.id, "deny", { reason: reason.trim() }, t("deniedDone"));
                  }}
                >
                  <label className="text-sm text-text-secondary" htmlFor={`deny-${i.id}`}>
                    {t("reasonLabel")}
                  </label>
                  <input
                    id={`deny-${i.id}`}
                    value={reason}
                    maxLength={200}
                    onChange={(e) => setReason(e.target.value)}
                    className="rounded-md border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary"
                  />
                  <button
                    type="submit"
                    className={SECONDARY}
                    disabled={busyId !== null || reason.trim().length === 0}
                  >
                    {t("confirmReject")}
                  </button>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
