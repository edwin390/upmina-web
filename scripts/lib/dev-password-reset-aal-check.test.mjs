import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  assertDevAppUrl,
  assertDevSupabaseUrl,
  assertServerConfirmsNoRole,
  CheckError,
  CONFIRM_VALUE,
  classifyUpdate,
  DEV_APP_URL,
  DEV_PROJECT_REF,
  describeJwt,
  parseRecoveryLink,
  runCheck,
  throwawayPassword,
} from "./dev-password-reset-aal-check.mjs";

// Valores SINTÉTICOS. Ninguna llamada de red real: fetch es un doble.

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "ES256" })}.${b64(claims)}.SENTINEL-SIGNATURE`;
const RECOVERY_TOKEN = jwt({ aal: "aal1", amr: [{ method: "recovery", timestamp: 1 }] });
const URL_DEV = `https://${DEV_PROJECT_REF}.supabase.co`;
const ACCESS_URL = `${DEV_APP_URL}/api/admin/access`;
const USER_URL = `${URL_DEV}/auth/v1/user`;
const res = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});
const randomBytes = (n) => Buffer.alloc(n, 7);
const NO_ROLE = { role: null, capabilities: [], mfa: { recent: false } };

describe("solo DEV", () => {
  it("acepta la URL del proyecto DEV y rechaza Production, otros hosts, http y basura", () => {
    expect(assertDevSupabaseUrl(`${URL_DEV}/`)).toBe(URL_DEV);
    for (const bad of [
      "https://dmtuvzfdaectvqczwfhx.supabase.co",
      "https://otro.supabase.co",
      `http://${DEV_PROJECT_REF}.supabase.co`,
      `https://${DEV_PROJECT_REF}.supabase.co.evil.test`,
      "",
      "no-es-url",
    ]) {
      expect(() => assertDevSupabaseUrl(bad), bad).toThrow(CheckError);
    }
  });

  it("la aplicación debe ser exactamente el alias DEV", () => {
    expect(assertDevAppUrl(`${DEV_APP_URL}/`)).toBe(DEV_APP_URL);
    for (const bad of [
      "https://upmina-web.vercel.app",
      "https://upmina-testing-backend.vercel.app.evil.test",
      "http://upmina-testing-backend.vercel.app",
      "https://app.test",
      "",
      undefined,
    ]) {
      expect(() => assertDevAppUrl(bad), String(bad)).toThrow(CheckError);
    }
  });
});

describe("enlace y token", () => {
  it("extrae el token de la URL con fragmento (o del fragmento) y exige type=recovery", () => {
    expect(
      parseRecoveryLink(
        `https://app.test/reset-password#access_token=${RECOVERY_TOKEN}&type=recovery`,
      ),
    ).toBe(RECOVERY_TOKEN);
    expect(parseRecoveryLink(`#access_token=${RECOVERY_TOKEN}&type=recovery&x=1`)).toBe(
      RECOVERY_TOKEN,
    );
    for (const bad of [
      "",
      "https://app.test/reset-password",
      "#access_token=x&type=signup",
      "#type=recovery",
    ]) {
      expect(() => parseRecoveryLink(bad), bad).toThrow(CheckError);
    }
  });

  it("describeJwt devuelve solo aal y métodos (nunca ids, correos ni firma)", () => {
    const out = describeJwt(
      jwt({
        aal: "aal1",
        sub: "SENTINEL-USER",
        email: "SENTINEL@example.test",
        amr: [{ method: "recovery" }, { method: "totp" }],
      }),
    );
    expect(out).toEqual({ aal: "aal1", amr: ["recovery", "totp"] });
    expect(JSON.stringify(out)).not.toMatch(/SENTINEL/);
    expect(() => describeJwt("basura")).toThrow(CheckError);
  });
});

