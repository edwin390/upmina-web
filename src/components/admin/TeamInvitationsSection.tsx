import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase";
import { buildActivationUrl } from "@/lib/admin-invitation-link";

// Sección "Invitaciones del equipo" de /admin (Bloque 9E). Solo PRESENTACIÓN: el dashboard la
// monta únicamente cuando GET /api/admin/me declara la capacidad `team_admin`, pero la autoridad
// es siempre el servidor (JWT + AAL2 + team_admin en cada llamada). Contrato que consume:
//   - GET  /api/admin/team-invitations         → { invitations: [...] } (sin token ni token_hash).
//   - POST /api/admin/team-invitations         → { role } → 201 { invitation, token, activation_path }.
//   - POST /api/admin/team-invitations-revoke  → { id } → 200 { id, status, revoked_at }.
//     Errores: 401/403 (sesión/permiso), 404 (no existe), 409 (ya no revocable), 500 (genérico).
//
// ENLACE SENSIBLE: el enlace de activación se construye SOLO a partir del `activation_path` de la
// respuesta de creación (relativo) y del origin del navegador, y vive únicamente en el estado de
// este componente (ni storage, ni cookies, ni query params, ni logs). Se elimina al descartarlo,
// al crear otra invitación o al desmontar, y el listado jamás lo recupera (el GET no lo trae).

export type InvitableRole = "admin" | "moderator";
export type InvitationStatus = "pending" | "consumed" | "revoked" | "expired";
type InvitationType = "standard" | "bootstrap_admin";

export interface TeamInvitation {
  id: string;
  role: InvitableRole;
  invitation_type: InvitationType;
  status: InvitationStatus;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
}

const LIST_ENDPOINT = "/api/admin/team-invitations";
const REVOKE_ENDPOINT = "/api/admin/team-invitations-revoke";

const ROLE_LABEL: Record<InvitableRole, string> = {
  admin: "Administrador",
  moderator: "Moderador",
};

const STATUS_LABEL: Record<InvitationStatus, string> = {
  pending: "Pendiente",
  consumed: "Consumida",
  revoked: "Revocada",
  expired: "Expirada",
};

const STATUS_DOT: Record<InvitationStatus, string> = {
  pending: "bg-accent-warning",
  consumed: "bg-accent-success",
  revoked: "bg-accent-live",
  expired: "bg-text-muted",
};

const MSG_SESSION = "Tu sesión ya no es válida. Inicia sesión de nuevo.";
const MSG_FORBIDDEN =
  "No se pudo autorizar esta acción. Comprueba tu verificación en dos pasos e inténtalo de nuevo.";
const MSG_LOAD = "No se pudieron cargar las invitaciones.";
const MSG_CREATE = "No pudimos crear la invitación. Inténtalo de nuevo.";
const MSG_REVOKE = "No pudimos revocar la invitación. Inténtalo de nuevo.";
const MSG_REVOKE_GONE = "Esta invitación ya no se puede revocar. Actualizamos la lista.";
const MSG_COPY_OK = "Enlace copiado.";
const MSG_COPY_FAIL =
  "No se pudo copiar automáticamente. Selecciona el enlace y cópialo manualmente.";

const PRIMARY_BUTTON_CLASS =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface disabled:pointer-events-none disabled:opacity-50";

const SECONDARY_BUTTON_CLASS =
  "inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50";

const DANGER_BUTTON_CLASS =
  "inline-flex min-h-11 items-center rounded-md border border-accent-live/60 px-5 py-2.5 text-sm font-semibold text-accent-live transition-colors duration-200 ease-smooth hover:bg-accent-live/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-live disabled:pointer-events-none disabled:opacity-50";

const FIELD_CLASS =
  "w-full rounded-md border border-border-subtle bg-bg-base px-3 py-2 text-text-primary outline-none focus:border-accent-secondary focus-visible:ring-2 focus-visible:ring-accent-secondary";

const isRole = (v: unknown): v is InvitableRole => v === "admin" || v === "moderator";
const isStatus = (v: unknown): v is InvitationStatus =>
  v === "pending" || v === "consumed" || v === "revoked" || v === "expired";
const isType = (v: unknown): v is InvitationType =>
  v === "standard" || v === "bootstrap_admin";
const dateOrNull = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === "string" ? v : undefined;

