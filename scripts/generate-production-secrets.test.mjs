import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertSafeOutDir, generateSecrets } from "./generate-production-secrets.mjs";

describe("generate-production-secrets", () => {
  it("rechaza una ruta dentro del repositorio, una ya existente y la ausencia de --out", () => {
    expect(() => assertSafeOutDir(undefined)).toThrow(/Falta/);
    expect(() => assertSafeOutDir(join(process.cwd(), "scripts", "x"))).toThrow(
      /repositorio/,
    );
    const existing = mkdtempSync(join(tmpdir(), "upmina-gen-"));
    try {
      expect(() => assertSafeOutDir(existing)).toThrow(/ya existe/);
      expect(assertSafeOutDir(join(existing, "nuevo"))).toContain("nuevo");
    } finally {
      rmSync(existing, { recursive: true, force: true });
    }
  });

  it("genera un par Ed25519 válido (PKCS#8 + SPKI) y secretos distintos de ≥ 32 caracteres", () => {
    const { keyId, publicSpki, env } = generateSecrets();
    expect(keyId).toBe("prod-1");
    const priv = createPrivateKey({
      key: Buffer.from(env.MEDIA_CAP_SIGNING_PRIVATE_KEY, "base64"),
      format: "der",
      type: "pkcs8",
    });
    const pub = createPublicKey({
      key: Buffer.from(publicSpki, "base64"),
      format: "der",
      type: "spki",
    });
    expect(priv.asymmetricKeyType).toBe("ed25519");
    expect(pub.export({ format: "der", type: "spki" }).toString("base64")).toBe(
      createPublicKey(priv).export({ format: "der", type: "spki" }).toString("base64"),
    );
    const secrets = [
      env.MEDIA_CHECK_SHARED_SECRET,
      env.MEDIA_GC_SHARED_SECRET,
      env.ACCOUNT_DELETION_SHARED_SECRET,
    ];
    expect(new Set(secrets).size).toBe(3);
    for (const s of secrets) expect(s.length).toBeGreaterThanOrEqual(32);
    expect(generateSecrets().env.MEDIA_CHECK_SHARED_SECRET).not.toBe(secrets[0]);
  });
});
