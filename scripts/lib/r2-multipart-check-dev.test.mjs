import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "./r2-head-dev.mjs";
import {
  buildPrefix,
  checkSessions,
  fingerprint,
  formatRow,
  shortId,
} from "./r2-multipart-check-dev.mjs";

const ID = "0d000000-0000-4000-8000-000000000001";
const SECRET_UPLOAD = "synthetic-upload-id-ABCDEF123456";

describe("r2-multipart-check-dev", () => {
  it("construye prefijos solo de staging/community y valida el UUID", () => {
    expect(buildPrefix()).toBe("staging/community/");
    expect(buildPrefix(ID)).toBe(`staging/community/${ID}/`);
    expect(() => buildPrefix("../x")).toThrow(ConfigError);
    expect(() => buildPrefix(ID.toUpperCase())).toThrow(ConfigError);
  });

  it("rechaza prefijos fuera de staging/community/", async () => {
    await expect(
      checkSessions({ prefix: "objects/community/", config: {}, send: async () => ({}) }),
    ).rejects.toThrow(ConfigError);
  });

  it("sin sesiones abiertas → NO_OPEN_SESSION", async () => {
    const rows = await checkSessions({
      prefix: `staging/community/${ID}/`,
      config: {},
      send: async () => ({ Uploads: [] }),
    });
    expect(rows[0].state).toBe("NO_OPEN_SESSION");
  });

  it("con sesión abierta informa partes y bytes, sin UploadId completo ni ETag", async () => {
    const sent = [];
    const rows = await checkSessions({
      prefix: `staging/community/${ID}/`,
      config: {},
      send: async (cmd) => {
        sent.push([cmd.constructor.name, cmd.input.Bucket]);
        if (cmd.constructor.name === "ListMultipartUploadsCommand") {
          return {
            Uploads: [
              {
                Key: `staging/community/${ID}/original.mp4`,
                UploadId: SECRET_UPLOAD,
                Initiated: new Date(0),
              },
            ],
          };
        }
        return {
          Parts: [
            { Size: 8, ETag: '"secret-etag"' },
            { Size: 4, ETag: '"x"' },
          ],
        };
      },
    });
    const line = formatRow(rows[0]);
    expect(line).toContain("OPEN_SESSION");
    expect(line).toContain("parts=2");
    expect(line).toContain("bytes=12");
    expect(line).toContain(shortId(SECRET_UPLOAD));
    expect(line).not.toContain(SECRET_UPLOAD);
    expect(line).not.toContain("secret-etag");
    // solo lecturas y solo el bucket privado DEV
    expect(sent.map((s) => s[0]).sort()).toEqual([
      "ListMultipartUploadsCommand",
      "ListPartsCommand",
    ]);
    expect(new Set(sent.map((s) => s[1]))).toEqual(new Set(["upmina-media-dev-private"]));
  });

  it("403 y red se reportan como ERROR (no como 'sin sesiones')", async () => {
    const r403 = await checkSessions({
      prefix: "staging/community/",
      config: {},
      send: async () => {
        throw Object.assign(new Error("x"), {
          name: "Forbidden",
          $metadata: { httpStatusCode: 403 },
        });
      },
    });
    expect(r403[0]).toMatchObject({ state: "ERROR", http: 403 });
    const net = await checkSessions({
      prefix: "staging/community/",
      config: {},
      send: async () => {
        throw Object.assign(new Error("x"), { name: "Error", code: "ENOTFOUND" });
      },
    });
    expect(net[0].state).toBe("ERROR");
  });

  it("el módulo no usa comandos de escritura", () => {
    const src = readFileSync(
      join(process.cwd(), "scripts/lib/r2-multipart-check-dev.mjs"),
      "utf8",
    );
    expect(src).not.toMatch(
      /Abort|Complete|PutObject|DeleteObject|CreateMultipart|UploadPart|CopyObject/,
    );
  });
});