/** Reconstruye una invitación campo a campo (lista blanca); null si la forma no es la esperada. */
function parseInvitation(raw: unknown): TeamInvitation | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const consumedAt = dateOrNull(r.consumed_at);
  const revokedAt = dateOrNull(r.revoked_at);
  if (
    typeof r.id !== "string" ||
    r.id.length === 0 ||
    !isRole(r.role) ||
    !isType(r.invitation_type) ||
    !isStatus(r.status) ||
    typeof r.created_at !== "string" ||
    typeof r.expires_at !== "string" ||
    consumedAt === undefined ||
    revokedAt === undefined
  ) {
    return null;
  }
  return {
    id: r.id,
    role: r.role,
    invitation_type: r.invitation_type,
    status: r.status,
    created_at: r.created_at,
    expires_at: r.expires_at,
    consumed_at: consumedAt,
    revoked_at: revokedAt,
  };
}

function parseInvitations(body: unknown): TeamInvitation[] | null {
  const list = (body as { invitations?: unknown } | null)?.invitations;
  if (!Array.isArray(list)) return null;
  const parsed: TeamInvitation[] = [];
  for (const item of list) {
    const invitation = parseInvitation(item);
    if (!invitation) return null;
    parsed.push(invitation);
  }
  return parsed;
}

/** Misma regla que el backend: solo una standard pendiente es revocable (el servidor decide). */
function isRevocable(invitation: TeamInvitation): boolean {
  return invitation.invitation_type === "standard" && invitation.status === "pending";
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

type ListState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; invitations: TeamInvitation[] };

interface CreatedLink {
  role: InvitableRole;
  expiresAt: string;
  url: string;
}

