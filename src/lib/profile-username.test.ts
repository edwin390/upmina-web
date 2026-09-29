import { describe, expect, it } from "vitest";
import {
  RESERVED_USERNAMES,
  checkUsername,
  isReservedUsername,
  isValidUsernameFormat,
  normalizeUsername,
} from "./profile-username";

// Formato de username congelado en 9J-1B: 3-24 caracteres, a-z/0-9/_/., sin punto
// inicial/final ni puntos consecutivos. Unidad pura (sin red/Supabase): la autoridad final
// sigue siendo el CHECK profiles_username_format de
// supabase/migrations/20261003120000_community_username_foundation.sql — este archivo prueba
// que la validación server-side (la que de verdad corre antes de tocar la DB) implementa
// EXACTAMENTE la misma regla.

describe("isValidUsernameFormat — longitud y conjunto de caracteres", () => {
  it("acepta 3 y 24 caracteres; rechaza 2 y 25", () => {
    expect(isValidUsernameFormat("abc")).toBe(true);
    expect(isValidUsernameFormat("a".repeat(24))).toBe(true);
    expect(isValidUsernameFormat("ab")).toBe(false);
    expect(isValidUsernameFormat("a".repeat(25))).toBe(false);
  });

  it("acepta a-z, 0-9, guion bajo y punto", () => {
    expect(isValidUsernameFormat("edwin_390")).toBe(true);
    expect(isValidUsernameFormat("ed.win390")).toBe(true);
    expect(isValidUsernameFormat("e.d_w9")).toBe(true);
  });

  it("rechaza mayúsculas (se espera ya normalizado), espacios, guion, arroba y Unicode", () => {
    for (const bad of ["Edwin390", "ed win", "ed-win", "ed@win", "edwín390", "peña"]) {
      expect(isValidUsernameFormat(bad)).toBe(false);
    }
  });
});

describe("isValidUsernameFormat — reglas de punto", () => {
  it("punto inicial → inválido", () => {
    expect(isValidUsernameFormat(".edwin")).toBe(false);
  });

  it("punto final → inválido", () => {
    expect(isValidUsernameFormat("edwin.")).toBe(false);
  });

  it("puntos consecutivos → inválido", () => {
    expect(isValidUsernameFormat("ed..win")).toBe(false);
    expect(isValidUsernameFormat("e....d")).toBe(false);
  });

  it("un único punto interior, sin tocar los extremos → válido", () => {
    expect(isValidUsernameFormat("ed.win")).toBe(true);
    expect(isValidUsernameFormat("a.b.c")).toBe(true);
  });
});

describe("normalizeUsername", () => {
  it("trim + minúsculas; sin transliteración Unicode", () => {
    expect(normalizeUsername("  Edwin390  ")).toBe("edwin390");
    expect(normalizeUsername("Edwín")).toBe("edwín");
  });
});

describe("RESERVED_USERNAMES — 9J-1B añade el set de Comunidad", () => {
  const addedIn9J1B = [
    "community",
    "account",
    "api",
    "login",
    "signup",
    "settings",
    "cosplay",
    "media",
  ];

  it.each(addedIn9J1B)("%s está reservado", (name) => {
    expect(isReservedUsername(name)).toBe(true);
  });

  it("conserva los nombres reservados previos", () => {
    for (const name of [
      "admin",
      "administrator",
      "moderator",
      "mod",
      "staff",
      "support",
      "official",
      "mina",
      "upmina",
      "upminaa",
      "root",
      "system",
    ]) {
      expect(isReservedUsername(name)).toBe(true);
    }
  });

  it("la comparación es sobre el valor ya normalizado (case-insensitive vía normalizeUsername)", () => {
    expect(isReservedUsername(normalizeUsername("Community"))).toBe(true);
    expect(isReservedUsername(normalizeUsername("  API  "))).toBe(true);
  });

  it("un nombre que solo CONTIENE uno reservado no está reservado", () => {
    expect(isReservedUsername("community1")).toBe(false);
    expect(isReservedUsername("myaccount")).toBe(false);
  });

  it("RESERVED_USERNAMES no tiene duplicados y todos están en minúsculas", () => {
    const values = [...RESERVED_USERNAMES];
    expect(new Set(values).size).toBe(values.length);
    expect(values.every((v) => v === v.toLowerCase())).toBe(true);
  });
});

describe("checkUsername — integración normalizar + formato + reservado", () => {
  it("válido: normaliza y acepta", () => {
    expect(checkUsername("  Ed.Win_390  ")).toEqual({ ok: true, username: "ed.win_390" });
  });

  it("formato inválido → reason invalid", () => {
    expect(checkUsername("ab")).toEqual({ ok: false, reason: "invalid" });
    expect(checkUsername(".edwin")).toEqual({ ok: false, reason: "invalid" });
    expect(checkUsername("edwin.")).toEqual({ ok: false, reason: "invalid" });
    expect(checkUsername("ed..win")).toEqual({ ok: false, reason: "invalid" });
  });

  it("reservado (tras normalizar) → reason reserved, nunca invalid", () => {
    expect(checkUsername("Community")).toEqual({ ok: false, reason: "reserved" });
    expect(checkUsername("  MEDIA  ")).toEqual({ ok: false, reason: "reserved" });
  });

  it("no-string → reason invalid", () => {
    expect(checkUsername(null)).toEqual({ ok: false, reason: "invalid" });
    expect(checkUsername(undefined)).toEqual({ ok: false, reason: "invalid" });
    expect(checkUsername(123)).toEqual({ ok: false, reason: "invalid" });
  });
});
