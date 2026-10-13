import { afterEach, describe, expect, it } from "vitest";
import {
  APPEAL_LOGIN_PATH,
  APPEAL_RETURN_PATH,
  PENDING_APPEAL_TOKEN_TTL_MS,
  capturePendingAppealToken,
  clearPendingAppealToken,
  parseAppealFragment,
  readPendingAppealToken,
} from "./pending-appeal-token";
import { parseSafeReturnTo } from "./safe-return-to";

// COPY-1 fase 2B: el token del enlace de apelación se guarda solo en memoria y sale de la URL.

const TOKEN = "Tt0123456789_-abcdefghijklmnopqrstuvwxyzABC".slice(0, 43);
afterEach(() => clearPendingAppealToken());

describe("memoria", () => {
  it("guarda un token válido, lo devuelve sin consumirlo y lo destruye al borrarlo", () => {
    expect(capturePendingAppealToken(TOKEN, 1000)).toBe(true);
    expect(readPendingAppealToken(1001)).toBe(TOKEN);
    expect(readPendingAppealToken(1002)).toBe(TOKEN);
    clearPendingAppealToken();
    expect(readPendingAppealToken(1003)).toBeNull();
  });

  it.each([null, undefined, 5, "", "corto", "A".repeat(44), "!".repeat(43), `${TOKEN} `])(
    "rechaza %j sin guardar nada",
    (bad) => {
      expect(capturePendingAppealToken(bad)).toBe(false);
      expect(readPendingAppealToken()).toBeNull();
    },
  );

  it("caduca y se destruye; un reloj hacia atrás también lo invalida", () => {
    capturePendingAppealToken(TOKEN, 1000);
    expect(readPendingAppealToken(1000 + PENDING_APPEAL_TOKEN_TTL_MS - 1)).toBe(TOKEN);
    expect(readPendingAppealToken(1000 + PENDING_APPEAL_TOKEN_TTL_MS)).toBeNull();
    expect(readPendingAppealToken(1001)).toBeNull();
    capturePendingAppealToken(TOKEN, 5000);
    expect(readPendingAppealToken(4000)).toBeNull();
  });

  it("un token nuevo sustituye al anterior", () => {
    capturePendingAppealToken(TOKEN);
    const other = "B".repeat(43);
    capturePendingAppealToken(other);
    expect(readPendingAppealToken()).toBe(other);
  });
});

describe("fragmento de la URL", () => {
  it("extrae el token y deja el resto del fragmento", () => {
    expect(parseAppealFragment(`#t=${TOKEN}`)).toEqual({
      present: true,
      token: TOKEN,
      remainder: "",
    });
    expect(parseAppealFragment(`#x=1&t=${TOKEN}`)).toEqual({
      present: true,
      token: TOKEN,
      remainder: "#x=1",
    });
  });

  it("un token mal formado también se retira de la URL, pero nunca se devuelve", () => {
    for (const hash of ["#t=corto", "#t=", "#t", `#t=${"A".repeat(44)}`])
      expect(parseAppealFragment(hash)).toMatchObject({
        present: true,
        token: null,
        remainder: "",
      });
  });

  it("un fragmento ajeno se conserva intacto", () => {
    expect(parseAppealFragment("#seccion")).toEqual({
      present: false,
      token: null,
      remainder: "#seccion",
    });
    expect(parseAppealFragment("")).toEqual({
      present: false,
      token: null,
      remainder: "",
    });
  });
});

describe("retorno tras iniciar sesión", () => {
  it("la ruta está en la lista permitida, sin parámetros, y el token nunca viaja en returnTo", () => {
    expect(APPEAL_LOGIN_PATH).toBe(`/login?returnTo=${APPEAL_RETURN_PATH}`);
    expect(parseSafeReturnTo(APPEAL_RETURN_PATH)?.path).toBe("/copyright/appeal");
    expect(parseSafeReturnTo(`/copyright/appeal?t=${TOKEN}`)).toBeNull();
    expect(parseSafeReturnTo(`/copyright/appeal#t=${TOKEN}`)).toBeNull();
  });
});
