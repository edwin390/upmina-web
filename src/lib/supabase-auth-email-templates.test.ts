// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderBrandedEmailHtml } from "./mail-html";

// Plantillas de Supabase Auth (docs/supabase-auth-email-templates): HTML autónomo que se pega en el Dashboard. Aquí se comprueba
// que usan la misma identidad que mail-html.ts, que conservan SOLO variables oficiales de Supabase, que no hay JavaScript,
// URLs de autenticación fijas ni recursos remotos, y que el HTML está bien formado en lo básico.
const DIR = resolve("docs/supabase-auth-email-templates");
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".html"))
  .sort();
const read = (f: string) => readFileSync(resolve(DIR, f), "utf8");
const ALLOWED_VARIABLES = new Set([
  "{{ .ConfirmationURL }}",
  "{{ .Token }}",
  "{{ .Email }}",
  "{{ .NewEmail }}",
]);
const reference = renderBrandedEmailHtml("x", []);

describe("plantillas de Supabase Auth", () => {
  it("existen las seis plantillas previstas", () => {
    expect(FILES).toEqual([
      "change-email.html",
      "confirm-signup.html",
      "invite-user.html",
      "magic-link.html",
      "reauthentication.html",
      "reset-password.html",
    ]);
  });

  it.each(FILES)("%s: identidad idéntica a mail-html.ts", (f) => {
    const html = read(f);
    // Mismo contenedor, cabecera y pie que los demás correos.
    for (const fragment of [
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#171f30;border:1px solid #28344c;border-top:3px solid #74b8f4;border-radius:8px;">',
      'letter-spacing:3px;color:#74b8f4;">UPMINAA<span style="color:#ff4da6;"> WEB</span></td>',
      "Automatic message from Upminaa Web. Please do not reply to this message.",
      '<meta name="color-scheme" content="dark light">',
      "Upminaa Web is an independent project and is not officially affiliated with Mina.",
    ])
      expect(html).toContain(fragment);
    expect(reference).toContain(
      "max-width:560px;background-color:#171f30;border:1px solid #28344c;border-top:3px solid #74b8f4;border-radius:8px;",
    );
    // Solo colores del sistema de diseño.
    const colors = new Set(
      (html.match(/#[0-9a-fA-F]{6}\b/g) ?? []).map((c) => c.toLowerCase()),
    );
    for (const c of colors)
      expect([
        "#0b0d13",
        "#171f30",
        "#28344c",
        "#74b8f4",
        "#ff4da6",
        "#e7f0fc",
        "#a9b8ce",
        "#7c8ca6",
        "#a8d4fa",
      ]).toContain(c);
    for (const old of ["#0a0a0a", "#ff2d95", "#00f0ff", "bebas", "inter"])
      expect(html.toLowerCase()).not.toContain(old);
  });

  it.each(FILES)(
    "%s: sin JavaScript, sin recursos ni URLs fijas, ASCII y bien formado",
    (f) => {
      const html = read(f);
      expect(html).not.toMatch(
        /<script|<img|<link|@import|url\(|<iframe|<form|javascript:|\son[a-z]+=/i,
      );
      expect(html).not.toMatch(/https?:\/\//i); // ninguna URL fija (incluidas las de autenticación)
      expect(html).toMatch(/^[\n\x20-\x7e]+$/);
      expect(html).not.toMatch(/eyJ|sk-|secret|apikey/i); // sin tokens ni secretos
      for (const tag of [
        "html",
        "head",
        "body",
        "style",
        "table",
        "tr",
        "td",
        "h1",
        "p",
        "a",
      ]) {
        const opens = (html.match(new RegExp(`<${tag}[\\s>]`, "gi")) ?? []).length;
        const closes = (html.match(new RegExp(`</${tag}>`, "gi")) ?? []).length;
        expect(opens, `<${tag}> sin cerrar en ${f}`).toBe(closes);
      }
      // Solo variables oficiales de Supabase, tal cual (sin escapar).
      for (const v of html.match(/\{\{[^}]*\}\}/g) ?? [])
        expect(ALLOWED_VARIABLES.has(v), v).toBe(true);
      expect(html).not.toMatch(/&#123;|&lcub;|%7B%7B/);
    },
  );

  it.each([
    "confirm-signup.html",
    "reset-password.html",
    "change-email.html",
    "invite-user.html",
    "magic-link.html",
  ])(
    "%s: botón y enlace alternativo usan {{ .ConfirmationURL }} y el botón tiene hover y foco",
    (f) => {
      const html = read(f);
      const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
      expect(hrefs).toEqual(["{{ .ConfirmationURL }}", "{{ .ConfirmationURL }}"]);
      expect(html).toContain(
        '<a class="btn" href="{{ .ConfirmationURL }}" style="display:inline-block;padding:12px 20px;background-color:#74b8f4;border:1px solid #74b8f4;color:#0b0d13;',
      );
      expect(html).toContain(".btn:hover{background-color:#a8d4fa !important");
      expect(html).toContain(".btn:focus{outline:2px solid #a8d4fa");
      // Nunca rosa en el botón: el rosa solo aparece en la cabecera (WEB).
      expect(html.match(/#ff4da6/g)).toHaveLength(1);
      expect(html.match(/<style>[\s\S]*<\/style>/)?.[0]).not.toContain("#ff4da6");
      expect(html).toContain(
        "If the button does not work, copy this address into your browser:",
      );
      expect(html).not.toContain("{{ .Token }}"); // un enlace nunca se presenta como código
      expect(html).toContain("@media only screen and (max-width:480px)");
    },
  );

  it("reauthentication: muestra el código {{ .Token }} y no tiene enlaces ni botón", () => {
    const html = read("reauthentication.html");
    expect(html).toContain("{{ .Token }}");
    expect(html).not.toContain("ConfirmationURL");
    expect(html).not.toMatch(/<a[\s>]/);
    expect(html).not.toContain('class="btn"');
  });

  it("change-email usa los datos del destinatario oficiales y confirm-signup conserva su mensaje", () => {
    expect(read("change-email.html")).toContain("from {{ .Email }} to {{ .NewEmail }}");
    const c = read("confirm-signup.html");
    for (const phrase of [
      "Verify your email",
      "Verify email",
      "Didn't create an account?",
    ])
      expect(c).toContain(phrase);
  });

  it("vista previa con valores ficticios: sin variables sin resolver", () => {
    const fake: Record<string, string> = {
      "{{ .ConfirmationURL }}": "https://example.invalid/EXAMPLE-NOT-A-REAL-LINK",
      "{{ .Token }}": "000000",
      "{{ .Email }}": "person@example.invalid",
      "{{ .NewEmail }}": "new-person@example.invalid",
    };
    for (const f of FILES) {
      let html = read(f);
      for (const [k, v] of Object.entries(fake)) html = html.split(k).join(v);
      expect(html).not.toMatch(/\{\{/); // las llaves dobles del CSS (@media) no son variables
    }
  });

  it("los dos azules del botón son los del frontend (globals.css, tailwind y el botón de verificación)", () => {
    const css = readFileSync(resolve("src/styles/globals.css"), "utf8");
    const hex = (name: string) => {
      const m = css.match(new RegExp(`--c-${name}:\\s*(\\d+) (\\d+) (\\d+);`));
      if (!m) throw new Error(name);
      return (
        "#" +
        m
          .slice(1, 4)
          .map((n) => Number(n).toString(16).padStart(2, "0"))
          .join("")
      );
    };
    const primary = hex("accent-primary");
    const secondary = hex("accent-secondary");
    expect([primary, secondary]).toEqual(["#74b8f4", "#a8d4fa"]);
    // El botón de verificación de la web: base accent-primary, hover y foco accent-secondary (nunca rosa).
    const web = readFileSync(
      resolve("src/components/auth/EmailVerificationPending.tsx"),
      "utf8",
    );
    expect(web).toContain("bg-accent-primary");
    expect(web).toContain("hover:bg-accent-secondary");
    expect(web).toContain("focus-visible:ring-accent-secondary");
    for (const f of FILES.filter((x) => x !== "reauthentication.html")) {
      const html = read(f);
      expect(html).toContain(`background-color:${primary};border:1px solid ${primary}`);
      expect(html).toContain(`.btn:hover{background-color:${secondary} !important`);
      expect(html).toContain(`.btn:focus{outline:2px solid ${secondary}`);
    }
  });
});
