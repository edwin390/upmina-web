// Shared server-side contract. Native provider HTTP is isolated in content-shadow-openai.ts.
import type { ShadowErrorCode, ShadowResultInput } from "./content-shadow-contract.js";

export const SHADOW_MODEL = "omni-moderation-latest";
export class ShadowFault extends Error {
  constructor(
    readonly code: ShadowErrorCode,
    readonly retryable = false,
    readonly retryAfter?: string,
  ) {
    super(code); // Never retain raw provider/storage errors or content.
  }
}
export type ModerationInput =
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export interface ModerationRequest {
  model: typeof SHADOW_MODEL;
  input: [ModerationInput];
}
export interface ModerationTransport {
  readonly mode: "simulated" | "openai";
  evaluate(request: ModerationRequest, signal: AbortSignal): Promise<unknown>;
}
const categories = [
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
const textOnly = new Set(categories.slice(0, 6).concat("sexual/minors"));
const object = (x: unknown): Record<string, unknown> => {
  if (!x || typeof x !== "object" || Array.isArray(x))
    throw new ShadowFault("invalid_input");
  return x as Record<string, unknown>;
};
type Success = Extract<ShadowResultInput, { state: "succeeded" }>;
export function validateModerationResponse(
  raw: unknown,
  modality?: "text" | "image",
): Omit<Success, "component_kind" | "asset_id"> {
  const root = object(raw);
  if (
    typeof root.id !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(root.id) ||
    typeof root.model !== "string" ||
    !/^[a-zA-Z0-9._-]{1,128}$/.test(root.model) ||
    !Array.isArray(root.results) ||
    root.results.length !== 1
  )
    throw new ShadowFault("invalid_input");
  const result = object(root.results[0]);
  const c = object(result.categories),
    scores = object(result.category_scores),
    types = object(result.category_applied_input_types);
  const keys = Object.keys(c);
  if (
    typeof result.flagged !== "boolean" ||
    keys.length === 0 ||
    keys.some(
      (k) => !categories.includes(k) || !(c[k] === null || typeof c[k] === "boolean"),
    ) ||
    Object.keys(scores).length !== keys.length ||
    Object.keys(types).length !== keys.length ||
    // Empty applicability for every category is not evidence that this component was evaluated.
    !keys.some(
      (k) =>
        Array.isArray(types[k]) &&
        (modality === undefined ? types[k].length > 0 : types[k].includes(modality)),
    ) ||
    keys.some(
      (k) =>
        typeof scores[k] !== "number" ||
        !Number.isFinite(scores[k]) ||
        (scores[k] as number) < 0 ||
        (scores[k] as number) > 1 ||
        !Array.isArray(types[k]) ||
        types[k].length > 2 ||
        new Set(types[k]).size !== types[k].length ||
        types[k].some(
          (t: unknown) =>
            (t !== "text" && t !== "image") ||
            (t === "image" && textOnly.has(k)) ||
            (modality !== undefined && t !== modality),
        ),
    )
  ) {
    throw new ShadowFault("invalid_input");
  }
  return {
    state: "succeeded",
    model_requested: SHADOW_MODEL,
    model_returned: root.model,
    provider_response_id: root.id,
    flagged: result.flagged,
    categories: { ...c } as Success["categories"],
    category_scores: { ...scores } as Success["category_scores"],
    category_applied_input_types: { ...types } as Success["category_applied_input_types"],
  };
}

/** Deterministic fixture response. Never claims to be an actual provider evaluation. */
export class FakeModerationTransport implements ModerationTransport {
  readonly mode = "simulated" as const;
  constructor(
    private readonly respond?: (
      request: ModerationRequest,
      signal: AbortSignal,
    ) => Promise<unknown>,
  ) {}
  async evaluate(request: ModerationRequest, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new ShadowFault("provider_timeout", true);
    if (this.respond) return this.respond(request, signal);
    return {
      id: "fixture_shadow_response",
      model: "fixture-omni-shadow",
      results: [
        {
          flagged: false,
          categories: { violence: false },
          category_scores: { violence: 0 },
          category_applied_input_types: {
            violence: [request.input[0].type === "text" ? "text" : "image"],
          },
        },
      ],
    };
  }
}

/** Invalid/absent/past values add no delay. Excessive valid values remain excessive, never clamped early. */
export function retryAfterSeconds(value: string | undefined, now: number): number {
  if (!value) return 0;
  const s = value.trim();
  if (/^\d+$/.test(s)) return Number(s); // Infinity is deliberately treated as over-budget.
  let canonical = s;
  // HTTP recipients also encounter the two obsolete HTTP-date forms. Validate by
  // round trip rather than accepting Date.parse's lenient calendar normalization.
  const old =
    /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}:\d{2}:\d{2}) GMT$/.exec(
      s,
    );
  const ascii =
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( [1-9]|[12]\d|3[01]) (\d{2}:\d{2}:\d{2}) (\d{4})$/.exec(
      s,
    );
  if (old) {
    let year = Math.floor(new Date(now).getUTCFullYear() / 100) * 100 + Number(old[4]);
    const future = new Date(now);
    future.setUTCFullYear(future.getUTCFullYear() + 50);
    const format = () =>
      `${old[1].slice(0, 3)}, ${old[2]} ${old[3]} ${year} ${old[5]} GMT`;
    if (Date.parse(format()) > future.getTime()) year -= 100;
    canonical = format();
  } else if (ascii) {
    canonical = `${ascii[1]}, ${ascii[3].trim().padStart(2, "0")} ${ascii[2]} ${ascii[5]} ${ascii[4]} GMT`;
  } else if (
    !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      s,
    )
  )
    return 0;
  const ms = Date.parse(canonical);
  return Number.isFinite(ms) && new Date(ms).toUTCString() === canonical
    ? Math.max(0, Math.ceil((ms - now) / 1000))
    : 0;
}
export function retryDelay(
  attempts: number,
  retryAfter: string | undefined,
  now: number,
  random: number,
): number {
  const floor = Math.min(300, 5 * 2 ** attempts);
  return Math.max(
    floor + Math.floor(Math.max(0, Math.min(0.999999, random)) * 6),
    retryAfterSeconds(retryAfter, now),
  );
}

export async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  ms: number,
  fault: ShadowFault,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            controller.abort();
            reject(fault);
          },
          Math.max(1, ms),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