export default function TeamInvitationsSection() {
  const headingId = useId();
  const roleId = useId();
  const linkId = useId();

  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [role, setRole] = useState<InvitableRole>("moderator");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedLink | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<{ id: string; message: string } | null>(
    null,
  );

  const isMountedRef = useRef(true);
  const listRequestRef = useRef(0);
  const createLockRef = useRef(false);
  const revokeLockRef = useRef(false);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const createButtonRef = useRef<HTMLButtonElement | null>(null);
  const listHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const revokeButtonRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const restoreFocusIdRef = useRef<string | null>(null);
  // Cada copiado lleva un número: si el enlace se descarta o se reemplaza mientras el
  // portapapeles responde, el feedback tardío se ignora (nunca se atribuye al enlace nuevo).
  const copyRequestRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Al aparecer el resultado se mueve el foco a él (lector de pantalla y teclado).
  useEffect(() => {
    if (created) resultRef.current?.focus();
  }, [created]);

  // Foco de la confirmación: al abrirla va a "Cancelar" (opción segura); al cancelarla vuelve al
  // botón "Revocar" de esa fila. El botón desaparece mientras se confirma, así que sin esto el
  // foco del teclado se perdería.
  useEffect(() => {
    if (confirmingId) {
      cancelButtonRef.current?.focus();
    } else if (restoreFocusIdRef.current) {
      revokeButtonRefs.current.get(restoreFocusIdRef.current)?.focus();
      restoreFocusIdRef.current = null;
    }
  }, [confirmingId]);

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
    const invitations = parseInvitations(body);
    setList(
      invitations ? { kind: "ready", invitations } : { kind: "error", message: MSG_LOAD },
    );
  }, []);

  useEffect(() => {
    void loadList(true);
  }, [loadList]);

  const discardLink = () => {
    copyRequestRef.current += 1;
    setCreated(null);
    setCopyFeedback(null);
    createButtonRef.current?.focus();
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (createLockRef.current) return; // guard síncrono contra doble submit
    createLockRef.current = true;
    setCreating(true);
    setCreateError(null);
    // Una invitación nueva reemplaza (y borra) el enlace anterior.
    copyRequestRef.current += 1;
    setCreated(null);
    setCopyFeedback(null);

    try {
      const token = await getAccessToken();
      if (!token) {
        if (isMountedRef.current) setCreateError(MSG_SESSION);
        return;
      }
      const response = await fetch(LIST_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role }),
      });
      if (response.status !== 201) {
        if (isMountedRef.current) {
          setCreateError(actionMessage(response.status, MSG_CREATE));
        }
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      const invitation = parseInvitation(
        (body as { invitation?: unknown } | null)?.invitation,
      );
      const url = buildActivationUrl(
        (body as { activation_path?: unknown } | null)?.activation_path,
      );
      if (!invitation || !url) {
        if (isMountedRef.current) setCreateError(MSG_CREATE);
        return;
      }
      if (isMountedRef.current) {
        setCreated({ role: invitation.role, expiresAt: invitation.expires_at, url });
        void loadList(false);
      }
    } catch {
      if (isMountedRef.current) setCreateError(MSG_CREATE);
    } finally {
      createLockRef.current = false;
      if (isMountedRef.current) setCreating(false);
    }
  };

  const copyLink = async () => {
    if (!created) return;
    const request = ++copyRequestRef.current;
    const isCurrent = () => isMountedRef.current && copyRequestRef.current === request;
    try {
      await navigator.clipboard.writeText(created.url);
      if (isCurrent()) setCopyFeedback({ ok: true, message: MSG_COPY_OK });
    } catch {
      if (isCurrent()) setCopyFeedback({ ok: false, message: MSG_COPY_FAIL });
    }
  };

  const revoke = async (id: string) => {
    if (revokeLockRef.current) return;
    revokeLockRef.current = true;
    setRevokingId(id);
    setRevokeError(null);

    try {
      const token = await getAccessToken();
      if (!token) {
        if (isMountedRef.current) setRevokeError({ id, message: MSG_SESSION });
        return;
      }
      const response = await fetch(REVOKE_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id }),
      });
      if (response.status === 200) {
        // Sin actualización optimista: se vuelve a leer lo que el servidor confirmó.
        if (isMountedRef.current) {
          setConfirmingId(null);
          listHeadingRef.current?.focus(); // la fila ya no es revocable: el foco no se pierde
          void loadList(false);
        }
        return;
      }
      if (!isMountedRef.current) return;
      if (response.status === 404 || response.status === 409) {
        setConfirmingId(null);
        listHeadingRef.current?.focus();
        setRevokeError({ id, message: MSG_REVOKE_GONE });
        void loadList(false);
        return;
      }
      setRevokeError({ id, message: actionMessage(response.status, MSG_REVOKE) });
    } catch {
      if (isMountedRef.current) setRevokeError({ id, message: MSG_REVOKE });
    } finally {
      revokeLockRef.current = false;
      if (isMountedRef.current) setRevokingId(null);
    }
  };

  return (
    <section aria-labelledby={headingId} className="mt-8">
      <h2 id={headingId} className="font-display text-xl tracking-wide text-text-primary">
        Invitaciones del equipo
      </h2>
      <p className="mt-2 text-sm text-text-secondary">
        Invita a nuevas personas al equipo. Cada invitación se puede usar una sola vez y
        caduca a los 7 días.
      </p>

      <form
        onSubmit={(e) => void create(e)}
        className="mt-4 flex flex-wrap items-end gap-3"
      >
        <div className="min-w-0 sm:w-64">
          <label htmlFor={roleId} className="block text-sm font-medium text-text-primary">
            Rol de la invitación
          </label>
          <select
            id={roleId}
            value={role}
            onChange={(e) => setRole(e.target.value as InvitableRole)}
            disabled={creating}
            className={`${FIELD_CLASS} mt-1`}
          >
            <option value="moderator">{ROLE_LABEL.moderator}</option>
            <option value="admin">{ROLE_LABEL.admin}</option>
          </select>
        </div>
        <button
          ref={createButtonRef}
          type="submit"
          disabled={creating}
          aria-busy={creating}
          className={PRIMARY_BUTTON_CLASS}
        >
          {creating ? "Creando…" : "Crear invitación"}
        </button>
      </form>

      {createError ? (
        <p role="alert" className="mt-3 text-sm text-accent-live">
          {createError}
        </p>
      ) : null}

      {created ? (
        <div
          ref={resultRef}
          tabIndex={-1}
          role="region"
          aria-label="Invitación creada"
          className="mt-4 rounded-md border border-accent-warning/60 bg-bg-base p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
        >
          <p className="font-semibold text-text-primary">Invitación creada</p>
          <p className="mt-1 text-sm text-text-secondary">
            Rol: {ROLE_LABEL[created.role]} · Expira: {formatDate(created.expiresAt)}
          </p>
          <p className="mt-3 text-sm text-accent-warning">
            Este enlace es sensible: quien lo tenga puede activar la invitación.
            Compártelo únicamente con la persona invitada. No se volverá a mostrar: si lo
            pierdes, revoca la invitación y crea otra.
          </p>
          <label
            htmlFor={linkId}
            className="mt-3 block text-sm font-medium text-text-primary"
          >
            Enlace de activación
          </label>
          <input
            id={linkId}
            type="text"
            readOnly
            value={created.url}
            onFocus={(e) => e.currentTarget.select()}
            className={`${FIELD_CLASS} mt-1 font-mono text-xs`}
          />
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void copyLink()}
              className={PRIMARY_BUTTON_CLASS}
            >
              Copiar enlace
            </button>
            <button
              type="button"
              onClick={discardLink}
              className={SECONDARY_BUTTON_CLASS}
            >
              Cerrar y descartar enlace
            </button>
          </div>
          {copyFeedback ? (
            <p
              role={copyFeedback.ok ? "status" : "alert"}
              className={`mt-3 text-sm ${copyFeedback.ok ? "text-accent-success" : "text-accent-live"}`}
            >
              {copyFeedback.message}
            </p>
          ) : null}
        </div>
      ) : null}

      <h3
        ref={listHeadingRef}
        tabIndex={-1}
        className="mt-8 font-semibold text-text-primary focus-visible:outline-none"
      >
        Invitaciones existentes
      </h3>

      {list.kind === "loading" ? (
        <p className="mt-3 text-sm text-text-secondary" role="status">
          Cargando invitaciones…
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

      {list.kind === "ready" && list.invitations.length === 0 ? (
        <p className="mt-3 text-sm text-text-secondary">Todavía no hay invitaciones.</p>
      ) : null}

      {list.kind === "ready" && list.invitations.length > 0 ? (
        <ul className="mt-3 grid gap-3">
          {list.invitations.map((invitation) => (
            <li
              key={invitation.id}
              className="min-w-0 rounded-md border border-border-subtle p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-text-primary">
                    {ROLE_LABEL[invitation.role]}
                    {invitation.invitation_type === "bootstrap_admin" ? (
                      <span className="ml-2 text-xs font-normal text-text-muted">
                        (invitación inicial)
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-1 flex items-center gap-2 text-sm text-text-secondary">
                    <span
                      aria-hidden="true"
                      className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[invitation.status]}`}
                    />
                    <span>{STATUS_LABEL[invitation.status]}</span>
                  </p>
                  <p className="mt-1 text-xs text-text-muted">
                    Creada: {formatDate(invitation.created_at)}
                    {invitation.status === "pending" || invitation.status === "expired"
                      ? ` · Expira: ${formatDate(invitation.expires_at)}`
                      : null}
                    {invitation.consumed_at
                      ? ` · Consumida: ${formatDate(invitation.consumed_at)}`
                      : null}
                    {invitation.revoked_at
                      ? ` · Revocada: ${formatDate(invitation.revoked_at)}`
                      : null}
                  </p>
                </div>
                {isRevocable(invitation) && confirmingId !== invitation.id ? (
                  <button
                    ref={(el) => {
                      revokeButtonRefs.current.set(invitation.id, el);
                    }}
                    type="button"
                    onClick={() => {
                      setRevokeError(null);
                      setConfirmingId(invitation.id);
                    }}
                    disabled={revokingId !== null}
                    aria-label={`Revocar invitación de ${ROLE_LABEL[invitation.role]} creada el ${formatDate(invitation.created_at)}`}
                    className={DANGER_BUTTON_CLASS}
                  >
                    Revocar
                  </button>
                ) : null}
              </div>

              {confirmingId === invitation.id ? (
                <div
                  role="group"
                  aria-label="Confirmar revocación"
                  className="mt-3 rounded-md border border-accent-live/40 p-3"
                >
                  <p className="text-sm text-text-primary">
                    ¿Revocar esta invitación? El enlace dejará de funcionar y no se puede
                    deshacer.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={() => void revoke(invitation.id)}
                      disabled={revokingId !== null}
                      aria-busy={revokingId === invitation.id}
                      className={DANGER_BUTTON_CLASS}
                    >
                      {revokingId === invitation.id ? "Revocando…" : "Sí, revocar"}
                    </button>
                    <button
                      ref={cancelButtonRef}
                      type="button"
                      onClick={() => {
                        restoreFocusIdRef.current = invitation.id;
                        setConfirmingId(null);
                      }}
                      disabled={revokingId !== null}
                      className={SECONDARY_BUTTON_CLASS}
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : null}

              {revokeError?.id === invitation.id ? (
                <p role="alert" className="mt-3 text-sm text-accent-live">
                  {revokeError.message}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
