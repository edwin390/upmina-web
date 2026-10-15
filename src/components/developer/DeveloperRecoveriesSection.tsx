import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { usePrivilegedFailureReporter } from "@/hooks/privileged-failure";
import { supabase } from "@/lib/supabase";
import { reverifyTotp } from "@/lib/totp-reverify";
import { useTranslations } from "use-intl";
import { useLocaleCode } from "@/i18n/useFormat";

// Recuperaciones EXCEPCIONALES de MFA (Developer Panel V1). Solo se listan las solicitudes de un Admin
// que es el único administrador elegible; cualquier otra la aprueba otro Admin por el flujo normal.
// Esta pantalla PRESENTA y envía la decisión: la elegibilidad, la titularidad, el estado, la vigencia y
// la recencia del TOTP (≤ 5 min) los decide el SERVIDOR en cada operación, y la base de datos revalida
// todo bajo el lock de roles. Ocultar o mostrar controles NO es una frontera de seguridad.
//
// "Autorización reforzada": antes de aprobar, rechazar o reenviar el aviso se pide el código del
// autenticador y se verifica en esta página (challenge + verify) para obtener un TOTP recién verificado.
// El código se usa solo con Supabase Auth; nunca se envía a nuestros endpoints ni se guarda.
//   GET  /api/admin/developer-mfa-recoveries → { recoveries: [...] }
//   POST /api/admin/developer-mfa-recoveries → { op: approve|deny|resend_notice, recovery_id, reason? }

const ENDPOINT = "/api/admin/developer-mfa-recoveries";

const SECONDARY =
  "inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50";
const FIELD =
  "rounded-md border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary";

interface Item {
  id: string;
  username: string | null;
  role: string | null;
  status: string;
  requested_at: string | null;
  email_verified_at: string | null;
  approved_at: string | null;
  approval_kind: string | null;
  approver_username: string | null;
  notice_state: string | null;
  readiness: string | null;
  eligible: boolean;
  closed_reason: string | null;
}

type Op = "approve" | "deny" | "resend_notice";
interface Pending {
  id: string;
  op: Op;
}

// Mensajes como marcadores `i18n:<clave>`; se traducen al renderizar.
const MSG_SESSION = "i18n:session";
const MSG_LIST = "i18n:listError";

interface Cooldown {
  ready: boolean;
  ready_at: string | null;
  remaining_seconds: number;
  cooldown_minutes: number;
}

function parseCooldown(raw: unknown): Cooldown | null {
  const c = (raw as { cooldown?: Record<string, unknown> } | null)?.cooldown;
  if (!c || typeof c.ready !== "boolean" || typeof c.remaining_seconds !== "number")
    return null;
  return {
    ready: c.ready,
    ready_at: typeof c.ready_at === "string" ? c.ready_at : null,
    remaining_seconds: c.remaining_seconds,
    cooldown_minutes: typeof c.cooldown_minutes === "number" ? c.cooldown_minutes : 0,
  };
}

type RecoveriesT = ReturnType<typeof useTranslations<"developer.recoveries">>;

function formatRemaining(seconds: number, t: RecoveriesT): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return t("minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const h = t("hours", { count: hours });
  return rest === 0
    ? h
    : t("hoursAndMinutes", { hours: h, minutes: t("minutes", { count: rest }) });
}

