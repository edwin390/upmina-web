import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ADMIN_ACCESS_QUERY_ROOT } from "@/hooks/useAdminAccess";
import { usePrivilegedFailureReporter } from "@/hooks/privileged-failure";
import { supabase } from "@/lib/supabase";
import { reverifyTotp } from "@/lib/totp-reverify";
import { useTranslations } from "use-intl";

// «Convertirme en Developer» (Developer Panel V1). Un Admin puede transferir SU PROPIA cuenta a Developer;
// no existe ninguna forma de asignar Developer a otra persona. Solo PRESENTA y envía la decisión: que haya
// otro Admin elegible, que no haya recuperaciones activas, el bloqueo de roles y el último Admin los decide
// el SERVIDOR en la base de datos. Ocultar o deshabilitar el botón NO es una frontera de seguridad.
//
// Confirmación: aceptación explícita de la pérdida de acceso Admin + código del autenticador. El código se
// verifica con Supabase Auth en esta página (TOTP recién verificado, ≤ 5 min para el servidor) y nunca se
// envía a nuestros endpoints ni se guarda.
//   GET  /api/admin/team-developer-transfer → { eligible, reason }
//   POST /api/admin/team-developer-transfer → { acknowledge: true }

const ENDPOINT = "/api/admin/team-developer-transfer";
const DEVELOPER_PATH = "/admin/developer";

const PRIMARY =
  "inline-flex min-h-11 items-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold text-text-inverse transition-colors duration-200 ease-smooth hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50";
const SECONDARY =
  "inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50";
const FIELD =
  "w-full rounded-md border border-border-subtle bg-bg-base px-3 py-2 text-text-primary outline-none focus:border-accent-secondary focus-visible:ring-2 focus-visible:ring-accent-secondary";

type Eligibility =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "blocked"; reason: "no_eligible_peer" | "recovery_in_progress" }
  | { kind: "error" };

async function token(): Promise<string | null> {
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

export default function BecomeDeveloperSection() {
  const t = useTranslations("admin.becomeDev");
  const headingId = useId();
  const checkId = useId();

  const codeId = useId();
  const reasonId = useId();
  const reportFailure = usePrivilegedFailureReporter();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [state, setState] = useState<Eligibility>({ kind: "loading" });
  const [open, setOpen] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const mounted = useRef(true);
  const request = useRef(0);
  const checkRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const mine = ++request.current;
    const current = () => mounted.current && request.current === mine;
    setState({ kind: "loading" });
    const jwt = await token();
    if (!current()) return;
    if (!jwt) {
      setState({ kind: "error" });
      return;
    }
    try {
      const response = await fetch(ENDPOINT, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!current()) return;
      if (!response.ok) {
        reportFailure(response);
        setState({ kind: "error" });
        return;
      }
      const body = (await response.json().catch(() => null)) as {
        eligible?: unknown;
        reason?: unknown;
      } | null;
      if (!current()) return;
      if (body?.eligible === true && body.reason === "ok") {
        setState({ kind: "ready" });
      } else if (
        body?.eligible === false &&
        (body.reason === "no_eligible_peer" || body.reason === "recovery_in_progress")
      ) {
        setState({ kind: "blocked", reason: body.reason });
      } else {
        setState({ kind: "error" });
      }
    } catch {
      if (current()) setState({ kind: "error" });
    }
  }, [reportFailure]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (open) checkRef.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setAccepted(false);
    setCode("");
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (lock.current || !accepted) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      // 1) TOTP recién verificado (el código no se envía a nuestros endpoints).
      const verified = await reverifyTotp(code);
      if (!mounted.current) return;
      if (verified !== "ok") {
        setError(t(`reverify.${verified}`));
        return;
      }
      setCode("");
      const jwt = await token();
      if (!jwt) {
        setError(t("session"));
        return;
      }
      // 2) La transferencia: el cuerpo solo lleva la aceptación; la cuenta es SIEMPRE la del token.
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledge: true }),
      });
      if (!mounted.current) return;
      if (response.ok) {
        // El acceso Admin termina YA: se descarta la caché de permisos y se entra al panel Developer.
        queryClient.removeQueries({ queryKey: [ADMIN_ACCESS_QUERY_ROOT] });
        navigate(DEVELOPER_PATH, { replace: true });
        return;
      }
      reportFailure(response);
      const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
      const key = typeof body?.code === "string" ? body.code : "";
      if (key === "no_eligible_peer" || key === "recovery_in_progress") {
        setState({ kind: "blocked", reason: key });
        close();
        return;
      }
      setError(
        response.status === 403 && key === "step_up_required"
          ? t("stepUp")
          : t("generic"),
      );
    } catch {
      if (mounted.current) setError(t("generic"));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <section aria-labelledby={headingId} className="mt-8" data-testid="become-developer">
      <h2 id={headingId} className="font-display text-xl tracking-wide text-text-primary">
        {t("heading")}
      </h2>
      <p className="mt-2 text-sm text-text-secondary">{t("intro")}</p>

      {state.kind === "blocked" ? (
        <p
          id={reasonId}
          role="status"
          className="mt-3 text-sm text-text-secondary"
          data-testid="become-developer-reason"
        >
          {t(`blocked.${state.reason}`)}
        </p>
      ) : null}
      {state.kind === "error" ? (
        <p role="alert" className="mt-3 text-sm text-accent-live">
          {t("checkError")}{" "}
          <button type="button" className="underline" onClick={() => void load()}>
            {t("retry")}
          </button>
        </p>
      ) : null}

      {!open ? (
        <button
          type="button"
          className={`mt-4 ${PRIMARY}`}
          disabled={state.kind !== "ready"}
          aria-describedby={state.kind === "blocked" ? reasonId : undefined}
          onClick={() => setOpen(true)}
        >
          {t("heading")}
        </button>
      ) : (
        <form
          role="group"
          aria-label={t("confirmGroup")}
          className="mt-4 flex flex-col gap-3 rounded-md border border-border-subtle p-4"
          onSubmit={(e) => void submit(e)}
        >
          <p className="text-sm text-text-primary">{t("warning")}</p>
          <label
            htmlFor={checkId}
            className="flex items-start gap-2 text-sm text-text-secondary"
          >
            <input
              id={checkId}
              ref={checkRef}
              type="checkbox"
              checked={accepted}
              disabled={busy}
              onChange={(e) => setAccepted(e.target.checked)}
              className="mt-1"
            />
            <span>{t("ack")}</span>
          </label>
          <label htmlFor={codeId} className="text-sm text-text-secondary">
            {t("codeLabel")}
          </label>
          <input
            id={codeId}
            value={code}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            disabled={busy}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            className={FIELD}
          />
          {error ? (
            <p role="alert" className="text-sm text-accent-live">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              className={PRIMARY}
              disabled={busy || !accepted || code.length !== 6}
            >
              {busy ? t("checking") : t("confirm")}
            </button>
            <button type="button" className={SECONDARY} disabled={busy} onClick={close}>
              {t("cancel")}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
