import { useCallback, useEffect, useId, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

// Sección "Miembros del equipo" de /admin (Bloque 9F). Solo PRESENTACIÓN: el dashboard la monta
// únicamente cuando GET /api/admin/me declara la capacidad `team_admin`, pero la autoridad es
// siempre el servidor (JWT + AAL2 + team_admin en cada llamada, y la RPC reconfirma ADMIN). Ocultar
// controles aquí NO es una frontera de seguridad. Contrato que consume:
//   - GET  /api/admin/team-members         → { members: [{ user_id, role, granted_at, username,
//                                              display_name, email, is_self }] }.
//   - POST /api/admin/team-members-role    → { user_id, role } → 200 { user_id, role, previous_role,
//                                              changed_at, revoked_invitations }.
//   - POST /api/admin/team-members-remove  → { user_id } → 200 { user_id, previous_role, removed_at,
//                                              revoked_invitations }.
//     Errores: 401/403 (sesión/permiso), 404 (miembro inexistente), 409 (operación no permitida),
//     500 (genérico).
//
// Sin actualización optimista: tras un resultado del servidor (éxito, 404 o 409) el listado se
// vuelve a leer. Un solo mutador activo a la vez (guard síncrono). El email es un dato sensible del
// listado: solo vive en el estado del componente y nunca se registra ni se guarda.

export type MemberRole = "admin" | "moderator" | "developer";

export interface TeamMember {
  user_id: string;
  role: MemberRole;
  granted_at: string;
  username: string | null;
  display_name: string | null;
  email: string | null;
  is_self: boolean;
}

const LIST_ENDPOINT = "/api/admin/team-members";
const ROLE_ENDPOINT = "/api/admin/team-members-role";
const REMOVE_ENDPOINT = "/api/admin/team-members-remove";

const ROLES: readonly MemberRole[] = ["admin", "moderator", "developer"];

// El rol se comunica siempre con TEXTO (el color es solo un refuerzo).
const ROLE_LABEL: Record<MemberRole, string> = {
  admin: "ADMIN",
  moderator: "MODERADOR",
  developer: "DEVELOPER",
};

const ROLE_BADGE_CLASS: Record<MemberRole, string> = {
  admin: "border-accent-primary/60 text-accent-secondary",
  moderator: "border-accent-warning/60 text-accent-warning",
  developer: "border-accent-success/60 text-accent-success",
};

const MSG_SESSION = "Tu sesión ya no es válida. Inicia sesión de nuevo.";
const MSG_FORBIDDEN =
  "No se pudo autorizar esta acción. Comprueba tu verificación en dos pasos e inténtalo de nuevo.";
const MSG_LOAD = "No se pudieron cargar los miembros.";
const MSG_ROLE = "No pudimos cambiar el rol. Inténtalo de nuevo.";
const MSG_REMOVE = "No pudimos quitar el acceso. Inténtalo de nuevo.";
const MSG_GONE = "Este cambio ya no se puede aplicar. Actualizamos la lista.";
const MSG_ROLE_OK = "Rol actualizado.";
const MSG_REMOVE_OK = "Acceso quitado.";

const SECONDARY_BUTTON_CLASS =
  "inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50";

const DANGER_BUTTON_CLASS =
  "inline-flex min-h-11 items-center rounded-md border border-accent-live/60 px-5 py-2.5 text-sm font-semibold text-accent-live transition-colors duration-200 ease-smooth hover:bg-accent-live/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-live disabled:pointer-events-none disabled:opacity-50";

const FIELD_CLASS =
  "w-full rounded-md border border-border-subtle bg-bg-base px-3 py-2 text-text-primary outline-none focus:border-accent-secondary focus-visible:ring-2 focus-visible:ring-accent-secondary";

const isRole = (v: unknown): v is MemberRole =>
  typeof v === "string" && (ROLES as readonly string[]).includes(v);
const stringOrNull = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === "string" ? v : undefined;

/** Reconstruye un miembro campo a campo (lista blanca); null si la forma no es la esperada. */
function parseMember(raw: unknown): TeamMember | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const username = stringOrNull(r.username);
  const displayName = stringOrNull(r.display_name);
  const email = stringOrNull(r.email);
  if (
    typeof r.user_id !== "string" ||
    r.user_id.length === 0 ||
    !isRole(r.role) ||
    typeof r.granted_at !== "string" ||
    username === undefined ||
    displayName === undefined ||
    email === undefined ||
    typeof r.is_self !== "boolean"
  ) {
    return null;
  }
  return {
    user_id: r.user_id,
    role: r.role,
    granted_at: r.granted_at,
    username,
    display_name: displayName,
    email,
    is_self: r.is_self,
  };
}