function formatTime(value: string, locale: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

function formatDate(value: string | null, locale: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

function parse(raw: unknown): Item[] | null {
  const list = (raw as { recoveries?: unknown } | null)?.recoveries;
  if (!Array.isArray(list)) return null;
  const out: Item[] = [];
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  for (const r of list as Record<string, unknown>[]) {
    if (!r || typeof r.id !== "string" || typeof r.status !== "string") return null;
    out.push({
      id: r.id,
      username: str(r.username),
      role: str(r.role),
      status: r.status,
      requested_at: str(r.requested_at),
      email_verified_at: str(r.email_verified_at),
      approved_at: str(r.approved_at),
      approval_kind: str(r.approval_kind),
      approver_username: str(r.approver_username),
      notice_state: str(r.notice_state),
      readiness: str(r.readiness),
      eligible: r.eligible === true,
      closed_reason: str(r.closed_reason),
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

export default function DeveloperRecoveriesSection() {
  const t = useTranslations("developer.recoveries");
  const locale = useLocaleCode();
  const label = (
    group: "status" | "notice" | "codes" | "reverify",
    key: string,
  ): string | null => {
    const path = `${group}.${key}`;
    return t.has(path as never) ? (t as unknown as (k: string) => string)(path) : null;
  };
  const resolveMessage = (message: string): string =>
    message.startsWith("i18n:")
      ? (t as unknown as (k: string) => string)(`msg.${message.slice(5)}`)
      : message;

  const headingId = useId();
  const reportFailure = usePrivilegedFailureReporter();
  const [items, setItems] = useState<Item[] | null>(null);
  const [cooldown, setCooldown] = useState<{ value: Cooldown; loadedAt: number } | null>(
    null,
  );
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [code, setCode] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
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
        setError(MSG_LIST);
        return;
      }
      const json: unknown = await response.json().catch(() => null);
      const parsed = parse(json);
      if (!current()) return;
      if (!parsed) {
        setError(MSG_LIST);
        return;
      }
      setError(null);
      setItems(parsed);
      const cd = parseCooldown(json);
      setCooldown(cd ? { value: cd, loadedAt: Date.now() } : null);
      setNow(Date.now());
    } catch {
      if (current()) setError(MSG_LIST);
    }
  }, [reportFailure]);

  useEffect(() => {
    void load();
  }, [load]);

  // Segundos restantes de la espera según el último dato del servidor (nunca por debajo de 0).
  const remaining = cooldown
    ? Math.max(
        0,
        cooldown.value.remaining_seconds - Math.floor((now - cooldown.loadedAt) / 1000),
      )
    : 0;
  const waiting = cooldown !== null && !cooldown.value.ready && remaining > 0;
  useEffect(() => {
    if (!waiting) return;
    // Solo mientras dura la espera: refresca el contador y, al terminar, confirma con el servidor.
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, [waiting]);
  const finished = cooldown !== null && !cooldown.value.ready && remaining === 0;
  useEffect(() => {
    if (finished) void load();
  }, [finished, load]);

  const close = () => {
    setPending(null);
    setCode("");
    setReason("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!pending || lock.current) return;
    if (pending.op === "deny" && reason.trim().length === 0) {
      setActionError(t("codes.reason_required"));
      return;
    }
    lock.current = true;
    setBusy(true);
    setNotice(null);
    setActionError(null);
    try {
      // 1) TOTP recién verificado (≤ 5 min para el servidor). El código no se envía a nuestros endpoints.
      const verified = await reverifyTotp(code);
      if (!mounted.current) return;
      if (verified !== "ok") {
        setActionError(label("reverify", verified) ?? t("generic"));
        return;
      }
      setCode("");
      // 2) La decisión, con el token nuevo. El servidor revalida rol, capacidad y recencia.
      const jwt = await token();
      if (!jwt) {
        setActionError(t("msg.session"));
        return;
      }
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          op: pending.op,
          recovery_id: pending.id,
          ...(pending.op === "deny" ? { reason: reason.trim() } : {}),
        }),
      });
      if (!mounted.current) return;
      if (!response.ok) {
        reportFailure(response);
        const body = (await response.json().catch(() => null)) as {
          code?: unknown;
        } | null;
        const key = typeof body?.code === "string" ? body.code : "";
        setActionError(label("codes", key) ?? t("generic"));
        if ([404, 409, 410].includes(response.status) && key !== "reminder_limit") {
          close();
          void load();
        }
        return;
      }
      const body = (await response.json().catch(() => null)) as {
        notice?: { status?: string };
        reminder?: { status?: string };
      } | null;
      const failedNotice =
        body?.notice?.status === "failed" || body?.reminder?.status === "failed";
      const wasDelivered =
        pending.op === "resend_notice" &&
        (items ?? []).find((i) => i.id === pending.id)?.notice_state === "delivered";
      const done = wasDelivered ? t("done.reminder") : t(`done.${pending.op}`);
      setNotice(failedNotice ? `${done} ${t("failedNotice")}` : done);
      close();
      void load();
    } catch {
      if (mounted.current) setActionError(t("generic"));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const eligible = (items ?? []).filter((i) => i.eligible);
  const history = (items ?? []).filter((i) => !i.eligible);

  const form = (i: Item, name: string) =>
    pending?.id === i.id ? (
      <form className="mt-3 flex flex-col gap-2" onSubmit={(e) => void submit(e)}>
        <p className="text-sm text-text-secondary">
          {t("confirmWith", { action: t(`action.${pending.op}`, { name }) })}
        </p>
        {pending.op === "deny" ? (
          <>
            <label className="text-sm text-text-secondary" htmlFor={`reason-${i.id}`}>
              {t("reasonLabel")}
            </label>
            <input
              id={`reason-${i.id}`}
              value={reason}
              maxLength={200}
              onChange={(e) => setReason(e.target.value)}
              className={FIELD}
            />
          </>
        ) : null}
        <label className="text-sm text-text-secondary" htmlFor={`totp-${i.id}`}>
          {t("totpLabel")}
        </label>
        <input
          id={`totp-${i.id}`}
          value={code}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          className={FIELD}
        />
        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            className={SECONDARY}
            disabled={busy || code.length !== 6}
          >
            {busy ? t("verifying") : t("confirm")}
          </button>
          <button type="button" className={SECONDARY} disabled={busy} onClick={close}>
            {t("cancel")}
          </button>
        </div>
      </form>
    ) : null;

  const open = (id: string, op: Op) => {
    setNotice(null);
    setActionError(null);
    setCode("");
    setReason("");
    setPending(pending?.id === id && pending.op === op ? null : { id, op });
  };

  return (
    <section
      aria-labelledby={headingId}
      className="mt-8"
      data-testid="developer-recoveries"
    >
      <h2 id={headingId} className="font-display text-xl tracking-wide text-text-primary">
        {t("heading")}
      </h2>
      <p className="mt-2 text-sm text-text-secondary">{t("intro")}</p>
      {waiting ? (
        <p
          role="status"
          className="mt-3 text-sm text-text-secondary"
          data-testid="developer-cooldown"
        >
          {t("cooldown", {
            remaining: formatRemaining(remaining, t),
            at: cooldown?.value.ready_at
              ? ` ${t("atTime", { time: formatTime(cooldown.value.ready_at, locale) })}`
              : "",
          })}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-3 text-sm text-accent-success">
          {notice}
        </p>
      ) : null}
      {actionError ? (
        <p role="alert" className="mt-3 text-sm text-accent-live">
          {actionError}
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
            {t("pendingHeading", { count: eligible.length })}
          </h3>
          {eligible.length === 0 ? (
            <p className="mt-2 text-sm text-text-secondary">{t("noEligible")}</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-3">
              {eligible.map((i) => {
                const name = i.username ? `@${i.username}` : t("noProfile");
                return (
                  <li key={i.id} className="rounded-md border border-border-subtle p-4">
                    <p className="font-semibold text-text-primary">
                      {name} · {i.role ?? "—"}
                    </p>
                    <p className="mt-1 text-sm text-text-secondary">
                      {label("status", i.status) ?? i.status}
                      {i.email_verified_at ? ` · ${t("emailVerified")}` : ""} ·{" "}
                      {t("requestedOn", { date: formatDate(i.requested_at, locale) })}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-3">
                      <button
                        type="button"
                        disabled={busy || waiting}
                        className={SECONDARY}
                        aria-label={t("approveAria", { name })}
                        onClick={() => open(i.id, "approve")}
                      >
                        {t("approveButton")}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        className={SECONDARY}
                        aria-label={t("rejectAria", { name })}
                        onClick={() => open(i.id, "deny")}
                      >
                        {t("reject")}
                      </button>
                    </div>
                    {form(i, name)}
                  </li>
                );
              })}
            </ul>
          )}

          <h3 className="mt-6 text-sm font-semibold text-text-primary">
            {t("historyHeading", { count: history.length })}
          </h3>
          {history.length === 0 ? (
            <p className="mt-2 text-sm text-text-secondary">{t("noHistory")}</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-3">
              {history.map((i) => {
                const name = i.username ? `@${i.username}` : t("noProfile");
                const exceptionalApproved =
                  i.status === "approved" && i.approval_kind === "exceptional";
                return (
                  <li key={i.id} className="rounded-md border border-border-subtle p-4">
                    <p className="font-semibold text-text-primary">
                      {name} · {i.role ?? "—"}
                    </p>
                    <p className="mt-1 text-sm text-text-secondary">
                      {label("status", i.status) ?? i.status}
                      {i.approval_kind === "exceptional"
                        ? ` · ${
                            i.approver_username
                              ? t("exceptionalApprovalBy", {
                                  approver: i.approver_username,
                                  date: formatDate(i.approved_at, locale),
                                })
                              : t("exceptionalApproval", {
                                  date: formatDate(i.approved_at, locale),
                                })
                          }`
                        : ""}
                      {i.closed_reason === "denied_by_developer"
                        ? ` · ${t("deniedByDeveloper")}`
                        : ""}
                      {exceptionalApproved
                        ? ` · ${i.notice_state ? (label("notice", i.notice_state) ?? i.notice_state) : t("noticeUnregistered")}`
                        : ""}
                    </p>
                    {exceptionalApproved ? (
                      <div className="mt-3 flex flex-wrap gap-3">
                        <button
                          type="button"
                          disabled={busy}
                          className={SECONDARY}
                          aria-label={t("resendAria", { name })}
                          onClick={() => open(i.id, "resend_notice")}
                        >
                          {t("resend")}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          className={SECONDARY}
                          aria-label={t("revertAria", { name })}
                          onClick={() => open(i.id, "deny")}
                        >
                          {t("revert")}
                        </button>
                      </div>
                    ) : null}
                    {form(i, name)}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}
