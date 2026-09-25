import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PENDING_INVITATION_TTL_MS,
  bindPendingInvitationToUser,
  capturePendingInvitation,
  clearPendingInvitation,
  consumePendingInvitation,
  discardPendingInvitationIfUserChanged,
  hasPendingInvitation,
  readPendingInvitation,
} from "./pending-invitation";

// Todos los valores son SINTÉTICOS y claramente no secretos (nunca un token de invitación real).
const TOKEN = "token-de-prueba-no-secreto_A1";
const OTHER_TOKEN = "otro-token-de-prueba_B2";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T0 = 1_800_000_000_000; // ms, reloj ficticio y fijo
const TTL = PENDING_INVITATION_TTL_MS;

beforeEach(() => {
  clearPendingInvitation();
});

afterEach(() => {
  clearPendingInvitation();
  vi.restoreAllMocks();
});

describe("TTL", () => {
  it("es de 30 minutos", () => {
    expect(TTL).toBe(30 * 60 * 1000);
  });

  it("vigente 1 ms antes del límite; vencido exactamente a los 30 min y después", () => {
    capturePendingInvitation(TOKEN, T0);
    expect(readPendingInvitation(null, T0 + TTL - 1)).toBe(TOKEN);
    expect(hasPendingInvitation(T0 + TTL - 1)).toBe(true);
    expect(readPendingInvitation(null, T0 + TTL)).toBeNull();
    expect(hasPendingInvitation(T0 + TTL)).toBe(false);
  });

  it("un token vencido se DESTRUYE al consultarlo: no reaparece aunque el reloj retroceda", () => {
    capturePendingInvitation(TOKEN, T0);
    expect(readPendingInvitation(null, T0 + TTL + 1)).toBeNull();
    expect(readPendingInvitation(null, T0)).toBeNull();
    expect(hasPendingInvitation(T0)).toBe(false);
  });

  it("un reloj anterior a la captura (negativo) o no finito falla cerrado y destruye", () => {
    capturePendingInvitation(TOKEN, T0);
    expect(readPendingInvitation(null, T0 - 1)).toBeNull();
    capturePendingInvitation(TOKEN, T0);
    expect(readPendingInvitation(null, NaN)).toBeNull();
    expect(hasPendingInvitation(T0)).toBe(false);
  });

  it("el TTL cuenta desde la captura y NO se renueva al leer", () => {
    capturePendingInvitation(TOKEN, T0);
    expect(readPendingInvitation(null, T0 + TTL - 10)).toBe(TOKEN);
    expect(readPendingInvitation(null, T0 + TTL)).toBeNull();
  });

  it("asociar a un usuario no renueva el TTL", () => {
    capturePendingInvitation(TOKEN, T0);
    expect(bindPendingInvitationToUser(USER_A, T0 + TTL - 10)).toBe(true);
    expect(readPendingInvitation(USER_A, T0 + TTL)).toBeNull();
  });

  it("un token vencido no se puede asociar", () => {
    capturePendingInvitation(TOKEN, T0);
    expect(bindPendingInvitationToUser(USER_A, T0 + TTL)).toBe(false);
  });

  it("sin reloj inyectado usa el reloj del sistema (fake timers)", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    capturePendingInvitation(TOKEN);
    vi.setSystemTime(T0 + TTL - 1);
    expect(readPendingInvitation(null)).toBe(TOKEN);
    vi.setSystemTime(T0 + TTL);
    expect(readPendingInvitation(null)).toBeNull();
    vi.useRealTimers();
  });
});

