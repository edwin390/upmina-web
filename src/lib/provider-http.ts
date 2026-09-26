// Primitivas de fiabilidad para las peticiones SALIENTES a proveedores externos (Twitch, YouTube).
// Solo servidor: nada de este módulo debe importarse desde src/components ni src/hooks.
//
// Qué resuelve, y solo eso:
//   - timeout explícito que ABORTA la petición (cabeceras y lectura del cuerpo incluidas);
//   - una clasificación mínima del fallo (ProviderFailureKind) para que los adaptadores decidan
//     igual ante un timeout, un 429, un 5xx, un fallo de red o una respuesta ilegible;
//   - lectura segura de Retry-After (delta-segundos o HTTP-date, acotada); NUNCA se espera dentro
//     de la petición ni se reintenta automáticamente un 429.
//
// Seguridad: los mensajes de error los construye quien llama, con el nombre de la operación; este
// módulo nunca incorpora la URL (Google lleva la API key en la query), el error original de fetch
// ni el cuerpo del proveedor. Instagram y TikTok ya usan AbortSignal.timeout con su propia
// clasificación y no dependen de este módulo.
import type { VercelResponse } from "@vercel/node";

/** Timeout por petición saliente. Explícito y único punto donde se ajusta. */
export const PROVIDER_REQUEST_TIMEOUT_MS = 8_000;

/** Longitud máxima del texto de un proveedor que llega a un mensaje o a un log. */
export const MAX_PROVIDER_TEXT_LENGTH = 200;

/** Retry-After mayor que esto (1 h) se considera no fiable y se descarta. */
export const MAX_RETRY_AFTER_SECONDS = 3_600;

export type ProviderFailureKind =
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_REJECTED"
  | "NETWORK_ERROR"
  | "INVALID_RESPONSE";

/**
 * Error de una función que atiende un endpoint público. `status` es el que responde NUESTRA
 * función (no el del proveedor). `code` solo existe cuando el fallo tiene una semántica pública
 * estable (timeout, límite de tasa); en el resto el cuerpo público queda como siempre.
 */
export class ProviderApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** Segundos hasta poder reintentar, ya validados y acotados. Solo para 429. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ProviderApiError";
  }
}

const PUBLIC_STATUS: Record<ProviderFailureKind, number> = {
  TIMEOUT: 504,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 502,
  UPSTREAM_REJECTED: 502,
  NETWORK_ERROR: 502,
  INVALID_RESPONSE: 502,
};

const PUBLIC_CODE: Partial<Record<ProviderFailureKind, string>> = {
  TIMEOUT: "provider_timeout",
  RATE_LIMITED: "provider_rate_limited",
};

/** Fallo de una petición a un proveedor, ya clasificado. El mensaje no contiene URLs ni cuerpos. */
export class ProviderRequestError extends ProviderApiError {
  constructor(
    readonly kind: ProviderFailureKind,
    message: string,
    options: {
      /** Status HTTP del proveedor, si hubo respuesta. */
      httpStatus?: number;
      retryAfterSeconds?: number;
    } = {},
  ) {
    super(message, PUBLIC_STATUS[kind], PUBLIC_CODE[kind], options.retryAfterSeconds);
    this.name = "ProviderRequestError";
    this.httpStatus = options.httpStatus;
  }

  readonly httpStatus?: number;
}

/** Clasificación de una respuesta NO exitosa por su status HTTP. */
export function classifyProviderStatus(status: number): ProviderFailureKind {
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "UPSTREAM_UNAVAILABLE";
  return "UPSTREAM_REJECTED";
}

const HTTP_DATE = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const DELTA_SECONDS = /^\d{1,7}$/;

/**
 * Retry-After → segundos enteros o undefined. Acepta delta-segundos (`120`) y HTTP-date. Rechaza
 * (undefined) lo ausente, malformado, negativo, no finito, ya pasado o mayor que
 * MAX_RETRY_AFTER_SECONDS: nunca se propaga un valor que el proveedor no haya dado en forma válida.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();

  let seconds: number;
  if (DELTA_SECONDS.test(text)) {
    seconds = Number(text);
  } else if (HTTP_DATE.test(text)) {
    const at = Date.parse(text);
    if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return undefined;
    seconds = Math.ceil((at - nowMs) / 1000);
  } else {
    return undefined;
  }

  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_RETRY_AFTER_SECONDS) {
    return undefined;
  }
  return seconds;
}

/**
 * Error clasificado para una respuesta NO exitosa (`!response.ok`). `message` lo escribe quien
 * llama (operación y status, nunca la URL ni el cuerpo del proveedor).
 */
export function providerErrorFromResponse(
  response: Pick<Response, "status" | "headers">,
  message: string,
  nowMs?: number,
): ProviderRequestError {
  const kind = classifyProviderStatus(response.status);
  return new ProviderRequestError(kind, message, {
    httpStatus: response.status,
    retryAfterSeconds:
      kind === "RATE_LIMITED"
        ? parseRetryAfter(response.headers?.get("retry-after"), nowMs)
        : undefined,
  });
}

// ---------- Plazo total de una operación con varias peticiones ----------

/**
 * Plazo TOTAL de una operación que encadena varias peticiones (p. ej. los clips de Twitch). El
 * timeout por petición no basta: N peticiones lentas suman N veces ese timeout. El reloj es
 * inyectable (por defecto Date.now, que un reloj falso controla en los tests).
 */
export interface Deadline {
  /** Milisegundos que quedan (nunca negativo). */
  remainingMs(): number;
}

export function createDeadline(totalMs: number, now: () => number = Date.now): Deadline {
  const end = now() + totalMs;
  return { remainingMs: () => Math.max(0, end - now()) };
}

