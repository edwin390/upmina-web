import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { isProductionEnvironment } from "./instagram-oauth-shared.js";

// Cliente R2, SOLO servidor (Fase 9I-2B; soporte de Production añadido en el release 9I). SDK S3
// v3 modular (paquetes independientes, no el monolítico `aws-sdk` v2) apuntando al endpoint
// S3-compatible de R2. `forcePathStyle: true` porque R2 no resuelve automáticamente
// <bucket>.<endpoint> como un vhost DNS salvo que se configure aparte — direccionamiento por ruta
// es el modo recomendado para el SDK genérico.
//
// Fail-closed simétrico en ambos sentidos: getR2DevConfig() SIEMPRE lanza en un runtime de
// Production (VERCEL_ENV=production), incluso si las variables DEV estuvieran presentes por
// error; getR2ProdConfig() SIEMPRE lanza FUERA de Production, incluso si las variables
// R2_PROD_* estuvieran presentes por error. Ningún entorno puede usar accidentalmente la
// configuración del otro, y Production NUNCA hace fallback a R2_DEV_* si falta una variable
// R2_PROD_* — simplemente falla. getActiveR2Config() (más abajo) es el ÚNICO punto que decide
// cuál usar; las operaciones de R2 nunca deciden esto por su cuenta. La infraestructura real de
// R2 de Production (buckets, credenciales) puede seguir sin existir todavía — este cambio es
// solo el soporte de código, fail-closed por diseño hasta que esas variables se configuren.
//
// Las credenciales nunca llegan al navegador: solo se usan aquí para (a) operaciones server-side
// (HEAD/GET/COPY/DELETE/crear-completar-abortar multipart) y (b) firmar URLs de corta duración
// que el navegador usa directamente contra R2 (PUT de un solo objeto o de una parte de
// multipart) — la firma nunca viaja con la URL de vuelta al servidor ni se registra.

export class R2ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "R2ConfigError";
  }
}

/** 15 minutos: bastante para que un PUT de hasta ~16 MiB termine en una conexión lenta, corto
 *  para no dejar URLs de subida reutilizables durante horas (Fase 9I-2, sección 16). */
export const PRESIGN_TTL_SINGLE_PUT_SECONDS = 900;
/** 30 minutos: una parte de multipart (8 MiB) puede reintentarse; la ventana es mayor que la del
 *  PUT único porque un archivo grande implica más partes y más tiempo total de subida. */
export const PRESIGN_TTL_MULTIPART_PART_SECONDS = 1800;

interface R2RuntimeConfig {
  client: S3Client;
  privateBucket: string;
  publicBucket: string;
  publicBaseUrl: string;
}

let cachedDev: R2RuntimeConfig | null = null;
let cachedProd: R2RuntimeConfig | null = null;

function requiredEnv(name: string, errorMessage: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new R2ConfigError(errorMessage);
  return value;
}

export function getR2DevConfig(): R2RuntimeConfig {
  if (isProductionEnvironment()) {
    throw new R2ConfigError("Medios DEV no disponibles en Production");
  }
  if (cachedDev) return cachedDev;

  const accessKeyId = requiredEnv(
    "R2_DEV_ACCESS_KEY_ID",
    "Configuración de R2 DEV incompleta",
  );
  const secretAccessKey = requiredEnv(
    "R2_DEV_SECRET_ACCESS_KEY",
    "Configuración de R2 DEV incompleta",
  );
  const endpoint = requiredEnv("R2_DEV_ENDPOINT", "Configuración de R2 DEV incompleta");
  const privateBucket = requiredEnv(
    "R2_DEV_PRIVATE_BUCKET",
    "Configuración de R2 DEV incompleta",
  );
  const publicBucket = requiredEnv(
    "R2_DEV_PUBLIC_BUCKET",
    "Configuración de R2 DEV incompleta",
  );
  const publicBaseUrl = requiredEnv(
    "R2_DEV_PUBLIC_BASE_URL",
    "Configuración de R2 DEV incompleta",
  );

  const client = new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  cachedDev = { client, privateBucket, publicBucket, publicBaseUrl };
  return cachedDev;
}

/** Config R2 de PRODUCTION (soporte de código añadido en el release 9I): SOLO server-side, SOLO
 *  cuando VERCEL_ENV=production. Nunca lee ninguna variable R2_DEV_*, nunca hace fallback a DEV
 *  si falta una variable R2_PROD_* — falla cerrado, igual que getR2DevConfig() falla cerrado en
 *  Production. Simétrica a propósito: fuera de Production, SIEMPRE lanza (defensa en
 *  profundidad — un entorno nunca puede usar por accidente la configuración del otro). */