describe("captura", () => {
  it("guarda y lee un token (estado previo al login, sin usuario)", () => {
    expect(capturePendingInvitation(TOKEN, T0)).toBe(true);
    expect(hasPendingInvitation(T0)).toBe(true);
    expect(readPendingInvitation(null, T0)).toBe(TOKEN);
    // Leer no consume.
    expect(readPendingInvitation(null, T0)).toBe(TOKEN);
  });

  it.each([
    ["vacío", ""],
    ["solo espacios", "   "],
    ["con espacios", "abc def"],
    ["salto de línea", "abc\n"],
    ["con /", "a/b"],
    ["con ?", "a?b"],
    ["con #", "a#b"],
    ["con =", "a=b"],
    ["con %", "a%20b"],
    ["Unicode", "tokén"],
    ["demasiado largo", "a".repeat(513)],
    ["null", null],
    ["undefined", undefined],
    ["número", 123],
    ["objeto", { token: TOKEN }],
    ["array", [TOKEN]],
  ])("rechaza %s sin guardar nada", (_name, value) => {
    expect(capturePendingInvitation(value, T0)).toBe(false);
    expect(hasPendingInvitation(T0)).toBe(false);
    expect(readPendingInvitation(null, T0)).toBeNull();
  });

  it("un token inválido NO borra uno válido ya guardado", () => {
    capturePendingInvitation(TOKEN, T0);
    expect(capturePendingInvitation("", T0)).toBe(false);
    expect(readPendingInvitation(null, T0)).toBe(TOKEN);
  });

  it("capturar otro token reemplaza al anterior, reinicia el TTL y lo deja sin usuario", () => {
    capturePendingInvitation(TOKEN, T0);
    bindPendingInvitationToUser(USER_A, T0);
    capturePendingInvitation(OTHER_TOKEN, T0 + 1000);
    expect(readPendingInvitation(null, T0 + 1000)).toBe(OTHER_TOKEN);
    expect(readPendingInvitation(USER_A, T0 + 1000)).toBeNull();
  });

  it("acepta el alfabeto base64url completo", () => {
    const token = "ABCabc012-_".repeat(4);
    expect(capturePendingInvitation(token, T0)).toBe(true);
    expect(readPendingInvitation(null, T0)).toBe(token);
  });
});

describe("política de captura T1 → T2 (determinista)", () => {
  it("T1 sin asociar → T2 sin asociar: T2 reemplaza por completo a T1 (T1 irrecuperable, TTL nuevo)", () => {
    capturePendingInvitation(TOKEN, T0);
    capturePendingInvitation(OTHER_TOKEN, T0 + 60_000);

    expect(readPendingInvitation(null, T0 + 60_000)).toBe(OTHER_TOKEN);
    // El TTL cuenta desde la captura de T2, no de T1.
    expect(readPendingInvitation(null, T0 + TTL)).toBe(OTHER_TOKEN);
    expect(readPendingInvitation(null, T0 + 60_000 + TTL)).toBeNull();
    // T1 no reaparece por ningún camino.
    capturePendingInvitation(OTHER_TOKEN, T0);
    expect(consumePendingInvitation(null, T0)).toBe(OTHER_TOKEN);
    expect(consumePendingInvitation(null, T0)).toBeNull();
  });

  it("T1 asociado a A → T2: T2 reemplaza a T1, queda SIN usuario y A no lo lee hasta volver a asociarlo", () => {
    capturePendingInvitation(TOKEN, T0);
    bindPendingInvitationToUser(USER_A, T0);

    capturePendingInvitation(OTHER_TOKEN, T0 + 1000);

    expect(readPendingInvitation(USER_A, T0 + 1000)).toBeNull(); // T1 perdido, T2 aún sin asociar
    expect(readPendingInvitation(null, T0 + 1000)).toBe(OTHER_TOKEN); // T2 sin usuario
    expect(bindPendingInvitationToUser(USER_A, T0 + 1000)).toBe(true);
    expect(consumePendingInvitation(USER_A, T0 + 1000)).toBe(OTHER_TOKEN);
    expect(consumePendingInvitation(USER_A, T0 + 1000)).toBeNull();
  });

  it("el reemplazo no hereda el usuario de T1: otra cuenta asociada después obtiene T2, nunca T1", () => {
    capturePendingInvitation(TOKEN, T0);
    bindPendingInvitationToUser(USER_A, T0);
    capturePendingInvitation(OTHER_TOKEN, T0);
    expect(bindPendingInvitationToUser(USER_B, T0)).toBe(true);
    expect(readPendingInvitation(USER_B, T0)).toBe(OTHER_TOKEN);
    expect(readPendingInvitation(USER_A, T0)).toBeNull();
  });

  it("un T2 inválido no reemplaza ni destruye a T1 (asociado o no)", () => {
    capturePendingInvitation(TOKEN, T0);
    bindPendingInvitationToUser(USER_A, T0);
    expect(capturePendingInvitation("token con espacios", T0)).toBe(false);
    expect(readPendingInvitation(USER_A, T0)).toBe(TOKEN);
  });
});

