import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { usePrivilegedFailureReporter } from "@/hooks/privileged-failure";
import { supabase } from "@/lib/supabase";
import { reverifyTotp, type ReverifyResult } from "@/lib/totp-reverify";

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

const STATUS_LABEL: Record<string, string> = {
  pending_approval: "Pendiente de aprobación",
  approved: "Aprobada, en espera",
  executing: "Invalidando autenticador",
  factors_deleted: "Autenticador invalidado, falta registrar el nuevo",
  completed: "Completada",
  denied: "Rechazada",
  cancelled: "Cancelada",
  expired: "Caducada",
};
const NOTICE_LABEL: Record<string, string> = {
  pending: "aviso pendiente de envío",
  accepted: "aviso enviado, sin confirmar entrega",
  delivered: "aviso entregado",
  failed: "aviso NO entregado",
};
const REVERIFY_ERRORS: Record<Exclude<ReverifyResult, "ok">, string> = {
  invalid_format: "Introduce el código de 6 dígitos de tu autenticador.",
  no_factor: "No encontramos un autenticador verificado en tu cuenta.",
  invalid_code: "Código incorrecto o expirado.",
  failed: "No se pudo verificar el código. Inténtalo de nuevo.",
};
const CODE_ERRORS: Record<string, string> = {
  cooldown_active:
    "Todavía no puedes aprobar: tu cuenta se convirtió en Developer hace poco. Actualizamos el tiempo restante.",
  peer_available:
    "Ahora existe otro administrador elegible: esta solicitud debe aprobarla otro administrador. Actualizamos la lista.",
  not_eligible: "Esta solicitud no admite aprobación excepcional. Actualizamos la lista.",
  self_approval: "No puedes decidir sobre tu propia recuperación.",
  not_pending: "La solicitud ya no admite esta acción. Actualizamos la lista.",
  expired: "La solicitud caducó. Actualizamos la lista.",
  email_changed: "El correo de la cuenta cambió: la solicitud se canceló.",
  role_changed: "El rol de la cuenta cambió: la solicitud se canceló.",
  no_request: "Esta solicitud ya no está disponible. Actualizamos la lista.",
  reason_required: "Escribe el motivo del rechazo.",
  too_soon: "Espera al menos un minuto antes de enviar otro recordatorio.",
  reminder_limit: "Ya se enviaron los 3 recordatorios permitidos para esta solicitud.",
  notice_not_delivered:
    "El aviso original todavía no consta como entregado. Actualizamos la lista.",
  mail_unavailable: "El envío de correos no está disponible ahora mismo.",
};
const GENERIC = "No se pudo completar la operación. Inténtalo de nuevo.";
const DONE: Record<Op, string> = {
  approve: "Recuperación aprobada de forma excepcional.",
  deny: "Recuperación rechazada.",
  resend_notice: "Aviso reenviado.",
};

// Espera de seguridad tras convertirse en Developer: la calcula y exige el SERVIDOR (base de datos); aquí solo
// se MUESTRA el tiempo restante que informa el servidor en el momento de cargar.
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