describe("r2-multipart-check-dev · huella e identificador esperado", () => {
  const KEY = `staging/community/${ID}/original.mp4`;
  const LISTED = "synthetic-listed-upload-id-AAAAAA";
  const EXPECTED = "synthetic-expected-upload-id-BBBBBB";
  const cmds = [];
  const mk =
    (opts = {}) =>
    async (cmd) => {
      cmds.push(cmd.constructor.name);
      if (cmd.constructor.name === "ListMultipartUploadsCommand")
        return {
          Uploads: opts.noUploads
            ? []
            : [{ Key: KEY, UploadId: opts.listed ?? LISTED, Initiated: new Date(0) }],
        };
      if (cmd.input.UploadId === EXPECTED && opts.expectedValid)
        return { Parts: [{ Size: 1, ETag: '"e"' }] };
      if (cmd.input.UploadId === (opts.listed ?? LISTED)) return { Parts: [] };
      throw Object.assign(new Error("x"), {
        name: opts.expectedError ?? "NoSuchUpload",
        $metadata: { httpStatusCode: opts.expectedError ? 500 : 404 },
      });
    };

  it("la huella es estable, de 12 hex, distinta por identificador y no revela el original", () => {
    expect(fingerprint(LISTED)).toBe(fingerprint(LISTED));
    expect(fingerprint(LISTED)).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprint(LISTED)).not.toBe(fingerprint(EXPECTED));
    expect(fingerprint(LISTED)).not.toContain(LISTED);
  });

  it("cada sesión muestra huella y longitud, sin el identificador completo", async () => {
    const rows = await checkSessions({
      prefix: `staging/community/${ID}/`,
      config: {},
      send: mk(),
    });
    const line = formatRow(rows[0]);
    expect(line).toContain(`fp=${fingerprint(LISTED)}`);
    expect(line).toContain(`len=${LISTED.length}`);
    expect(line).not.toContain(LISTED);
    expect(line).not.toContain("match_expected");
  });

  it("con identificador esperado: informa si coincide con el listado y si direcciona una sesión viva", async () => {
    const rows = await checkSessions({
      prefix: `staging/community/${ID}/`,
      config: {},
      send: mk({ expectedValid: true }),
      expectedUploadId: EXPECTED,
    });
    const text = rows.map(formatRow).join("\n");
    expect(text).toContain("match_expected=no");
    expect(text).toContain(`EXPECTED_ID | fp=${fingerprint(EXPECTED)}`);
    expect(text).toContain("result=VALID_SESSION");
    expect(text).not.toContain(EXPECTED);
    expect(text).not.toContain(LISTED);
  });

  it("si el esperado coincide textualmente con el listado: match_expected=yes", async () => {
    const rows = await checkSessions({
      prefix: `staging/community/${ID}/`,
      config: {},
      send: mk({ listed: EXPECTED, expectedValid: true }),
      expectedUploadId: EXPECTED,
    });
    expect(rows.map(formatRow).join("\n")).toContain("match_expected=yes");
  });

  it("esperado inexistente en R2: NO_SUCH_UPLOAD; otros fallos: ERROR (no se confunden)", async () => {
    const none = await checkSessions({
      prefix: `staging/community/${ID}/`,
      config: {},
      send: mk(),
      expectedUploadId: EXPECTED,
    });
    expect(none.map(formatRow).join("\n")).toContain("result=NO_SUCH_UPLOAD");
    const err = await checkSessions({
      prefix: `staging/community/${ID}/`,
      config: {},
      send: mk({ expectedError: "InternalError" }),
      expectedUploadId: EXPECTED,
    });
    expect(err.map(formatRow).join("\n")).toContain("result=ERROR");
  });

  it("sin sesiones listadas no se puede comprobar el esperado (NOT_CHECKED) y solo se usan lecturas", async () => {
    cmds.length = 0;
    const rows = await checkSessions({
      prefix: `staging/community/${ID}/`,
      config: {},
      send: mk({ noUploads: true }),
      expectedUploadId: EXPECTED,
    });
    expect(rows.map(formatRow).join("\n")).toContain("NOT_CHECKED_NO_LISTED_KEY");
    expect(new Set(cmds)).toEqual(new Set(["ListMultipartUploadsCommand"]));
  });

  it("un identificador esperado vacío o desmesurado es un error de configuración", async () => {
    for (const bad of ["", "x".repeat(2049), 5]) {
      await expect(
        checkSessions({
          prefix: "staging/community/",
          config: {},
          send: mk(),
          expectedUploadId: bad,
        }),
      ).rejects.toThrow(ConfigError);
    }
  });
});