describe("ninguna operación renueva el TTL (se cuenta solo desde la captura)", () => {
  it("has, read, bind y un intento fallido de otra cuenta no lo extienden", () => {
    capturePendingInvitation(TOKEN, T0);
    expect(hasPendingInvitation(T0 + TTL - 5)).toBe(true);
    expect(readPendingInvitation(null, T0 + TTL - 4)).toBe(TOKEN);
    expect(bindPendingInvitationToUser(USER_A, T0 + TTL - 3)).toBe(true);
    expect(readPendingInvitation(USER_A, T0 + TTL - 2)).toBe(TOKEN);
    discardPendingInvitationIfUserChanged(USER_A, T0 + TTL - 1);
    expect(hasPendingInvitation(T0 + TTL - 1)).toBe(true);
    // Tras tantas operaciones, sigue venciendo exactamente a los 30 min desde la captura.
    expect(hasPendingInvitation(T0 + TTL)).toBe(false);
    expect(readPendingInvitation(USER_A, T0 + TTL)).toBeNull();
  });

  it("consume no renueva nada: tras consumir no queda estado que extender", () => {
    capturePendingInvitation(TOKEN, T0);
    expect(consumePendingInvitation(null, T0 + TTL - 1)).toBe(TOKEN);
    expect(hasPendingInvitation(T0 + TTL - 1)).toBe(false);
  });
});

describe("estado previo al login y asociación al usuario", () => {
  it("sin usuario: lo lee quien todavía no se identifica; un usuario concreto no puede leerlo sin asociarlo antes", () => {
    capturePendingInvitation(TOKEN, T0);
    expect(readPendingInvitation(null, T0)).toBe(TOKEN);
    expect(readPendingInvitation(USER_A, T0)).toBeNull();
    // El intento fallido no lo destruye: aún puede asociarse.
    expect(bindPendingInvitationToUser(USER_A, T0)).toBe(true);
  });

  it("asocia a A y solo A lo lee; ya no lo lee un lector sin identificar", () => {
    capturePendingInvitation(TOKEN, T0);
    expect(bindPendingInvitationToUser(USER_A, T0)).toBe(true);
    expect(readPendingInvitation(USER_A, T0)).toBe(TOKEN);
    expect(readPendingInvitation(null, T0)).toBeNull();
    expect(hasPendingInvitation(T0)).toBe(true);
  });

  it("asociar dos veces al mismo usuario es idempotente", () => {
    capturePendingInvitation(TOKEN, T0);
    expect(bindPendingInvitationToUser(USER_A, T0)).toBe(true);
    expect(bindPendingInvitationToUser(USER_A, T0)).toBe(true);
    expect(readPendingInvitation(USER_A, T0)).toBe(TOKEN);
  });

  it("el usuario B NO puede leer el token de A: falla cerrado y lo DESTRUYE (ni A lo recupera)", () => {
    capturePendingInvitation(TOKEN, T0);
    bindPendingInvitationToUser(USER_A, T0);
    expect(readPendingInvitation(USER_B, T0)).toBeNull();
    expect(hasPendingInvitation(T0)).toBe(false);
    expect(readPendingInvitation(USER_A, T0)).toBeNull();
  });

  it("el usuario B NO puede consumirlo: null y token destruido", () => {
    capturePendingInvitation(TOKEN, T0);
    bindPendingInvitationToUser(USER_A, T0);
    expect(consumePendingInvitation(USER_B, T0)).toBeNull();
    expect(consumePendingInvitation(USER_A, T0)).toBeNull();
  });

  it("intentar asociar un token de A a B falla cerrado y lo destruye", () => {
    capturePendingInvitation(TOKEN, T0);
    bindPendingInvitationToUser(USER_A, T0);
    expect(bindPendingInvitationToUser(USER_B, T0)).toBe(false);
    expect(hasPendingInvitation(T0)).toBe(false);
  });

  it.each([null, undefined, "", 0, {}, []])(
    "no asocia con un userId inválido (%j)",
    (bad) => {
      capturePendingInvitation(TOKEN, T0);
      expect(bindPendingInvitationToUser(bad, T0)).toBe(false);
      // Un bind inválido no destruye el token pendiente.
      expect(readPendingInvitation(null, T0)).toBe(TOKEN);
    },
  );

  it("sin token pendiente: asociar, leer y consumir devuelven falso/null", () => {
    expect(bindPendingInvitationToUser(USER_A, T0)).toBe(false);
    expect(readPendingInvitation(USER_A, T0)).toBeNull();
    expect(readPendingInvitation(null, T0)).toBeNull();
    expect(consumePendingInvitation(USER_A, T0)).toBeNull();
  });

  it("un userId vacío al leer no entrega nada", () => {
    capturePendingInvitation(TOKEN, T0);
    bindPendingInvitationToUser(USER_A, T0);
    expect(readPendingInvitation("", T0)).toBeNull();
    expect(readPendingInvitation(USER_A, T0)).toBe(TOKEN);
  });
});

