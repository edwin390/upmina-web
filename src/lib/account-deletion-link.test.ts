// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAccountDeletionLink,
  readAccountDeletionMailConfig,
} from "./account-deletion-mail";

const BASE = {
  MFA_RECOVERY_RESEND_API_KEY: "re_synthetic_key_not_real",
  MFA_RECOVERY_MAIL_FROM: "no-reply@example.invalid",
  MFA_RECOVERY_APP_URL: "https://old-origin.example.invalid",
} as NodeJS.ProcessEnv;
const DEV = "https://upmina-web-testing.vercel.app";

describe("enlace del correo de eliminación de cuenta", () => {
  it("la ruta del enlace existe como ruta de la SPA (si no, el comodín redirige a /)", () => {
    const link = buildAccountDeletionLink(DEV, "SYNTHETIC-TOKEN");
    const path = new URL(link).pathname;
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    expect(app).toContain(`path="${path}"`);
    expect(link).toBe(`${DEV}/account/delete#t=SYNTHETIC-TOKEN`); // el token va en el fragmento, no en la query
  });

  it("el origen sale SOLO de la configuración del servidor", () => {
    expect(readAccountDeletionMailConfig(BASE)?.appUrl).toBe(
      "https://old-origin.example.invalid",
    ); // sin variable propia: hereda MFA_RECOVERY_APP_URL
    expect(
      readAccountDeletionMailConfig({ ...BASE, ACCOUNT_DELETION_APP_URL: `${DEV}/` })
        ?.appUrl,
    ).toBe(DEV); // la variable propia prevalece y se normaliza sin barra final
  });

  it("un origen propio inválido no envía nada (fail closed) y no cae al otro", () => {
    for (const bad of ["http://insecure.example.invalid", `${DEV}/ruta`, "no-url"])
      expect(
        readAccountDeletionMailConfig({ ...BASE, ACCOUNT_DELETION_APP_URL: bad }),
      ).toBeNull();
  });
});
