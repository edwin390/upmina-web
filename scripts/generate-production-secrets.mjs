#!/usr/bin/env node
// Genera los secretos NUEVOS de Production para Community (nunca se copian de DEV):
//   - par Ed25519 de capabilities de medios (PKCS#8 privada / SPKI pública, base64 estándar)
//   - MEDIA_CHECK_SHARED_SECRET, MEDIA_GC_SHARED_SECRET, ACCOUNT_DELETION_SHARED_SECRET
// Uso (PowerShell):  node scripts/generate-production-secrets.mjs --out C:\ruta\privada\upmina-prod-secrets
// - --out DEBE estar fuera del repositorio y NO existir todavía (se crea con permisos de usuario).
// - Escribe un archivo .env-style y un archivo con SOLO la clave pública. Por consola imprime únicamente la
//   clave pública y las rutas: JAMÁS un secreto.
// Exit: 0 ok · 2 uso/ruta inválidos.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function assertSafeOutDir(out, repoRoot = REPO_ROOT) {
  if (!out) throw new Error("Falta --out");
  const abs = resolve(out);
  const rel = relative(repoRoot, abs);
  const insideRepo = rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
  if (insideRepo) throw new Error("--out no puede estar dentro del repositorio");
  if (existsSync(abs)) throw new Error("--out ya existe: usa una ruta nueva");
  return abs;
}

export function generateSecrets(keyId = "prod-1") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const secret = () => randomBytes(48).toString("base64url");
  return {
    keyId,
    publicSpki: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    env: {
      MEDIA_CAP_SIGNING_PRIVATE_KEY: privateKey
        .export({ format: "der", type: "pkcs8" })
        .toString("base64"),
      MEDIA_CAP_KEY_ID: keyId,
      MEDIA_CHECK_SHARED_SECRET: secret(),
      MEDIA_GC_SHARED_SECRET: secret(),
      ACCOUNT_DELETION_SHARED_SECRET: secret(),
    },
  };
}

function main() {
  const i = process.argv.indexOf("--out");
  const dir = assertSafeOutDir(i > -1 ? process.argv[i + 1] : undefined);
  const { keyId, publicSpki, env } = generateSecrets();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "production-secrets.env"),
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  writeFileSync(
    join(dir, "media-cap-public-keys.json"),
    JSON.stringify({ [keyId]: publicSpki }) + "\n",
  );
  console.log(
    `Secretos escritos en: ${join(dir, "production-secrets.env")} (no se muestran).`,
  );
  console.log(`MEDIA_CAP_KEY_ID=${keyId}`);
  console.log(`MEDIA_CAP_PUBLIC_KEYS=${JSON.stringify({ [keyId]: publicSpki })}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`ERROR: ${e instanceof Error ? e.message : "inesperado"}`);
    process.exit(2);
  }
}
