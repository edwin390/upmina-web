#!/usr/bin/env node
// Uso (PowerShell, desde la raíz del repo):
//   node scripts/r2-head-dev.mjs --env-file .env.local --keys-file evidence/before.csv
// Variables R2_DEV_* desde el entorno actual o, si faltan, desde --env-file (solo esas 5 variables).
// Archivo de claves: una línea por objeto -> bucket,clave   (bucket = public | private | nombre completo)
// Exit: 0 = todo consultado sin ERROR · 1 = hubo ERROR · 2 = configuración/uso inválido.
import { readFileSync } from "node:fs";
import {
  ConfigError,
  ENV_NAMES,
  formatRow,
  headMany,
  parseTargets,
  readEnvFile,
  resolveConfig,
} from "./lib/r2-head-dev.mjs";

function parseArgs(argv) {
  const a = { envFile: null, keysFile: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env-file") a.envFile = argv[++i];
    else if (argv[i] === "--keys-file") a.keysFile = argv[++i];
    else throw new ConfigError(`Argumento desconocido: ${argv[i]}`);
  }
  if (!a.keysFile) throw new ConfigError("Falta --keys-file");
  return a;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const env = {};
  for (const n of ENV_NAMES) if (process.env[n]) env[n] = process.env[n];
  if (args.envFile)
    for (const [k, v] of Object.entries(readEnvFile(args.envFile))) env[k] ??= v;
  const config = resolveConfig(env);
  const targets = parseTargets(readFileSync(args.keysFile, "utf8"));
  if (!targets.length) throw new ConfigError("El archivo de claves está vacío");
  console.log(
    `# HEAD de solo lectura · ${new Date().toISOString()} · ${targets.length} objetos`,
  );
  const rows = await headMany(targets, config);
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
