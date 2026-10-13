#!/usr/bin/env node
// SENSIBLE — operator-side, SOLO DEV. NO lo ejecutan los tests, el build ni el dev server. NUNCA ejecutar sin que la
// persona operadora lo haya autorizado para esta prueba. Procedimiento completo: docs/9K-PASSWORD-RECOVERY-AND-REMINDERS.md §5.
//
// Uso (PowerShell, desde la raíz del repo; las variables las pone la persona en SU terminal, no en el chat):
//   $env:VITE_SUPABASE_URL = "<URL del proyecto Supabase DEV>"
//   $env:VITE_SUPABASE_ANON_KEY = "<clave anon de DEV>"
//   $env:UPMINA_DEV_CHECK_CONFIRM = "DEV_ONLY"
//   node scripts/dev-password-reset-aal-check.mjs no-totp     # prueba decisiva (sin completar el TOTP)
//   node scripts/dev-password-reset-aal-check.mjs with-totp   # con enlace NUEVO: confirma el flujo seguro
// Imprime solo códigos HTTP, códigos de error de Auth y conclusiones. Nunca tokens, enlaces, códigos ni contraseñas.
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import {
  assertDevSupabaseUrl,
  CheckError,
  CONFIRM_VALUE,
  runCheck,
} from "./lib/dev-password-reset-aal-check.mjs";

const APP_URL = "https://upmina-testing-backend.vercel.app";

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    rl._writeToOutput = (text) => {
      if (text.startsWith(question)) process.stdout.write(question);
      // el resto (lo que se teclea o pega) no se muestra
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

try {
  const mode = process.argv[2];
  if (mode !== "no-totp" && mode !== "with-totp") {
    throw new CheckError(
      "Uso: node scripts/dev-password-reset-aal-check.mjs <no-totp|with-totp>",
    );
  }
  if (process.env.UPMINA_DEV_CHECK_CONFIRM !== CONFIRM_VALUE) {
    throw new CheckError(
      `Falta UPMINA_DEV_CHECK_CONFIRM=${CONFIRM_VALUE} (confirma que es una prueba en DEV)`,
    );
  }
  const supabaseUrl = assertDevSupabaseUrl(process.env.VITE_SUPABASE_URL ?? "");
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY ?? "";
  if (!anonKey) throw new CheckError("Falta VITE_SUPABASE_ANON_KEY");
  const result = await runCheck(mode, {
    fetchImpl: fetch,
    supabaseUrl,
    anonKey,
    appUrl: APP_URL,
    confirm: process.env.UPMINA_DEV_CHECK_CONFIRM,
    askHidden,
    log: (line) => console.log(line),
    randomBytes,
  });
  process.exit(result.verdict === "ALLOWED_AAL1" ? 3 : 0);
} catch (error) {
  console.error(
    error instanceof CheckError
      ? error.message
      : "Error inesperado (sin detalles por seguridad)",
  );
  process.exit(2);
}