export function getR2ProdConfig(): R2RuntimeConfig {
  if (!isProductionEnvironment()) {
    throw new R2ConfigError("Medios de Production no disponibles fuera de Production");
  }
  if (cachedProd) return cachedProd;

  const accessKeyId = requiredEnv(
    "R2_PROD_ACCESS_KEY_ID",
    "Configuración de R2 Production incompleta",
  );
  const secretAccessKey = requiredEnv(
    "R2_PROD_SECRET_ACCESS_KEY",
    "Configuración de R2 Production incompleta",
  );
  const endpoint = requiredEnv(
    "R2_PROD_ENDPOINT",
    "Configuración de R2 Production incompleta",
  );
  const privateBucket = requiredEnv(
    "R2_PROD_PRIVATE_BUCKET",
    "Configuración de R2 Production incompleta",
  );
  const publicBucket = requiredEnv(
    "R2_PROD_PUBLIC_BUCKET",
    "Configuración de R2 Production incompleta",
  );
  const publicBaseUrl = requiredEnv(
    "R2_PROD_PUBLIC_BASE_URL",
    "Configuración de R2 Production incompleta",
  );

  const client = new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  cachedProd = { client, privateBucket, publicBucket, publicBaseUrl };
  return cachedProd;
}

/** Único punto de decisión DEV vs Production para las operaciones de más abajo — ellas nunca
 *  inspeccionan VERCEL_ENV por su cuenta. En Production usa EXCLUSIVAMENTE getR2ProdConfig()
 *  (nunca getR2DevConfig(), nunca R2_DEV_*); fuera de Production usa getR2DevConfig() sin
 *  cambios respecto al comportamiento previo a este release. */
function getActiveR2Config(): R2RuntimeConfig {
  return isProductionEnvironment() ? getR2ProdConfig() : getR2DevConfig();
}

/** SOLO tests: limpia la config DEV cacheada tras cambiar/restaurar variables de entorno con
 *  vi.stubEnv, para que la siguiente llamada a getR2DevConfig() las vuelva a leer. */
export function resetR2DevConfigCache(): void {
  cachedDev = null;
}

/** SOLO tests: mismo propósito que resetR2DevConfigCache(), para la config de Production. */
export function resetR2ProdConfigCache(): void {
  cachedProd = null;
}

function isNotFoundError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  const status = (err as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata
    ?.httpStatusCode;
  return name === "NotFound" || name === "NoSuchKey" || status === 404;
}

// ---------- privado: staging/objects ----------

export function presignPrivatePut(
  key: string,
  contentType: string,
  expiresIn: number = PRESIGN_TTL_SINGLE_PUT_SECONDS,
): Promise<string> {
  const { client, privateBucket } = getActiveR2Config();
  const command = new PutObjectCommand({
    Bucket: privateBucket,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(client, command, { expiresIn });
}

export async function createPrivateMultipartUpload(
  key: string,
  contentType: string,
): Promise<string> {
  const { client, privateBucket } = getActiveR2Config();
  const result = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: privateBucket,
      Key: key,
      ContentType: contentType,
    }),
  );
  if (!result.UploadId) throw new R2ConfigError("R2 no devolvió UploadId");
  return result.UploadId;
}

export function presignPrivateUploadPart(
  key: string,
  uploadId: string,
  partNumber: number,
  expiresIn: number = PRESIGN_TTL_MULTIPART_PART_SECONDS,
): Promise<string> {
  const { client, privateBucket } = getActiveR2Config();
  const command = new UploadPartCommand({
    Bucket: privateBucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  });
  return getSignedUrl(client, command, { expiresIn });
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export async function completePrivateMultipartUpload(
  key: string,
  uploadId: string,
  parts: CompletedPart[],
): Promise<void> {
  const { client, privateBucket } = getActiveR2Config();
  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: privateBucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
      },
    }),
  );
}

export async function abortPrivateMultipartUpload(
  key: string,
  uploadId: string,
): Promise<void> {
  const { client, privateBucket } = getActiveR2Config();
  await client.send(
    new AbortMultipartUploadCommand({
      Bucket: privateBucket,
      Key: key,
      UploadId: uploadId,
    }),
  );
}

export interface HeadResult {
  bytes: number;
  contentType: string | null;
}

/** null = el objeto no existe (nunca se distingue de otro 404 más específico: quien llama solo
 *  necesita saber "¿está ahí o no?"). Cualquier otro fallo se relanza. */