function parseMembers(body: unknown): TeamMember[] | null {
  const list = (body as { members?: unknown } | null)?.members;
  if (!Array.isArray(list)) return null;
  const parsed: TeamMember[] = [];
  for (const item of list) {
    const member = parseMember(item);
    if (!member) return null;
    parsed.push(member);
  }
  return parsed;
}

/** Identidad principal: display_name, luego @username, luego "Cuenta sin perfil". */
function primaryIdentity(member: TeamMember): string {
  if (member.display_name) return member.display_name;
  if (member.username) return `@${member.username}`;
  return "Cuenta sin perfil";
}

/** Nombre para textos de acción; si no hay perfil se añade el email para que no sea ambiguo. */
function actionName(member: TeamMember): string {
  const name = primaryIdentity(member);
  const hasProfile = Boolean(member.display_name || member.username);
  return !hasProfile && member.email ? `${name} (${member.email})` : name;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("es", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
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

function actionMessage(status: number, generic: string): string {
  if (status === 401) return MSG_SESSION;
  if (status === 403) return MSG_FORBIDDEN;
  return generic;
}

function omitKey(
  map: Record<string, MemberRole>,
  key: string,
): Record<string, MemberRole> {
  const copy = { ...map };
  delete copy[key];
  return copy;
}

function revokedSuffix(body: unknown): string {
  const n = (body as { revoked_invitations?: unknown } | null)?.revoked_invitations;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) return "";
  return n === 1
    ? " Se revocó 1 invitación pendiente suya."
    : ` Se revocaron ${n} invitaciones pendientes suyas.`;
}

type ListState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; members: TeamMember[] };

type Confirmation =
  { id: string; kind: "role"; role: MemberRole } | { id: string; kind: "remove" };

