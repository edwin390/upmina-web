import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_EXPIRY_MS,
  buildActivationUrl,
  buildBootstrapInvitationRow,
  generateBootstrapToken,
  hashBootstrapToken,
  readSupabaseServiceConfig,
} from "./admin-bootstrap-invitation.mjs";

// Ningún test de este archivo genera una invitación real ni toca Supabase: solo
// importa la lógica PURA (sin I/O) de admin-bootstrap-invitation.mjs. El script
// operator-side real (../bootstrap-admin-invitation.mjs) nunca se importa ni se
// ejecuta aquí — sus propiedades de seguridad (no imprimir el token/service role,
// gitignore, ejecución solo explícita) se verifican por inspección ESTÁTICA de su
// código fuente, igual que se hizo con la migración SQL de Bloque 2A.

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("generateBootstrapToken", () => {
  it("nunca usa Math.random en su implementación (ni en este archivo)", () => {
    const source = readFileSync(
      join(__dirname, "admin-bootstrap-invitation.mjs"),
      "utf8",
    );
    expect(source).not.toMatch(/Math\.random/);
  });

  it("produce un token base64url de 256 bits de entropía (43 caracteres, sin padding)", () => {
    const token = generateBootstrapToken();
    // 32 bytes en base64url sin padding = ceil(32*8/6) = 43 caracteres.
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toMatch(/[+/=]/); // base64 "normal" tendría estos caracteres.
  });

  it("dos tokens sucesivos son distintos", () => {
    const a = generateBootstrapToken();
    const b = generateBootstrapToken();
    expect(a).not.toBe(b);
  });
});

