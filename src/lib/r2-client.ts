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

// Cliente R2 DEV, SOLO servidor (Fase 9I-2B). SDK S3 v3 modular (paquetes independientes, no el
// monolítico `aws-sdk` v2) apuntando al endpoint S3-compatible de R2. `forcePathStyle: true`
// porque R2 no resuelve automáticamente <bucket>.<endpoint> como un vhost DNS salvo que se
// configure aparte — direccionamiento por ruta es el modo recomendado para el SDK genérico.
//
// Fail-closed (Fase 9I-2, sección 7): getR2DevConfig() SIEMPRE lanza en un runtime de Production
// (VERCEL_ENV=production), incluso si las variables DEV estuvieran presentes por error. Hoy
// (9I-2B) no existe ninguna infraestructura de R2 de Production — esto no es una selección entre
// dos entornos, es un rechazo total en Production hasta que 9I-2 (fase de Production) exista.
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

interface R2DevConfig {
  client: S3Client;
  privateBucket: string;
  publicBucket: string;
  publicBaseUrl: string;
}

let cached: R2DevConfig | null = null;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new R2ConfigError("Configuración de R2 DEV incompleta");
  return value;
}

export function getR2DevConfig(): R2DevConfig {
  if (isProductionEnvironment()) {
    throw new R2ConfigError("Medios DEV no disponibles en Production");
  }
  if (cached) return cached;

  const accessKeyId = requiredEnv("R2_DEV_ACCESS_KEY_ID");
  const secretAccessKey = requiredEnv("R2_DEV_SECRET_ACCESS_KEY");
  const endpoint = requiredEnv("R2_DEV_ENDPOINT");
  const privateBucket = requiredEnv("R2_DEV_PRIVATE_BUCKET");
  const publicBucket = requiredEnv("R2_DEV_PUBLIC_BUCKET");
  const publicBaseUrl = requiredEnv("R2_DEV_PUBLIC_BASE_URL");

  const client = new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  cached = { client, privateBucket, publicBucket, publicBaseUrl };
  return cached;
}

/** SOLO tests: limpia la config cacheada tras cambiar/restaurar variables de entorno con
 *  vi.stubEnv, para que la siguiente llamada a getR2DevConfig() las vuelva a leer. */
export function resetR2DevConfigCache(): void {
  cached = null;
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
  const { client, privateBucket } = getR2DevConfig();
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
  const { client, privateBucket } = getR2DevConfig();
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
  const { client, privateBucket } = getR2DevConfig();
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
  const { client, privateBucket } = getR2DevConfig();
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
  const { client, privateBucket } = getR2DevConfig();
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
  const { client, privateBucket } = getR2DevConfig();
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
  const { client, privateBucket } = getR2DevConfig();
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
  const { client, privateBucket } = getR2DevConfig();
  await client.send(
    new CopyObjectCommand({
      Bucket: privateBucket,
      Key: destinationKey,
      CopySource: `${privateBucket}/${encodeURIComponent(sourceKey)}`,
    }),
  );
}

export async function deletePrivateObject(key: string): Promise<void> {
  const { client, privateBucket } = getR2DevConfig();
  await client.send(new DeleteObjectCommand({ Bucket: privateBucket, Key: key }));
}

// ---------- público: variantes canónicas ----------

export async function putPublicVariant(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const { client, publicBucket } = getR2DevConfig();
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

export async function deletePublicVariants(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const { client, publicBucket } = getR2DevConfig();
  await client.send(
    new DeleteObjectsCommand({
      Bucket: publicBucket,
      Delete: { Objects: keys.map((Key) => ({ Key })) },
    }),
  );
}

/** URL pública derivada SIEMPRE de R2_DEV_PUBLIC_BASE_URL (variable de servidor) — nunca de una
 *  base que el navegador proponga (Fase 9I-2, sección 27). */
export function publicVariantUrl(key: string): string {
  const { publicBaseUrl } = getR2DevConfig();
  return `${publicBaseUrl.replace(/\/+$/, "")}/${key}`;
}
