import { useId, useRef, useState, type FormEvent } from "react";
import { usePrivilegedFailureReporter } from "@/hooks/privileged-failure";
import { supabase } from "@/lib/supabase";
import { reverifyTotp, type ReverifyResult } from "@/lib/totp-reverify";

// Controles de UN Developer en la gestión del equipo: otro Admin lo devuelve a Moderador o a Admin con el mismo
// selector «Nuevo rol» + «Aplicar» que las demás cuentas, confirmación y código del autenticador. También puede
// quitarle el acceso al equipo («Quitar acceso»): se retira su verificación en dos pasos del acceso de equipo (misma
// política que Admin y Moderator, con reintento si falla) y la cuenta personal se conserva. Solo PRESENTA y envía la decisión: el servidor exige Admin con
// TOTP ≤ 5 min y la base de datos revalida (objetivo Developer, sin recuperación activa, TOTP verificado para
// volver a Admin) y audita. Nunca existe una acción para convertir a alguien EN Developer.
//   POST /api/admin/team-developer-restore → { user_id, role: "admin" | "moderator" }
//   POST /api/admin/team-developer-remove  → { user_id }

const ENDPOINT = "/api/admin/team-developer-restore";
const REMOVE_ENDPOINT = "/api/admin/team-developer-remove";

const SECONDARY =
  "inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50";
const DANGER =
  "inline-flex min-h-11 items-center rounded-md border border-accent-live/60 px-5 py-2.5 text-sm font-semibold text-accent-live transition-colors duration-200 ease-smooth hover:bg-accent-live/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-live disabled:pointer-events-none disabled:opacity-50";
const FIELD =
  "w-full rounded-md border border-border-subtle bg-bg-base px-3 py-2 text-text-primary outline-none focus:border-accent-secondary focus-visible:ring-2 focus-visible:ring-accent-secondary";

type Target = "moderator" | "admin";
type Action = Target | "remove";
const LABEL: Record<Target, string> = { moderator: "Moderador", admin: "Admin" };
const REVERIFY_ERRORS: Record<Exclude<ReverifyResult, "ok">, string> = {
  invalid_format: "Introduce el código de 6 dígitos de tu app autenticadora.",
  no_factor: "No encontramos una app autenticadora verificada en tu cuenta.",
  invalid_code: "Código incorrecto o expirado.",
  failed: "No se pudo verificar el código. Inténtalo de nuevo.",
};
const TARGETS: readonly Target[] = ["moderator", "admin"];
const CODE_ERRORS: Record<string, string> = {
  not_developer: "Esta persona ya no es Developer. Actualizamos la lista.",
  recovery_in_progress:
    "Esta persona tiene una recuperación de autenticador en curso. Inténtalo cuando termine.",
  mfa_not_enrolled:
    "Para volver a ser Admin necesita tener activada la verificación en dos pasos.",
  not_found: "Esta persona ya no está en el equipo. Actualizamos la lista.",
  approval_in_progress:
    "Esta persona aprobó una recuperación de autenticador que sigue en curso. Inténtalo cuando termine.",
  mfa_cleanup_pending:
    "Esta persona tiene una limpieza de autenticador pendiente. Resuélvela en «Autenticadores pendientes de restablecer».",
  recovery_depends_on_developer:
    "Hay una solicitud de recuperación de un Admin que solo esta persona puede aprobar. Resuélvela antes de quitarle el acceso.",
  not_allowed: "No puedes hacer este cambio sobre tu propia cuenta.",
};
const GENERIC = "No se pudo completar el cambio. Inténtalo de nuevo.";

