import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import AdminAuthField from "@/components/admin/AdminAuthField";

// Perfil público dentro de /account (Bloque 7C.2). Lee public.profiles con el cliente de
// Supabase del navegador (SELECT público por diseño) y, si el usuario aún no tiene perfil,
// muestra el onboarding de username que envía POST /api/profile con el Bearer de la
// sesión existente (un solo AuthProvider, ningún listener adicional).
//
// La existencia (o no) de perfil NO es una señal de privilegios: no se consulta
// admin_roles ni /api/admin/me y no hay MFA. El servidor (POST /api/profile) es la
// autoridad de reservados, disponibilidad y formato; la validación de aquí es solo UX.
//
// Edición (Bloque 7D.3): el perfil existente tiene modo view/edit local. Solo se editan
// display_name y bio mediante PATCH /api/profile con el Bearer de la sesión y ÚNICAMENTE
// los campos cuyo valor semántico cambió; username y avatar no son editables. La
// normalización/validación de aquí es solo UX (contadores en code points): el servidor es
// la autoridad final. La respuesta 200 reemplaza el estado local (sin segundo SELECT).
//
// Nunca se muestran user_id, email público, tokens, claims ni metadata. avatar_path se
// ignora (Storage aún no está diseñado).

const NAME_INPUT_ID = "account-profile-display-name";
const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;

const USERNAME_HELP = "3–20 caracteres: letras a-z, números y guion bajo (_).";
const USERNAME_INVALID = "Usa 3–20 caracteres: letras a-z, números y guion bajo (_).";
const READ_ERROR_MESSAGE = "No se pudo cargar tu perfil.";
const MSG_BAD_REQUEST = "No se pudo procesar la solicitud. Revisa el username.";
const MSG_TAKEN = "Este username no está disponible.";
const MSG_CHOOSE_OTHER = "Elige otro username.";
const MSG_SESSION = "Tu sesión ya no es válida. Cierra sesión e inicia de nuevo.";
const MSG_GENERIC = "No se pudo crear tu perfil. Inténtalo de nuevo.";
const DISPLAY_NAME_MAX = 40;
const BIO_MAX = 280;
const MSG_EDIT_BAD_REQUEST = "Los datos enviados no son válidos.";
const MSG_EDIT_INVALID = "Revisa el nombre visible y la bio.";
const MSG_EDIT_GENERIC = "No se pudo guardar tu perfil. Inténtalo de nuevo.";
const MSG_NAME_TOO_LONG = `El nombre visible admite hasta ${DISPLAY_NAME_MAX} caracteres.`;
const MSG_BIO_TOO_LONG = `La bio admite hasta ${BIO_MAX} caracteres.`;

interface PublicProfile {
  username: string;
  display_name: string | null;
  bio: string | null;
}

type ProfileState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "absent" }
  | { status: "present"; profile: PublicProfile };

/** Extrae solo los campos públicos mostrados; null si la forma no es la esperada. */
function toPublicProfile(value: unknown): PublicProfile | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.username !== "string" || row.username.length === 0) return null;
  const text = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    username: row.username,
    display_name: text(row.display_name),
    bio: text(row.bio),
  };
}

// Normalización UX (misma forma que el servidor: trim + NFC, vacío → null; la bio además
// unifica CRLF/CR a LF). Sirve para detectar cambios reales y contar; no sustituye al
// servidor.
function normalizeDisplayNameInput(raw: string): string | null {
  const text = raw.trim().normalize("NFC");
  return text === "" ? null : text;
}

function normalizeBioInput(raw: string): string | null {
  const text = raw.replace(/\r\n?/g, "\n").trim().normalize("NFC");
  return text === "" ? null : text;
}

/** Longitud en code points (como char_length de Postgres), no unidades UTF-16. */
function codePoints(value: string | null): number {
  return value === null ? 0 : Array.from(value).length;
}

function editStatusMessage(status: number): string {
  if (status === 400) return MSG_EDIT_BAD_REQUEST;
  if (status === 401) return MSG_SESSION;
  if (status === 422) return MSG_EDIT_INVALID;
  return MSG_EDIT_GENERIC;
}

