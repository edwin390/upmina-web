// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildAccountDeletionEmail } from "./account-deletion-mail";
import { buildCopyrightEmail, type CopyrightMailInput } from "./copyright-mail";
import { escapeMailHtml, renderBrandedEmailHtml } from "./mail-html";
import { buildRecoveryEmail } from "./mfa-recovery-mail";

// Presentación HTML unificada de los correos transaccionales. Invariantes por variante real: identidad (cabecera y colores),
// sin dependencias remotas, enlaces idénticos a los del texto plano, párrafos del texto plano presentes (escapados) en el HTML,
// datos dinámicos escapados y HTML solo ASCII. El asunto y el texto plano no los toca este cambio (lo cubren sus pruebas propias).

const HOSTILE = `<img src=x onerror=alert(1)> "q" & 'a' <script>x</script>`;
const LINK = "https://app.example/copyright/appeal#t=" + "T".repeat(43);
const urlsIn = (s: string) => s.split(/\s+/).filter((w) => /^https:\/\/\S+$/.test(w));

function expectBranded(mail: { subject: string; text: string; html: string }) {
  const { html, text } = mail;
  expect(html.startsWith("<!doctype html>")).toBe(true);
  expect(html).toContain("UPMINAA");
  expect(html).toContain("WEB");
  for (const color of ["#0b0d13", "#171f30", "#74b8f4", "#ff4da6"])
    expect(html).toContain(color);
  // Sin JavaScript, CSS externo, imágenes ni fuentes remotas.
  expect(html).not.toMatch(/<script|<img|<link|@import|url\(|<iframe|<form/i);
  // El único <style> admitido son las reglas del botón: hover y foco con el SEGUNDO azul del sistema, nunca el rosa.
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
  expect(style.replace(/\.btn:(hover|focus)\{[^}]*\}/g, "").trim()).toBe("");
  expect(style).toContain(".btn:hover{background-color:#a8d4fa");
  expect(style).not.toContain("#ff4da6");
  expect(html).toMatch(/^[\n\x20-\x7e]+$/); // ASCII, sin tabuladores
  // Los enlaces del HTML son exactamente los del texto plano (y nada más).
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) =>
    m[1].replace(/&amp;/g, "&"),
  );
  const expected = urlsIn(text.replace(/^Confirmation link: /m, ""));
  expect([...new Set(hrefs)].sort()).toEqual([...new Set(expected)].sort());
  // Cada párrafo de texto (no enlace) aparece, escapado, en el HTML.
  for (const paragraph of text.split("\n\n")) {
    if (/^(Confirmation link: )?https:\/\/\S+$/.test(paragraph)) continue;
    expect(html).toContain(escapeMailHtml(paragraph));
  }
}

describe("correos de Copyright y Community", () => {
  const base = { reference: "CPY-2026-000001", reason: HOSTILE, windowMinutes: 60 };
  const variants: Array<[string, CopyrightMailInput]> = [
    ["removal", { kind: "removal", ...base, appealLink: LINK }],
    ["appeal_accepted", { kind: "appeal_accepted", ...base, resolutionNote: HOSTILE }],
    ["appeal_rejected", { kind: "appeal_rejected", ...base, resolutionNote: HOSTILE }],
    [
      "strike nivel 1",
      {
        kind: "strike",
        ...base,
        strike: { level: 1, permanent: false, endsAt: "2026-11-01T00:00:00Z" },
      },
    ],
    [
      "strike nivel 3",
      { kind: "strike", ...base, strike: { level: 3, permanent: true, endsAt: null } },
    ],
    [
      "community_strike nivel 2",
      {
        kind: "community_strike",
        ...base,
        strike: { level: 2, permanent: false, endsAt: "2026-12-01T00:00:00Z" },
      },
    ],
    [
      "community_strike nivel 3",
      {
        kind: "community_strike",
        ...base,
        strike: { level: 3, permanent: true, endsAt: null },
      },
    ],
  ];
  it.each(variants)("%s: identidad, enlaces, párrafos y escape", (_name, input) => {
    const mail = buildCopyrightEmail(input);
    expectBranded(mail);
    expect(mail.html).toContain(escapeMailHtml(HOSTILE)); // el motivo se copia, escapado
    expect(mail.html).not.toContain("<img src=x");
    expect(mail.html).not.toContain("onerror=alert(1)>");
  });
});

describe("correo de eliminación de cuenta", () => {
  it("conserva enlace, caducidad, advertencia de irreversibilidad y cierre", () => {
    const link = "https://app.example/account/delete#t=" + "A".repeat(43);
    const mail = buildAccountDeletionEmail({ link, expiresInMinutes: 30 });
    expectBranded(mail);
    expect(mail.subject).toBe("Upmina Community - Confirm the deletion of your account");
    expect(mail.html).toContain("Deleting your account is irreversible.");
    expect(mail.html).toContain("expires in 30 minutes");
    expect(mail.html).toContain(`href="${link}"`);
    expect(mail.html).toContain("Review and confirm the deletion");
    expect(mail.text.startsWith("We received a request to permanently delete")).toBe(
      true,
    );
  });
});

describe("correos de recuperación de MFA (misma presentación compartida)", () => {
  const link = "https://app.example/admin/mfa/recovery#c=TOKEN";
  it.each([
    buildRecoveryEmail({ kind: "challenge", link, expiresMinutes: 15 }),
    buildRecoveryEmail({ kind: "closed", reason: "denied" }),
    buildRecoveryEmail({ kind: "completed" }),
  ])("variante %#", (mail) => expectBranded(mail));
});

describe("renderBrandedEmailHtml", () => {
  it("escapa título, texto, etiqueta y enlace, incluidas las comillas", () => {
    const html = renderBrandedEmailHtml(HOSTILE, [
      { type: "text", text: HOSTILE },
      { type: "link", href: `https://x.test/?a="b"&c='d'`, label: HOSTILE },
    ]);
    expect(html).not.toContain("<script>x");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain('href="https://x.test/?a=&quot;b&quot;&amp;c=&#39;d&#39;"');
  });
});