export async function headPrivateObject(key: string): Promise<HeadResult | null> {
  const { client, privateBucket } = getActiveR2Config();
  try {
    const result = await client.send(
      new HeadObjectCommand({ Bucket: privateBucket, Key: key }),
    );
    return { bytes: result.ContentLength ?? 0, contentType: result.ContentType ?? null };
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

export async function getPrivateObjectBytes(key: string): Promise<Buffer> {
  const { client, privateBucket } = getActiveR2Config();
  const result = await client.send(
    new GetObjectCommand({ Bucket: privateBucket, Key: key }),
  );
  if (!result.Body) throw new R2ConfigError("Objeto privado sin cuerpo");
  return Buffer.from(await result.Body.transformToByteArray());
}

export async function copyPrivateObject(
  sourceKey: string,
  destinationKey: string,
): Promise<void> {
  const { client, privateBucket } = getActiveR2Config();
  await client.send(
    new CopyObjectCommand({
      Bucket: privateBucket,
      Key: destinationKey,
      CopySource: `${privateBucket}/${encodeURIComponent(sourceKey)}`,
    }),
  );
}

export async function deletePrivateObject(key: string): Promise<void> {
  const { client, privateBucket } = getActiveR2Config();
  await client.send(new DeleteObjectCommand({ Bucket: privateBucket, Key: key }));
}

/** Copia un objeto PRIVADO (objects/) directamente al bucket PÚBLICO, servidor-a-servidor dentro
 *  de R2 — los bytes nunca pasan por la función de Vercel (Fase 9J-3, sección 25 del checkpoint:
 *  "prefer direct public R2 delivery... do not build a proxy through Vercel unless absolutely
 *  necessary"). Usado SOLO para vídeo: a diferencia de una imagen (que SIEMPRE se decodifica y
 *  recomprime a WebP vía putPublicVariant, con los bytes en memoria del proceso), el vídeo
 *  original se sirve tal cual — cargar hasta 100 MB en la función solo para volver a subirlos
 *  sería un desperdicio de tiempo de ejecución y memoria sin ningún beneficio. `contentType` se
 *  fija explícitamente (MetadataDirective: "REPLACE") para que el objeto público sirva el MIME
 *  real del vídeo en vez de heredar el que R2 infiera del objeto privado. */
export async function copyPrivateObjectToPublic(
  sourceKey: string,
  destinationKey: string,
  contentType: string,
): Promise<void> {
  const { client, privateBucket, publicBucket } = getActiveR2Config();
  await client.send(
    new CopyObjectCommand({
      Bucket: publicBucket,
      Key: destinationKey,
      CopySource: `${privateBucket}/${encodeURIComponent(sourceKey)}`,
      ContentType: contentType,
      MetadataDirective: "REPLACE",
      // Igual que putPublicVariant: inmutable a propósito, la clave incluye el assetId así que un
      // objeto publicado nunca se sobrescribe con bytes distintos.
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
}

// ---------- público: variantes canónicas ----------

export async function putPublicVariant(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const { client, publicBucket } = getActiveR2Config();
  await client.send(
    new PutObjectCommand({
      Bucket: publicBucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      // Inmutable a propósito (Fase 9I-2, sección 27): la clave cambia si el contenido cambia
      // (nuevo assetId), así que un objeto publicado nunca se sobrescribe con bytes distintos.
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
}

/** DeleteObjects responde 200 aunque algunas claves fallen: el fallo viaja en `Errors[]`. Un éxito
 *  HTTP NO es un éxito de borrado (R4-E2). Solo expone un recuento: nunca claves ni el cuerpo del
 *  proveedor. */
export class R2PartialDeleteError extends Error {
  readonly failedCount: number;
  constructor(failedCount: number) {
    super("R2 DeleteObjects reported per-key errors");
    this.name = "R2PartialDeleteError";
    this.failedCount = failedCount;
  }
}

/** Borra objetos del bucket PÚBLICO. Una clave ya inexistente (NoSuchKey) es éxito idempotente;
 *  cualquier otro error por clave lanza R2PartialDeleteError. */
export async function deletePublicVariants(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const { client, publicBucket } = getActiveR2Config();
  const response = await client.send(
    new DeleteObjectsCommand({
      Bucket: publicBucket,
      Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: false },
    }),
  );
  const failed = (response.Errors ?? []).filter((e) => e.Code !== "NoSuchKey");
  if (failed.length > 0) throw new R2PartialDeleteError(failed.length);
}

/** URL pública derivada SIEMPRE de la base pública configurada server-side (R2_DEV_PUBLIC_BASE_URL
 *  fuera de Production, R2_PROD_PUBLIC_BASE_URL en Production, vía getActiveR2Config()) — nunca
 *  de una base que el navegador proponga (Fase 9I-2, sección 27). */
export function publicVariantUrl(key: string): string {
  const { publicBaseUrl } = getActiveR2Config();
  return `${publicBaseUrl.replace(/\/+$/, "")}/${key}`;
}
