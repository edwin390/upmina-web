import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PRIVILEGED_MFA_CLOCK_SKEW_SECONDS,
  PRIVILEGED_MFA_WINDOW_SECONDS,
  currentEpochSeconds,
  getLatestTotpTimestamp,
  hasRecentMfa,
  isMfaRecent,
} from "./privileged-mfa";

// Fija la regla de MFA reciente (Fase 9G-1): aal2 + timestamp TOTP del claim `amr` dentro de la
// ventana, con reloj inyectado. Todo lo que no sea una marca TOTP válida y reciente falla cerrado.

const NOW = 1_800_000_000; // segundos UNIX ficticios y fijos
const WINDOW = PRIVILEGED_MFA_WINDOW_SECONDS;
const SKEW = PRIVILEGED_MFA_CLOCK_SKEW_SECONDS;

const totp = (timestamp: unknown, method = "totp") => ({ method, timestamp });

afterEach(() => {
  vi.useRealTimers();
});

describe("constantes", () => {
  it("la ventana es de 30 minutos y la tolerancia de reloj es pequeña y explícita", () => {
    expect(WINDOW).toBe(1800);
    expect(SKEW).toBeGreaterThan(0);
    expect(SKEW).toBeLessThanOrEqual(120);
  });
});

describe("hasRecentMfa", () => {
  it("aal2 + totp dentro de 30 min → true", () => {
    expect(hasRecentMfa({ aal: "aal2", amr: [totp(NOW - 600)] }, NOW)).toBe(true);
  });

  it("aal2 + mfa/totp dentro de 30 min → true", () => {
    expect(hasRecentMfa({ aal: "aal2", amr: [totp(NOW - 600, "mfa/totp")] }, NOW)).toBe(
      true,
    );
  });

  it("recién verificado (delta 0) → true", () => {
    expect(hasRecentMfa({ aal: "aal2", amr: [totp(NOW)] }, NOW)).toBe(true);
  });

  it("timestamp exactamente en el límite (1800 s) → true; un segundo más → false", () => {
    expect(hasRecentMfa({ aal: "aal2", amr: [totp(NOW - WINDOW)] }, NOW)).toBe(true);
    expect(hasRecentMfa({ aal: "aal2", amr: [totp(NOW - WINDOW - 1)] }, NOW)).toBe(false);
  });

  it("timestamp vencido → false", () => {
    expect(hasRecentMfa({ aal: "aal2", amr: [totp(NOW - 3600)] }, NOW)).toBe(false);
  });

  it("aal1 → false aunque exista un TOTP reciente en amr", () => {
    expect(hasRecentMfa({ aal: "aal1", amr: [totp(NOW - 10)] }, NOW)).toBe(false);
  });

  it("aal ausente o de otro tipo → false", () => {
    for (const aal of [undefined, null, "", "AAL2", 2, true, {}]) {
      expect(hasRecentMfa({ aal, amr: [totp(NOW)] }, NOW)).toBe(false);
    }
  });

  it("amr ausente → false", () => {
    expect(hasRecentMfa({ aal: "aal2" }, NOW)).toBe(false);
  });

  it("amr malformado (no array, elementos raros) → false, sin lanzar", () => {
    for (const amr of [
      null,
      "totp",
      42,
      {},
      [null],
      [undefined],
      ["x"],
      [[]],
      [{}],
      [{ method: 5 }],
    ]) {
      expect(hasRecentMfa({ aal: "aal2", amr }, NOW)).toBe(false);
    }
  });

  it("amr string[] (formato RFC sin timestamps) → false", () => {
    expect(hasRecentMfa({ aal: "aal2", amr: ["password", "totp"] }, NOW)).toBe(false);
    expect(hasRecentMfa({ aal: "aal2", amr: ["mfa/totp"] }, NOW)).toBe(false);
  });

  it("solo password (sin entrada TOTP) → false", () => {
    expect(
      hasRecentMfa({ aal: "aal2", amr: [{ method: "password", timestamp: NOW }] }, NOW),
    ).toBe(false);
  });

  it("otros métodos con timestamp reciente no cuentan como TOTP", () => {
    for (const method of [
      "otp",
      "oauth",
      "magiclink",
      "mfa/phone",
      "mfa/webauthn",
      "TOTP",
      "totp ",
    ]) {
      expect(hasRecentMfa({ aal: "aal2", amr: [totp(NOW, method)] }, NOW)).toBe(false);
    }
  });

  it("timestamp NaN / infinito / no numérico / <= 0 → false", () => {
    for (const ts of [
      NaN,
      Infinity,
      -Infinity,
      "1800000000",
      null,
      undefined,
      {},
      0,
      -5,
    ]) {
      expect(hasRecentMfa({ aal: "aal2", amr: [totp(ts)] }, NOW)).toBe(false);
    }
  });

  it("timestamp futuro dentro de la tolerancia de reloj → true", () => {
    expect(hasRecentMfa({ aal: "aal2", amr: [totp(NOW + 5)] }, NOW)).toBe(true);
    expect(hasRecentMfa({ aal: "aal2", amr: [totp(NOW + SKEW)] }, NOW)).toBe(true);
  });

  it("timestamp futuro por encima de la tolerancia → false", () => {
    expect(hasRecentMfa({ aal: "aal2", amr: [totp(NOW + SKEW + 1)] }, NOW)).toBe(false);
    expect(hasRecentMfa({ aal: "aal2", amr: [totp(NOW + 86_400)] }, NOW)).toBe(false);
  });

  it("múltiples TOTP → usa el más reciente (uno viejo no invalida al nuevo y viceversa)", () => {
    expect(
      hasRecentMfa(
        { aal: "aal2", amr: [totp(NOW - 9999), totp(NOW - 60, "mfa/totp")] },
        NOW,
      ),
    ).toBe(true);
    expect(
      hasRecentMfa({ aal: "aal2", amr: [totp(NOW - 9999), totp(NOW - 8888)] }, NOW),
    ).toBe(false);
  });

  it("el orden de las entradas no importa", () => {
    const a = [totp(NOW - 60), totp(NOW - 9999)];
    expect(hasRecentMfa({ aal: "aal2", amr: a }, NOW)).toBe(true);
    expect(hasRecentMfa({ aal: "aal2", amr: [...a].reverse() }, NOW)).toBe(true);
  });

  it("una entrada TOTP inválida no anula a una válida", () => {
    expect(
      hasRecentMfa({ aal: "aal2", amr: [totp(NaN), totp(NOW - 10), totp("x")] }, NOW),
    ).toBe(true);
  });

  it("un TOTP futuro anómalo junto a uno reciente válido → false (falla cerrado ante anomalías)", () => {
    expect(
      hasRecentMfa({ aal: "aal2", amr: [totp(NOW - 10), totp(NOW + 86_400)] }, NOW),
    ).toBe(false);
  });

  it("claims null/undefined/no objeto → false", () => {
    expect(hasRecentMfa(null, NOW)).toBe(false);
    expect(hasRecentMfa(undefined, NOW)).toBe(false);
    expect(hasRecentMfa("aal2" as never, NOW)).toBe(false);
  });

  it("ventana o reloj no finitos / ventana <= 0 → false", () => {
    const claims = { aal: "aal2", amr: [totp(NOW)] };
    expect(hasRecentMfa(claims, NaN)).toBe(false);
    expect(hasRecentMfa(claims, NOW, 0)).toBe(false);
    expect(hasRecentMfa(claims, NOW, -1)).toBe(false);
    expect(hasRecentMfa(claims, NOW, NaN)).toBe(false);
    expect(hasRecentMfa(claims, NOW, Infinity)).toBe(false);
  });

  it("acepta una ventana explícita distinta de la de por defecto", () => {
    const claims = { aal: "aal2", amr: [totp(NOW - 120)] };
    expect(hasRecentMfa(claims, NOW, 60)).toBe(false);
    expect(hasRecentMfa(claims, NOW, 300)).toBe(true);
  });

  it("sin reloj inyectado usa el reloj del sistema (testeable con fake timers)", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
    const claims = { aal: "aal2", amr: [totp(NOW - 100)] };
    expect(hasRecentMfa(claims)).toBe(true);
    vi.setSystemTime((NOW + WINDOW) * 1000);
    expect(hasRecentMfa(claims)).toBe(false);
    expect(currentEpochSeconds()).toBe(NOW + WINDOW);
  });

  it("no muta las claims recibidas", () => {
    const claims = { aal: "aal2", amr: [totp(NOW - 5), totp(NOW - 50)] };
    const copy = JSON.parse(JSON.stringify(claims));
    hasRecentMfa(claims, NOW);
    expect(claims).toEqual(copy);
  });
});

describe("getLatestTotpTimestamp", () => {
  it("devuelve el mayor timestamp TOTP válido, o null", () => {
    expect(getLatestTotpTimestamp([totp(10), totp(30, "mfa/totp"), totp(20)])).toBe(30);
    expect(getLatestTotpTimestamp([])).toBeNull();
    expect(getLatestTotpTimestamp(undefined)).toBeNull();
    expect(getLatestTotpTimestamp([{ method: "password", timestamp: 5 }])).toBeNull();
  });
});

describe("isMfaRecent (identidad ya extraída del JWT)", () => {
  it("combina aal y marca: aal2 + marca reciente → true; aal1 o marca null → false", () => {
    expect(isMfaRecent("aal2", NOW - 10, NOW)).toBe(true);
    expect(isMfaRecent("aal1", NOW - 10, NOW)).toBe(false);
    expect(isMfaRecent("aal2", null, NOW)).toBe(false);
    expect(isMfaRecent("aal2", undefined, NOW)).toBe(false);
  });
});
