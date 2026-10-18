// Presentación HTML compartida de los correos transaccionales (MFA, Copyright/Community, eliminación de cuenta).
// SOLO presentación: recibe el contenido ya decidido por cada módulo y lo escapa; no decide textos, destinatarios ni enlaces.
// Identidad = tema oscuro de docs/DESIGN_SYSTEM.md / src/styles/globals.css (fondo 11 13 19, tarjeta 23 31 48, texto 231 240 252,
// azul 116 184 244, rosa 255 77 166). Tablas + CSS en línea, sin JavaScript, sin CSS externo, sin fuentes ni imágenes remotas
// (cabecera de texto: más fiable que un logo alojado). Salida solo ASCII y sin tabuladores.

export type EmailBlock =
  { type: "text"; text: string } | { type: "link"; href: string; label: string };

const FONT = "Arial,Helvetica,sans-serif";
// Botón primario = botón de la web (accent-primary con texto text-inverse, mayúsculas con tracking 0.18em, rounded-md). Hover y foco
// usan el SEGUNDO azul del sistema (accent-secondary, #a8d4fa), nunca el rosa. Si el cliente ignora <style>, queda el azul base.
const BUTTON_STYLE =
  "display:inline-block;padding:12px 20px;background-color:#74b8f4;border:1px solid #74b8f4;color:#0b0d13;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;letter-spacing:2.5px;text-transform:uppercase;text-decoration:none;border-radius:6px;";
const HEAD_STYLE = [
  ".btn:hover{background-color:#a8d4fa !important;border-color:#a8d4fa !important;color:#0b0d13 !important}",
  ".btn:focus{outline:2px solid #a8d4fa;outline-offset:2px;background-color:#a8d4fa !important;border-color:#a8d4fa !important}",
].join("\n");
const DEFAULT_FOOTER =
  "Automatic message from Upminaa Web. Please do not reply to this message.";

export const escapeMailHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

function renderBlock(block: EmailBlock): string {
  if (block.type === "text") {
    return `<p style="margin:0 0 20px 0;font-size:16px;line-height:24px;color:#e7f0fc;">${escapeMailHtml(block.text)}</p>`;
  }
  const href = escapeMailHtml(block.href);
  return [
    `<p style="margin:0 0 20px 0;"><a class="btn" href="${href}" style="${BUTTON_STYLE}">${escapeMailHtml(block.label)}</a></p>`,
    `<p style="margin:0 0 20px 0;font-size:13px;line-height:20px;color:#a9b8ce;word-break:break-all;">If the button does not work, copy this address into your browser:<br><a href="${href}" style="color:#74b8f4;">${escapeMailHtml(block.href)}</a></p>`,
  ].join("\n");
}

export function renderBrandedEmailHtml(
  title: string,
  blocks: EmailBlock[],
  footer: string = DEFAULT_FOOTER,
): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="dark light">',
    `<title>${escapeMailHtml(title)}</title>`,
    `<style>\n${HEAD_STYLE}\n</style>`,
    "</head>",
    '<body style="margin:0;padding:0;background-color:#0b0d13;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0b0d13;">',
    '<tr><td align="center" style="padding:24px 12px;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#171f30;border:1px solid #28344c;border-top:3px solid #74b8f4;border-radius:8px;">',
    `<tr><td style="padding:24px 24px 8px 24px;font-family:${FONT};font-size:22px;font-weight:bold;letter-spacing:3px;color:#74b8f4;">UPMINAA<span style="color:#ff4da6;"> WEB</span></td></tr>`,
    `<tr><td style="padding:8px 24px 8px 24px;font-family:${FONT};">`,
    blocks.map(renderBlock).join("\n"),
    "</td></tr>",
    `<tr><td style="padding:8px 24px 24px 24px;font-family:${FONT};font-size:12px;line-height:18px;color:#7c8ca6;">${escapeMailHtml(footer)}</td></tr>`,
    "</table>",
    "</td></tr>",
    "</table>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
