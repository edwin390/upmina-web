import { useId, useRef, useState, type FormEvent } from "react";
import { usePrivilegedFailureReporter } from "@/hooks/privileged-failure";
import { supabase } from "@/lib/supabase";
import { reverifyTotp } from "@/lib/totp-reverify";
import { useTranslations } from "use-intl";

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
const TARGETS: readonly Target[] = ["moderator", "admin"];
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
  const t = useTranslations("admin.restore");
  const text = (group: "codes" | "reverify", key: string): string | null => {
    const path = `${group}.${key}`;
    return t.has(path as never) ? (t as unknown as (k: string) => string)(path) : null;
  };
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
        setError(text("reverify", verified) ?? t("generic"));
        return;
      }
      setCode("");
      const jwt = await token();
      if (!jwt) {
        setError(t("session"));
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
          onRestored(t("restored", { name, role: t(`role.${target}`) }));
          return;
        }
        // Nunca se afirma que el autenticador se invalidó si la limpieza está pendiente o no se sabe.
        const mfa = ok?.mfa_reset?.status;
        const mfaText =
          mfa === "completed"
            ? ` ${t("mfaCompleted")}`
            : mfa === "pending"
              ? ` ${t("mfaPending")}`
              : "";
        const lastText = ok?.last_developer === true ? ` ${t("lastDeveloperLeft")}` : "";
        onRestored(`${t("removed", { name })}${mfaText}${lastText}`, true);
        return;
      }
      reportFailure(response);
      const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
      const key = typeof body?.code === "string" ? body.code : "";
      setError(text("codes", key) ?? t("generic"));
      if (key === "not_developer" || key === "not_found") onStale();
    } catch {
      setError(t("generic"));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="mt-3">
      <p className="text-xs text-text-muted">{t("isDeveloper")}</p>
      {target === null ? (
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <div className="min-w-0 sm:w-56">
            <label
              htmlFor={selectId}
              className="block text-sm font-medium text-text-primary"
            >
              {t("newRole")}
            </label>
            <select
              id={selectId}
              value={selected}
              disabled={disabled}
              onChange={(e) => {
                const value = e.target.value;
                setSelected(TARGETS.find((r) => r === value) ?? "");
              }}
              className={`${FIELD} mt-1`}
            >
              <option value="">{t("chooseRole")}</option>
              {TARGETS.map((r) => (
                <option key={r} value={r}>
                  {t(`role.${r}`).toUpperCase()}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            disabled={disabled || selected === ""}
            className={SECONDARY}
            aria-label={t("applyAria", { name })}
            onClick={() => {
              if (selected !== "") setTarget(selected);
            }}
          >
            {t("apply")}
          </button>
          <button
            type="button"
            disabled={disabled}
            className={DANGER}
            aria-label={t("removeAria", { name })}
            onClick={() => setTarget("remove")}
          >
            {t("removeAccess")}
          </button>
        </div>
      ) : (
        <form
          role="group"
          aria-label={
            target === "remove"
              ? t("confirmRemoveGroup", { name })
              : t("confirmRestoreGroup", { name })
          }
          className="mt-2 flex flex-col gap-2 rounded-md border border-border-subtle p-3"
          onSubmit={(e) => void submit(e)}
        >
          {target === "remove" ? (
            <>
              <p className="text-sm text-text-primary">{t("confirmRemove", { name })}</p>
              {isLastDeveloper ? (
                <p role="note" className="text-sm font-semibold text-accent-live">
                  {t("lastDeveloper")}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-text-primary">
              {t("confirmRestore", { name, role: t(`role.${target}`) })}
            </p>
          )}
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
              className={SECONDARY}
              disabled={busy || code.length !== 6}
            >
              {busy
                ? t("checking")
                : target === "remove"
                  ? t("yesRemove")
                  : t("yesRestore")}
            </button>
            <button type="button" className={SECONDARY} disabled={busy} onClick={close}>
              {t("cancel")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
