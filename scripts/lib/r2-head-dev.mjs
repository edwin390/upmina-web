// HEAD de SOLO LECTURA contra Cloudflare R2 DEV (API S3). Lo ejecuta la persona operadora en su
// terminal. Solo importa HeadObjectCommand: no hay PUT/DELETE/LIST/COPY en este módulo.
// Nunca imprime credenciales, encabezados ni URLs firmadas.
import { readFileSync } from "node:fs";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";

export const ALLOWED_BUCKETS = Object.freeze([
  "upmina-media-dev-public",
  "upmina-media-dev-private",
]);

// Solo estas variables se leen de un --env-file; el resto del archivo se ignora.
export const ENV_NAMES = Object.freeze([
  "R2_DEV_ACCESS_KEY_ID",
  "R2_DEV_SECRET_ACCESS_KEY",
  "R2_DEV_ENDPOINT",
  "R2_DEV_PRIVATE_BUCKET",
  "R2_DEV_PUBLIC_BUCKET",
]);

const KEY_RE = /^(community|cosplay|staging|objects)\/[A-Za-z0-9._/-]+$/;

export class ConfigError extends Error {}

/** Lee solo ENV_NAMES de un archivo dotenv. No devuelve ni registra otras claves. */
export function readEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m || !ENV_NAMES.includes(m[1])) continue;
    out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

export function resolveConfig(env) {
  const missing = ENV_NAMES.filter((n) => !env[n]?.trim());
  if (missing.length) throw new ConfigError(`Faltan variables: ${missing.join(", ")}`);
  const endpoint = env.R2_DEV_ENDPOINT.trim();
  if (!/^https:\/\/[a-z0-9]{32}\.r2\.cloudflarestorage\.com\/?$/.test(endpoint)) {
    throw new ConfigError(
      "R2_DEV_ENDPOINT no tiene forma de endpoint S3 de Cloudflare R2",
    );
  }
  const pub = env.R2_DEV_PUBLIC_BUCKET.trim();
  const priv = env.R2_DEV_PRIVATE_BUCKET.trim();
  if (pub !== ALLOWED_BUCKETS[0] || priv !== ALLOWED_BUCKETS[1]) {
    throw new ConfigError("Los buckets configurados no son los de DEV permitidos");
  }
  return {
    endpoint,
    accessKeyId: env.R2_DEV_ACCESS_KEY_ID.trim(),
    secretAccessKey: env.R2_DEV_SECRET_ACCESS_KEY.trim(),
  };
}

export function validateTarget(bucket, key) {
  if (!ALLOWED_BUCKETS.includes(bucket))
    throw new ConfigError(`Bucket no permitido: ${bucket}`);
  if (
    !KEY_RE.test(key) ||
    key.includes("..") ||
    key.includes("//") ||
    key.endsWith("/")
  ) {
    throw new ConfigError(`Clave no válida o no soportada: ${key}`);
  }
}

/** Convierte el resultado/excepción de un HEAD en { state, http, detail }. */
export function classify(err, res) {
  if (!err) {
    const http = res?.$metadata?.httpStatusCode ?? 200;
    return { state: "EXISTS", http };
  }
  const http = err.$metadata?.httpStatusCode;
  if (http === 404 || err.name === "NotFound" || err.name === "NoSuchKey") {
    return { state: "NOT_FOUND", http: 404 };
  }
  if (http === 403)
    return {
      state: "ERROR",
      http,
      detail: "403 acceso denegado (credenciales o permisos)",
    };
  if (http === 401) return { state: "ERROR", http, detail: "401 no autenticado" };
  if (http) return { state: "ERROR", http, detail: `HTTP ${http}` };
  const code = typeof err.code === "string" ? err.code : "";
  if (
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR|TimeoutError/i.test(
      `${code} ${err.name}`,
    )
  ) {
    return { state: "ERROR", detail: `red (${code || err.name})` };
  }
  return { state: "ERROR", detail: `error de cliente (${err.name || "desconocido"})` };
}

/** `send` se inyecta en tests; por defecto usa un S3Client real. */
export async function headMany(targets, config, send) {
  let doSend = send;
  if (!doSend) {
    const client = new S3Client({
      region: "auto",
      endpoint: config.endpoint,
      forcePathStyle: true,
      maxAttempts: 2,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    doSend = (cmd) => client.send(cmd);
  }
  const rows = [];
  for (const { bucket, key } of targets) {
    validateTarget(bucket, key);
    try {
      const res = await doSend(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      rows.push({ bucket, key, ...classify(null, res) });
    } catch (e) {
      rows.push({ bucket, key, ...classify(e) });
    }
  }
  return rows;
}

export function formatRow(r) {
  return [r.bucket, r.key, r.state, r.http ?? "-", r.detail ?? ""].join(" | ");
}

/** Acepta líneas `bucket,key` o `public|private,key`; ignora vacías y #comentarios. */
export function parseTargets(text) {
  const alias = { public: ALLOWED_BUCKETS[0], private: ALLOWED_BUCKETS[1] };
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [b, k, ...rest] = line.split(",").map((s) => s.trim());
    if (!b || !k || rest.length)
      throw new ConfigError(`Línea no válida (se espera bucket,clave): ${line}`);
    out.push({ bucket: alias[b] ?? b, key: k });
  }
  return out;
}
