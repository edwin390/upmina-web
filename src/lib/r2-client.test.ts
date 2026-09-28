import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getR2DevConfig,
  getR2ProdConfig,
  publicVariantUrl,
  R2ConfigError,
  resetR2DevConfigCache,
  resetR2ProdConfigCache,
} from "./r2-client";

// Config de R2 (Fase 9I-2B: DEV; release 9I: soporte de Production añadido): solo se prueba la
// resolución/guardas de configuración, no llamadas de red reales a R2 (eso lo cubre la prueba
// técnica real contra los buckets, documentada en el reporte del checkpoint correspondiente, no
// en la suite automática — y en Production, la infraestructura real todavía no existe). Nunca se
// imprime ni se afirma el valor de ninguna credencial — solo que la función lanza/no lanza según
// el caso, y (para probar que Production nunca cae a DEV) que el bucket/URL resuelto es el
// esperado.

const REQUIRED_VARS = [
  "R2_DEV_ACCESS_KEY_ID",
  "R2_DEV_SECRET_ACCESS_KEY",
  "R2_DEV_ENDPOINT",
  "R2_DEV_PRIVATE_BUCKET",
  "R2_DEV_PUBLIC_BUCKET",
  "R2_DEV_PUBLIC_BASE_URL",
] as const;

const PROD_REQUIRED_VARS = [
  "R2_PROD_ACCESS_KEY_ID",
  "R2_PROD_SECRET_ACCESS_KEY",
  "R2_PROD_ENDPOINT",
  "R2_PROD_PRIVATE_BUCKET",
  "R2_PROD_PUBLIC_BUCKET",
  "R2_PROD_PUBLIC_BASE_URL",
] as const;

function stubAllRequiredVars() {
  vi.stubEnv("R2_DEV_ACCESS_KEY_ID", "test-access-key-id");
  vi.stubEnv("R2_DEV_SECRET_ACCESS_KEY", "test-secret-access-key");
  vi.stubEnv("R2_DEV_ENDPOINT", "https://test-account.r2.cloudflarestorage.com");
  vi.stubEnv("R2_DEV_PRIVATE_BUCKET", "upmina-media-dev-private");
  vi.stubEnv("R2_DEV_PUBLIC_BUCKET", "upmina-media-dev-public");
  vi.stubEnv("R2_DEV_PUBLIC_BASE_URL", "https://pub-test.r2.dev");
}

function stubAllRequiredProdVars() {
  vi.stubEnv("R2_PROD_ACCESS_KEY_ID", "test-prod-access-key-id");
  vi.stubEnv("R2_PROD_SECRET_ACCESS_KEY", "test-prod-secret-access-key");
  vi.stubEnv("R2_PROD_ENDPOINT", "https://test-prod-account.r2.cloudflarestorage.com");
  vi.stubEnv("R2_PROD_PRIVATE_BUCKET", "upmina-media-prod-private");
  vi.stubEnv("R2_PROD_PUBLIC_BUCKET", "upmina-media-prod-public");
  vi.stubEnv("R2_PROD_PUBLIC_BASE_URL", "https://media.upminaa-web.com");
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetR2DevConfigCache();
  resetR2ProdConfigCache();
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

// ────────────────────────────────────────────────────────────────────────────────────────────
// Release 9I: soporte de Production. Simétrico a getR2DevConfig() en todo — mismas garantías,
// mismo estilo de prueba — más las pruebas específicas de "Production nunca cae a DEV".

describe("getR2ProdConfig — fail closed fuera de Production", () => {
  it("lanza SIEMPRE fuera de VERCEL_ENV=production, incluso con todas las variables R2_PROD_* presentes", () => {
    stubAllRequiredProdVars();
    expect(() => getR2ProdConfig()).toThrow(R2ConfigError);
    expect(() => getR2ProdConfig()).toThrow(/Production/);
  });
});

describe("getR2ProdConfig — variables requeridas", () => {
  it("lanza si falta cualquier variable R2_PROD_* requerida, una por una", () => {
    for (const missing of PROD_REQUIRED_VARS) {
      resetR2ProdConfigCache();
      vi.stubEnv("VERCEL_ENV", "production");
      stubAllRequiredProdVars();
      vi.stubEnv(missing, "");
      expect(() => getR2ProdConfig(), `debería fallar sin ${missing}`).toThrow(
        R2ConfigError,
      );
    }
  });

  it("no expone el nombre de la variable faltante ni ningún valor en el mensaje de error", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    stubAllRequiredProdVars();
    vi.stubEnv("R2_PROD_ACCESS_KEY_ID", "");
    try {
      getR2ProdConfig();
      expect.unreachable("debería haber lanzado");
    } catch (err) {
      expect(err).toBeInstanceOf(R2ConfigError);
      expect((err as Error).message).not.toMatch(
        /test-prod-access-key-id|test-prod-secret-access-key/,
      );
    }
  });

  it("con todas las variables R2_PROD_* presentes en Production, resuelve sin lanzar", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    stubAllRequiredProdVars();
    expect(() => getR2ProdConfig()).not.toThrow();
  });
});

describe("getR2ProdConfig — nunca lee R2_DEV_*, Production nunca cae a DEV", () => {
  it("en Production, con SOLO variables R2_DEV_* presentes (ninguna R2_PROD_*), sigue fallando cerrado", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    stubAllRequiredVars(); // solo DEV
    expect(() => getR2ProdConfig()).toThrow(R2ConfigError);
  });

  it("en Production, con DEV y PROD presentes a la vez, resuelve EXCLUSIVAMENTE con los valores R2_PROD_*", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    stubAllRequiredVars(); // DEV completo, con sus propios valores
    stubAllRequiredProdVars(); // PROD completo, con valores distintos
    const config = getR2ProdConfig();
    expect(config.privateBucket).toBe("upmina-media-prod-private");
    expect(config.publicBucket).toBe("upmina-media-prod-public");
    expect(config.publicBaseUrl).toBe("https://media.upminaa-web.com");
  });
});

describe("publicVariantUrl — usa la base pública activa según el entorno", () => {
  it("fuera de Production, usa R2_DEV_PUBLIC_BASE_URL (comportamiento DEV sin cambios)", () => {
    stubAllRequiredVars();
    expect(publicVariantUrl("k.webp")).toBe("https://pub-test.r2.dev/k.webp");
  });

  it("en Production, usa R2_PROD_PUBLIC_BASE_URL — nunca la base DEV, aunque ambas estén presentes", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    stubAllRequiredVars();
    stubAllRequiredProdVars();
    expect(publicVariantUrl("k.webp")).toBe("https://media.upminaa-web.com/k.webp");
  });
});