describe("consumir y limpiar", () => {
  it("consume devuelve el token UNA vez y lo limpia", () => {
    capturePendingInvitation(TOKEN, T0);
    bindPendingInvitationToUser(USER_A, T0);
    expect(consumePendingInvitation(USER_A, T0)).toBe(TOKEN);
    expect(consumePendingInvitation(USER_A, T0)).toBeNull();
    expect(readPendingInvitation(USER_A, T0)).toBeNull();
    expect(hasPendingInvitation(T0)).toBe(false);
  });

  it("consumir sin usuario (previo al login) también limpia", () => {
    capturePendingInvitation(TOKEN, T0);
    expect(consumePendingInvitation(null, T0)).toBe(TOKEN);
    expect(hasPendingInvitation(T0)).toBe(false);
  });

  it("un consume que no entrega nada (token de otro estado) no borra un token ajeno legítimo", () => {
    capturePendingInvitation(TOKEN, T0);
    expect(consumePendingInvitation(USER_A, T0)).toBeNull(); // sin asociar: no se entrega
    expect(readPendingInvitation(null, T0)).toBe(TOKEN); // sigue disponible
  });

  it("clearPendingInvitation lo borra en cualquier estado", () => {
    capturePendingInvitation(TOKEN, T0);
    clearPendingInvitation();
    expect(hasPendingInvitation(T0)).toBe(false);
    capturePendingInvitation(TOKEN, T0);
    bindPendingInvitationToUser(USER_A, T0);
    clearPendingInvitation();
    expect(readPendingInvitation(USER_A, T0)).toBeNull();
    expect(() => clearPendingInvitation()).not.toThrow();
  });
});

describe("logout y cambio de usuario", () => {
  it("logout (userId null) destruye un token ya asociado a una cuenta", () => {
    capturePendingInvitation(TOKEN, T0);
    bindPendingInvitationToUser(USER_A, T0);
    discardPendingInvitationIfUserChanged(null, T0);
    expect(hasPendingInvitation(T0)).toBe(false);
  });

  it("cambio de usuario A → B destruye el token de A", () => {
    capturePendingInvitation(TOKEN, T0);
    bindPendingInvitationToUser(USER_A, T0);
    discardPendingInvitationIfUserChanged(USER_B, T0);
    expect(hasPendingInvitation(T0)).toBe(false);
  });

  it("el mismo usuario conserva su token", () => {
    capturePendingInvitation(TOKEN, T0);
    bindPendingInvitationToUser(USER_A, T0);
    discardPendingInvitationIfUserChanged(USER_A, T0);
    expect(readPendingInvitation(USER_A, T0)).toBe(TOKEN);
  });

  it("un token todavía sin asociar sobrevive a 'sin sesión' (aún no hay login) pero no a un usuario nuevo sin asociar", () => {
    capturePendingInvitation(TOKEN, T0);
    discardPendingInvitationIfUserChanged(null, T0);
    expect(readPendingInvitation(null, T0)).toBe(TOKEN);
    // Sin asociar no pertenece a nadie: aparecer un usuario no lo destruye, pero tampoco lo recibe
    // sin bindPendingInvitationToUser.
    discardPendingInvitationIfUserChanged(USER_A, T0);
    expect(readPendingInvitation(null, T0)).toBe(TOKEN);
    expect(readPendingInvitation(USER_A, T0)).toBeNull();
  });

  it("no lanza sin token pendiente", () => {
    expect(() => discardPendingInvitationIfUserChanged(USER_A, T0)).not.toThrow();
    expect(() => discardPendingInvitationIfUserChanged(null, T0)).not.toThrow();
  });
});

