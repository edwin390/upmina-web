// Construcción del src de <img> para el QR de enrolamiento TOTP (Bloque 4C). Vive aquí
// (no inline en AdminMfaPage.tsx) para poder testearlo con valores completamente
// sintéticos sin renderizar nada ni tocar Supabase.
//
// La documentación instalada de @supabase/auth-js (v2.116.0) es INTERNAMENTE
// inconsistente sobre el formato de `data.totp.qr_code`:
//   - El comentario del tipo (AuthMFAEnrollTOTPResponseFields, en
//     node_modules/@supabase/auth-js/dist/main/lib/types.d.ts) dice que hay que
//     "convertirlo en URL anteponiendo `data:image/svg+xml;utf-8,`" — implica que
//     qr_code NO incluye ya ese prefijo.
//   - El ejemplo JSDoc de `enroll()` en el mismo archivo lo usa DIRECTAMENTE como
//     `src` de un <Image> de Next.js (`<Image src={data.totp.qr_code} .../>`), sin
//     anteponer nada — lo que implica que SÍ es ya una data URI completa.
// No se puede saber cuál de las dos describe el runtime real solo por los tipos:
// de ahí que buildTotpQrImageSrc detecte el formato por la FORMA del valor recibido
// en vez de asumir una única regla fija.

const SVG_DATA_URI_PREFIX = "data:image/svg+xml;utf-8,";

/**
 * Construye un `src` de <img> válido a partir de `data.totp.qr_code`, detectando el
 * formato real por su forma (nunca asumiendo uno solo):
 *
 * - Ya es una data URI completa (empieza por `data:`): se usa TAL CUAL. Anteponerle
 *   nuestro propio prefijo encima produciría una data URI anidada e inválida
 *   (`data:image/svg+xml;utf-8,data:image/svg+xml;...`) — el navegador no puede
 *   decodificar eso como SVG y muestra el alt text, exactamente el síntoma observado.
 * - Es marcado SVG crudo sin encodear (empieza por `<svg`/`<?xml`): se aplica
 *   `encodeURIComponent` UNA sola vez antes de anteponer el prefijo. Es la única forma
 *   segura de embeber SVG arbitrario en una data URI sin que caracteres reservados
 *   (`#`, `"`, espacios) la corrompan, y no es doble encoding porque el valor de
 *   entrada nunca estuvo encodeado.
 * - Cualquier otro caso (p. ej. ya percent-encoded pero sin el prefijo `data:`): se
 *   antepone el prefijo tal cual, sin volver a encodear (evita doble encoding).
 */
export function buildTotpQrImageSrc(qrCode: string): string {
  if (qrCode.startsWith("data:")) {
    return qrCode;
  }
  if (/^\s*<(\?xml|svg)/i.test(qrCode)) {
    return `${SVG_DATA_URI_PREFIX}${encodeURIComponent(qrCode)}`;
  }
  return `${SVG_DATA_URI_PREFIX}${qrCode}`;
}
