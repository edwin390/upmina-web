import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRecoveryMark,
  markRecoverySession,
  passwordResetRedirectUrl,
  RECOVERY_MARK_MAX_AGE_MS,
  recoveryMarkMatches,
  sessionIdFromAccessToken,
  startRecoveryTracking,
} from "./password-recovery";

// Marca de recuperación de contraseña. Valores SINTÉTICOS. La marca nace del evento real PASSWORD_RECOVERY, está atada
// al usuario y al session_id de ESA sesión, caduca a los 15 min y nunca guarda tokens.

const SID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const b64 = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const token = (sessionId: string | null, secret = "SENTINEL-SIGNATURE") =>
  `${b64({ alg: "ES256" })}.${b64({ sub: "u", ...(sessionId ? { session_id: sessionId } : {}) })}.${secret}`;
const session = (userId: string, sessionId: string | null) => ({
  user: { id: userId },
  access_token: token(sessionId),
});

beforeEach(() => {
  clearRecoveryMark();
  window.sessionStorage.clear();
});
afterEach(() => {
  clearRecoveryMark();
  vi.useRealTimers();
});

describe("session_id del token (solo para comparar)", () => {
  it("lo lee del payload y rechaza tokens malformados o sin session_id válido", () => {
    expect(sessionIdFromAccessToken(token(SID_A))).toBe(SID_A);
    expect(sessionIdFromAccessToken(token(null))).toBeNull();
    expect(sessionIdFromAccessToken("sin-puntos")).toBeNull();
    expect(sessionIdFromAccessToken("a.%%%.c")).toBeNull();
    expect(
      sessionIdFromAccessToken(`${b64({})}.${b64({ session_id: "no-uuid" })}.s`),
    ).toBeNull();
    expect(sessionIdFromAccessToken("")).toBeNull();
  });
});

describe("marca atada a la sesión de recuperación", () => {
  it("coincide solo con el mismo usuario Y la misma sesión; sigue valiendo si el token se renueva (mismo session_id)", () => {
    markRecoverySession(session("u1", SID_A));
    expect(recoveryMarkMatches(session("u1", SID_A))).toBe(true);
    expect(
      recoveryMarkMatches({
        user: { id: "u1" },
        access_token: token(SID_A, "OTRA-FIRMA"),
      }),
    ).toBe(true);
  });

  it("una sesión ORDINARIA (otro session_id) NO coincide y la marca obsoleta se limpia", () => {
    markRecoverySession(session("u1", SID_A));
    expect(recoveryMarkMatches(session("u1", SID_B))).toBe(false);
    // ya limpiada: ni siquiera la sesión original vuelve a coincidir
    expect(recoveryMarkMatches(session("u1", SID_A))).toBe(false);
  });

  it("una sesión de OTRA cuenta no coincide y limpia la marca", () => {
    markRecoverySession(session("u1", SID_A));
    expect(recoveryMarkMatches(session("u2", SID_A))).toBe(false);
    expect(recoveryMarkMatches(session("u1", SID_A))).toBe(false);
  });

  it("sin sesión no coincide pero NO borra la marca (la sesión puede estar resolviéndose)", () => {
    markRecoverySession(session("u1", SID_A));
    expect(recoveryMarkMatches(null)).toBe(false);
    expect(recoveryMarkMatches(session("u1", SID_A))).toBe(true);
  });

  it("caduca a los 15 minutos exactos y se limpia", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-05T10:00:00Z"));
    markRecoverySession(session("u1", SID_A));
    vi.setSystemTime(Date.now() + RECOVERY_MARK_MAX_AGE_MS - 1);
    expect(recoveryMarkMatches(session("u1", SID_A))).toBe(true);
    vi.setSystemTime(Date.now() + 1);
    expect(recoveryMarkMatches(session("u1", SID_A))).toBe(false);
    vi.setSystemTime(new Date("2026-11-05T10:00:01Z")); // aunque el reloj «vuelva»: ya se limpió
    expect(recoveryMarkMatches(session("u1", SID_A))).toBe(false);
    expect(RECOVERY_MARK_MAX_AGE_MS).toBe(15 * 60 * 1000);
  });

  it("un token sin session_id legible no se marca (falla cerrado)", () => {
    markRecoverySession(session("u1", null));
    expect(recoveryMarkMatches(session("u1", SID_A))).toBe(false);
    expect(window.sessionStorage.getItem("upmina:password-recovery")).toBeNull();
  });
});

describe("qué se almacena", () => {
  it("solo userId, sessionId y caducidad: ni token, ni firma, ni contraseña, ni fragmento", () => {
    markRecoverySession(session("u1", SID_A));
    const raw = window.sessionStorage.getItem("upmina:password-recovery")!;
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      "expiresAt",
      "sessionId",
      "userId",
    ]);
    expect(raw).not.toMatch(/SENTINEL|eyJ|access_token|password/i);
    expect(JSON.stringify(Object.entries(window.localStorage))).not.toMatch(/SENTINEL/);
  });
});