export default function TeamMembersSection() {
  const headingId = useId();
  const baseId = useId();

  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [selectedRoles, setSelectedRoles] = useState<Record<string, MemberRole>>({});
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isMountedRef = useRef(true);
  const listRequestRef = useRef(0);
  const mutationLockRef = useRef(false);
  const listHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const triggerRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const restoreFocusKeyRef = useRef<string | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Foco de la confirmación: al abrirla va a "Cancelar" (opción segura); al cancelarla vuelve al
  // botón que la abrió. Ese botón desaparece mientras se confirma, así que sin esto el foco del
  // teclado se perdería.
  useEffect(() => {
    if (confirming) {
      cancelButtonRef.current?.focus();
    } else if (restoreFocusKeyRef.current) {
      triggerRefs.current.get(restoreFocusKeyRef.current)?.focus();
      restoreFocusKeyRef.current = null;
    }
  }, [confirming]);

  const loadList = useCallback(async (showLoading: boolean) => {
    const request = ++listRequestRef.current;
    const isCurrent = () => isMountedRef.current && listRequestRef.current === request;
    if (showLoading) setList({ kind: "loading" });

    const token = await getAccessToken();
    if (!isCurrent()) return;
    if (!token) {
      setList({ kind: "error", message: MSG_SESSION });
      return;
    }

    let response: Response;
    try {
      response = await fetch(LIST_ENDPOINT, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      if (isCurrent()) setList({ kind: "error", message: MSG_LOAD });
      return;
    }
    if (!isCurrent()) return;
    if (!response || typeof response.status !== "number") {
      setList({ kind: "error", message: MSG_LOAD });
      return;
    }
    if (!response.ok) {
      setList({ kind: "error", message: actionMessage(response.status, MSG_LOAD) });
      return;
    }
    const body: unknown = await response.json().catch(() => null);
    if (!isCurrent()) return;
    const members = parseMembers(body);
    setList(members ? { kind: "ready", members } : { kind: "error", message: MSG_LOAD });
  }, []);

  useEffect(() => {
    void loadList(true);
  }, [loadList]);

  const cancelConfirmation = () => {
    if (!confirming) return;
    restoreFocusKeyRef.current = `${confirming.id}:${confirming.kind}`;
    setConfirming(null);
  };

  const mutate = async (action: Confirmation) => {
    if (mutationLockRef.current) return; // guard síncrono: un solo mutador activo a la vez
    mutationLockRef.current = true;
    setBusyId(action.id);
    setRowError(null);
    setNotice(null);
    const isRoleChange = action.kind === "role";
    const generic = isRoleChange ? MSG_ROLE : MSG_REMOVE;

    try {
      const token = await getAccessToken();
      if (!token) {
        if (isMountedRef.current) setRowError({ id: action.id, message: MSG_SESSION });
        return;
      }
      const response = await fetch(isRoleChange ? ROLE_ENDPOINT : REMOVE_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          action.kind === "role"
            ? { user_id: action.id, role: action.role }
            : { user_id: action.id },
        ),
      });
      if (!isMountedRef.current) return;

      if (response.status === 200) {
        // Sin actualización optimista: se vuelve a leer lo que el servidor confirmó.
        const body: unknown = await response.json().catch(() => null);
        if (!isMountedRef.current) return;
        setConfirming(null);
        setSelectedRoles((prev) => omitKey(prev, action.id));
        setNotice(`${isRoleChange ? MSG_ROLE_OK : MSG_REMOVE_OK}${revokedSuffix(body)}`);
        listHeadingRef.current?.focus(); // la fila cambia o desaparece: el foco no se pierde
        void loadList(false);
        return;
      }
      if (response.status === 404 || response.status === 409) {
        setConfirming(null);
        listHeadingRef.current?.focus();
        setRowError({ id: action.id, message: MSG_GONE });
        void loadList(false);
        return;
      }
      setRowError({ id: action.id, message: actionMessage(response.status, generic) });
    } catch {
      if (isMountedRef.current) setRowError({ id: action.id, message: generic });
    } finally {
      mutationLockRef.current = false;
      if (isMountedRef.current) setBusyId(null);
    }
  };

  const confirmationText = (member: TeamMember, action: Confirmation): string => {
    const name = actionName(member);
    const losesAdmin =
      member.role === "admin" && !(action.kind === "role" && action.role === "admin");
    const invitations = losesAdmin
      ? " Sus invitaciones pendientes se revocarán y no se pueden recuperar."
      : "";
    if (action.kind === "remove") {
      return `¿Quitar el acceso al equipo de ${name}? La cuenta y el perfil NO se eliminan: solo pierde su acceso privilegiado.${invitations}`;
    }
    const gain = action.role === "admin" ? " Tendrá control total del equipo." : "";
    return `¿Cambiar el rol de ${name} de ${ROLE_LABEL[member.role]} a ${ROLE_LABEL[action.role]}?${gain}${invitations}`;
  };

  return (
    <section aria-labelledby={headingId} className="mt-8">
      <h2 id={headingId} className="font-display text-xl tracking-wide text-text-primary">
        Miembros del equipo
      </h2>
      <p className="mt-2 text-sm text-text-secondary">
        Personas con acceso privilegiado. Puedes cambiar el rol de otro miembro o quitarle
        el acceso; no puedes modificar el tuyo.
      </p>

      <h3
        ref={listHeadingRef}
        tabIndex={-1}
        className="mt-6 font-semibold text-text-primary focus-visible:outline-none"
      >
        Miembros actuales
      </h3>

      {notice ? (
        <p role="status" className="mt-3 text-sm text-accent-success">
          {notice}
        </p>
      ) : null}

      {list.kind === "loading" ? (
        <p className="mt-3 text-sm text-text-secondary" role="status">
          Cargando miembros…
        </p>
      ) : null}

      {list.kind === "error" ? (
        <div className="mt-3">
          <p role="alert" className="text-sm text-accent-live">
            {list.message}
          </p>
          <button
            type="button"
            onClick={() => void loadList(true)}
            className={`${SECONDARY_BUTTON_CLASS} mt-3`}
          >
            Reintentar
          </button>
        </div>
      ) : null}

      {list.kind === "ready" && list.members.length === 0 ? (
        <p className="mt-3 text-sm text-text-secondary">No hay miembros para mostrar.</p>
      ) : null}

      {list.kind === "ready" && list.members.length > 0 ? (
        <ul className="mt-3 grid gap-3">
          {list.members.map((member) => {
            const name = actionName(member);
            const selectId = `${baseId}-role-${member.user_id}`;
            const selected = selectedRoles[member.user_id];
            const validSelection = selected && selected !== member.role ? selected : "";
            const isConfirming = confirming?.id === member.user_id;
            const isBusy = busyId === member.user_id;
            const otherRoles = ROLES.filter((r) => r !== member.role);

            return (
              <li
                key={member.user_id}
                className="min-w-0 rounded-md border border-border-subtle p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-semibold text-text-primary">
                      <span className="break-words">{primaryIdentity(member)}</span>
                      <span
                        className={`rounded border px-2 py-0.5 text-xs font-bold tracking-[0.12em] ${ROLE_BADGE_CLASS[member.role]}`}
                      >
                        {ROLE_LABEL[member.role]}
                      </span>
                      {member.is_self ? (
                        <span className="text-xs font-normal text-text-muted">Tú</span>
                      ) : null}
                    </p>
                    {member.display_name && member.username ? (
                      <p className="mt-1 text-sm text-text-secondary">
                        @{member.username}
                      </p>
                    ) : null}
                    {member.email ? (
                      <p className="mt-1 break-all text-sm text-text-secondary">
                        {member.email}
                      </p>
                    ) : null}
                    <p className="mt-1 text-xs text-text-muted">
                      Acceso desde: {formatDate(member.granted_at)}
                    </p>
                  </div>
                </div>

                {!member.is_self && !isConfirming ? (
                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <div className="min-w-0 sm:w-56">
                      <label
                        htmlFor={selectId}
                        className="block text-sm font-medium text-text-primary"
                      >
                        Nuevo rol
                      </label>
                      <select
                        id={selectId}
                        value={validSelection}
                        onChange={(e) => {
                          const value = e.target.value;
                          setSelectedRoles((prev) => {
                            const rest = omitKey(prev, member.user_id);
                            return isRole(value)
                              ? { ...rest, [member.user_id]: value }
                              : rest;
                          });
                        }}
                        disabled={busyId !== null}
                        className={`${FIELD_CLASS} mt-1`}
                      >
                        <option value="">Elegir rol…</option>
                        {otherRoles.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      ref={(el) => {
                        triggerRefs.current.set(`${member.user_id}:role`, el);
                      }}
                      type="button"
                      onClick={() => {
                        if (!isRole(validSelection)) return;
                        setRowError(null);
                        setNotice(null);
                        setConfirming({
                          id: member.user_id,
                          kind: "role",
                          role: validSelection,
                        });
                      }}
                      disabled={busyId !== null || !validSelection}
                      aria-label={`Aplicar cambio de rol a ${name}`}
                      className={SECONDARY_BUTTON_CLASS}
                    >
                      Aplicar
                    </button>
                    <button
                      ref={(el) => {
                        triggerRefs.current.set(`${member.user_id}:remove`, el);
                      }}
                      type="button"
                      onClick={() => {
                        setRowError(null);
                        setNotice(null);
                        setConfirming({ id: member.user_id, kind: "remove" });
                      }}
                      disabled={busyId !== null}
                      aria-label={`Quitar acceso a ${name}`}
                      className={DANGER_BUTTON_CLASS}
                    >
                      Quitar acceso
                    </button>
                  </div>
                ) : null}

                {isConfirming && confirming ? (
                  <div
                    role="group"
                    aria-label={
                      confirming.kind === "remove"
                        ? "Confirmar quitar acceso"
                        : "Confirmar cambio de rol"
                    }
                    className="mt-3 rounded-md border border-accent-live/40 p-3"
                  >
                    <p className="text-sm text-text-primary">
                      {confirmationText(member, confirming)}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-3">
                      <button
                        type="button"
                        onClick={() => void mutate(confirming)}
                        disabled={busyId !== null}
                        aria-busy={isBusy}
                        className={DANGER_BUTTON_CLASS}
                      >
                        {isBusy
                          ? "Aplicando…"
                          : confirming.kind === "remove"
                            ? "Sí, quitar acceso"
                            : "Sí, cambiar rol"}
                      </button>
                      <button
                        ref={cancelButtonRef}
                        type="button"
                        onClick={cancelConfirmation}
                        disabled={busyId !== null}
                        className={SECONDARY_BUTTON_CLASS}
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                ) : null}

                {rowError?.id === member.user_id ? (
                  <p role="alert" className="mt-3 text-sm text-accent-live">
                    {rowError.message}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