/**
 * Timeout de UNA petición dentro de un plazo total: el menor entre el máximo por petición y lo que
 * queda del plazo, de modo que ninguna petición sobrevive al plazo. Si el plazo ya se agotó lanza
 * TIMEOUT ANTES de iniciar la petición: nunca se empieza una más después de agotar el presupuesto.
 * Sin plazo devuelve el máximo por petición.
 */
export function requestTimeoutWithin(
  operation: string,
  deadline: Deadline | undefined,
  perRequestMs: number = PROVIDER_REQUEST_TIMEOUT_MS,
): number {
  if (!deadline) return perRequestMs;
  const remaining = deadline.remainingMs();
  if (remaining <= 0) {
    throw new ProviderRequestError("TIMEOUT", `${operation}: plazo total agotado`);
  }
  return Math.min(perRequestMs, remaining);
}

// ---------- Texto controlado por el proveedor ----------

/** Caracteres de control C0/C1 y separadores de línea/párrafo Unicode (inyección de líneas en logs). */
function isControlChar(code: number): boolean {
  return (
    code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
  );
}

/** Sustituye cada carácter de control por un espacio (recorre puntos de código: sin regex). */
function stripControlChars(text: string): string {
  let out = "";
  for (const char of text) {
    out += isControlChar(char.codePointAt(0) ?? 0) ? " " : char;
  }
  return out;
}

const URL_TEXT = /https?:\/\/\S+/gi;
const BEARER_TEXT = /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi;
const CREDENTIAL_PAIR =
  /\b(authorization|access_token|refresh_token|client_secret|client_id|api[_-]?key|token|secret|password|key)\s*[:=]\s*[^\s,;"']+/gi;
const OPAQUE_LONG = /[A-Za-z0-9_\-+/=.]{32,}/g;
/** Se recorta antes de aplicar las expresiones regulares: acota su coste con textos enormes. */
const SANITIZE_INPUT_CAP = 1_000;

/**
 * Texto de un proveedor apto para un mensaje de error o un log: sin caracteres de control (evita
 * inyectar líneas), sin URLs, sin pares credencial=valor, sin cadenas opacas largas (tokens/JWT),
 * sin los `secrets` exactos indicados y acotado a `maxLength`. Conserva el resto del texto como
 * diagnóstico. Nunca lanza.
 */
export function sanitizeProviderText(
  value: unknown,
  options: { maxLength?: number; secrets?: readonly string[] } = {},
): string {
  const maxLength = options.maxLength ?? MAX_PROVIDER_TEXT_LENGTH;
  let text = typeof value === "string" ? value : "";

  for (const secret of options.secrets ?? []) {
    if (secret.length >= 6) text = text.split(secret).join("[redacted]");
  }

  text = stripControlChars(text.slice(0, SANITIZE_INPUT_CAP))
    .replace(URL_TEXT, "[url]")
    .replace(BEARER_TEXT, "Bearer [redacted]")
    .replace(CREDENTIAL_PAIR, "$1=[redacted]")
    .replace(OPAQUE_LONG, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();

  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

/** Un status "sin cuerpo" no admite cuerpo en el constructor de Response. */
const isNullBodyStatus = (status: number) =>
  status === 101 || status === 204 || status === 205 || status === 304;

/**
 * fetch con timeout REAL: al vencer aborta la petición, incluida la lectura del cuerpo (por eso
 * el cuerpo se lee aquí y se devuelve una Response equivalente ya completa: los llamadores siguen
 * usando `.ok`, `.status` y `.json()`). El temporizador y el listener de `init.signal` se limpian
 * siempre. Si quien llama aborta con su propia señal, ese error se propaga tal cual.
 *
 * Lanza ProviderRequestError TIMEOUT o NETWORK_ERROR. `operation` es un texto sin URL.
 */
export async function fetchWithTimeout(
  operation: string,
  url: string,
  init: RequestInit = {},
  timeoutMs: number = PROVIDER_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const outer = init.signal;
  const onOuterAbort = () => controller.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) onOuterAbort();
    else outer.addEventListener("abort", onOuterAbort, { once: true });
  }

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = isNullBodyStatus(response.status) ? null : await response.text();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (err) {
    if (timedOut) {
      throw new ProviderRequestError(
        "TIMEOUT",
        `${operation}: tiempo de espera agotado (${timeoutMs / 1000} s)`,
      );
    }
    if (outer?.aborted) throw err;
    throw new ProviderRequestError("NETWORK_ERROR", `${operation}: error de red`);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}

/** JSON de una respuesta ya recibida; un cuerpo ilegible es INVALID_RESPONSE (nunca se expone). */
export async function readProviderJson<T>(
  response: Pick<Response, "json">,
  operation: string,
): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new ProviderRequestError(
      "INVALID_RESPONSE",
      `${operation}: respuesta no válida`,
    );
  }
}

/**
 * Respuesta de error de un endpoint público. Cuerpo `{ error }` (más `code` solo si el fallo lo
 * tiene: timeout o límite de tasa); en un 429 añade `Retry-After` si el valor era válido. Un error
 * que no es de proveedor usa `fallbackStatus`.
 */
export function sendProviderFailure(
  res: VercelResponse,
  err: unknown,
  message: string,
  fallbackStatus = 502,
): VercelResponse {
  if (!(err instanceof ProviderApiError)) {
    return res.status(fallbackStatus).json({ error: message });
  }
  if (err.status === 429 && err.retryAfterSeconds !== undefined) {
    res.setHeader("Retry-After", String(err.retryAfterSeconds));
  }
  return res
    .status(err.status)
    .json(err.code ? { error: message, code: err.code } : { error: message });
}