describe("memoria únicamente: un refresco completo pierde el token (limitación intencional)", () => {
  it("recargar el módulo (simula F5 / reabrir la pestaña) descarta el token", async () => {
    capturePendingInvitation(TOKEN, T0);
    bindPendingInvitationToUser(USER_A, T0);
    expect(readPendingInvitation(USER_A, T0)).toBe(TOKEN);

    vi.resetModules();
    const fresh = await import("./pending-invitation");

    expect(fresh.hasPendingInvitation(T0)).toBe(false);
    expect(fresh.readPendingInvitation(null, T0)).toBeNull();
    expect(fresh.readPendingInvitation(USER_A, T0)).toBeNull();
  });

  it("el token nunca llega a localStorage, sessionStorage, cookies, la URL ni el historial", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const hrefBefore = window.location.href;
    const historyLength = window.history.length;

    capturePendingInvitation(TOKEN, T0);
    bindPendingInvitationToUser(USER_A, T0);
    readPendingInvitation(USER_A, T0);
    consumePendingInvitation(USER_A, T0);
    capturePendingInvitation(TOKEN, T0);

    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
    expect(window.location.href).toBe(hrefBefore);
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.history.length).toBe(historyLength);
    expect(
      JSON.stringify({ ...window.localStorage, ...window.sessionStorage }),
    ).not.toContain(TOKEN);
  });

  it("el código fuente no usa ningún mecanismo de persistencia ni de red (verificación estructural)", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/pending-invitation.ts"),
      "utf8",
    )
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    for (const forbidden of [
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "document.",
      "window.",
      "history.",
      "fetch(",
      "console.",
      "JSON.stringify",
      "throw ",
      "import ",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe("el token no se filtra", () => {
  it("las funciones de estado devuelven booleanos/void, nunca un objeto que contenga el token", () => {
    const results = [
      capturePendingInvitation(TOKEN, T0),
      bindPendingInvitationToUser(USER_A, T0),
      hasPendingInvitation(T0),
      discardPendingInvitationIfUserChanged(USER_A, T0),
      clearPendingInvitation(),
    ];
    expect(JSON.stringify(results)).not.toContain(TOKEN);
    for (const r of results) expect(typeof r === "boolean" || r === undefined).toBe(true);
  });

  it("el módulo exporta solo las funciones esperadas y ningún getter de estado con el token", async () => {
    const mod = await import("./pending-invitation");
    expect(Object.keys(mod).sort()).toEqual([
      "PENDING_INVITATION_TTL_MS",
      "bindPendingInvitationToUser",
      "capturePendingInvitation",
      "clearPendingInvitation",
      "consumePendingInvitation",
      "discardPendingInvitationIfUserChanged",
      "hasPendingInvitation",
      "readPendingInvitation",
    ]);
    expect(JSON.stringify(mod)).not.toContain(TOKEN);
  });

  it("ninguna operación (ni las que fallan) escribe en la consola", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    capturePendingInvitation(TOKEN, T0);
    capturePendingInvitation("", T0);
    bindPendingInvitationToUser(USER_A, T0);
    readPendingInvitation(USER_B, T0);
    consumePendingInvitation(USER_A, T0 + TTL);
    for (const spy of spies) {
      const printed = JSON.stringify(spy.mock.calls);
      expect(printed).not.toContain(TOKEN);
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("los rechazos no lanzan ni devuelven texto que incluya el token", () => {
    const bad = "token con espacios y secreto";
    expect(() => capturePendingInvitation(bad, T0)).not.toThrow();
    expect(capturePendingInvitation(bad, T0)).toBe(false);
  });
});
