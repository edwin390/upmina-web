import { afterEach, describe, expect, it } from "vitest";
import {
  parseRecoveryFragment,
  capturePendingRecoveryCode,
  clearPendingRecoveryCode,
  extractRecoveryCode,
  PENDING_RECOVERY_CODE_TTL_MS,
  readPendingRecoveryCode,
  RECOVERY_LOGIN_PATH,
} from "./pending-recovery-code";
import { parseSafeReturnTo } from "./safe-return-to";

// Código del correo de recuperación de MFA, SOLO en memoria. Datos sintéticos.

const A = "A".repeat(43);
const B = "B".repeat(43);

afterEach(() => clearPendingRecoveryCode());

describe("pending-recovery-code", () => {
  it("captura, lee sin consumir y limpia", () => {
    expect(readPendingRecoveryCode()).toBeNull();
    expect(capturePendingRecoveryCode(A)).toBe(true);
    expect(readPendingRecoveryCode()).toBe(A);
    expect(readPendingRecoveryCode()).toBe(A);
    clearPendingRecoveryCode();
    expect(readPendingRecoveryCode()).toBeNull();
  });

  it("un código nuevo sustituye al anterior; uno inválido no reemplaza nada", () => {
    capturePendingRecoveryCode(A);
    expect(capturePendingRecoveryCode("corto")).toBe(false);
    expect(capturePendingRecoveryCode(123)).toBe(false);
    expect(capturePendingRecoveryCode(`${A}!`)).toBe(false);
    expect(readPendingRecoveryCode()).toBe(A);
    capturePendingRecoveryCode(B);
    expect(readPendingRecoveryCode()).toBe(B);
  });

  it("caduca exactamente a los 15 minutos (límite exclusivo) y al caducar se destruye", () => {
    capturePendingRecoveryCode(A, 1_000);
    expect(readPendingRecoveryCode(1_000 + PENDING_RECOVERY_CODE_TTL_MS - 1)).toBe(A);
    expect(readPendingRecoveryCode(1_000 + PENDING_RECOVERY_CODE_TTL_MS)).toBeNull();
    expect(readPendingRecoveryCode(1_001)).toBeNull(); // ya destruido
  });

  it("un reloj que retrocede falla cerrado", () => {
    capturePendingRecoveryCode(A, 5_000);
    expect(readPendingRecoveryCode(4_000)).toBeNull();
  });

  it("nunca se guarda en el almacenamiento del navegador", () => {
    capturePendingRecoveryCode(A);
    expect(JSON.stringify({ ...localStorage })).not.toContain(A);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(A);
    expect(document.cookie).not.toContain(A);
  });

  it("la ruta de retorno del login es una ruta permitida y NO contiene el código", () => {
    capturePendingRecoveryCode(A);
    expect(RECOVERY_LOGIN_PATH).toBe("/login?returnTo=/admin/mfa/recovery");
    expect(RECOVERY_LOGIN_PATH).not.toContain(A);
    const returnTo = new URL(RECOVERY_LOGIN_PATH, "https://x.test").searchParams.get(
      "returnTo",
    );
    expect(parseSafeReturnTo(returnTo)?.path).toBe("/admin/mfa/recovery");
  });
});

describe("extractRecoveryCode (pegar el código o el enlace del correo en otro dispositivo)", () => {
  it("acepta el código solo, con espacios alrededor", () => {
    expect(extractRecoveryCode(A)).toBe(A);
    expect(extractRecoveryCode(`  ${A}\n`)).toBe(A);
  });
  it("extrae el código del enlace completo", () => {
    expect(
      extractRecoveryCode(`https://dev.example.test/admin/mfa/recovery#c=${A}`),
    ).toBe(A);
    expect(
      extractRecoveryCode(`ver: https://x.test/admin/mfa/recovery#c=${B} gracias`),
    ).toBe(B);
  });
  it.each([
    [""],
    ["hola"],
    ["A".repeat(42)],
    ["A".repeat(44)],
    [`https://x.test/#c=${"A".repeat(44)}`],
    [`https://x.test/#t=${A}`], // el token de CANCELACIÓN no es un código de verificación
    [`https://x.test/?c=${A}`],
  ])("rechaza %j", (raw) => {
    expect(extractRecoveryCode(raw)).toBeNull();
  });
});

describe("parseRecoveryFragment", () => {
  const OK = "A".repeat(43);
  const cases: [string, string, boolean, string | null, string][] = [
    ["código válido", `#c=${OK}`, true, OK, ""],
    ["fragmento vacío «#c=»", "#c=", true, null, ""],
    ["parámetro sin valor «#c»", "#c", true, null, ""],
    ["39 caracteres", `#c=${"A".repeat(39)}`, true, null, ""],
    ["44 caracteres", `#c=${"A".repeat(44)}`, true, null, ""],
    ["caracteres no permitidos", `#c=${"A".repeat(42)}!`, true, null, ""],
    ["con espacios o %20", `#c=${"A".repeat(42)}%20`, true, null, ""],
    ["código válido y otro parámetro", `#c=${OK}&x=1`, true, OK, "#x=1"],
    ["otro parámetro y código válido", `#a=1&c=${OK}`, true, OK, "#a=1"],
    ["inválido y otro parámetro: conserva el ajeno", `#c=corto&x=1`, true, null, "#x=1"],
    ["fragmento ajeno de ancla", "#seccion", false, null, "#seccion"],
    ["fragmento ajeno con parámetros", "#x=1&y=2", false, null, "#x=1&y=2"],
    ["clave parecida («C» o «cc»)", `#C=${OK}`, false, null, `#C=${OK}`],
    ["clave parecida «cc»", `#cc=${OK}`, false, null, `#cc=${OK}`],
    ["solo «#»", "#", false, null, "#"],
    ["sin fragmento", "", false, null, ""],
  ];
  it.each(cases)("%s", (_name, hash, present, code, remainder) => {
    expect(parseRecoveryFragment(hash)).toEqual({ present, code, remainder });
  });

  it("nunca devuelve un código inválido ni lo conserva en el resto del fragmento", () => {
    for (const hash of ["#c=corto", `#c=${"B".repeat(50)}`, "#c=", "#c"]) {
      const parsed = parseRecoveryFragment(hash);
      expect(parsed.code).toBeNull();
      expect(parsed.remainder).not.toContain("c=");
    }
  });
});
