// Comprobación de SOLO LECTURA de sesiones multipart abiertas en R2 DEV (bucket privado).
// Solo importa ListMultipartUploads y ListParts: ninguna operación de escritura en este módulo.
// Nunca imprime credenciales, ETags, URLs firmadas ni el UploadId completo: solo los 6 últimos
// caracteres, una HUELLA estable (SHA-256, 12 hex) y su longitud, para comparar sesiones entre
// ejecuciones y con el identificador guardado en Supabase sin revelarlo.
import { createHash } from "node:crypto";
import {
  ListMultipartUploadsCommand,
  ListPartsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { ConfigError, classify } from "./r2-head-dev.mjs";

export const PRIVATE_BUCKET = "upmina-media-dev-private";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Prefijo de búsqueda: `staging/community/<assetId>/` o, sin asset, `staging/community/`. */
export function buildPrefix(assetId) {
  if (assetId === undefined || assetId === null) return "staging/community/";
  if (!UUID_RE.test(assetId))
    throw new ConfigError("assetId no es un UUID en minúsculas");
  return `staging/community/${assetId}/`;
}

export function shortId(uploadId) {
  return `…${String(uploadId ?? "").slice(-6)}`;
}

/** Huella estable del identificador completo (no reversible a efectos prácticos; 48 bits). */
export function fingerprint(uploadId) {
  return createHash("sha256")
    .update(String(uploadId ?? ""), "utf8")
    .digest("hex")
    .slice(0, 12);
}

/** `send` se inyecta en tests. Devuelve filas { state, ... } sin datos sensibles. */
export async function checkSessions({ prefix, config, send, expectedUploadId }) {
  if (
    expectedUploadId !== undefined &&
    (typeof expectedUploadId !== "string" ||
      expectedUploadId.length < 1 ||
      expectedUploadId.length > 2048)
  ) {
    throw new ConfigError("El identificador esperado no es válido");
  }
  if (!/^staging\/community\/([0-9a-f-]{36}\/)?$/.test(prefix)) {
    throw new ConfigError("Prefijo no permitido");
  }
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
  try {
    const res = await doSend(
      new ListMultipartUploadsCommand({
        Bucket: PRIVATE_BUCKET,
        Prefix: prefix,
        MaxUploads: 1000,
      }),
    );
    const uploads = res.Uploads ?? [];
    const rows = [];
    for (const u of uploads) {
      let parts = 0;
      let bytes = 0;
      const pr = await doSend(
        new ListPartsCommand({
          Bucket: PRIVATE_BUCKET,
          Key: u.Key,
          UploadId: u.UploadId,
          MaxParts: 1000,
        }),
      );
      for (const p of pr.Parts ?? []) {
        parts += 1;
        bytes += p.Size ?? 0;
      }
      rows.push({
        state: "OPEN_SESSION",
        key: u.Key,
        initiated: u.Initiated ? new Date(u.Initiated).toISOString() : "-",
        upload: shortId(u.UploadId),
        fp: fingerprint(u.UploadId),
        len: String(u.UploadId ?? "").length,
        matchesExpected:
          expectedUploadId === undefined ? null : u.UploadId === expectedUploadId,
        parts,
        bytes,
        truncated: Boolean(pr.IsTruncated),
      });
    }
    if (rows.length === 0) rows.push({ state: "NO_OPEN_SESSION", key: prefix });
    if (expectedUploadId !== undefined) {
      // Lectura: ¿el identificador esperado (el de Supabase) direcciona una sesión viva de la clave?
      const keys = [...new Set(uploads.map((u) => u.Key))];
      const base = {
        state: "EXPECTED_ID",
        fp: fingerprint(expectedUploadId),
        len: expectedUploadId.length,
      };
      if (keys.length === 0)
        rows.push({ ...base, key: prefix, result: "NOT_CHECKED_NO_LISTED_KEY" });
      for (const key of keys) {
        try {
          const pr = await doSend(
            new ListPartsCommand({
              Bucket: PRIVATE_BUCKET,
              Key: key,
              UploadId: expectedUploadId,
              MaxParts: 1000,
            }),
          );
          rows.push({
            ...base,
            key,
            result: "VALID_SESSION",
            parts: (pr.Parts ?? []).length,
          });
        } catch (e) {
          const c = classify(e);
          const noSuch = e?.name === "NoSuchUpload" || e?.Code === "NoSuchUpload";
          rows.push({
            ...base,
            key,
            result: noSuch ? "NO_SUCH_UPLOAD" : "ERROR",
            http: c.http,
            detail: noSuch ? undefined : (c.detail ?? c.state),
          });
        }
      }
    }
    if (res.IsTruncated)
      rows.push({ state: "ERROR", key: prefix, detail: "lista truncada (>1000)" });
    return rows;
  } catch (e) {
    const c = classify(e);
    return [{ state: "ERROR", key: prefix, http: c.http, detail: c.detail ?? c.state }];
  }
}

export function formatRow(r) {
  if (r.state === "OPEN_SESSION") {
    const match =
      r.matchesExpected === null || r.matchesExpected === undefined
        ? ""
        : ` | match_expected=${r.matchesExpected ? "yes" : "no"}`;
    return `${PRIVATE_BUCKET} | ${r.key} | OPEN_SESSION | initiated=${r.initiated} | upload=${r.upload} | fp=${r.fp} | len=${r.len} | parts=${r.parts} | bytes=${r.bytes}${r.truncated ? " (partes truncadas)" : ""}${match}`;
  }
  if (r.state === "EXPECTED_ID") {
    return `${PRIVATE_BUCKET} | ${r.key} | EXPECTED_ID | fp=${r.fp} | len=${r.len} | result=${r.result}${r.parts !== undefined ? ` | parts=${r.parts}` : ""}${r.detail ? ` | ${r.http ?? "-"} ${r.detail}` : ""}`;
  }
  if (r.state === "NO_OPEN_SESSION")
    return `${PRIVATE_BUCKET} | ${r.key} | NO_OPEN_SESSION`;
  return `${PRIVATE_BUCKET} | ${r.key} | ERROR | ${r.http ?? "-"} | ${r.detail ?? ""}`;
}