function statusMessage(status: number): string {
  if (status === 400) return MSG_BAD_REQUEST;
  if (status === 401) return MSG_SESSION;
  if (status === 409) return MSG_TAKEN;
  if (status === 422) return MSG_CHOOSE_OTHER;
  return MSG_GENERIC;
}

const PRIMARY_BUTTON_CLASS =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface disabled:pointer-events-none disabled:opacity-50";

const SECONDARY_BUTTON_CLASS =
  "inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary";

export default function ProfileSection() {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;

  const [state, setState] = useState<ProfileState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [username, setUsername] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [nameInput, setNameInput] = useState("");
  const [bioInput, setBioInput] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Refs para leer el valor MÁS RECIENTE tras un await sin cerrar sobre renders viejos.
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = session?.access_token ?? null;
  const submitLockRef = useRef(false);
  const saveLockRef = useRef(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const wasEditingRef = useRef(false);
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Lectura del perfil propio. Cada ejecución es independiente: `cancelled` invalida la
  // respuesta si cambia el usuario, se reintenta o se desmonta antes de que termine.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    setState({ status: "loading" });
    setMode("view");
    setEditError(null);

    async function load() {
      if (!supabase) {
        if (!cancelled) setState({ status: "error" });
        return;
      }
      try {
        const { data, error } = await supabase
          .from("profiles")
          .select("username, display_name, bio")
          .eq("user_id", userId)
          .maybeSingle();
        if (cancelled) return;
        // Un error de lectura NUNCA se interpreta como "sin perfil".
        if (error) {
          setState({ status: "error" });
          return;
        }
        if (data === null) {
          setState({ status: "absent" });
          return;
        }
        const profile = toPublicProfile(data);
        setState(profile ? { status: "present", profile } : { status: "error" });
      } catch {
        if (!cancelled) setState({ status: "error" });
      }
    }
    void load();

    return () => {
      cancelled = true;
    };
  }, [userId, reloadKey]);

  // Foco: al entrar en edición, al primer campo; al salir, de vuelta al botón Editar.
  useEffect(() => {
    if (mode === "edit") {
      wasEditingRef.current = true;
      document.getElementById(NAME_INPUT_ID)?.focus();
    } else if (wasEditingRef.current) {
      wasEditingRef.current = false;
      editButtonRef.current?.focus();
    }
  }, [mode]);

  const currentProfile = state.status === "present" ? state.profile : null;
  const nameNormalized = normalizeDisplayNameInput(nameInput);
  const bioNormalized = normalizeBioInput(bioInput);
  const nameCount = codePoints(nameNormalized);
  const bioCount = codePoints(bioNormalized);
  const nameTooLong = nameCount > DISPLAY_NAME_MAX;
  const bioTooLong = bioCount > BIO_MAX;
  const nameChanged =
    currentProfile !== null &&
    nameNormalized !== normalizeDisplayNameInput(currentProfile.display_name ?? "");
  const bioChanged =
    currentProfile !== null &&
    bioNormalized !== normalizeBioInput(currentProfile.bio ?? "");
  const canSave = (nameChanged || bioChanged) && !nameTooLong && !bioTooLong;

  const startEdit = () => {
    if (!currentProfile) return;
    setNameInput(currentProfile.display_name ?? "");
    setBioInput(currentProfile.bio ?? "");
    setEditError(null);
    setMode("edit");
  };

  const cancelEdit = () => {
    if (saveLockRef.current) return;
    setEditError(null);
    setMode("view");
  };

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saveLockRef.current) return;
    const saveUserId = userIdRef.current;
    const token = tokenRef.current;
    if (!saveUserId || !token || !currentProfile || !canSave) return;

    // Solo los campos cuyo valor semántico cambió; el objeto se arma campo a campo.
    const body: { display_name?: string | null; bio?: string | null } = {};
    if (nameChanged) body.display_name = nameNormalized;
    if (bioChanged) body.bio = bioNormalized;

    saveLockRef.current = true;
    setIsSaving(true);
    setEditError(null);

    const isCurrent = () => isMountedRef.current && userIdRef.current === saveUserId;

    try {
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (response.status === 200) {
        let payload: unknown = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        if (!isCurrent()) return;
        const profile = toPublicProfile(
          (payload as { profile?: unknown } | null)?.profile,
        );
        if (profile) {
          setState({ status: "present", profile });
          setMode("view");
        } else {
          setEditError(MSG_EDIT_GENERIC);
        }
      } else if (isCurrent()) {
        if (response.status === 404) {
          // El perfil ya no existe: se sale de edición y se vuelve a comprobar con la
          // lectura existente (si de verdad no está, cae al onboarding). Nunca se crea.
          setEditError(null);
          setMode("view");
          setReloadKey((key) => key + 1);
        } else {
          setEditError(editStatusMessage(response.status));
        }
      }
    } catch {
      if (isCurrent()) setEditError(MSG_EDIT_GENERIC);
    } finally {
      saveLockRef.current = false;
      if (isMountedRef.current) setIsSaving(false);
    }
  };

  const normalized = username.trim().toLowerCase();
  const isValid = USERNAME_PATTERN.test(normalized);
  const showInvalid = username.length > 0 && !isValid;

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitLockRef.current) return;
      const submitUserId = userIdRef.current;
      const token = tokenRef.current;
      if (!submitUserId || !token) return;
      const candidate = username.trim().toLowerCase();
      if (!USERNAME_PATTERN.test(candidate)) {
        setSubmitError(USERNAME_INVALID);
        return;
      }

      submitLockRef.current = true;
      setIsSubmitting(true);
      setSubmitError(null);

      // La respuesta solo se aplica si el componente sigue montado y sigue siendo la
      // misma cuenta que envió el formulario.
      const isCurrent = () => isMountedRef.current && userIdRef.current === submitUserId;

      try {
        const response = await fetch("/api/profile", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ username: candidate }),
        });
        if (response.status === 201) {
          let payload: unknown = null;
          try {
            payload = await response.json();
          } catch {
            payload = null;
          }
          if (!isCurrent()) return;
          const profile = toPublicProfile(
            (payload as { profile?: unknown } | null)?.profile,
          );
          if (profile) setState({ status: "present", profile });
          else setSubmitError(MSG_GENERIC);
        } else if (isCurrent()) {
          setSubmitError(statusMessage(response.status));
        }
      } catch {
        if (isCurrent()) setSubmitError(MSG_GENERIC);
      } finally {
        submitLockRef.current = false;
        if (isMountedRef.current) setIsSubmitting(false);
      }
    },
    [username],
  );

  return (
    <section
      aria-labelledby="account-profile-heading"
      className="mt-6 border-t border-border-subtle pt-6"
    >
      <h2
        id="account-profile-heading"
        className="font-display text-xl tracking-wide text-text-primary"
      >
        Tu perfil público
      </h2>

      {state.status === "loading" ? (
        <p className="mt-3 text-sm text-text-secondary" aria-live="polite">
          Cargando tu perfil…
        </p>
      ) : null}

      {state.status === "error" ? (
        <div className="mt-3">
          <p role="alert" className="text-sm text-accent-live">
            {READ_ERROR_MESSAGE}
          </p>
          <button
            type="button"
            onClick={() => setReloadKey((key) => key + 1)}
            className={`${SECONDARY_BUTTON_CLASS} mt-3`}
          >
            Reintentar
          </button>
        </div>
      ) : null}

      {state.status === "present" && mode === "view" ? (
        <div className="mt-3 min-w-0">
          {state.profile.display_name ? (
            <p className="break-words text-lg font-semibold text-text-primary">
              {state.profile.display_name}
            </p>
          ) : null}
          <p className="break-all text-sm text-text-secondary">
            @
            <span className="font-medium text-text-primary">
              {state.profile.username}
            </span>
          </p>
          {state.profile.bio ? (
            <p className="mt-3 whitespace-pre-line break-words text-sm text-text-secondary">
              {state.profile.bio}
            </p>
          ) : null}
          <button
            type="button"
            ref={editButtonRef}
            onClick={startEdit}
            className={`${SECONDARY_BUTTON_CLASS} mt-4`}
          >
            Editar perfil
          </button>
        </div>
      ) : null}

      {state.status === "present" && mode === "edit" ? (
        <form onSubmit={(e) => void handleSave(e)} noValidate className="mt-3 min-w-0">
          <p className="break-all text-sm text-text-secondary">
            @
            <span className="font-medium text-text-primary">
              {state.profile.username}
            </span>
            <span className="ml-2 text-xs">(el username no se puede cambiar)</span>
          </p>
          <p className="mt-2 text-xs text-text-secondary">
            Tu nombre visible y tu bio serán públicos.
          </p>

          <div className="mt-4">
            <AdminAuthField
              label="Nombre visible"
              id={NAME_INPUT_ID}
              name="display_name"
              type="text"
              autoComplete="off"
              errorId="account-profile-name-count"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              disabled={isSaving}
            />
            <p
              id="account-profile-name-count"
              className={`mt-2 text-xs ${nameTooLong ? "text-accent-live" : "text-text-secondary"}`}
            >
              {nameCount}/{DISPLAY_NAME_MAX}
            </p>
            {nameTooLong ? (
              <p role="alert" className="mt-1 text-sm text-accent-live">
                {MSG_NAME_TOO_LONG}
              </p>
            ) : null}
          </div>

          <div className="mt-4">
            <label
              htmlFor="account-profile-bio"
              className="mb-1 block text-sm text-text-secondary"
            >
              Bio
            </label>
            <textarea
              id="account-profile-bio"
              name="bio"
              rows={4}
              aria-describedby="account-profile-bio-count"
              value={bioInput}
              onChange={(e) => setBioInput(e.target.value)}
              disabled={isSaving}
              className="w-full resize-y rounded-md border border-border-subtle bg-bg-base px-3 py-2 text-text-primary outline-none focus:border-accent-secondary focus-visible:ring-2 focus-visible:ring-accent-secondary"
            />
            <p
              id="account-profile-bio-count"
              className={`mt-2 text-xs ${bioTooLong ? "text-accent-live" : "text-text-secondary"}`}
            >
              {bioCount}/{BIO_MAX}
            </p>
            {bioTooLong ? (
              <p role="alert" className="mt-1 text-sm text-accent-live">
                {MSG_BIO_TOO_LONG}
              </p>
            ) : null}
          </div>

          {editError ? (
            <p role="alert" className="mt-4 text-sm text-accent-live">
              {editError}
            </p>
          ) : null}

          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={isSaving || !canSave}
              className={PRIMARY_BUTTON_CLASS}
            >
              {isSaving ? "Guardando…" : "Guardar"}
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              disabled={isSaving}
              className={SECONDARY_BUTTON_CLASS}
            >
              Cancelar
            </button>
          </div>
        </form>
      ) : null}

      {state.status === "absent" ? (
        <form onSubmit={(e) => void handleSubmit(e)} noValidate className="mt-3">
          <p className="mb-4 text-sm text-text-secondary">
            Elige tu username para crear tu perfil.
          </p>
          <AdminAuthField
            label="Username"
            id="account-profile-username"
            name="username"
            type="text"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={40}
            errorId="account-profile-username-help"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={isSubmitting}
          />
          <p
            id="account-profile-username-help"
            className={`mt-2 text-xs ${showInvalid ? "text-accent-live" : "text-text-secondary"}`}
          >
            {showInvalid ? USERNAME_INVALID : USERNAME_HELP}
          </p>

          {submitError ? (
            <p role="alert" className="mt-4 text-sm text-accent-live">
              {submitError}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={isSubmitting || !isValid}
            className={`${PRIMARY_BUTTON_CLASS} mt-4`}
          >
            {isSubmitting ? "Creando perfil…" : "Crear perfil"}
          </button>
        </form>
      ) : null}
    </section>
  );
}
