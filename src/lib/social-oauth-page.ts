import { createHash } from "node:crypto";

// Pantalla de resultado de los callbacks OAuth de TikTok e Instagram (HTML estático servido por la función).
// Textos en inglés y tokens visuales del sitio (bg #0a0a0a/#141414, acento #ff2d95/#00f0ff). Sin datos del
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
const ACCENT: Record<SocialPageKind, string> = {
  success: "#00ff88",
  error: "#ff0033",
  cancelled: "#ffb800",
  expired: "#ffb800",
  unavailable: "#ffb800",
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
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1rem;background:#0a0a0a;color:#f5f5f5;font-family:Inter,system-ui,sans-serif}
main{width:100%;max-width:26rem;padding:2rem;text-align:center;background:#141414;border:1px solid #2a2a2a;border-radius:.5rem}
.badge{display:inline-grid;place-items:center;width:3rem;height:3rem;margin-bottom:1rem;border-radius:9999px;border:2px solid ${ACCENT[kind]};color:${ACCENT[kind]};font-size:1.5rem;font-weight:700}
h1{margin:0 0 .75rem;font-family:"Bebas Neue",Impact,system-ui,sans-serif;font-weight:400;font-size:2rem;letter-spacing:.04em;text-transform:uppercase}
p{margin:0 0 1.5rem;color:#a0a0a0;line-height:1.5}
.actions{display:flex;flex-wrap:wrap;gap:.75rem;justify-content:center}
a{display:inline-flex;min-height:2.75rem;align-items:center;padding:.625rem 1.25rem;border-radius:.375rem;font-size:.875rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;text-decoration:none}
a.primary{background:#ff2d95;border:1px solid #ff2d95;color:#0a0a0a}
a.secondary{border:1px solid #2a2a2a;color:#a0a0a0}
a:hover{border-color:#00f0ff}
a:focus-visible{outline:2px solid #00f0ff;outline-offset:2px}
</style>
</head>
<body>
<main role="main">
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
