#!/usr/bin/env node
// Solo lectura. Lista las sesiones multipart ABIERTAS de upmina-media-dev-private bajo
// staging/community/ (opcionalmente de un solo asset) y sus partes (nº y bytes).
// Uso (PowerShell, raíz del repo):
//   node scripts/r2-multipart-check-dev.mjs --env-file .env.local --asset <assetId>
//   node scripts/r2-multipart-check-dev.mjs --env-file .env.local          (todas las de staging/community/)
//   ... --asset <assetId> --expected-upload-id-env NOMBRE_DE_VARIABLE
//       Compara el UploadId guardado en Supabase (que TÚ pones en esa variable de entorno; nunca
//       como argumento) con las sesiones listadas: imprime solo huella (SHA-256, 12 hex) y longitud,
//       y comprueba con ListParts (lectura) si ese identificador direcciona una sesión viva.
// Exit: 0 consultado sin ERROR · 1 hubo ERROR · 2 configuración/uso inválido.
import {
  ConfigError,
  ENV_NAMES,
  readEnvFile,
  resolveConfig,
} from "./lib/r2-head-dev.mjs";
import { buildPrefix, checkSessions, formatRow } from "./lib/r2-multipart-check-dev.mjs";

function parseArgs(argv) {
  const a = { envFile: null, asset: null, expectedEnv: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env-file") a.envFile = argv[++i];
    else if (argv[i] === "--asset") a.asset = argv[++i];
    else if (argv[i] === "--expected-upload-id-env") a.expectedEnv = argv[++i];
    else throw new ConfigError(`Argumento desconocido: ${argv[i]}`);
  }
  return a;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const env = {};
  for (const n of ENV_NAMES) if (process.env[n]) env[n] = process.env[n];
  if (args.envFile)
    for (const [k, v] of Object.entries(readEnvFile(args.envFile))) env[k] ??= v;
  const config = resolveConfig(env);
  const prefix = buildPrefix(args.asset);
  console.log(
    `# Sesiones multipart (solo lectura) · ${new Date().toISOString()} · prefijo ${prefix}`,
  );
  let expectedUploadId;
  if (args.expectedEnv) {
    if (
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(args.expectedEnv) ||
      ENV_NAMES.includes(args.expectedEnv)
    )
      throw new ConfigError("Nombre de variable no válido");
    expectedUploadId = process.env[args.expectedEnv];
    if (!expectedUploadId)
      throw new ConfigError("La variable indicada está vacía o no existe");
  }
  const rows = await checkSessions({ prefix, config, expectedUploadId });
  for (const r of rows) console.log(formatRow(r));
  process.exit(rows.some((r) => r.state === "ERROR") ? 1 : 0);
} catch (e) {
  console.error(
    e instanceof ConfigError
      ? `CONFIG: ${e.message}`
      : "ERROR inesperado (sin detalles por seguridad)",
  );
  process.exit(2);
}
