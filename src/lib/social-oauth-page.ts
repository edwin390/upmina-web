import { createHash } from "node:crypto";

// Pantalla de resultado de los callbacks OAuth de TikTok e Instagram (HTML estático servido por la función).
// Textos en inglés y tokens visuales actuales del sitio (src/styles/globals.css: fondo azul oscuro, acento azul y rosa;
// tema claro por prefers-color-scheme). Sin React ni Tailwind: el CSS es propio y autónomo. Sin datos del
// proveedor ni del usuario. Un único script inline, fijo y autorizado por hash en la CSP, quita ?code, ?state y
// el resto de parámetros de la URL visible (no ejecuta nada más y no lee el contenido de la query).

export type SocialPageKind =
  "success" | "error" | "cancelled" | "expired" | "unavailable";
const ICON: Record<SocialPageKind, string> = {
  success: "✓",
  error: "!",
  cancelled: "–",
  expired: "⏱",
  unavailable: "!",
};
// Estados semánticos: variables de los tokens --c-accent-success / --c-accent-live / --c-accent-warning (oscuro y claro).
const ACCENT: Record<SocialPageKind, string> = {
  success: "var(--ok)",
  error: "var(--err)",
  cancelled: "var(--warn)",
  expired: "var(--warn)",
  unavailable: "var(--warn)",
};

export const CLEAN_URL_SCRIPT = `history.replaceState(null,"",location.pathname)`;
const SCRIPT_HASH = createHash("sha256").update(CLEAN_URL_SCRIPT).digest("base64");

export const SOCIAL_PAGE_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${SCRIPT_HASH}'`,
};

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function renderSocialOAuthPage(
  title: string,
  message: string,
  kind: SocialPageKind,
): string {
  const retry = kind !== "success";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · UPMINAA</title>
<style>
:root{color-scheme:dark light;--bg:rgb(11 13 19);--surface:rgb(23 31 48);--border:rgb(40 52 76);--text:rgb(231 240 252);--muted:rgb(169 184 206);--accent:rgb(116 184 244);--pink:rgb(255 77 166);--on-accent:rgb(11 13 19);--ok:rgb(0 255 136);--err:rgb(255 0 51);--warn:rgb(255 184 0)}
@media (prefers-color-scheme:light){:root{--bg:rgb(234 242 252);--surface:rgb(248 251 255);--border:rgb(197 214 234);--text:rgb(37 59 86);--muted:rgb(66 92 123);--accent:rgb(79 115 159);--pink:rgb(190 70 135);--on-accent:rgb(255 255 255);--ok:rgb(11 133 80);--err:rgb(207 0 41);--warn:rgb(150 98 0)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1rem;background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.5}
main{width:100%;max-width:26rem;padding:2rem 1.5rem;text-align:center;background:var(--surface);border:1px solid var(--border);border-top:3px solid var(--accent);border-radius:.5rem}
.brand{margin:0 0 1.25rem;font-family:"Bebas Neue",Impact,system-ui,sans-serif;font-size:1.5rem;letter-spacing:.12em;color:var(--accent)}
.brand span{color:var(--pink)}
.badge{display:inline-grid;place-items:center;width:3rem;height:3rem;margin-bottom:1rem;border-radius:9999px;border:2px solid ${ACCENT[kind]};color:${ACCENT[kind]};font-size:1.5rem;font-weight:700}
h1{margin:0 0 .75rem;font-family:"Bebas Neue",Impact,system-ui,sans-serif;font-weight:400;font-size:2rem;letter-spacing:.04em;text-transform:uppercase}
p{margin:0 0 1.5rem;color:var(--muted)}
.actions{display:flex;flex-wrap:wrap;gap:.75rem;justify-content:center}
a{display:inline-flex;min-height:2.75rem;align-items:center;padding:.625rem 1.25rem;border-radius:.375rem;font-size:.875rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;text-decoration:none}
a.primary{background:var(--accent);border:1px solid var(--accent);color:var(--on-accent)}
a.secondary{border:1px solid var(--border);color:var(--muted)}
a:hover{border-color:var(--pink)}
a:focus-visible{outline:2px solid var(--pink);outline-offset:2px}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>
</head>
<body>
<main role="main">
<p class="brand" aria-hidden="true">UPMINA<span>A</span></p>
<div class="badge" aria-hidden="true">${ICON[kind]}</div>
<h1>${escapeHtml(title)}</h1>
<p role="${kind === "success" ? "status" : "alert"}">${escapeHtml(message)}</p>
<div class="actions">
<a class="primary" href="/admin">Return to settings</a>${retry ? `\n<a class="secondary" href="/admin">Try again</a>` : ""}
</div>
</main>
<script>${CLEAN_URL_SCRIPT}</script>
</body>
</html>
`;
}

/** Estado visual a partir del desenlace del callback (sin inspeccionar datos del proveedor). */
export function socialPageKind(status: number, title: string): SocialPageKind {
  if (status === 200) return "success";
  if (title === "Authorization cancelled") return "cancelled";
  if (status === 400 || status === 409) return "expired";
  return status === 403 || status >= 500 ? "unavailable" : "error";
}