describe("clasificación del resultado de PUT /auth/v1/user", () => {
  it.each([
    [200, {}, "ALLOWED_AAL1"],
    [403, { error_code: "insufficient_aal" }, "REQUIRES_AAL2"],
    [400, { error_code: "reauthentication_needed" }, "REQUIRES_REAUTH"],
    [400, { error_code: "reauthentication_not_valid" }, "REQUIRES_REAUTH"],
    [400, { error_code: "current_password_required" }, "REQUIRES_CURRENT_PASSWORD"],
    [422, { error_code: "same_password" }, "POLICY"],
    [422, { error_code: "weak_password" }, "POLICY"],
    [500, { error_code: "algo_raro", msg: "detalle SENTINEL" }, "OTHER"],
    [500, null, "OTHER"],
  ])("HTTP %i %j → %s, sin repetir mensajes del proveedor", (status, body, verdict) => {
    const out = classifyUpdate(status, body);
    expect(out.verdict).toBe(verdict);
    expect(out.text).not.toMatch(/SENTINEL/);
  });

  it("la contraseña desechable es aleatoria, larga y distinta por ejecución", () => {
    const a = throwawayPassword(randomBytes);
    expect(a.length).toBeGreaterThan(20);
    expect(throwawayPassword((n) => Buffer.alloc(n, 9))).not.toBe(a);
  });
});

describe("el servidor debe confirmar inequívocamente que NO hay rol", () => {
  it("solo 200 con role null, sin capacidades y mfa.recent=false es concluyente", () => {
    expect(() => assertServerConfirmsNoRole(200, NO_ROLE)).not.toThrow();
  });

  it.each([
    ["401", 401, { error: "x" }],
    ["403", 403, { error: "x" }],
    ["404", 404, null],
    ["500", 500, null],
    ["200 sin cuerpo", 200, null],
    ["200 con cuerpo no objeto", 200, "texto"],
    ["200 con array", 200, []],
    [
      "200 sin la clave role (ambiguo)",
      200,
      { capabilities: [], mfa: { recent: false } },
    ],
    [
      "200 con role undefined",
      200,
      { role: undefined, capabilities: [], mfa: { recent: false } },
    ],
    ["200 con role vacío", 200, { role: "", capabilities: [], mfa: { recent: false } }],
    ["200 sin capabilities", 200, { role: null, mfa: { recent: false } }],
    [
      "200 con capacidades",
      200,
      { role: null, capabilities: ["x"], mfa: { recent: false } },
    ],
    ["200 sin mfa", 200, { role: null, capabilities: [] }],
    [
      "200 con mfa.recent true",
      200,
      { role: null, capabilities: [], mfa: { recent: true } },
    ],
    ["200 con mfa.recent ausente", 200, { role: null, capabilities: [], mfa: {} }],
  ])("%s → aborta", (_name, status, body) => {
    expect(() => assertServerConfirmsNoRole(status, body)).toThrow(CheckError);
  });

  it.each(["admin", "moderator", "developer"])(
    "rol %s → aborta nombrando el privilegio",
    (role) => {
      expect(() =>
        assertServerConfirmsNoRole(200, {
          role,
          capabilities: ["x"],
          mfa: { recent: false },
        }),
      ).toThrow(/rol privilegiado/);
    },
  );
});