function formatRemaining(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minuto" : "minutos"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const h = `${hours} ${hours === 1 ? "hora" : "horas"}`;
  return rest === 0 ? h : `${h} y ${rest} ${rest === 1 ? "minuto" : "minutos"}`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("es", { dateStyle: "medium", timeStyle: "short" });
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
      setError("Tu sesión ya no es válida. Inicia sesión de nuevo.");
      return;
    }
    try {
      const response = await fetch(ENDPOINT, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!current()) return;
      if (!response.ok) {
        reportFailure(response);
        setError("No se pudo cargar la lista de solicitudes.");
        return;
      }
      const json: unknown = await response.json().catch(() => null);
      const parsed = parse(json);
      if (!current()) return;
      if (!parsed) {
        setError("No se pudo cargar la lista de solicitudes.");
        return;
      }
      setError(null);
      setItems(parsed);
      const cd = parseCooldown(json);
      setCooldown(cd ? { value: cd, loadedAt: Date.now() } : null);
      setNow(Date.now());
    } catch {
      if (current()) setError("No se pudo cargar la lista de solicitudes.");
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
      setActionError(CODE_ERRORS.reason_required);
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
        setActionError(REVERIFY_ERRORS[verified]);
        return;
      }
      setCode("");
      // 2) La decisión, con el token nuevo. El servidor revalida rol, capacidad y recencia.
      const jwt = await token();
      if (!jwt) {
        setActionError("Tu sesión ya no es válida. Inicia sesión de nuevo.");
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
        setActionError(
          response.status === 403 && key === "step_up_required"
            ? "Tu verificación en dos pasos no es lo bastante reciente. Vuelve a introducir el código."
            : (CODE_ERRORS[key] ?? GENERIC),
        );
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
      const done = wasDelivered ? "Recordatorio enviado a la persona." : DONE[pending.op];
      setNotice(
        failedNotice
          ? `${done} Atención: el aviso a la persona no se pudo enviar; sin entrega confirmada no podrá ejecutarlo. Puedes reenviarlo.`
          : done,
      );
      close();
      void load();
    } catch {
      if (mounted.current) setActionError(GENERIC);
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
          Confirma con tu autenticador para{" "}
          {pending.op === "approve"
            ? `aprobar de forma excepcional la recuperación de ${name}`
            : pending.op === "deny"
              ? `rechazar la recuperación de ${name}`
              : `reenviar el aviso a ${name}`}
          .
        </p>
        {pending.op === "deny" ? (
          <>
            <label className="text-sm text-text-secondary" htmlFor={`reason-${i.id}`}>
              Motivo del rechazo
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
          Código del autenticador
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
            {busy ? "Verificando…" : "Confirmar"}
          </button>
          <button type="button" className={SECONDARY} disabled={busy} onClick={close}>
            Cancelar
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
        Recuperaciones excepcionales
      </h2>
      <p className="mt-2 text-sm text-text-secondary">
        Solicitudes de un administrador que es el único administrador elegible. Aprueba
        solo si reconoces la petición por otro canal; no puedes decidir sobre la tuya. Si
        existe otro administrador elegible, la solicitud desaparece de esta lista y la
        aprueba él.
      </p>
      {waiting ? (
        <p
          role="status"
          className="mt-3 text-sm text-text-secondary"
          data-testid="developer-cooldown"
        >
          Acabas de convertirte en Developer. Por seguridad, podrás aprobar recuperaciones
          excepcionales dentro de {formatRemaining(remaining)}
          {cooldown?.value.ready_at
            ? ` (a las ${formatTime(cooldown.value.ready_at)})`
            : ""}
          . Mientras tanto puedes revisarlas y rechazarlas.
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
          {error}
        </p>
      ) : null}
      {items && !error ? (
        <>
          <h3 className="mt-4 text-sm font-semibold text-text-primary">
            Pendientes de decisión ({eligible.length})
          </h3>
          {eligible.length === 0 ? (
            <p className="mt-2 text-sm text-text-secondary">
              No hay solicitudes elegibles para aprobación excepcional.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-3">
              {eligible.map((i) => {
                const name = i.username ? `@${i.username}` : "Cuenta sin perfil";
                return (
                  <li key={i.id} className="rounded-md border border-border-subtle p-4">
                    <p className="font-semibold text-text-primary">
                      {name} · {i.role ?? "—"}
                    </p>
                    <p className="mt-1 text-sm text-text-secondary">
                      {STATUS_LABEL[i.status] ?? i.status}
                      {i.email_verified_at ? " · correo verificado" : ""} · solicitada{" "}
                      {formatDate(i.requested_at)}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-3">
                      <button
                        type="button"
                        disabled={busy || waiting}
                        className={SECONDARY}
                        aria-label={`Aprobar de forma excepcional la recuperación de ${name}`}
                        onClick={() => open(i.id, "approve")}
                      >
                        Aprobar excepcionalmente
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        className={SECONDARY}
                        aria-label={`Rechazar la recuperación de ${name}`}
                        onClick={() => open(i.id, "deny")}
                      >
                        Rechazar
                      </button>
                    </div>
                    {form(i, name)}
                  </li>
                );
              })}
            </ul>
          )}

          <h3 className="mt-6 text-sm font-semibold text-text-primary">
            Historial ({history.length})
          </h3>
          {history.length === 0 ? (
            <p className="mt-2 text-sm text-text-secondary">Sin decisiones recientes.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-3">
              {history.map((i) => {
                const name = i.username ? `@${i.username}` : "Cuenta sin perfil";
                const exceptionalApproved =
                  i.status === "approved" && i.approval_kind === "exceptional";
                return (
                  <li key={i.id} className="rounded-md border border-border-subtle p-4">
                    <p className="font-semibold text-text-primary">
                      {name} · {i.role ?? "—"}
                    </p>
                    <p className="mt-1 text-sm text-text-secondary">
                      {STATUS_LABEL[i.status] ?? i.status}
                      {i.approval_kind === "exceptional"
                        ? ` · aprobación excepcional${i.approver_username ? ` de @${i.approver_username}` : ""} (${formatDate(i.approved_at)})`
                        : ""}
                      {i.closed_reason === "denied_by_developer"
                        ? " · rechazada por un Developer"
                        : ""}
                      {exceptionalApproved
                        ? ` · ${i.notice_state ? NOTICE_LABEL[i.notice_state] : "aviso no registrado"}`
                        : ""}
                    </p>
                    {exceptionalApproved ? (
                      <div className="mt-3 flex flex-wrap gap-3">
                        <button
                          type="button"
                          disabled={busy}
                          className={SECONDARY}
                          aria-label={`Reenviar el aviso a ${name}`}
                          onClick={() => open(i.id, "resend_notice")}
                        >
                          Reenviar aviso
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          className={SECONDARY}
                          aria-label={`Revertir la aprobación de ${name}`}
                          onClick={() => open(i.id, "deny")}
                        >
                          Revertir aprobación
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
