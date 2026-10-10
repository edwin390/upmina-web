import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  classify,
  formatRow,
  headMany,
  parseTargets,
  readEnvFile,
  resolveConfig,
  validateTarget,
} from "./r2-head-dev.mjs";

const SYN = {
  R2_DEV_ACCESS_KEY_ID: "synthetic-id",
  R2_DEV_SECRET_ACCESS_KEY: "synthetic-secret-do-not-use",
  R2_DEV_ENDPOINT: `https://${"a".repeat(32)}.r2.cloudflarestorage.com`,
  R2_DEV_PRIVATE_BUCKET: "upmina-media-dev-private",
  R2_DEV_PUBLIC_BUCKET: "upmina-media-dev-public",
};
const KEY = "community/0d000000-0000-4000-8000-000000000001/w480.webp";
const PUB = "upmina-media-dev-public";

describe("r2-head-dev", () => {
  it("clasifica 200, 404, 403, red y config", () => {
    expect(classify(null, { $metadata: { httpStatusCode: 200 } })).toEqual({
      state: "EXISTS",
      http: 200,
    });
    expect(classify({ name: "NotFound", $metadata: { httpStatusCode: 404 } }).state).toBe(
      "NOT_FOUND",
    );
    const f = classify({ name: "Forbidden", $metadata: { httpStatusCode: 403 } });
    expect(f.state).toBe("ERROR");
    expect(f.http).toBe(403);
    expect(classify({ name: "Error", code: "ENOTFOUND" }).detail).toMatch(/red/);
    expect(classify({ name: "Boom" }).state).toBe("ERROR");
  });

  it("solo envía HeadObject y nunca imprime credenciales", async () => {
    const seen = [];
    const rows = await headMany(
      [{ bucket: PUB, key: KEY }],
      resolveConfig(SYN),
      async (cmd) => {
        seen.push(cmd.constructor.name);
        return { $metadata: { httpStatusCode: 200 } };
      },
    );
    expect(seen).toEqual(["HeadObjectCommand"]);
    const out = rows.map(formatRow).join("\n");
    expect(out).toBe(`${PUB} | ${KEY} | EXISTS | 200 | `);
    expect(out).not.toContain("synthetic");
  });

  it("devuelve NOT_FOUND y ERROR por objeto sin abortar el resto", async () => {
    let n = 0;
    const rows = await headMany(
      [
        { bucket: PUB, key: KEY },
        { bucket: PUB, key: KEY },
      ],
      resolveConfig(SYN),
      async () => {
        if (n++ === 0)
          throw Object.assign(new Error("x"), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          });
        throw Object.assign(new Error("x"), {
          name: "Forbidden",
          $metadata: { httpStatusCode: 403 },
        });
      },
    );
    expect(rows.map((r) => r.state)).toEqual(["NOT_FOUND", "ERROR"]);
  });

  it("rechaza buckets de Production o ajenos y claves peligrosas", () => {
    expect(() => validateTarget("upmina-media-prod-public", KEY)).toThrow(ConfigError);
    expect(() => validateTarget(PUB, "community/../x")).toThrow(ConfigError);
    expect(() => validateTarget(PUB, "community/")).toThrow(ConfigError);
    expect(() => validateTarget(PUB, "otro/x.webp")).toThrow(ConfigError);
    expect(() => validateTarget(PUB, KEY)).not.toThrow();
  });

  it("rechaza config incompleta, endpoint raro o buckets no DEV", () => {
    expect(() => resolveConfig({})).toThrow(/Faltan/);
    expect(() =>
      resolveConfig({ ...SYN, R2_DEV_ENDPOINT: "https://evil.example" }),
    ).toThrow(ConfigError);
    expect(() =>
      resolveConfig({ ...SYN, R2_DEV_PUBLIC_BUCKET: "upmina-media-prod-public" }),
    ).toThrow(ConfigError);
    // el mensaje de error no contiene valores secretos
    try {
      resolveConfig({ ...SYN, R2_DEV_PUBLIC_BUCKET: "otro" });
    } catch (e) {
      expect(String(e.message)).not.toContain("synthetic");
    }
  });

  it("readEnvFile solo extrae las 5 variables R2_DEV_*", () => {
    const dir = mkdtempSync(join(tmpdir(), "r2head-"));
    const f = join(dir, "env");
    writeFileSync(
      f,
      `OTRA=1\nR2_PROD_ACCESS_KEY_ID=nope\nR2_DEV_ENDPOINT="${SYN.R2_DEV_ENDPOINT}"\nSUPABASE_SERVICE_ROLE_KEY=x\n`,
    );
    const got = readEnvFile(f);
    expect(Object.keys(got)).toEqual(["R2_DEV_ENDPOINT"]);
    expect(got.R2_DEV_ENDPOINT).toBe(SYN.R2_DEV_ENDPOINT);
  });

  it("parseTargets admite alias public/private y comentarios", () => {
    expect(
      parseTargets(`# c\npublic,${KEY}\n\nprivate,staging/community/x/original.mp4`),
    ).toEqual([
      { bucket: PUB, key: KEY },
      { bucket: "upmina-media-dev-private", key: "staging/community/x/original.mp4" },
    ]);
    expect(() => parseTargets("solo-una-columna")).toThrow(ConfigError);
  });

  it("el módulo no importa comandos de escritura/listado", () => {
    const src = readFileSync(join(process.cwd(), "scripts/lib/r2-head-dev.mjs"), "utf8");
    expect(src).not.toMatch(
      /PutObject|DeleteObject|ListObjects|CopyObject|Multipart|Bucket(Command|Policy)/,
    );
  });
});