describe("runCheck", () => {
  function io(handlers, extra = {}) {
    const log = vi.fn();
    const fetchImpl = vi.fn(async (url, init) => handlers(url, init));
    return {
      fetchImpl,
      log,
      supabaseUrl: URL_DEV,
      anonKey: "anon-sintetica",
      appUrl: DEV_APP_URL,
      confirm: CONFIRM_VALUE,
      askHidden: vi.fn(
        async () =>
          `https://app.test/reset-password#access_token=${RECOVERY_TOKEN}&type=recovery`,
      ),
      randomBytes,
      ...extra,
    };
  }
  const base =
    (put, { access = () => res(200, NO_ROLE), me } = {}) =>
    (url, init) => {
      if (url === ACCESS_URL) return access();
      if (url === USER_URL && (init?.method ?? "GET") === "GET")
        return (
          me?.() ??
          res(200, { factors: [{ id: "f1", status: "verified", factor_type: "totp" }] })
        );
      if (url === USER_URL && init?.method === "PUT") return put(init);
      throw new Error(`fetch inesperado: ${url}`);
    };
  const allOutput = (i) => JSON.stringify(i.log.mock.calls);
  const writes = (i) =>
    i.fetchImpl.mock.calls.filter(
      ([, init]) => init?.method === "PUT" || init?.method === "POST",
    );

  it("no-totp: informa si Supabase PERMITE el cambio con aal1, envía solo {password} y no imprime secretos", async () => {
    const i = io(base(() => res(200, {})));
    const out = await runCheck("no-totp", i);
    expect(out.verdict).toBe("ALLOWED_AAL1");
    const put = i.fetchImpl.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(Object.keys(JSON.parse(put[1].body))).toEqual(["password"]);
    expect(put[1].headers.Authorization).toBe(`Bearer ${RECOVERY_TOKEN}`);
    // nunca se imprime el token, la contraseña, la firma ni la clave
    const printed = allOutput(i);
    expect(printed).not.toMatch(/SENTINEL|Tmp-|anon-sintetica|eyJ/);
    expect(printed).toContain("aal=aal1");
  });

  it("no-totp: si Supabase exige aal2 lo dice", async () => {
    const i = io(base(() => res(403, { error_code: "insufficient_aal" })));
    expect((await runCheck("no-totp", i)).verdict).toBe("REQUIRES_AAL2");
  });

  describe("cada condición de aborto: rechaza SIN llamar a la red de escritura ni cambiar nada", () => {
    async function expectAbort(i, mode = "no-totp", message) {
      await expect(runCheck(mode, i)).rejects.toThrow(message ?? CheckError);
      expect(writes(i)).toHaveLength(0); // ningún PUT ni POST (challenge/verify)
      const printed = allOutput(i);
      expect(printed).not.toMatch(/SENTINEL|Tmp-|anon-sintetica|eyJ/);
    }

    it("modo desconocido, sin confirmación o con confirmación errónea: ni siquiera pide el enlace ni usa la red", async () => {
      for (const [mode, extra] of [
        ["otro-modo", {}],
        ["no-totp", { confirm: undefined }],
        ["no-totp", { confirm: "dev_only" }],
        ["no-totp", { confirm: "PRODUCTION" }],
      ]) {
        const i = io(
          base(() => res(200, {})),
          extra,
        );
        await expect(runCheck(mode, i)).rejects.toThrow(CheckError);
        expect(i.askHidden).not.toHaveBeenCalled();
        expect(i.fetchImpl).not.toHaveBeenCalled();
      }
    });

    it("Supabase que no es DEV o aplicación que no es el alias DEV: ni enlace ni red", async () => {
      for (const extra of [
        { supabaseUrl: "https://dmtuvzfdaectvqczwfhx.supabase.co" },
        { supabaseUrl: "https://otro.supabase.co" },
        { appUrl: "https://upmina-web.vercel.app" },
        { appUrl: "https://app.test" },
        { anonKey: "" },
      ]) {
        const i = io(
          base(() => res(200, {})),
          extra,
        );
        await expect(runCheck("no-totp", i)).rejects.toThrow(CheckError);
        expect(i.askHidden).not.toHaveBeenCalled();
        expect(i.fetchImpl).not.toHaveBeenCalled();
      }
    });

    it("enlace que no es de recuperación, o sesión que no es aal1", async () => {
      await expectAbort(
        io(
          base(() => res(200, {})),
          { askHidden: async () => "no-es-un-enlace" },
        ),
      );
      await expectAbort(
        io(
          base(() => res(200, {})),
          {
            askHidden: async () => `#access_token=${jwt({ aal: "aal2" })}&type=recovery`,
          },
        ),
        "no-totp",
        /aal1/,
      );
      await expectAbort(
        io(
          base(() => res(200, {})),
          { askHidden: async () => `#access_token=${jwt({})}&type=recovery` },
        ),
        "no-totp",
        /aal1/,
      );
    });

    it.each(["admin", "moderator", "developer"])(
      "cuenta con rol %s → aborta antes de tocar nada",
      async (role) => {
        const i = io(
          base(() => res(200, {}), {
            access: () => res(200, { role, capabilities: ["x"], mfa: { recent: false } }),
          }),
        );
        await expectAbort(i, "no-totp", /rol privilegiado/);
        await expectAbort(i, "with-totp", /rol privilegiado/);
      },
    );

    it.each([
      ["401", () => res(401, { error: "Unauthorized" })],
      ["403", () => res(403, { error: "Forbidden" })],
      ["404", () => res(404, null)],
      ["500", () => res(500, null)],
      [
        "200 con cuerpo malformado",
        () => ({
          status: 200,
          ok: true,
          json: async () => {
            throw new Error("x");
          },
        }),
      ],
      ["200 sin role", () => res(200, { capabilities: [], mfa: { recent: false } })],
      [
        "200 con capacidades",
        () => res(200, { role: null, capabilities: ["x"], mfa: { recent: false } }),
      ],
      [
        "200 con mfa reciente",
        () => res(200, { role: null, capabilities: [], mfa: { recent: true } }),
      ],
    ])("la comprobación de rol no concluyente (%s) → aborta", async (_n, access) => {
      await expectAbort(
        io(base(() => res(200, {}), { access })),
        "no-totp",
        /no confirmó|rol/,
      );
      await expectAbort(
        io(base(() => res(200, {}), { access })),
        "with-totp",
        /no confirmó|rol/,
      );
    });

    it("error de red en la comprobación de rol: aborta sin filtrar detalles del error", async () => {
      const i = io((url, init) => {
        if (url === ACCESS_URL)
          throw new Error("SENTINEL-DETALLE https://secreto.test/?token=SENTINEL");
        return base(() => res(200, {}))(url, init);
      });
      await expect(runCheck("no-totp", i)).rejects.toThrow(/Error de red/);
      await runCheck("no-totp", i).catch((e) =>
        expect(e.message).not.toMatch(/SENTINEL|secreto/),
      );
      expect(writes(i)).toHaveLength(0);
    });

    it("cuenta sin TOTP verificado (sin factores, solo no verificados o de otro tipo) → aborta", async () => {
      for (const factors of [
        [],
        [{ id: "f1", status: "unverified", factor_type: "totp" }],
        [{ id: "f2", status: "verified", factor_type: "phone" }],
      ]) {
        await expectAbort(
          io(base(() => res(200, {}), { me: () => res(200, { factors }) })),
          "no-totp",
          /TOTP verificado/,
        );
      }
    });

    it("no se pueden leer los factores (401/500) o hay error de red → aborta", async () => {
      await expectAbort(
        io(base(() => res(200, {}), { me: () => res(401, null) })),
        "no-totp",
        /factores/,
      );
      await expectAbort(
        io(base(() => res(200, {}), { me: () => res(500, null) })),
        "no-totp",
        /factores/,
      );
      const i = io((url, init) => {
        if (url === USER_URL && (init?.method ?? "GET") === "GET")
          throw new Error("SENTINEL");
        return base(() => res(200, {}))(url, init);
      });
      await expectAbort(i, "no-totp", /Error de red/);
    });

    it("with-totp: un challenge o una verificación fallidos abortan sin llegar al PUT", async () => {
      const aal2 = jwt({ aal: "aal2" });
      const run = (challenge, verify) =>
        io(
          (url, init) => {
            if (url.endsWith("/challenge")) return challenge();
            if (url.endsWith("/verify")) return verify();
            return base(() => res(200, {}))(url, init);
          },
          {
            askHidden: async (q) =>
              q.includes("TOTP")
                ? "123456"
                : `#access_token=${RECOVERY_TOKEN}&type=recovery`,
          },
        );
      for (const i of [
        run(
          () => res(400, null),
          () => res(200, { access_token: aal2 }),
        ),
        run(
          () => res(200, { id: "c1" }),
          () => res(400, null),
        ),
        run(
          () => res(200, { id: "c1" }),
          () => res(200, {}),
        ),
      ]) {
        await expect(runCheck("with-totp", i)).rejects.toThrow(CheckError);
        expect(i.fetchImpl.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(
          false,
        );
        expect(allOutput(i)).not.toMatch(/123456|SENTINEL|eyJ/);
      }
    });
  });

  it("el PUT es la última llamada y ocurre solo después de todos los controles", async () => {
    const i = io(base(() => res(200, {})));
    await runCheck("no-totp", i);
    const urls = i.fetchImpl.mock.calls.map(
      ([url, init]) => `${init?.method ?? "GET"} ${url}`,
    );
    expect(urls).toEqual([`GET ${ACCESS_URL}`, `GET ${USER_URL}`, `PUT ${USER_URL}`]);
  });

  it("with-totp: completa el desafío TOTP (código oculto) y usa el token aal2 para el cambio", async () => {
    const aal2 = jwt({ aal: "aal2", amr: [{ method: "totp" }, { method: "recovery" }] });
    const asked = [];
    const i = io(
      (url, init) => {
        if (url.endsWith("/challenge")) return res(200, { id: "challenge-1" });
        if (url.endsWith("/verify")) return res(200, { access_token: aal2 });
        return base(() => res(200, {}))(url, init);
      },
      {
        askHidden: async (q) => {
          asked.push(q);
          return q.includes("TOTP")
            ? "123456"
            : `#access_token=${RECOVERY_TOKEN}&type=recovery`;
        },
      },
    );
    await runCheck("with-totp", i);
    const put = i.fetchImpl.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(put[1].headers.Authorization).toBe(`Bearer ${aal2}`);
    expect(allOutput(i)).not.toMatch(/123456|SENTINEL|eyJ/);
    expect(asked).toHaveLength(2);
  });
});

describe("la herramienta no guarda nada", () => {
  const sources = [
    "./dev-password-reset-aal-check.mjs",
    "../dev-password-reset-aal-check.mjs",
  ].map((p) => readFileSync(new URL(p, import.meta.url), "utf8"));

  it("no escribe en disco ni en almacenamiento: sin fs de escritura, sin localStorage, sin appendFile", () => {
    for (const src of sources) {
      expect(src).not.toMatch(
        /writeFile|appendFile|createWriteStream|localStorage|sessionStorage|process\.stdout\.write\([^)]*token/i,
      );
    }
    expect(sources[0]).not.toMatch(/from "node:fs"|require\("fs"\)/);
    expect(sources[1]).not.toMatch(/from "node:fs"|require\("fs"\)/);
  });

  it("nunca interpola el token, la contraseña, el enlace ni el código en una salida (solo describeJwt: aal y métodos)", () => {
    const outputLines = sources[0]
      .split("\n")
      .filter((line) => /\blog\(|CheckError\(/.test(line));
    expect(outputLines.length).toBeGreaterThan(5);
    for (const line of outputLines) {
      expect(line).not.toMatch(/\$\{\s*(token|password|link|code|anonKey)\s*\}/);
    }
    expect(sources[0]).not.toMatch(/log\(\s*(token|link|code|password|anonKey)\s*\)/);
    expect(sources[1]).not.toMatch(
      /console\.(log|error)\([^)]*(token|link|anonKey|password)/i,
    );
  });
});
