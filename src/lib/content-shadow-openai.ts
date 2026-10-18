// Backend only. Native HTTP exists solely here; tests inject an in-memory HTTP mock.
import {
  FakeModerationTransport,
  ShadowFault,
  SHADOW_MODEL,
  bounded,
  retryAfterSeconds,
  validateModerationResponse,
  type ModerationRequest,
  type ModerationTransport,
} from "./content-shadow-provider.js";

const ENDPOINT = "https://api.openai.com/v1/moderations";
export const OPENAI_RESPONSE_BYTES = 64 * 1024; // Internal bound, not a provider limit.
export const OPENAI_TIMEOUT_MS = 1800; // Below executor's two-second component bound.
type Environment = Readonly<Record<string, string | undefined>>;
type Options = { environment?: () => Environment; http?: typeof fetch };
export function assertOpenAIEnvironment(env: Environment): void {
  if (
    "window" in globalThis || // Runtime Node/Vercel: nunca en navegador (sin depender de los tipos DOM).
    env.CONTENT_SHADOW_PROVIDER !== "openai" ||
    env.CONTENT_SHADOW_RUN_ENABLED !== "true" ||
    env.CONTENT_SHADOW_BUDGET_MODE !== "persistent_dev" ||
    env.VERCEL !== "1" ||
    env.VERCEL_ENV !== "preview" ||
    env.VERCEL_PROJECT_ID !== "prj_fz4fs3FBfz2Gn4LH1Qnew18PpBrP" ||
    env.VITE_SUPABASE_URL !== "https://rkqeqbqwdswhpzwqptac.supabase.co"
  )
    throw new ShadowFault("auth_unavailable");
  const key = env.OPENAI_API_KEY;
  if (!key || !/^[\x21-\x7e]{10,512}$/.test(key))
    throw new ShadowFault("auth_unavailable");
}

