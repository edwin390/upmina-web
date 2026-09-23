import { readFileSync } from "node:fs";
import { join } from "node:path";

// Carga de variables de entorno locales para scripts operator-side (Bloque 4B). Extrae
// EXACTAMENTE el mismo patrón que ya usaba scripts/dev-local.mjs (regex de asignación
// KEY=value, comillas opcionales, no sobrescribir lo ya presente en el entorno objetivo)
// para que scripts/bootstrap-admin-invitation.mjs pueda reusarlo sin duplicar la lógica
// ni depender de una librería nueva (Node 24 ya trae todo lo necesario: node:fs/node:path).
//
// Puramente de lectura de archivo + parseo de texto: nunca contacta Supabase, nunca
// imprime ni registra el contenido de las variables que carga.

const ASSIGNMENT_PATTERN = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/;

/**
 * Parsea el contenido de un archivo .env sencillo (una asignación por línea, comillas
 * simples/dobles opcionales alrededor del valor). No expande variables, no soporta
 * continuación multilínea ni comentarios inline: el mismo formato mínimo que ya asumía
 * dev-local.mjs. Función PURA (sin I/O): recibe texto, devuelve un objeto plano.
 */
export function parseEnvFileContents(contents) {
  const result = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = ASSIGNMENT_PATTERN.exec(line);
    if (!match) continue;
    const value = match[2].replace(/^("|')(.*)\1$/, "$2");
    result[match[1]] = value;
  }
  return result;
}

/**
 * Aplica sobre `targetEnv` las asignaciones de un archivo .env en `path`, SIN sobrescribir
 * ninguna clave ya presente en `targetEnv` — una variable ya exportada explícitamente en
 * el shell (o inyectada por el llamador, p. ej. en un test) siempre gana sobre el archivo.
 * Si el archivo no existe, es un no-op silencioso (mismo comportamiento que ya tenía
 * dev-local.mjs); cualquier otro error de lectura se propaga tal cual, sin envolver su
 * mensaje (podría incluir la ruta del archivo, nunca un valor de variable).
 */
export function applyEnvFile(path, targetEnv) {
  let contents;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  const parsed = parseEnvFileContents(contents);
  for (const [key, value] of Object.entries(parsed)) {
    if (key in targetEnv) continue;
    targetEnv[key] = value;
  }
}

/**
 * Carga las variables de entorno locales del proyecto en `targetEnv`, en orden de
 * precedencia: lo que YA esté en `targetEnv` (p. ej. exportado en el shell) gana siempre;
 * si falta, se completa desde `.env.local`; lo que siga faltando, desde `.env` como
 * fallback. Mismo orden que ya usaba dev-local.mjs (`.env.local` antes que `.env`).
 * `cwd`/`targetEnv` son inyectables para que los tests sean deterministas y nunca lean el
 * `.env.local`/`.env` reales del repo ni muten el `process.env` real del proceso de test.
 */
export function loadLocalEnvFiles(cwd = process.cwd(), targetEnv = process.env) {
  applyEnvFile(join(cwd, ".env.local"), targetEnv);
  applyEnvFile(join(cwd, ".env"), targetEnv);
}
