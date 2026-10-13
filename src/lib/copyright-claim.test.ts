// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  CLAIM_PAYLOAD_KEYS,
  CLAIM_STATEMENT_VERSION,
  parseEvidenceUrls,
  parsePostReference,
  validateClaimForm,
  validateReviewNote,
  type ClaimFormInput,
} from "./copyright-claim";
import {
  ACTIONS_BY_STATUS,
  CLAIM_STATUSES,
  NOTE_REQUIRED_ACTIONS,
  REVIEW_ACTIONS,
  decodeClaimCursor,
  encodeClaimCursor,
  parseClaimDetail,
  parseClaimSummary,
  parseReviewResult,
} from "./copyright-contract";

// COPY-1 fase 2A: validación compartida del formulario/servidor y contrato de lecturas. Valores claramente sintéticos.

const POST = "0f000000-0000-4000-8000-0000000003e9";
const valid = (over: Partial<ClaimFormInput> = {}): ClaimFormInput => ({
  claimantName: "  Ana Titular ",
  claimantEmail: "  ANA@Example.com ",
  organization: "",
  relationship: "owner",
  workDescription: "Ilustración original publicada en mi portafolio",
  infringementDescription: "La publicación reutiliza mi ilustración sin permiso",
  evidenceUrls: "https://example.com/obra\n\nhttps://example.org/otra  ",
  postUrl: `https://upmina.test/community/${POST.toUpperCase()}?x=1`,
  signature: "Ana Titular",
  statementsAccepted: true,
  ...over,
});