// Cancel reads on abort even if a mock/non-cooperative reader ignores its fetch signal.
async function abortable<T>(op: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void op.catch(() => undefined);
    throw new ShadowFault("provider_timeout", true);
  }
  let abort: () => void = () => undefined;
  try {
    return await Promise.race([
      op,
      new Promise<never>((_, reject) => {
        abort = () => reject(new ShadowFault("provider_timeout", true));
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
async function cancel(response: Response): Promise<void> {
  // Do not await a non-cooperative stream cancellation indefinitely.
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    /* sanitized */
  }
}
async function readJSON(response: Response, signal: AbortSignal): Promise<unknown> {
  const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  const length = response.headers.get("content-length");
  if (
    type !== "application/json" ||
    (length !== null &&
      (!/^\d+$/.test(length) || Number(length) > OPENAI_RESPONSE_BYTES)) ||
    !response.body
  ) {
    await cancel(response);
    throw new ShadowFault("invalid_input");
  }
  const reader = response.body.getReader(),
    bytes = new Uint8Array(OPENAI_RESPONSE_BYTES);
  let used = 0;
  try {
    for (let chunks = 0; ; chunks++) {
      if (chunks >= 2048) throw new ShadowFault("invalid_input");
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      if (!(value instanceof Uint8Array) || used + value.byteLength > bytes.length)
        throw new ShadowFault("invalid_input");
      bytes.set(value, used);
      used += value.byteLength;
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)),
      );
    } catch {
      throw new ShadowFault("invalid_input");
    }
  } finally {
    bytes.fill(0);
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      /* sanitized */
    }
    reader.releaseLock();
  }
}
function payload(request: ModerationRequest): ModerationRequest {
  if (
    !request ||
    request.model !== SHADOW_MODEL ||
    !Array.isArray(request.input) ||
    request.input.length !== 1
  )
    throw new ShadowFault("invalid_input");
  const input = request.input[0];
  if (
    input?.type === "text" &&
    typeof input.text === "string" &&
    input.text.trim().length &&
    input.text.length <= 5000
  )
    return { model: SHADOW_MODEL, input: [{ type: "text", text: input.text }] };
  if (input?.type === "image_url" && typeof input.image_url?.url === "string") {
    const url = input.image_url.url,
      prefix = "data:image/webp;base64,";
    if (url.startsWith(prefix)) {
      const encoded = url.slice(prefix.length);
      const decoded =
        (encoded.length * 3) / 4 -
        (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
      if (
        encoded.length % 4 === 0 &&
        decoded >= 12 &&
        decoded <= 4 * 1024 * 1024 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
      )
        return {
          model: SHADOW_MODEL,
          input: [{ type: "image_url", image_url: { url } }],
        };
    }
  }
  throw new ShadowFault("invalid_input"); // Never accepts remote image URLs, audio or video.
}
const requiredCategories = [
  "harassment",
  "harassment/threatening",
  "hate",
  "hate/threatening",
  "illicit",
  "illicit/violent",
  "self-harm",
  "self-harm/intent",
  "self-harm/instructions",
  "sexual",
  "sexual/minors",
  "violence",
  "violence/graphic",
];
function validateOpenAI(raw: unknown, modality: "text" | "image"): void {
  const parsed = validateModerationResponse(raw, modality);
  if (
    !/^modr-[A-Za-z0-9_-]{1,120}$/.test(parsed.provider_response_id) ||
    !/^omni-moderation-(?:latest|\d{4}-\d{2}-\d{2})$/.test(parsed.model_returned) ||
    requiredCategories.some(
      (k) => typeof parsed.categories[k as keyof typeof parsed.categories] !== "boolean",
    ) ||
    parsed.flagged !== Object.values(parsed.categories).some((v) => v === true)
  )
    throw new ShadowFault("invalid_input");
}
function retryHeader(response: Response): string | undefined {
  const seconds = retryAfterSeconds(
    response.headers.get("retry-after") ?? undefined,
    Date.now(),
  );
  return seconds > 0 ? String(Math.min(Number.MAX_SAFE_INTEGER, seconds)) : undefined;
}

export class OpenAIModerationTransport implements ModerationTransport {
  readonly mode = "openai" as const;
  #environment: () => Environment;
  #http: typeof fetch;
  private constructor(options: Options) {
    this.#environment = options.environment ?? (() => process.env);
    assertOpenAIEnvironment(this.#environment());
    this.#http = options.http ?? globalThis.fetch;
  }
  static create(options: Options = {}): OpenAIModerationTransport {
    return new OpenAIModerationTransport(options);
  }
  assertReady(): void {
    assertOpenAIEnvironment(this.#environment());
  }
  async evaluate(request: ModerationRequest, signal: AbortSignal): Promise<unknown> {
    this.assertReady(); // Recheck flags/identity before every component.
    const body = payload(request);
    if (signal.aborted) throw new ShadowFault("provider_timeout", true);
    return bounded(
      async (local) => {
        const combined = AbortSignal.any([signal, local]);
        try {
          const env = this.#environment();
          assertOpenAIEnvironment(env); // Also recheck after bounded() schedules its microtask.
          const pending = this.#http(ENDPOINT, {
            method: "POST",
            redirect: "manual",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify(body),
            signal: combined,
          });
          // Late mock responses are discarded; native fetch aborts its own stream.
          void pending.then(
            (r) => {
              if (combined.aborted) void cancel(r);
            },
            () => undefined,
          );
          const response = await abortable(pending, combined);
          if (
            response.redirected ||
            (response.url && response.url !== ENDPOINT) ||
            (response.status >= 300 && response.status < 400)
          ) {
            await cancel(response);
            throw new ShadowFault("invalid_input");
          }
          if (!response.ok) {
            const retry = retryHeader(response);
            await cancel(response);
            if (response.status === 429)
              throw new ShadowFault("provider_rate_limit", true, retry ?? "60");
            if (response.status === 401 || response.status === 403)
              throw new ShadowFault("auth_unavailable");
            if (response.status >= 500)
              throw new ShadowFault("provider_unavailable", true, retry);
            if (response.status === 408)
              throw new ShadowFault("provider_timeout", true, retry);
            throw new ShadowFault("invalid_input");
          }
          const raw = await readJSON(response, combined);
          if (combined.aborted) throw new ShadowFault("provider_timeout", true);
          validateOpenAI(raw, body.input[0].type === "text" ? "text" : "image");
          return raw;
        } catch (error) {
          if (error instanceof ShadowFault) throw error;
          throw new ShadowFault(
            combined.aborted ? "provider_timeout" : "provider_unavailable",
            true,
          );
        }
      },
      OPENAI_TIMEOUT_MS,
      new ShadowFault("provider_timeout", true),
    );
  }
}
export function selectShadowTransport(
  options: Options = {},
): FakeModerationTransport | OpenAIModerationTransport {
  const env = (options.environment ?? (() => process.env))();
  if (env.CONTENT_SHADOW_PROVIDER === undefined || env.CONTENT_SHADOW_PROVIDER === "fake")
    return new FakeModerationTransport();
  if (env.CONTENT_SHADOW_PROVIDER !== "openai") throw new ShadowFault("auth_unavailable");
  return OpenAIModerationTransport.create(options);
}
