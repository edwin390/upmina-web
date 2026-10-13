import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import AdminAuthCard from "@/components/admin/AdminAuthCard";

// /admin/mfa/recovery/cancel#t=<token> — cancelar una recuperación de autenticador que NO pediste
// (enlace del correo de aprobación). Pública a propósito: no pide sesión ni código, porque quien la
// necesita puede haber perdido el acceso. Solo puede CANCELAR (no aprueba, no ejecuta, no cambia roles).
// El token viaja en el fragmento (#), que el navegador no envía al servidor: se lee una vez, se borra de
// la URL y vive solo en memoria. Abrir el enlace (GET) únicamente muestra esta confirmación; la
// cancelación real exige pulsar el botón (POST), así un escáner de enlaces del correo no cancela nada.
// No se revela ningún dato de la cuenta: un enlace no válido, usado o caducado recibe el mismo mensaje.

const ENDPOINT = "/api/admin/mfa-recovery-cancel";
const TOKEN_IN_HASH = /^#t=([A-Za-z0-9_-]{43})$/;

type Phase = "checking" | "ready" | "invalid" | "done" | "error";

const PRIMARY =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface disabled:pointer-events-none disabled:opacity-50";

async function post(op: "check" | "cancel", token: string): Promise<Response> {
  return fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op, token }),
  });
}

export default function AdminMfaRecoveryCancelPage() {
  const tokenRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<Phase>("checking");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const match = TOKEN_IN_HASH.exec(window.location.hash);
    // El fragmento se retira de la URL en cuanto se lee (no queda en el historial ni en capturas).
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + window.location.search,
    );
    if (!match) {
      setPhase("invalid");
      return;
    }
    tokenRef.current = match[1];
    let alive = true;
    post("check", match[1])
      .then((response) => {
        if (!alive) return;
        setPhase(response.ok ? "ready" : response.status === 404 ? "invalid" : "error");
      })
      .catch(() => alive && setPhase("error"));
    return () => {
      alive = false;
    };
  }, []);

  const cancel = async () => {
    const token = tokenRef.current;
    if (!token || busy) return;
    setBusy(true);
    try {
      const response = await post("cancel", token);
      if (response.ok) {
        tokenRef.current = null;
        setPhase("done");
      } else {
        setPhase(response.status === 404 ? "invalid" : "error");
      }
    } catch {
      setPhase("error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdminAuthCard title="Cancelar recuperación de autenticador">
      {phase === "checking" ? (
        <p role="status" className="text-sm text-text-secondary">
          Comprobando el enlace…
        </p>
      ) : null}
      {phase === "ready" ? (
        <>
          <p className="text-sm text-text-secondary">
            Alguien pidió restablecer el autenticador de tu cuenta del equipo de Upminaa
            Web. Si no fuiste tú, cancélalo ahora. Esto no modifica tu rol ni tu
            autenticador actual.
          </p>
          <button
            type="button"
            className={`mt-6 ${PRIMARY}`}
            disabled={busy}
            onClick={() => void cancel()}
          >
            {busy ? "Cancelando…" : "Cancelar la recuperación"}
          </button>
        </>
      ) : null}
      {phase === "done" ? (
        <>
          <p role="status" className="text-sm text-text-secondary">
            La recuperación se canceló y ya no puede ejecutarse. Si no fuiste tú, cambia
            tu contraseña y avisa a un administrador.
          </p>
          <Link
            to="/"
            className="mt-4 inline-flex min-h-11 items-center text-sm underline"
          >
            Ir al inicio
          </Link>
        </>
      ) : null}
      {phase === "invalid" ? (
        <p role="alert" className="text-sm text-accent-live">
          Este enlace no es válido, ya se usó o caducó. Si necesitas ayuda, habla con un
          administrador.
        </p>
      ) : null}
      {phase === "error" ? (
        <p role="alert" className="text-sm text-accent-live">
          No se pudo completar la operación. Inténtalo de nuevo.
        </p>
      ) : null}
      {phase === "error" && tokenRef.current ? (
        <button
          type="button"
          className={`mt-4 ${PRIMARY}`}
          disabled={busy}
          onClick={() => void cancel()}
        >
          Reintentar la cancelación
        </button>
      ) : null}
    </AdminAuthCard>
  );
}