describe("validateClaimForm", () => {
  it("normaliza y construye el cuerpo exacto que viaja al servidor", () => {
    const result = validateClaimForm(valid());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toEqual({
      claimantName: "Ana Titular",
      claimantEmail: "ana@example.com",
      organization: null,
      relationship: "owner",
      workDescription: "Ilustración original publicada en mi portafolio",
      infringementDescription: "La publicación reutiliza mi ilustración sin permiso",
      evidenceUrls: ["https://example.com/obra", "https://example.org/otra"],
      postUrl: `https://upmina.test/community/${POST.toUpperCase()}?x=1`,
      postId: POST,
      signature: "Ana Titular",
      statementVersion: CLAIM_STATEMENT_VERSION,
      statementsAccepted: true,
    });
    expect(Object.keys(result.payload).sort()).toEqual([...CLAIM_PAYLOAD_KEYS].sort());
  });

  it("acepta una organización y un enlace sin identificador de publicación (postId null)", () => {
    const result = validateClaimForm(
      valid({
        organization: " Estudio Ejemplo ",
        postUrl: "https://upmina.test/@alguien",
      }),
    );
    expect(result.ok && result.payload.organization).toBe("Estudio Ejemplo");
    expect(result.ok && result.payload.postId).toBeNull();
  });

  it.each([
    ["claimantName", { claimantName: "" }, "required"],
    ["claimantName", { claimantName: "A" }, "tooShort"],
    ["claimantName", { claimantName: "x".repeat(121) }, "tooLong"],
    ["claimantName", { claimantName: "Ana\u0007" }, "invalid"],
    ["claimantName", { claimantName: 42 }, "invalid"],
    ["claimantEmail", { claimantEmail: " " }, "required"],
    ["claimantEmail", { claimantEmail: "ana@" }, "invalid"],
    ["claimantEmail", { claimantEmail: "a na@example.com" }, "invalid"],
    ["claimantEmail", { claimantEmail: `${"a".repeat(250)}@e.co` }, "invalid"],
    ["claimantEmail", { claimantEmail: "ana@example.com\nBcc: x@y.z" }, "invalid"],
    ["claimantEmail", { claimantEmail: "ana\u0007@example.com" }, "invalid"],
    ["claimantEmail", { claimantEmail: "ana@exam\u0000ple.com" }, "invalid"],
    ["organization", { organization: "x".repeat(121) }, "tooLong"],
    ["organization", { organization: 5 }, "invalid"],
    ["relationship", { relationship: "" }, "required"],
    ["relationship", { relationship: "friend" }, "invalid"],
    ["workDescription", { workDescription: "corta" }, "tooShort"],
    ["workDescription", { workDescription: "x".repeat(2001) }, "tooLong"],
    ["workDescription", { workDescription: "texto con control \u0000 nulo" }, "invalid"],
    ["infringementDescription", { infringementDescription: "" }, "required"],
    ["postUrl", { postUrl: "" }, "required"],
    ["postUrl", { postUrl: "x".repeat(501) }, "tooLong"],
    ["postUrl", { postUrl: "https://x.test/\nfoo" }, "invalid"],
    ["signature", { signature: "A" }, "tooShort"],
    ["statementsAccepted", { statementsAccepted: false }, "required"],
    ["statementsAccepted", { statementsAccepted: "true" }, "required"],
  ] as const)("rechaza %s: %j → %s", (field, over, error) => {
    const result = validateClaimForm(valid(over as Partial<ClaimFormInput>));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[field]).toBe(error);
  });

  it("permite saltos de línea y tabuladores en las descripciones, pero no en una sola línea", () => {
    expect(
      validateClaimForm(valid({ workDescription: "Línea uno\n\tLínea dos de la obra" }))
        .ok,
    ).toBe(true);
    expect(validateClaimForm(valid({ claimantName: "Ana\nTitular" })).ok).toBe(false);
  });

  it("cuenta caracteres Unicode (no unidades UTF-16) como el servidor y la base de datos", () => {
    expect(validateClaimForm(valid({ claimantName: "😀😀" })).ok).toBe(true);
    expect(validateClaimForm(valid({ claimantName: "😀" })).ok).toBe(false);
    expect(validateClaimForm(valid({ organization: "😀".repeat(120) })).ok).toBe(true);
    expect(validateClaimForm(valid({ organization: "😀".repeat(121) })).ok).toBe(false);
  });

  it("reúne todos los errores a la vez", () => {
    const result = validateClaimForm({
      claimantName: "",
      claimantEmail: "",
      relationship: "",
      workDescription: "",
      infringementDescription: "",
      evidenceUrls: "",
      postUrl: "",
      signature: "",
      statementsAccepted: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(Object.keys(result.errors).sort()).toEqual(
        [
          "claimantEmail",
          "claimantName",
          "evidenceUrls",
          "infringementDescription",
          "postUrl",
          "relationship",
          "signature",
          "statementsAccepted",
          "workDescription",
        ].sort(),
      );
  });
});

describe("parseEvidenceUrls", () => {
  it("acepta de 1 a 5 enlaces http/https, una lista o líneas de texto", () => {
    expect(parseEvidenceUrls("http://a.example/x")).toEqual({
      value: ["http://a.example/x"],
    });
    expect(parseEvidenceUrls("http://a")).toEqual({ value: ["http://a"] }); // 8 caracteres: el mínimo
    expect(parseEvidenceUrls(["https://a.example/x", "https://b.example/y"])).toEqual({
      value: ["https://a.example/x", "https://b.example/y"],
    });
    const five = Array.from({ length: 5 }, (_, i) => `https://e.example/${i}`);
    expect("value" in parseEvidenceUrls(five)).toBe(true);
  });

  it.each([
    ["sin enlaces", "", "required"],
    ["solo líneas vacías", "\n \n", "required"],
    [
      "seis enlaces",
      Array.from({ length: 6 }, (_, i) => `https://e.example/${i}`),
      "tooLong",
    ],
    ["javascript:", "javascript:alert(1)", "invalid"],
    ["data:", "data:text/html,<b>x</b>", "invalid"],
    ["ftp:", "ftp://example.com/archivo", "invalid"],
    ["file:", "file:///C:/secreto.txt", "invalid"],
    ["sin esquema", "example.com/obra", "invalid"],
    ["con espacio", ["https://example.com/a b"], "invalid"],
    ["sin nada tras el esquema", "https://", "invalid"],
    ["demasiado corto", "http://", "invalid"],
    ["demasiado largo", `https://example.com/${"x".repeat(500)}`, "invalid"],
    ["no es texto", [123], "invalid"],
    ["ni lista ni texto", { 0: "https://e.example" }, "invalid"],
  ])("rechaza %s", (_label, value, error) => {
    expect(parseEvidenceUrls(value)).toEqual({ error });
  });
});

describe("parsePostReference", () => {
  it("extrae el UUID de /community/<uuid> en cualquier host, con ruta, consulta o ancla", () => {
    for (const url of [
      `https://upmina.test/community/${POST}`,
      `https://otro.test/community/${POST}/`,
      `/community/${POST}?utm=1`,
      `https://upmina.test/community/post/${POST}`,
      `https://otro.test/community/post/${POST}/`,
      `community/post/${POST}?utm=1#top`,
      `community/${POST}#top`,
      POST,
      ` ${POST.toUpperCase()} `,
    ])
      expect(parsePostReference(url)).toBe(POST);
  });

  it.each([
    "https://upmina.test/community/no-es-uuid",
    "https://upmina.test/@alguien",
    `https://upmina.test/other/${POST}`,
    `https://upmina.test/community/${POST}x`,
    `https://upmina.test/community/post/${POST}x`,
    `https://upmina.test/community/post/post/${POST}`,
    `https://upmina.test/community/posts/${POST}`,
    `https://upmina.test/community/otro/${POST}`,
    "https://upmina.test/community/post/no-es-uuid",
    "https://upmina.test/community/post/",
    "",
  ])("devuelve null para %s", (url) => {
    expect(parsePostReference(url)).toBeNull();
  });
});

describe("validateReviewNote", () => {
  it("recorta y acepta de 1 a 1000 caracteres; rechaza vacío, controles y exceso", () => {
    expect(validateReviewNote("  ok  ")).toEqual({ ok: true, note: "ok" });
    expect(validateReviewNote("x".repeat(1000)).ok).toBe(true);
    expect(validateReviewNote("x".repeat(1001))).toEqual({ ok: false, error: "tooLong" });
    expect(validateReviewNote("   ")).toEqual({ ok: false, error: "required" });
    expect(validateReviewNote("a\u0007b")).toEqual({ ok: false, error: "invalid" });
    expect(validateReviewNote(7)).toEqual({ ok: false, error: "invalid" });
  });
});

describe("contrato de lecturas", () => {
  const summary = {
    id: POST,
    reference: "CPY-2026-000001",
    status: "received",
    version: 1,
    claimantName: "Ana Titular",
    relationship: "owner",
    postFound: true,
    createdAt: "2026-10-12T10:00:00.000Z",
    updatedAt: "2026-10-12T10:00:00.000Z",
  };
  const detail = {
    ...summary,
    claimantEmail: "ana@example.com",
    organization: null,
    workDescription: "Obra original",
    infringementDescription: "Copia mi obra",
    evidenceUrls: ["https://example.com/obra"],
    claimedPostUrl: "https://upmina.test/community/x",
    postId: POST,
    postTextSnapshot: null,
    postMediaCount: 0,
    currentPostStatus: "published",
    statementVersion: "v1",
    signature: "Ana Titular",
    events: [
      {
        kind: "received",
        actorKind: "claimant",
        fromStatus: null,
        toStatus: "received",
        note: null,
        createdAt: "2026-10-12T10:00:00.000Z",
      },
    ],
  };

  it("acepta proyecciones válidas", () => {
    expect(parseClaimSummary(summary)).toEqual(summary);
    expect(parseClaimDetail(detail).events).toHaveLength(1);
    expect(
      parseReviewResult({
        id: POST,
        reference: "CPY-2026-000001",
        status: "in_review",
        version: 2,
        updatedAt: "2026-10-12T10:05:00.000Z",
      }).status,
    ).toBe("in_review");
  });

  it.each([
    ["estado desconocido", { ...summary, status: "upheld" }],
    ["referencia mal formada", { ...summary, reference: "CPY-26-1" }],
    ["id que no es UUID", { ...summary, id: "x" }],
    ["versión 0", { ...summary, version: 0 }],
    ["fecha inválida", { ...summary, createdAt: "ayer" }],
    ["relación desconocida", { ...summary, relationship: "friend" }],
    ["no es un objeto", [summary]],
  ])("rechaza %s", (_label, value) => {
    expect(() => parseClaimSummary(value)).toThrow("Invalid copyright projection");
  });

  it("rechaza detalles con más de 5 enlaces, eventos con tipo desconocido o texto desmesurado", () => {
    expect(() =>
      parseClaimDetail({ ...detail, evidenceUrls: Array(6).fill("https://e.example/x") }),
    ).toThrow();
    expect(() =>
      parseClaimDetail({
        ...detail,
        events: [{ ...detail.events[0], kind: "exterminated" }],
      }),
    ).toThrow();
    expect(() =>
      parseClaimDetail({ ...detail, workDescription: "x".repeat(2001) }),
    ).toThrow();
  });

  it("el cursor es opaco y solo se acepta si decodifica a un instante y un UUID válidos", () => {
    const next = { createdAt: "2026-10-12T10:00:00.123456+00:00", id: POST };
    const cursor = encodeClaimCursor(next);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeClaimCursor(cursor)).toEqual(next);
    for (const bad of [
      "",
      "***",
      "a".repeat(201),
      btoa("no json"),
      btoa(JSON.stringify({ c: "x", i: POST })),
    ])
      expect(decodeClaimCursor(bad)).toBeNull();
    expect(
      decodeClaimCursor(btoa(JSON.stringify({ c: next.createdAt, i: "x" }))),
    ).toBeNull();
  });

  it("las acciones disponibles por estado son coherentes con las de la RPC", () => {
    expect(Object.keys(ACTIONS_BY_STATUS).sort()).toEqual([...CLAIM_STATUSES].sort());
    expect(ACTIONS_BY_STATUS.dismissed).toEqual([]);
    expect(ACTIONS_BY_STATUS.withdrawn).toEqual([]);
    for (const actions of Object.values(ACTIONS_BY_STATUS))
      for (const action of actions) expect(REVIEW_ACTIONS).toContain(action);
    expect(ACTIONS_BY_STATUS.received).toContain("start_review");
    expect(ACTIONS_BY_STATUS.in_review).toContain("request_info");
    expect(ACTIONS_BY_STATUS.needs_info).toContain("resume_review");
    expect([...NOTE_REQUIRED_ACTIONS].sort()).toEqual(
      ["add_note", "dismiss", "request_info", "withdraw"].sort(),
    );
    // Nunca hay una acción que retire, oculte o restaure en la fase 2A.
    expect(REVIEW_ACTIONS.join(",")).not.toMatch(/remove|hide|restore|purge|uphold/);
  });
});
