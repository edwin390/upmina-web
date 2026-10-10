// Detección de usernames y NOMBRES VISIBLES (display_name) que pueden confundirse con la identidad de
// Mina / Upmina / Upminaa Web.
//
// Módulo PURO (sin dependencias; lo importan el servidor y el navegador). La AUTORIDAD es PostgreSQL:
// `community_username_impersonation()` (supabase/migrations/20261101120000_username_impersonation_guard.sql)
// implementa EXACTAMENTE este algoritmo y un trigger lo aplica a cualquier INSERT/UPDATE de
// profiles.username. Este archivo existe para (1) dar el error antes de un viaje de red, (2) la UX
// del formulario y (3) tests de paridad con los mismos vectores (username-impersonation-vectors.ts).
// Si cambias una regla aquí, cámbiala en la migración (nueva migración; nunca editar la aplicada).
//
// ALGORITMO (ver docs/USERNAME-IMPERSONATION-GUARD.md):
//  1. Normalización: NFKD, sin marcas diacríticas, minúsculas ASCII, homoglifos Cirílico/Griego
//     habituales → latín, caracteres invisibles fuera.
//  2. Dos "esqueletos" solo-letras: A (leet: 0→o 1→i 3→e 4→a 5→s 7→t @→a $→s !→i |→i l→i) y B
//     (los dígitos se descartan: "mina1" → "mina"). Separadores (_ . espacios) desaparecen.
//  3. Se bloquea si algún esqueleto, con cada letra repetible (m+i+n+a+, de modo que miina/minaa
//     equivalen a mina):
//       exact     = [up]mina
//       affixed   = prefijos/sufijos de identidad + [up]mina + prefijos/sufijos de identidad
//       embedded  = contiene "upmina" en cualquier posición
//       near      = (esqueleto con letras repetidas colapsadas, 5–7 letras) a UNA edición de "upmina"
//     "mina" a secas NO se bloquea por contención ("amina", "terminal", "mina_lopez" se permiten).
//  4. display_name (frases con espacios, Unicode, emojis): mismo esqueleto, pero SIN la regla
//     "embedded" para no rechazar frases claramente personales ("Fan de Mina desde 2020",
//     "Hola, soy Ana y me encanta Upmina"). Se bloquea cuando el nombre ENTERO es la identidad o la
//     identidad más afijos (exact / affixed), una DECLARACIÓN de identidad/representación/oficialidad
//     (declared: vocabulario + conectores + al menos una palabra de autoridad, "Cuenta oficial de
//     Mina", "Official Account of Mina", "Upmina Chat") o una errata de "upmina" (near).

export type ImpersonationReason = "exact" | "affixed" | "declared" | "embedded" | "near";
export type IdentityField = "username" | "display_name";

/** Vocabulario de identidad/autoridad que, junto a mina/upmina, indica suplantación. Mínimo y
 *  deliberadamente corto: solo palabras de "oficialidad", nunca palabras de afición ("fan"). */
export const IMPERSONATION_AFFIXES: readonly string[] = [
  "real",
  "the",
  "official",
  "oficial",
  "original",
  "verified",
  "verificado",
  "team",
  "staff",
  "admin",
  "mod",
  "moderator",
  "support",
  "soporte",
  "account",
  "cuenta",
  "acc",
  "true",
  "authentic",
  "legit",
  "its",
  "iam",
  "im",
  // Cuentas de aficionados / páginas: parecen asociadas al proyecto o a la persona.
  "fan",
  "fans",
  "fanpage",
  "fanclub",
  "club",
  "page",
  // Identidad del sitio ("Upminaa Web").
  "web",
  "website",
  "site",
  // Declaraciones de identidad en español / alemán ("Soy Mina", "Ich bin Mina").
  "soy",
  "ich",
  "bin",
];

/** SOLO display_name: palabras de autoridad/oficialidad/canal (es/en/de) que, junto a la identidad y con
 *  conectores ("Cuenta oficial de Mina", "Official Account of Mina", "Upmina Chat"), forman una
 *  declaración de identidad o representación. No incluye "fan": "Fan de Mina" es legítimo. */
export const DISPLAY_AUTHORITY_WORDS: readonly string[] = [
  "official",
  "oficial",
  "offiziell",
  "offizielle",
  "offizieller",
  "offizielles",
  "original",
  "verified",
  "verificado",
  "verifiziert",
  "team",
  "equipo",
  "staff",
  "admin",
  "administracion",
  "administration",
  "administrador",
  "administrator",
  "mod",
  "moderator",
  "moderador",
  "support",
  "soporte",
  "account",
  "cuenta",
  "konto",
  "chat",
  "community",
  "comunidad",
  "gemeinschaft",
];

/** SOLO display_name: conectores entre palabras de autoridad e identidad ("de", "of", "von"…). */
export const DISPLAY_CONNECTORS: readonly string[] = [
  "de",
  "del",
  "la",
  "el",
  "of",
  "by",
  "from",
  "von",
  "der",
  "die",
  "das",
  "y",
  "and",
  "und",
];