describe("hashBootstrapToken", () => {
  it("produce exactamente 64 caracteres hexadecimales (SHA-256 en hex)", () => {
    const hash = hashBootstrapToken("token-sintetico-de-prueba-no-real");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("el mismo token produce siempre el mismo hash", () => {
    const token = "token-sintetico-de-prueba-no-real";
    expect(hashBootstrapToken(token)).toBe(hashBootstrapToken(token));
  });

  it("tokens distintos producen hashes distintos", () => {
    expect(hashBootstrapToken("token-sintetico-a")).not.toBe(
      hashBootstrapToken("token-sintetico-b"),
    );
  });

  it("el hash de un token real generado nunca coincide con el propio token (no es un passthrough)", () => {
    const token = generateBootstrapToken();
    expect(hashBootstrapToken(token)).not.toBe(token);
  });
});

describe("buildBootstrapInvitationRow", () => {
  it("concede role='admin', invitation_type='bootstrap_admin' y created_by=null", () => {
    const row = buildBootstrapInvitationRow(
      "hash-sintetico-de-64-caracteres-0000000000000000000000000000",
    );
    expect(row.role).toBe("admin");
    expect(row.invitation_type).toBe("bootstrap_admin");
    expect(row.created_by).toBeNull();
  });

  it("usa exactamente el token_hash recibido, nunca el token en claro", () => {
    const hash = hashBootstrapToken("token-sintetico-de-prueba-no-real");
    const row = buildBootstrapInvitationRow(hash);
    expect(row.token_hash).toBe(hash);
    expect(row).not.toHaveProperty("token");
    expect(row).not.toHaveProperty("plaintext");
  });

  it("expira aproximadamente 7 días después de `now` (tolerancia de 1 segundo)", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const row = buildBootstrapInvitationRow("hash-sintetico", now);
    const expected = now.getTime() + BOOTSTRAP_EXPIRY_MS;
    expect(new Date(row.expires_at).getTime()).toBeCloseTo(expected, -3);
    expect(BOOTSTRAP_EXPIRY_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("buildActivationUrl", () => {
  const FAKE_BASE_URL = "https://ejemplo-de-prueba.invalid";
  const FAKE_TOKEN = "token-sintetico-de-prueba-no-real";

  it("usa el fragment #token=, nunca query string ?token=", () => {
    const url = buildActivationUrl(FAKE_BASE_URL, FAKE_TOKEN);
    expect(url).toContain("#token=");
    expect(url).not.toContain("?token=");
  });

  it("la URL apunta a /admin/activate", () => {
    const url = buildActivationUrl(FAKE_BASE_URL, FAKE_TOKEN);
    expect(url.startsWith(`${FAKE_BASE_URL}/admin/activate`)).toBe(true);
  });

  it("la URL contiene el token en claro (necesario para la activación), nunca su hash", () => {
    const url = buildActivationUrl(FAKE_BASE_URL, FAKE_TOKEN);
    const hash = hashBootstrapToken(FAKE_TOKEN);
    expect(url).toContain(FAKE_TOKEN);
    expect(url).not.toContain(hash);
  });
});

describe("readSupabaseServiceConfig", () => {
  it("con ambas variables presentes (valores sintéticos), devuelve url y serviceRoleKey", () => {
    const config = readSupabaseServiceConfig({
      VITE_SUPABASE_URL: "https://ejemplo-de-prueba.invalid",
      SUPABASE_SERVICE_ROLE_KEY: "clave-sintetica-no-real",
    });
    expect(config).toEqual({
      url: "https://ejemplo-de-prueba.invalid",
      serviceRoleKey: "clave-sintetica-no-real",
    });
  });

  it("si falta VITE_SUPABASE_URL, el mensaje nombra solo esa variable", () => {
    expect(() =>
      readSupabaseServiceConfig({ SUPABASE_SERVICE_ROLE_KEY: "clave-sintetica-no-real" }),
    ).toThrow(/VITE_SUPABASE_URL/);
  });

  it("si falta SUPABASE_SERVICE_ROLE_KEY, el mensaje nombra solo esa variable y nunca la anon key", () => {
    expect(() =>
      readSupabaseServiceConfig({
        VITE_SUPABASE_URL: "https://ejemplo-de-prueba.invalid",
      }),
    ).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("el mensaje de error nunca incluye ningún valor, solo el nombre de la variable ausente", () => {
    try {
      readSupabaseServiceConfig({
        VITE_SUPABASE_URL: "https://ejemplo-de-prueba.invalid",
      });
      throw new Error("no debería llegar aquí");
    } catch (err) {
      expect(err.message).not.toMatch(/ejemplo-de-prueba\.invalid/);
    }
  });
});

describe("scripts/bootstrap-admin-invitation.mjs — inspección estática de seguridad", () => {
  const scriptSource = readFileSync(
    join(__dirname, "..", "bootstrap-admin-invitation.mjs"),
    "utf8",
  );

  it("nunca hace console.log/console.error del token en claro ni de la URL de activación", () => {
    expect(scriptSource).not.toMatch(/console\.(log|error)\([^)]*\btoken\b[^)]*\)/);
    expect(scriptSource).not.toMatch(/console\.(log|error)\([^)]*activationUrl[^)]*\)/);
  });

  it("nunca hace console.log/console.error de config.serviceRoleKey ni de config.url", () => {
    expect(scriptSource).not.toMatch(/console\.(log|error)\([^)]*serviceRoleKey[^)]*\)/);
    expect(scriptSource).not.toMatch(/console\.(log|error)\([^)]*config\.url[^)]*\)/);
  });

  it("usa VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, nunca VITE_SUPABASE_ANON_KEY", () => {
    expect(scriptSource).not.toMatch(/VITE_SUPABASE_ANON_KEY/);
    expect(scriptSource).toMatch(/readSupabaseServiceConfig/);
  });

  it("comprueba que el archivo secreto no exista ya, ANTES de generar el token", () => {
    const existsCheckIdx = scriptSource.indexOf("existsSync(SECRET_FILE_PATH)");
    const tokenGenIdx = scriptSource.indexOf("generateBootstrapToken()");
    expect(existsCheckIdx).toBeGreaterThan(-1);
    expect(existsCheckIdx).toBeLessThan(tokenGenIdx);
  });

  it("escribe el archivo secreto con flag 'wx' (falla si ya existe, nunca sobrescribe silenciosamente)", () => {
    expect(scriptSource).toMatch(/flag:\s*"wx"/);
  });

  it("Bloque 2B.1: mkdirSync ocurre antes de writeFileSync", () => {
    const mkdirIdx = scriptSource.indexOf("mkdirSync(SECRET_DIR");
    const writeIdx = scriptSource.indexOf("writeFileSync(SECRET_FILE_PATH");
    expect(mkdirIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(-1);
    expect(mkdirIdx).toBeLessThan(writeIdx);
  });

  it("Bloque 2B.1: writeFileSync ocurre ANTES de crear el cliente/llamar a Supabase (insert)", () => {
    const writeIdx = scriptSource.indexOf("writeFileSync(SECRET_FILE_PATH");
    const createClientIdx = scriptSource.indexOf("createClient(config.url");
    const insertIdx = scriptSource.indexOf('.from("admin_invitations")');
    expect(writeIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeLessThan(createClientIdx);
    expect(writeIdx).toBeLessThan(insertIdx);
  });

  it("Bloque 2B.1: si falla la escritura del archivo, no se llega a crear el cliente ni a hacer INSERT (return dentro del catch)", () => {
    const writeBlockStart = scriptSource.indexOf('try {\n    // flag "wx"');
    expect(writeBlockStart).toBeGreaterThan(-1);
    const catchIdx = scriptSource.indexOf("} catch {", writeBlockStart);
    const returnIdx = scriptSource.indexOf("return;", catchIdx);
    const createClientIdx = scriptSource.indexOf("createClient(config.url");
    expect(catchIdx).toBeGreaterThan(-1);
    expect(returnIdx).toBeGreaterThan(catchIdx);
    expect(returnIdx).toBeLessThan(createClientIdx);
  });

  it("Bloque 2B.1: un INSERT fallido intenta eliminar SECRET_FILE_PATH con unlinkSync", () => {
    const insertIdx = scriptSource.indexOf('.from("admin_invitations")');
    const errorBranchIdx = scriptSource.indexOf("if (error || !data)", insertIdx);
    const unlinkIdx = scriptSource.indexOf(
      "unlinkSync(SECRET_FILE_PATH)",
      errorBranchIdx,
    );
    expect(errorBranchIdx).toBeGreaterThan(insertIdx);
    expect(unlinkIdx).toBeGreaterThan(errorBranchIdx);
  });

  it("Bloque 2B.1: si el rollback (unlinkSync) también falla, el mensaje exige borrado manual sin imprimir la causa", () => {
    const errorBranchIdx = scriptSource.indexOf("if (error || !data)");
    const rollbackCatchIdx = scriptSource.indexOf("} catch {", errorBranchIdx);
    const rollbackCatchBlock = scriptSource.slice(
      rollbackCatchIdx,
      rollbackCatchIdx + 500,
    );
    expect(rollbackCatchBlock).toMatch(/eliminar manualmente/);
    expect(rollbackCatchBlock).not.toMatch(/\berr\b/); // nunca referencia el objeto de error real
  });

  it("Bloque 2B.1: nunca imprime `contents` (el cuerpo del archivo secreto)", () => {
    expect(scriptSource).not.toMatch(/console\.(log|error)\([^)]*\bcontents\b[^)]*\)/);
  });

  it("solo se ejecuta cuando es el módulo principal (guard import.meta.url === argv[1])", () => {
    expect(scriptSource).toMatch(/isMainModule/);
    expect(scriptSource).toMatch(/if \(isMainModule\)/);
  });

  it("nunca importa/usa dotenv ni imprime process.env completo", () => {
    expect(scriptSource).not.toMatch(/console\.(log|error)\(process\.env\)/);
    expect(scriptSource).not.toMatch(/JSON\.stringify\(process\.env\)/);
  });
});

describe("package.json — sin ejecución accidental del script operator-side", () => {
  const packageJson = JSON.parse(
    readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"),
  );

  it("test/build/dev/prepare no invocan bootstrap-admin-invitation.mjs", () => {
    for (const key of ["test", "build", "dev", "dev:frontend", "dev:local", "prepare"]) {
      expect(packageJson.scripts[key]).not.toMatch(/bootstrap-admin-invitation/);
    }
  });

  it("existe un comando operator-side explícito y dedicado", () => {
    expect(packageJson.scripts["admin:bootstrap-invitation"]).toBe(
      "node scripts/bootstrap-admin-invitation.mjs",
    );
  });
});

describe(".gitignore — el secreto nunca puede entrar en Git", () => {
  it("ignora exactamente el directorio de secretos del script, sin un patrón demasiado amplio", () => {
    const gitignore = readFileSync(join(__dirname, "..", "..", ".gitignore"), "utf8");
    expect(gitignore).toMatch(/^\/scripts\/\.secrets\/$/m);
  });
});