async function token(): Promise<string | null> {
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

export default function DeveloperRestoreControls({
  userId,
  name,
  disabled = false,
  isLastDeveloper = false,
  onRestored,
  onStale,
}: {
  userId: string;
  name: string;
  disabled?: boolean;
  /** Es el único Developer del equipo: quitarle el acceso elimina la aprobación excepcional. */
  isLastDeveloper?: boolean;
  /** Tras restaurar o quitar el acceso: el contenedor muestra el aviso y relee la lista desde el servidor.
   *  `removed` = se quitó el acceso (puede haber cambiado la lista de limpiezas MFA). */
  onRestored: (message: string, removed?: boolean) => void;
  /** El servidor dice que la lista cambió (ya no es Developer, ya no existe…): se relee. */
  onStale: () => void;
}) {
  const codeId = useId();
  const selectId = useId();
  const reportFailure = usePrivilegedFailureReporter();
  const [selected, setSelected] = useState<Target | "">("");
  const [target, setTarget] = useState<Action | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);

  const close = () => {
    setSelected("");
    setTarget(null);
    setCode("");
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!target || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const verified = await reverifyTotp(code);
      if (verified !== "ok") {
        setError(REVERIFY_ERRORS[verified]);
        return;
      }
      setCode("");
      const jwt = await token();
      if (!jwt) {
        setError("Tu sesión ya no es válida. Inicia sesión de nuevo.");
        return;
      }
      const removing = target === "remove";
      const response = await fetch(removing ? REMOVE_ENDPOINT : ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify(
          removing ? { user_id: userId } : { user_id: userId, role: target },
        ),
      });
      if (response.ok) {
        const ok = (await response.json().catch(() => null)) as {
          last_developer?: unknown;
          mfa_reset?: { status?: unknown };
        } | null;
        close();
        if (!removing) {
          onRestored(`${name} vuelve a ser ${LABEL[target]}.`);
          return;
        }
        // Nunca se afirma que el autenticador se invalidó si la limpieza está pendiente o no se sabe.
        const mfa = ok?.mfa_reset?.status;
        const mfaText =
          mfa === "completed"
            ? " Su verificación en dos pasos asociada al acceso de equipo también quedó retirada."
            : mfa === "pending"
              ? " Atención: el acceso se retiró, pero su verificación en dos pasos todavía no se pudo retirar. Puedes reintentarlo en «Autenticadores pendientes de restablecer»."
              : "";
        const lastText =
          ok?.last_developer === true
            ? " Ya no queda ningún Developer: las recuperaciones excepcionales no tendrán quien las apruebe."
            : "";
        onRestored(`${name} ya no tiene acceso al equipo.${mfaText}${lastText}`, true);
        return;
      }
      reportFailure(response);
      const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
      const key = typeof body?.code === "string" ? body.code : "";
      setError(
        response.status === 403 && key === "step_up_required"
          ? "Tu verificación en dos pasos no es lo bastante reciente. Vuelve a introducir el código."
          : (CODE_ERRORS[key] ?? GENERIC),
      );
      if (key === "not_developer" || key === "not_found") onStale();
    } catch {
      setError(GENERIC);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="mt-3">
      <p className="text-xs text-text-muted">
        Esta persona es Developer. Solo otro Admin puede devolverle un rol de equipo o
        quitarle el acceso.
      </p>
      {target === null ? (
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <div className="min-w-0 sm:w-56">
            <label
              htmlFor={selectId}
              className="block text-sm font-medium text-text-primary"
            >
              Nuevo rol
            </label>
            <select
              id={selectId}
              value={selected}
              disabled={disabled}
              onChange={(e) => {
                const value = e.target.value;
                setSelected(TARGETS.find((t) => t === value) ?? "");
              }}
              className={`${FIELD} mt-1`}
            >
              <option value="">Elegir rol…</option>
              {TARGETS.map((t) => (
                <option key={t} value={t}>
                  {LABEL[t].toUpperCase()}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            disabled={disabled || selected === ""}
            className={SECONDARY}
            aria-label={`Aplicar cambio de rol a ${name}`}
            onClick={() => {
              if (selected !== "") setTarget(selected);
            }}
          >
            Aplicar
          </button>
          <button
            type="button"
            disabled={disabled}
            className={DANGER}
            aria-label={`Quitar acceso a ${name}`}
            onClick={() => setTarget("remove")}
          >
            Quitar acceso
          </button>
        </div>
      ) : (
        <form
          role="group"
          aria-label={
            target === "remove"
              ? `Confirmar quitar el acceso a ${name}`
              : `Confirmar la restauración de ${name}`
          }
          className="mt-2 flex flex-col gap-2 rounded-md border border-border-subtle p-3"
          onSubmit={(e) => void submit(e)}
        >
          {target === "remove" ? (
            <>
              <p className="text-sm text-text-primary">
                ¿Quitar el acceso al equipo de {name}? Perderá todos sus privilegios de
                equipo, incluido el panel Developer, y también se retirará la verificación
                en dos pasos asociada a ese acceso (tendrá que activar una nueva si vuelve
                al equipo). Su cuenta personal NO se elimina: conserva su perfil y su
                contenido.
              </p>
              {isLastDeveloper ? (
                <p role="note" className="text-sm font-semibold text-accent-live">
                  Es el único Developer. Sin Developer, si un Admin pierde su autenticador
                  y no hay otro Admin que pueda aprobarlo, nadie podrá aprobar esa
                  recuperación.
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-text-primary">
              ¿Devolver a {name} el rol de {LABEL[target]}? Dejará de ser Developer y
              perderá el acceso al panel Developer.
            </p>
          )}
          <label htmlFor={codeId} className="text-sm text-text-secondary">
            Código de tu app autenticadora
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
              className={SECONDARY}
              disabled={busy || code.length !== 6}
            >
              {busy
                ? "Comprobando…"
                : target === "remove"
                  ? "Sí, quitar acceso"
                  : "Sí, restaurar"}
            </button>
            <button type="button" className={SECONDARY} disabled={busy} onClick={close}>
              Cancelar
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
