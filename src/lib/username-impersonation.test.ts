import { describe, expect, it } from "vitest";
import {
  detectImpersonation,
  IMPERSONATION_AFFIXES,
  isImpersonationDisplayName,
  isImpersonationUsername,
  DISPLAY_AUTHORITY_WORDS,
  DISPLAY_CONNECTORS,
  USERNAME_FOLD,
  usernameSkeleton,
  withinOneEdit,
} from "./username-impersonation";
import {
  checkUsername,
  isReservedUsername,
  RESERVED_USERNAMES,
} from "./profile-username";
import {
  ALLOWED,
  AMBIGUOUS_BLOCKED,
  DISPLAY_ALLOWED,
  DISPLAY_BLOCKED,
  DISPLAY_KNOWN_GAPS,
  UNEQUIVOCAL,
} from "./username-impersonation-vectors";

describe("detección de suplantación de Mina/Upmina en username (módulo TS)", () => {
  it.each(UNEQUIVOCAL)("1 · inequívoca, siempre bloqueada: %j", (name) => {
    expect(isImpersonationUsername(name)).toBe(true);
  });
  it.each(AMBIGUOUS_BLOCKED)(
    "2 · ambigua, política conservadora (bloqueada): %j",
    (name) => {
      expect(isImpersonationUsername(name)).toBe(true);
    },
  );
  it.each(ALLOWED)("3 · claramente distinta, permitida: %j", (name) => {
    expect(isImpersonationUsername(name)).toBe(false);
    expect(detectImpersonation(name)).toBeNull();
  });

  it("clasifica el motivo: exact < affixed < embedded < near", () => {
    expect(detectImpersonation("m1na")).toBe("exact");
    expect(detectImpersonation("upminaa_real")).toBe("affixed");
    expect(detectImpersonation("mina_fanpage")).toBe("affixed");
    expect(detectImpersonation("xupminax")).toBe("embedded");
    expect(detectImpersonation("upmine")).toBe("near");
  });

  it("páginas de aficionados y soporte se bloquean (ampliación), pero no nombres personales", () => {
    for (const n of [
      "minafan",
      "minafans",
      "mina_fan",
      "mina_fanpage",
      "minafanpage",
      "upminafan",
      "upminaa_fans",
      "mina_support",
      "mina_team",
      "mina_admin",
      "upmina_staff",
    ]) {
      expect(isImpersonationUsername(n), n).toBe(true);
    }
    for (const n of ["carmina", "amina", "minato", "minami", "mina_lopez"]) {
      expect(isImpersonationUsername(n), n).toBe(false);
    }
  });

  it("no depende de una lista fija: combinaciones nuevas se detectan por estructura", () => {
    for (const n of [
      "verified_u.p.m.i.n.a",
      "r3al_m1n4",
      "oficial.upm1naaaa",
      "the_m!nna",
      "m1n4_f4np4g3",
    ]) {
      expect(isImpersonationUsername(n), n).toBe(true);
    }
  });

  it("'mina' dentro de otra palabra NO se bloquea (sin heurística por contención)", () => {
    for (const n of [
      "terminal",
      "criminal",
      "seminario",
      "amina",
      "minamoto",
      "carmina",
    ]) {
      expect(isImpersonationUsername(n), n).toBe(false);
    }
  });

  it("vacío o sin letras no se considera suplantación (lo rechaza el formato)", () => {
    expect(isImpersonationUsername("")).toBe(false);
    expect(isImpersonationUsername("___")).toBe(false);
    expect(isImpersonationUsername("123")).toBe(false);
  });

  it("esqueletos: A traduce leet, B descarta dígitos", () => {
    expect(usernameSkeleton("M1N4_2", true)).toBe("mina"); // el 2 no es leet y se descarta
    expect(usernameSkeleton("mina99", false)).toBe("mina");
    expect(usernameSkeleton("Mína", true)).toBe("mina");
    expect(usernameSkeleton("Mina™", true)).toBe("mina");
  });

  it("tabla de homoglifos: from/to con la misma longitud en code points", () => {
    expect([...USERNAME_FOLD.from].length).toBe([...USERNAME_FOLD.to].length);
  });

  it("vocabulario de afijos: minúsculas, sin duplicados, sin la propia identidad ni conectores genéricos", () => {
    expect(new Set(IMPERSONATION_AFFIXES).size).toBe(IMPERSONATION_AFFIXES.length);
    expect(IMPERSONATION_AFFIXES.every((a) => a === a.toLowerCase())).toBe(true);
    for (const generic of ["mina", "upmina", "love", "de", "of", "chat"]) {
      expect(IMPERSONATION_AFFIXES).not.toContain(generic);
    }
    for (const needed of [
      "fan",
      "fans",
      "fanpage",
      "official",
      "oficial",
      "support",
      "team",
      "admin",
      "staff",
    ]) {
      expect(IMPERSONATION_AFFIXES).toContain(needed);
    }
  });

  it("withinOneEdit: sustitución, inserción, borrado y transposición; no dos ediciones", () => {
    expect(withinOneEdit("upmina", "upmina")).toBe(true);
    expect(withinOneEdit("upmine", "upmina")).toBe(true);
    expect(withinOneEdit("upmna", "upmina")).toBe(true);
    expect(withinOneEdit("upminas", "upmina")).toBe(true);
    expect(withinOneEdit("upmian", "upmina")).toBe(true);
    expect(withinOneEdit("upmnie", "upmina")).toBe(false);
    expect(withinOneEdit("up", "upmina")).toBe(false);
  });
});