// Homoglifos/letras sin descomposición Unicode (mismo contenido que la migración).
const FOLD_FROM = "ßẞłŁøØđĐıħĦ" + "аеорсімухкт" + "АЕОРСІМУХКТ" + "αοιρΑΟΙΡ" + "ᴍɪɴᴀᴜᴘ"; // + versalitas
const FOLD_TO = "ssllooddihh" + "aeopcimyxkt" + "aeopcimyxkt" + "aoipaoip" + "minaup";
export const USERNAME_FOLD = { from: FOLD_FROM, to: FOLD_TO } as const;

const LEET_FROM = "013457@$!|l";
const LEET_TO = "oieastasiii";
const SYMBOL_FROM = "@$!|l";
const SYMBOL_TO = "asiii";

function translate(s: string, from: string, to: string): string {
  const map = new Map<string, string>();
  [...from].forEach((c, i) => map.set(c, to[i] ?? ""));
  let out = "";
  for (const c of s) out += map.get(c) ?? c;
  return out;
}

function fold(raw: string): string {
  const base = raw
    .replace(/[\u2122\u2120\u00ae\u00a9]/g, "") // ™ ℠ ® ©: NFKD los volvería "TM"/"SM"
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u200b-\u200f\u2060\ufeff\u00ad]/g, "");
  return translate(base, FOLD_FROM, FOLD_TO).toLowerCase();
}

const lettersOnly = (s: string) => s.replace(/[^a-z]/g, "");

/** Esqueleto solo-letras. `digitsAsLetters`: true = leet (A); false = dígitos descartados (B). */
export function usernameSkeleton(raw: string, digitsAsLetters: boolean): string {
  const s = fold(raw);
  return digitsAsLetters
    ? lettersOnly(translate(s, LEET_FROM, LEET_TO))
    : lettersOnly(translate(s.replace(/[0-9]/g, ""), SYMBOL_FROM, SYMBOL_TO));
}

const collapse = (s: string) => s.replace(/(.)\1+/g, "$1");
const expand = (w: string) => w.replace(/./g, "$&+");

const AFFIX_ALT = IMPERSONATION_AFFIXES.map((a) =>
  expand(usernameSkeleton(a, true)),
).join("|");
const BASE = `(?:${expand("up")})?${expand("mina")}`;
const EXACT = new RegExp(`^${BASE}$`);
const AFFIXED = new RegExp(`^(?:${AFFIX_ALT})*${BASE}(?:${AFFIX_ALT})*$`);
const EMBEDDED = new RegExp(expand("upmina"));
const skel = (w: string) => expand(usernameSkeleton(w, true));
const AUTH_ALT = DISPLAY_AUTHORITY_WORDS.map(skel).join("|");
const DECL_ALT = [
  ...IMPERSONATION_AFFIXES,
  ...DISPLAY_AUTHORITY_WORDS,
  ...DISPLAY_CONNECTORS,
]
  .map(skel)
  .join("|");
// Declaración de identidad (display_name): vocabulario + conectores, con al menos una palabra de
// autoridad antes o después de la identidad. "s" opcional tras la identidad ("Mina's Official Account").
const DECLARED = new RegExp(
  `^(?:(?:${DECL_ALT})*(?:${AUTH_ALT})(?:${DECL_ALT})*${BASE}s*(?:${DECL_ALT})*` +
    `|(?:${DECL_ALT})*${BASE}s*(?:${DECL_ALT})*(?:${AUTH_ALT})(?:${DECL_ALT})*)$`,
);

/** ¿Distancia de Damerau (sustitución, inserción, borrado o transposición adyacente) ≤ 1? */
export function withinOneEdit(a: string, b: string): boolean {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (a === b) return true;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

// Cota de seguridad contra backtracking: display_name admite ≤ 40 caracteres y username ≤ 30, así que
// un esqueleto mayor solo puede venir de relleno artificial y nunca es "identidad + vocabulario".
export const MAX_SKELETON_LENGTH = 120;

function classify(s: string, field: IdentityField): ImpersonationReason | null {
  if (s.length === 0 || s.length > MAX_SKELETON_LENGTH) return null;
  if (EXACT.test(s)) return "exact";
  if (AFFIXED.test(s)) return "affixed";
  if (field === "display_name" && DECLARED.test(s)) return "declared";
  if (field === "username" && EMBEDDED.test(s)) return "embedded";
  const c = collapse(s);
  if (c.length >= 5 && c.length <= 7 && withinOneEdit(c, "upmina")) return "near";
  return null;
}

const ORDER: ImpersonationReason[] = ["exact", "affixed", "declared", "embedded", "near"];

/** Motivo de bloqueo (el más fuerte entre los dos esqueletos) o null si no hay suplantación. */
export function detectImpersonation(
  raw: string,
  field: IdentityField = "username",
): ImpersonationReason | null {
  const found = [true, false]
    .map((leet) => classify(usernameSkeleton(raw, leet), field))
    .filter((r): r is ImpersonationReason => r !== null);
  if (found.length === 0) return null;
  return found.sort((x, y) => ORDER.indexOf(x) - ORDER.indexOf(y))[0];
}

export function isImpersonationUsername(raw: string): boolean {
  return detectImpersonation(raw, "username") !== null;
}

export function isImpersonationDisplayName(raw: string): boolean {
  return detectImpersonation(raw, "display_name") !== null;
}