describe("recarga, pestañas y almacenamiento", () => {
  it("una recarga legítima (mismo sessionStorage, misma sesión) conserva la marca", () => {
    markRecoverySession(session("u1", SID_A));
    // la recarga no tiene estado en memoria: todo sale del sessionStorage de la pestaña
    expect(recoveryMarkMatches(session("u1", SID_A))).toBe(true);
  });

  it("OTRA pestaña (sessionStorage vacío) comparte la sesión pero no la marca: no coincide", () => {
    markRecoverySession(session("u1", SID_A));
    window.sessionStorage.clear(); // simula la otra pestaña
    expect(recoveryMarkMatches(session("u1", SID_A))).toBe(false);
  });

  it("una entrada corrupta o con forma inesperada se ignora", () => {
    for (const bad of [
      "no-json",
      "{}",
      JSON.stringify({
        userId: "u1",
        sessionId: "no-uuid",
        expiresAt: Date.now() + 1000,
      }),
      JSON.stringify({ userId: "u1", sessionId: SID_A, expiresAt: "mañana" }),
      "null",
    ]) {
      window.sessionStorage.setItem("upmina:password-recovery", bad);
      expect(recoveryMarkMatches(session("u1", SID_A)), bad).toBe(false);
    }
  });

  it("sin sessionStorage no lanza y la marca vive en memoria", () => {
    const original = Object.getOwnPropertyDescriptor(window, "sessionStorage")!;
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      expect(() => markRecoverySession(session("u1", SID_A))).not.toThrow();
      expect(recoveryMarkMatches(session("u1", SID_A))).toBe(true);
      expect(() => clearRecoveryMark()).not.toThrow();
      expect(recoveryMarkMatches(session("u1", SID_A))).toBe(false);
    } finally {
      Object.defineProperty(window, "sessionStorage", original);
    }
  });
});

describe("evento real de supabase-js", () => {
  function track() {
    let callback!: (event: string, s: ReturnType<typeof session> | null) => void;
    startRecoveryTracking({
      onAuthStateChange: (cb) => {
        callback = cb;
        return { data: { subscription: {} } };
      },
    });
    return callback;
  }

  it("solo PASSWORD_RECOVERY marca; otros eventos (INITIAL_SESSION, SIGNED_IN, TOKEN_REFRESHED, USER_UPDATED) no", () => {
    const emit = track();
    for (const event of [
      "INITIAL_SESSION",
      "SIGNED_IN",
      "TOKEN_REFRESHED",
      "USER_UPDATED",
      "MFA_CHALLENGE_VERIFIED",
    ]) {
      emit(event, session("u1", SID_A));
      expect(recoveryMarkMatches(session("u1", SID_A)), event).toBe(false);
    }
    emit("PASSWORD_RECOVERY", session("u1", SID_A));
    expect(recoveryMarkMatches(session("u1", SID_A))).toBe(true);
    emit("TOKEN_REFRESHED", session("u1", SID_A)); // renovar no la toca
    expect(recoveryMarkMatches(session("u1", SID_A))).toBe(true);
  });

  it("SIGNED_OUT limpia la marca", () => {
    const emit = track();
    emit("PASSWORD_RECOVERY", session("u1", SID_A));
    emit("SIGNED_OUT", null);
    expect(recoveryMarkMatches(session("u1", SID_A))).toBe(false);
  });

  it("un SIGNED_IN de otra sesión o cuenta invalida la marca; el de la misma sesión no", () => {
    const emit = track();
    emit("PASSWORD_RECOVERY", session("u1", SID_A));
    emit("SIGNED_IN", session("u1", SID_A));
    expect(recoveryMarkMatches(session("u1", SID_A))).toBe(true);
    emit("SIGNED_IN", session("u1", SID_B)); // inicio de sesión normal posterior
    expect(recoveryMarkMatches(session("u1", SID_A))).toBe(false);
    emit("PASSWORD_RECOVERY", session("u1", SID_A));
    emit("SIGNED_IN", session("u2", SID_A)); // otra cuenta
    expect(recoveryMarkMatches(session("u1", SID_A))).toBe(false);
  });

  it("un enlace de recuperación nuevo reemplaza la marca anterior", () => {
    const emit = track();
    emit("PASSWORD_RECOVERY", session("u1", SID_A));
    emit("PASSWORD_RECOVERY", session("u2", SID_B));
    expect(recoveryMarkMatches(session("u1", SID_A))).toBe(false);
    markRecoverySession(session("u2", SID_B));
    expect(recoveryMarkMatches(session("u2", SID_B))).toBe(true);
  });
});

describe("el cliente de Supabase se suscribe al crearse (antes del evento)", () => {
  it("importar supabase.ts registra UNA suscripción de recuperación", async () => {
    const onAuthStateChange = vi.fn(() => ({ data: { subscription: {} } }));
    vi.resetModules();
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({ auth: { onAuthStateChange } }),
    }));
    try {
      await import("./supabase");
      expect(onAuthStateChange).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock("@supabase/supabase-js");
      vi.resetModules();
    }
  });
});

describe("URL de retorno", () => {
  it("es siempre /reset-password del mismo origen (nunca derivada de datos del usuario)", () => {
    expect(passwordResetRedirectUrl()).toBe(`${window.location.origin}/reset-password`);
  });
});
