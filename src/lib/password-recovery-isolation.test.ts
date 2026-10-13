// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Aislamiento de la comprobación del correo (lotes 3P-R y 3P-S): no toca MFA, roles ni la redirección del restablecimiento,
// no añade funciones serverless y deja intactos los contratos de /api/profile. Comprobaciones estructurales del código.

const read = (p: string) => readFileSync(p, "utf8");
const MIGRATION = read("supabase/migrations/20261105120000_password_recovery_lookup.sql");
const HANDLER = read("src/lib/password-recovery-handlers.ts");
const CLIENT = read("src/lib/password-recovery-client.ts");

describe("sin efectos laterales sobre MFA ni roles", () => {
  it("ni la migración ni el handler ni el cliente mencionan MFA, roles o tablas de administración", () => {
    for (const src of [MIGRATION, HANDLER, CLIENT]) {
      expect(src).not.toMatch(/mfa|admin_roles|admin_mfa|admin_invitations|factor/i);
    }
  });

  it("la migración solo lee auth.users (SELECT) y solo escribe en sus dos tablas privadas", () => {
    const writes = [
      ...MIGRATION.matchAll(/\b(insert into|update|delete from)\s+([\w.]+)/gi),
    ].map((m) => m[2].toLowerCase());
    for (const target of writes) {
      // «set» es el DO UPDATE SET del UPSERT; «l» y «x» son alias de auth_lookup_limits
      expect([
        "public.auth_lookup_limits",
        "public.auth_lookup_salt",
        "l",
        "x",
        "set",
      ]).toContain(target);
    }
    expect(MIGRATION).toMatch(/from auth\.users u/);
  });

  it("el flujo de /reset-password (marca, TOTP, cierre global) no se importa ni se modifica desde aquí", () => {
    for (const src of [HANDLER, CLIENT]) {
      expect(src).not.toMatch(
        /from ["'](\.\/|@\/lib\/)password-recovery["']|from ["'].*ResetPassword|totp-reverify|\.signOut\(/,
      );
    }
  });
});

describe("sin funciones serverless nuevas y contratos intactos", () => {
  it("api/ conserva las mismas 12 funciones (la acción vive dentro de api/profile.ts)", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const entries = readdirSync("api").flatMap((name) =>
      statSync(`api/${name}`).isDirectory()
        ? readdirSync(`api/${name}`).map((f) => `api/${name}/${f}`)
        : [`api/${name}`],
    );
    expect(entries.filter((f) => f.endsWith(".ts"))).toHaveLength(12);
    expect(entries.some((f) => /password|recovery|forgot/i.test(f))).toBe(false);
  });

  it("api/profile.ts sigue siendo un entrypoint que solo delega en handleProfile", () => {
    const src = read("api/profile.ts");
    expect(src).toMatch(/return handleProfile\(req, res\)/);
    expect(src).not.toMatch(/^import .*password-recovery-handlers/m);
  });
});

describe("integración controlada: apagada por defecto", () => {
  it("el único interruptor es VITE_PASSWORD_RECOVERY_LOOKUP=1 y .env.example lo deja comentado", () => {
    expect(CLIENT).toMatch(/VITE_PASSWORD_RECOVERY_LOOKUP === "1"/);
    const env = read(".env.example");
    expect(env).toMatch(/^# VITE_PASSWORD_RECOVERY_LOOKUP=1$/m);
    expect(env).not.toMatch(/^VITE_PASSWORD_RECOVERY_LOOKUP=/m);
  });
});
