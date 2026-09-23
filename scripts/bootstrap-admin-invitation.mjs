import { createClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildActivationUrl,
  buildBootstrapInvitationRow,
  generateBootstrapToken,
  hashBootstrapToken,
  readSupabaseServiceConfig,
} from "./lib/admin-bootstrap-invitation.mjs";
import { loadLocalEnvFiles } from "./lib/load-env.mjs";

// Script OPERATOR-SIDE (Bloque 2B): crea la invitación bootstrap_admin real en
// Supabase. Se ejecuta EXPLÍCITAMENTE con `npm run admin:bootstrap-invitation` —
// ningún script de `npm test`/`npm run build`/`npm install`/`npm run dev` lo invoca, y
// este archivo no se importa desde ningún test (los tests solo importan la lógica pura
// de ./lib/admin-bootstrap-invitation.mjs).
//
// Regla crítica: el token en claro y la URL de activación NUNCA se escriben en
// stdout/stderr (podrían quedar capturados por herramientas que leen la salida de la
// terminal, incluyendo Claude Code). Se escriben UNA sola vez a un archivo local
// gitignored (ver SECRET_FILE_PATH) que el operador abre y borra manualmente fuera de
// esta herramienta, tras enviar el enlace por un canal privado ya establecido.
//
// Orden de operaciones (Bloque 2B.1 — corrección de atomicidad): el archivo secreto se
// escribe ANTES del INSERT en Supabase, nunca después. Si el archivo no puede escribirse
// no se llama a Supabase en absoluto (no queda ninguna invitación cuyo token en claro se
// haya perdido). Si el archivo se escribe pero el INSERT falla, se borra el archivo
// inmediatamente (rollback local): sin esto, un fallo de red DESPUÉS del INSERT dejaría
// un archivo con un enlace que no corresponde a ninguna invitación real en DB, y un
// fallo ANTES (el orden previo) podía dejar una invitación real en DB cuyo token en
// claro ya se había perdido — ambos son estados inconsistentes que este orden evita.

const ACTIVATION_BASE_URL = "https://upmina-web.vercel.app";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SECRET_DIR = join(SCRIPT_DIR, ".secrets");
const SECRET_FILE_PATH = join(SECRET_DIR, "bootstrap-admin-invitation.txt");

function secretFileContents(activationUrl, expiresAtIso) {
  return [
    "=== SECRETO — INVITACIÓN BOOTSTRAP_ADMIN DE UPMINA WEB ===",
    "",
    "Este archivo contiene un enlace de un solo uso que concede el rol ADMIN a quien lo",
    "abra desde una sesión Supabase autenticada con MFA verificado (aal2). Trátalo como",
    "una contraseña: envíalo SOLO por un canal privado ya establecido, y borra este",
    "archivo en cuanto lo hayas enviado.",
    "",
    `Enlace de activación: ${activationUrl}`,
    `Caduca: ${expiresAtIso}`,
    "",
    "No lo pegues en chats públicos, tickets, logs ni capturas de pantalla.",
    "No lo commitees. No lo subas a ningún sitio salvo el canal privado acordado.",
    "",
  ].join("\n");
}

async function main() {
  // Completa process.env desde .env.local/.env (Bloque 4B) ANTES de validar la
  // configuración: nunca sobrescribe una variable ya exportada explícitamente en el
  // shell. Sin esto, había que exportar SUPABASE_SERVICE_ROLE_KEY a mano en cada
  // terminal — el mismo problema que dev-local.mjs ya resolvía para `npm run dev:local`.
  loadLocalEnvFiles();

  let config;
  try {
    config = readSupabaseServiceConfig(process.env);
  } catch (err) {
    // El mensaje de readSupabaseServiceConfig ya es seguro: nombra solo la variable
    // ausente, nunca ningún valor.
    console.error(`[bootstrap-admin-invitation] ${err.message}`);
    process.exitCode = 1;
    return;
  }

  // Nunca sobrescribir silenciosamente un secreto anterior: si el archivo ya existe,
  // puede que el operador aún no lo haya enviado/borrado. Se detiene ANTES de generar
  // ningún token nuevo o tocar Supabase.
  if (existsSync(SECRET_FILE_PATH)) {
    console.error(
      `[bootstrap-admin-invitation] Ya existe ${SECRET_FILE_PATH}. Bórralo (tras haberlo enviado por un canal privado) antes de generar una invitación nueva.`,
    );
    process.exitCode = 1;
    return;
  }

  const token = generateBootstrapToken();
  const tokenHash = hashBootstrapToken(token);
  const row = buildBootstrapInvitationRow(tokenHash);
  const activationUrl = buildActivationUrl(ACTIVATION_BASE_URL, token);
  const contents = secretFileContents(activationUrl, row.expires_at);

  mkdirSync(SECRET_DIR, { recursive: true });

  try {
    // flag "wx": falla si el archivo ya existe (defensa adicional, atómica, más allá
    // del chequeo explícito de arriba, por si hay una carrera entre ambas
    // comprobaciones). Este write ocurre ANTES de tocar Supabase: si falla, no se ha
    // hecho ninguna llamada de red todavía y no queda ninguna invitación huérfana.
    writeFileSync(SECRET_FILE_PATH, contents, { encoding: "utf8", flag: "wx" });
  } catch {
    // Nunca se imprime el error real: podría incluir `contents` (p. ej. un mensaje de
    // "disco lleno" de algunos sistemas de archivos que ecoa el buffer). El mensaje se
    // mantiene genérico a propósito.
    console.error(
      "[bootstrap-admin-invitation] No se pudo escribir el archivo secreto local. No se contactó a Supabase.",
    );
    process.exitCode = 1;
    return;
  }

  try {
    // Solo el propietario puede leer/escribir. Best-effort: en Windows el sistema de
    // permisos es distinto (ACLs) y esta llamada no ofrece la misma garantía; no es
    // fatal si no aplica.
    chmodSync(SECRET_FILE_PATH, 0o600);
  } catch {
    // Ignorado a propósito: no bloquea la entrega del secreto si el SO no lo soporta.
  }

  const client = createClient(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await client
    .from("admin_invitations")
    .insert(row)
    .select("expires_at")
    .single();

  if (error || !data) {
    // El INSERT falló: el archivo local ya escrito contendría un enlace que no
    // corresponde a ninguna invitación real en DB. Rollback local inmediato.
    try {
      unlinkSync(SECRET_FILE_PATH);
      console.error(
        "[bootstrap-admin-invitation] No se pudo crear la invitación en Supabase. El archivo secreto local fue eliminado; no quedó ningún enlace huérfano.",
      );
    } catch {
      // El borrado también falló: no se imprime la causa (podría filtrar detalles del
      // sistema de archivos), solo se exige acción manual explícita del operador.
      console.error(
        `[bootstrap-admin-invitation] No se pudo crear la invitación en Supabase, y tampoco se pudo eliminar el archivo secreto local. Debes eliminar manualmente ${SECRET_FILE_PATH} antes de volver a intentarlo: ese archivo NO corresponde a ninguna invitación válida.`,
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `[bootstrap-admin-invitation] Invitación creada y verificada en Supabase. Enlace guardado en: ${SECRET_FILE_PATH}`,
  );
  console.log(
    "[bootstrap-admin-invitation] Ábrelo manualmente, envíalo por un canal privado y bórralo después. Nunca se imprime aquí.",
  );
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main();
}