describe("display_name: protección equivalente, sin rechazar frases personales", () => {
  it.each(DISPLAY_BLOCKED)("bloqueado: %j", (name) => {
    expect(isImpersonationDisplayName(name), name).toBe(true);
  });
  it.each(DISPLAY_ALLOWED)("permitido: %j", (name) => {
    expect(isImpersonationDisplayName(name), name).toBe(false);
  });
  it("huecos CONOCIDOS y documentados (se permiten a propósito en display_name)", () => {
    for (const name of DISPLAY_KNOWN_GAPS) {
      expect(isImpersonationDisplayName(name), name).toBe(false);
    }
  });
  it("la regla 'embedded' solo existe para username", () => {
    expect(detectImpersonation("xupminax", "username")).toBe("embedded");
    expect(detectImpersonation("xupminax", "display_name")).toBeNull();
    expect(detectImpersonation("Fan de Upmina desde siempre", "display_name")).toBeNull();
    expect(detectImpersonation("Mina Oficial", "display_name")).toBe("affixed");
    expect(detectImpersonation("Mina", "display_name")).toBe("exact");
    expect(detectImpersonation("Upmna", "display_name")).toBe("near");
  });
  it("declaraciones de identidad: reason 'declared' solo en display_name, nunca por 'fan' ni por mencionar a Mina", () => {
    expect(detectImpersonation("Cuenta oficial de Mina", "display_name")).toBe(
      "declared",
    );
    expect(detectImpersonation("Upmina Chat", "display_name")).toBe("declared");
    expect(detectImpersonation("Official Account of Mina", "display_name")).toBe(
      "declared",
    );
    expect(detectImpersonation("Fan de Mina", "display_name")).toBeNull();
    expect(detectImpersonation("Fan de Upmina", "display_name")).toBeNull();
    // En username no existe la regla 'declared' (los separadores no existen; ya hay affixed/embedded).
    expect(detectImpersonation("cuentaoficialdemina", "username")).not.toBe("declared");
    expect(detectImpersonation("mina_chat", "username")).toBeNull();
  });
  it("las palabras de autoridad nunca contienen 'fan' ni la propia identidad; conectores cortos", () => {
    for (const w of DISPLAY_AUTHORITY_WORDS) {
      expect(w).toBe(w.toLowerCase());
      expect(w).not.toMatch(/fan|mina/);
    }
    expect(new Set(DISPLAY_AUTHORITY_WORDS).size).toBe(DISPLAY_AUTHORITY_WORDS.length);
    expect(new Set(DISPLAY_CONNECTORS).size).toBe(DISPLAY_CONNECTORS.length);
  });
  it("entradas largas o patológicas se evalúan en tiempo acotado (sin backtracking explosivo)", () => {
    const inputs = [
      "a".repeat(5000) + "!",
      "mina".repeat(2000) + "x",
      "cuentaoficialde".repeat(300) + "z",
      "de ".repeat(3000) + "Mina x",
      "o".repeat(4000) + "fficial " + "Mina".repeat(100) + "?",
    ];
    const worst = [
      "mina".repeat(30),
      "de".repeat(60),
      "cuentaoficial".repeat(9) + "x",
      "oficial".repeat(17) + "mina" + "de".repeat(2) + "x",
      "a".repeat(120),
    ];
    const t0 = Date.now();
    for (const i of worst) detectImpersonation(i, "display_name");
    for (const i of inputs) detectImpersonation(i, "display_name");
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it("símbolos de marca (™ ® ©) y adornos no sirven para esquivar", () => {
    for (const n of [
      "Mina™",
      "Mina®",
      "The Real Mina™",
      "★ Mina ★",
      "【Mina】",
      "~Mina~",
    ]) {
      expect(isImpersonationDisplayName(n), n).toBe(true);
    }
  });
  it("un nombre vacío o sin letras latinas no es suplantación", () => {
    for (const n of ["", "   ", "🌸", "123", "日本語"]) {
      expect(isImpersonationDisplayName(n), n).toBe(false);
    }
  });
});

describe("integración con profile-username (servidor)", () => {
  it("isReservedUsername combina la lista exacta previa y la detección", () => {
    expect(isReservedUsername("admin")).toBe(true);
    expect(isReservedUsername("realmina")).toBe(true);
    expect(isReservedUsername("minafan")).toBe(true);
    expect(isReservedUsername("edwin390")).toBe(false);
  });
  it("checkUsername responde 'reserved' (no 'invalid') para variantes con formato válido", () => {
    for (const n of ["Mina", "mi.na", "m1na", "real_upm1naa", "UPMINAA", "minafan"]) {
      expect(checkUsername(n)).toEqual({ ok: false, reason: "reserved" });
    }
    expect(checkUsername("minato")).toEqual({ ok: true, username: "minato" });
    // Formato inválido sigue siendo 'invalid' aunque parezca suplantación.
    expect(checkUsername("m!na")).toEqual({ ok: false, reason: "invalid" });
  });
  it("la lista exacta previa no cambia", () => {
    for (const n of ["mina", "upmina", "upminaa", "admin", "community"]) {
      expect(RESERVED_USERNAMES.has(n)).toBe(true);
    }
  });
});
