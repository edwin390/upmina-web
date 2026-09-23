import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { applyEnvFile, loadLocalEnvFiles, parseEnvFileContents } from "./load-env.mjs";
import { readSupabaseServiceConfig } from "./admin-bootstrap-invitation.mjs";

// Ningún test de este archivo lee el .env.local/.env REALES del repo, ni contacta
// Supabase, ni genera ninguna invitación: cada test crea su PROPIO directorio temporal
// (fuera del repo, bajo el tmpdir del sistema) con archivos .env sintéticos, y pasa un
// objeto `targetEnv` de prueba en vez de mutar el `process.env` real del proceso de
// test. `readSupabaseServiceConfig` se importa solo por su lógica PURA de validación
// (sin I/O); `scripts/bootstrap-admin-invitation.mjs` (el script operator-side real)
// nunca se importa ni se ejecuta aquí.

const __dirname = dirname(fileURLToPath(import.meta.url));

const tempDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "upmina-load-env-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseEnvFileContents", () => {
  it("parsea asignaciones KEY=value simples", () => {
    const parsed = parseEnvFileContents("FOO=bar\nBAZ=qux\n");
    expect(parsed).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("quita comillas simples/dobles opcionales alrededor del valor", () => {
    const parsed = parseEnvFileContents(`A="valor con espacios"\nB='otro valor'\n`);
    expect(parsed).toEqual({ A: "valor con espacios", B: "otro valor" });
  });

  it("ignora líneas vacías y líneas sin forma KEY=value", () => {
    const parsed = parseEnvFileContents(
      "\n# esto no es una asignación\nSOLO_TEXTO\nOK=1\n",
    );
    expect(parsed).toEqual({ OK: "1" });
  });
});

describe("applyEnvFile / loadLocalEnvFiles — carga desde un archivo de entorno CONTROLADO de test", () => {
  it("carga variables desde un .env.local sintético en un directorio temporal", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, ".env.local"),
      "VITE_SUPABASE_URL=https://ejemplo-de-prueba.invalid\nSUPABASE_SERVICE_ROLE_KEY=clave-sintetica-no-real\n",
    );

    const fakeEnv = {};
    loadLocalEnvFiles(dir, fakeEnv);

    expect(fakeEnv).toEqual({
      VITE_SUPABASE_URL: "https://ejemplo-de-prueba.invalid",
      SUPABASE_SERVICE_ROLE_KEY: "clave-sintetica-no-real",
    });
  });

  it("usa .env como fallback para claves que .env.local no define, sin perder las de .env.local", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, ".env.local"),
      "VITE_SUPABASE_URL=https://desde-env-local.invalid\n",
    );
    writeFileSync(
      join(dir, ".env"),
      "VITE_SUPABASE_URL=https://desde-env.invalid\nSUPABASE_SERVICE_ROLE_KEY=solo-en-env\n",
    );

    const fakeEnv = {};
    loadLocalEnvFiles(dir, fakeEnv);

    // .env.local tiene precedencia sobre .env para la clave que ambos definen.
    expect(fakeEnv.VITE_SUPABASE_URL).toBe("https://desde-env-local.invalid");
    // .env solo se usa como fallback para lo que .env.local no definió.
    expect(fakeEnv.SUPABASE_SERVICE_ROLE_KEY).toBe("solo-en-env");
  });

  it("una variable ya presente en el entorno objetivo NUNCA es sobrescrita por el archivo", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, ".env.local"),
      "SUPABASE_SERVICE_ROLE_KEY=valor-del-archivo-nunca-usado\n",
    );

    const fakeEnv = { SUPABASE_SERVICE_ROLE_KEY: "valor-ya-exportado-en-el-shell" };
    loadLocalEnvFiles(dir, fakeEnv);

    expect(fakeEnv.SUPABASE_SERVICE_ROLE_KEY).toBe("valor-ya-exportado-en-el-shell");
  });

  it("si ni .env.local ni .env existen en el directorio, es un no-op silencioso (no lanza)", () => {
    const dir = makeTempDir(); // directorio vacío, garantizado fuera del repo
    const fakeEnv = {};
    expect(() => loadLocalEnvFiles(dir, fakeEnv)).not.toThrow();
    expect(fakeEnv).toEqual({});
  });

  it("applyEnvFile propaga errores de lectura distintos de ENOENT (p. ej. una ruta que es un directorio)", () => {
    const dir = makeTempDir();
    const fakeEnv = {};
    // `dir` es un directorio, no un archivo: leerlo como archivo falla con EISDIR, no ENOENT.
    expect(() => applyEnvFile(dir, fakeEnv)).toThrow();
  });
});

describe("ausencia de variable requerida tras cargar el entorno: sigue fallando de forma segura", () => {
  it("un directorio sin .env.local/.env dejando faltar SUPABASE_SERVICE_ROLE_KEY produce un error que nombra solo esa variable", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, ".env.local"),
      "VITE_SUPABASE_URL=https://ejemplo-de-prueba.invalid\n",
    );

    const fakeEnv = {};
    loadLocalEnvFiles(dir, fakeEnv);

    expect(() => readSupabaseServiceConfig(fakeEnv)).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("el error no contiene ningún valor de variable, solo el nombre de la ausente", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, ".env.local"),
      "VITE_SUPABASE_URL=https://no-debe-aparecer-en-el-error.invalid\n",
    );

    const fakeEnv = {};
    loadLocalEnvFiles(dir, fakeEnv);

    try {
      readSupabaseServiceConfig(fakeEnv);
      throw new Error("no debería llegar aquí");
    } catch (err) {
      expect(err.message).not.toMatch(/no-debe-aparecer-en-el-error/);
      expect(err.message).toMatch(
        /^Falta la variable de entorno SUPABASE_SERVICE_ROLE_KEY$/,
      );
    }
  });
});

describe("scripts/lib/load-env.mjs — inspección estática de seguridad", () => {
  it("nunca importa dotenv ni ninguna dependencia externa (solo node:fs/node:path)", () => {
    const contents = readFileSync(join(__dirname, "load-env.mjs"), "utf8");
    expect(contents).not.toMatch(/dotenv/i);
    expect(contents).toMatch(/from "node:fs"/);
    expect(contents).toMatch(/from "node:path"/);
  });

  it("nunca imprime ni registra el contenido de un archivo .env ni process.env", () => {
    const contents = readFileSync(join(__dirname, "load-env.mjs"), "utf8");
    expect(contents).not.toMatch(/console\.(log|error)/);
  });
});

describe("scripts/bootstrap-admin-invitation.mjs — usa loadLocalEnvFiles antes de validar config", () => {
  it("llama a loadLocalEnvFiles() antes de readSupabaseServiceConfig(process.env)", () => {
    const source = readFileSync(
      join(__dirname, "..", "bootstrap-admin-invitation.mjs"),
      "utf8",
    );
    const loadIdx = source.indexOf("loadLocalEnvFiles()");
    const configIdx = source.indexOf("readSupabaseServiceConfig(process.env)");
    expect(loadIdx).toBeGreaterThan(-1);
    expect(configIdx).toBeGreaterThan(-1);
    expect(loadIdx).toBeLessThan(configIdx);
  });

  it("sigue sin importar dotenv ni imprimir process.env completo", () => {
    const source = readFileSync(
      join(__dirname, "..", "bootstrap-admin-invitation.mjs"),
      "utf8",
    );
    expect(source).not.toMatch(/dotenv/i);
    expect(source).not.toMatch(/console\.(log|error)\(process\.env\)/);
  });
});
