import { afterEach, describe, expect, it, vi } from "vitest";
import { getR2DevConfig, R2ConfigError, resetR2DevConfigCache } from "./r2-client";

// Config de R2 DEV (Fase 9I-2B): solo se prueba la resolución/guardas de configuración, no
// llamadas de red reales a R2 (eso lo cubre la prueba técnica real contra los buckets DEV,
// documentada en el reporte del checkpoint, no en la suite automática). Nunca se imprime ni se
// afirma el valor de ninguna credencial — solo que la función lanza/no lanza según el caso.

const REQUIRED_VARS = [
  "R2_DEV_ACCESS_KEY_ID",
  "R2_DEV_SECRET_ACCESS_KEY",
  "R2_DEV_ENDPOINT",
  "R2_DEV_PRIVATE_BUCKET",
  "R2_DEV_PUBLIC_BUCKET",
  "R2_DEV_PUBLIC_BASE_URL",
] as const;

function stubAllRequiredVars() {
  vi.stubEnv("R2_DEV_ACCESS_KEY_ID", "test-access-key-id");
  vi.stubEnv("R2_DEV_SECRET_ACCESS_KEY", "test-secret-access-key");
  vi.stubEnv("R2_DEV_ENDPOINT", "https://test-account.r2.cloudflarestorage.com");
  vi.stubEnv("R2_DEV_PRIVATE_BUCKET", "upmina-media-dev-private");
  vi.stubEnv("R2_DEV_PUBLIC_BUCKET", "upmina-media-dev-public");
  vi.stubEnv("R2_DEV_PUBLIC_BASE_URL", "https://pub-test.r2.dev");
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetR2DevConfigCache();
});

describe("getR2DevConfig — fail closed en Production", () => {
  it("lanza SIEMPRE en VERCEL_ENV=production, incluso con todas las variables DEV presentes", () => {
    stubAllRequiredVars();
    vi.stubEnv("VERCEL_ENV", "production");
    expect(() => getR2DevConfig()).toThrow(R2ConfigError);
    expect(() => getR2DevConfig()).toThrow(/Production/);
  });
});

describe("getR2DevConfig — variables requeridas", () => {
  it("lanza si falta cualquier variable requerida, una por una", () => {
    for (const missing of REQUIRED_VARS) {
      resetR2DevConfigCache();
      stubAllRequiredVars();
      vi.stubEnv(missing, "");
      expect(() => getR2DevConfig(), `debería fallar sin ${missing}`).toThrow(
        R2ConfigError,
      );
    }
  });

  it("no expone el nombre de la variable faltante ni ningún valor en el mensaje de error", () => {
    stubAllRequiredVars();
    vi.stubEnv("R2_DEV_ACCESS_KEY_ID", "");
    try {
      getR2DevConfig();
      expect.unreachable("debería haber lanzado");
    } catch (err) {
      expect(err).toBeInstanceOf(R2ConfigError);
      expect((err as Error).message).not.toMatch(
        /test-access-key-id|test-secret-access-key/,
      );
    }
  });

  it("con todas las variables presentes y fuera de Production, resuelve sin lanzar", () => {
    stubAllRequiredVars();
    expect(() => getR2DevConfig()).not.toThrow();
  });
});

describe("getR2DevConfig — caché", () => {
  it("resetR2DevConfigCache() fuerza releer las variables de entorno", () => {
    stubAllRequiredVars();
    const first = getR2DevConfig();
    expect(getR2DevConfig()).toBe(first); // misma instancia: cacheada

    resetR2DevConfigCache();
    vi.stubEnv("R2_DEV_PUBLIC_BUCKET", "otro-bucket-distinto");
    const second = getR2DevConfig();
    expect(second).not.toBe(first);
    expect(second.publicBucket).toBe("otro-bucket-distinto");
  });
});
