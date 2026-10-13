import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// POST /api/profile?action=password-recovery — «Olvidé mi contraseña» con comprobación del correo (lotes 3P-R y 3P-S).
// Sin función serverless nueva: se enruta dentro del entrypoint existente api/profile.ts (profile-handlers.ts).
//
// DECISIÓN DE PRODUCTO aceptada expresamente por el propietario: la respuesta REVELA si el correo está registrado
// (para ofrecer «Crear cuenta con [correo]» o pedir confirmar una cuenta pendiente). Eso es enumeración de cuentas
// deliberada, así que la consulta lleva límites POR CAPAS del SERVIDOR (SQL: auth_email_lookup) y el resto de la
// superficie sigue cerrada:
//   * Solo POST, cuerpo exactamente { email } con forma estricta; nada más entra.
//   * La consulta usa service_role SOLO a través de la RPC auth_email_lookup (SECURITY DEFINER, solo service_role): el
//     cliente nunca ve la clave ni nada de auth.users. La respuesta es únicamente { status } (y retryAfterSeconds).
//   * NO se crean usuarios, NO se usa OTP/inicio de sesión como comprobación y NO se envía ningún correo desde aquí.
//   * El ENVÍO de la recuperación lo hace el NAVEGADOR con la anon key (resetPasswordForEmail, el flujo oficial de Supabase
//     Auth), no este servidor. Motivo (lote 3P-S, documentación de Supabase): /auth/v1/recover tiene un límite POR IP de
//     30 peticiones cada 5 min compartido con signup/resend/otp/user; si el envío saliera de aquí, TODAS las
//     recuperaciones llegarían a Auth con la IP de salida de Vercel y compartirían ese cupo (basta un atacante para
//     agotarlo). Desde el navegador cada persona usa su propia IP. Conservar la IP original desde el servidor exige la
//     cabecera Sb-Forwarded-For con una clave SECRETA (no vale anon ni la service_role legacy) y activar el ajuste en Auth:
//     configuración remota y un secreto nuevo, no hecha.
//   * Un fallo técnico (RPC, configuración) NUNCA se interpreta como «correo inexistente».
//
// IP del cliente (lote 3P-S). Documentación de Vercel («Request headers»): `x-forwarded-for` es la IP pública del cliente y
// Vercel LA SOBRESCRIBE (no reenvía IPs externas) para impedir el spoofing; `x-real-ip` y `x-vercel-forwarded-for` son
// idénticas, y la última además no la pisa un proxy delante de Vercel. Se usa esa precedencia, se valida con net.isIP
// (cualquier otra cosa se descarta) y, si ninguna es válida, la IP es «unknown» (bucket propio, nunca un permiso libre).
// IPv6 se agrupa por /64 (rotar dentro de un /64 es trivial) y la red por /24 (IPv4) o /48 (IPv6).
// La IP NUNCA sale de este módulo en claro: se envía a la base solo como HMAC-SHA256 (clave derivada del secreto del
// servidor), no se registra y no se devuelve al navegador.
//
// Respuestas:
//   200 { status: "confirmed" | "unconfirmed" | "unregistered" }
//   400 { error }                                   — forma inválida
//   405 / 429 { status: "rate_limited", retryAfterSeconds } / 502 | 503 { status: "error" }

const GENERIC_ERROR = { status: "error" } as const;
const MAX_EMAIL = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const UNKNOWN = "unknown";

export interface PasswordRecoveryDeps {
  /** Cliente service_role (SOLO para la RPC auth_email_lookup). null si falta configuración. */
  lookupClient: () => SupabaseClient | null;
  /** Secreto del servidor para derivar el HMAC de IP y red. null si falta configuración. */
  ipSecret: () => string | null;
}

export function defaultDeps(env: NodeJS.ProcessEnv = process.env): PasswordRecoveryDeps {
  const url = env.VITE_SUPABASE_URL?.trim();
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return {
    lookupClient: () =>
      url && serviceKey
        ? createClient(url, serviceKey, {
            auth: { persistSession: false, autoRefreshToken: false },
          })
        : null,
    // La propia clave de servicio, solo como material de clave de un HMAC con etiqueta de contexto: no se imprime,
    // no sale del servidor y el digest no permite recuperarla.
    ipSecret: () => serviceKey || null,
  };
}

function parseBody(req: VercelRequest): Record<string, unknown> | null {
  let parsed: unknown = req.body;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/** Correo normalizado (trim + minúsculas, como GoTrue al escribirlo) o null si la forma no es válida. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_EMAIL + 64) return null;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > MAX_EMAIL || CONTROL_CHARS.test(email))
    return null;
  return EMAIL_SHAPE.test(email) ? email : null;
}

/** Expande una IPv6 válida (con «::» y/o cola IPv4) a sus 8 grupos de 4 hex en minúsculas. */
function expandIPv6(address: string): string[] | null {
  let text = address.toLowerCase();
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const parts = tail[1].split(".").map(Number);
    const hex = (a: number, b: number) => ((a << 8) | b).toString(16);
    text = `${text.slice(0, -tail[1].length)}${hex(parts[0], parts[1])}:${hex(parts[2], parts[3])}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = [
    ...head,
    ...Array(halves.length === 2 ? missing : 0).fill("0"),
    ...rest,
  ];
  return groups.length === 8 && groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))
    ? groups.map((g) => g.padStart(4, "0"))
    : null;
}

/** Claves canónicas de IP (/32 o /64) y de red (/24 o /48), o null si no es una IP válida. Nunca se registran. */
export function canonicalClient(value: string): { ip: string; net: string } | null {
  if (value.length > 45 || /[\s%]/.test(value)) return null;
  const family = isIP(value);
  if (family === 4) {
    const octets = value.split(".");
    return { ip: `v4:${value}`, net: `v4:${octets.slice(0, 3).join(".")}` };
  }
  if (family === 6) {
    const groups = expandIPv6(value);
    if (!groups) return null;
    // IPv4 mapeada (::ffff:a.b.c.d) = la misma persona que su IPv4.
    if (groups.slice(0, 5).every((g) => g === "0000") && groups[5] === "ffff") {
      const octets = [
        parseInt(groups[6].slice(0, 2), 16),
        parseInt(groups[6].slice(2), 16),
        parseInt(groups[7].slice(0, 2), 16),
        parseInt(groups[7].slice(2), 16),
      ];
      return { ip: `v4:${octets.join(".")}`, net: `v4:${octets.slice(0, 3).join(".")}` };
    }
    return {
      ip: `v6:${groups.slice(0, 4).join(":")}`,
      net: `v6:${groups.slice(0, 3).join(":")}`,
    };
  }
  return null;
}

/**
 * Dirección del cliente según la plataforma. Precedencia documentada de Vercel: x-vercel-forwarded-for, x-real-ip,
 * x-forwarded-for. Un valor que no sea EXACTAMENTE una IP se descarta y se prueba la siguiente cabecera; en
 * x-forwarded-for se usa el ÚLTIMO elemento (el añadido por el salto más cercano), no el primero, que es el que un
 * cliente puede falsear si alguna vez hubiera un proxy que añade en vez de sobrescribir.
 */
export function clientAddress(req: VercelRequest): string | null {
  const read = (name: string): string | null => {
    const raw = req.headers[name];
    const value = Array.isArray(raw) ? raw.join(",") : raw;
    return typeof value === "string" ? value : null;
  };
  for (const name of ["x-vercel-forwarded-for", "x-real-ip", "x-forwarded-for"]) {
    const value = read(name);
    if (value === null) continue;
    const parts = value.split(",").map((p) => p.trim());
    const candidate = name === "x-forwarded-for" ? parts[parts.length - 1] : value.trim();
    if (candidate && canonicalClient(candidate)) return candidate;
  }
  return null;
}

/** Digests HMAC (64 hex) de la IP y de la red del cliente, o «unknown». Es lo único que llega a la base de datos. */
export function clientKeys(
  req: VercelRequest,
  secret: string,
): { ip: string; net: string } {
  const address = clientAddress(req);
  const canonical = address ? canonicalClient(address) : null;
  if (!canonical) return { ip: UNKNOWN, net: UNKNOWN };
  const digest = (label: string, key: string) =>
    createHmac("sha256", secret).update(`upmina:lookup:${label}:v1:${key}`).digest("hex");
  return { ip: digest("ip", canonical.ip), net: digest("net", canonical.net) };
}

export async function handlePasswordRecoveryRequest(
  req: VercelRequest,
  res: VercelResponse,
  deps: PasswordRecoveryDeps = defaultDeps(),
): Promise<VercelResponse> {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }

  const body = parseBody(req);
  const keys = body ? Object.keys(body) : [];
  const email =
    body && keys.length === 1 && keys[0] === "email" ? normalizeEmail(body.email) : null;
  if (!email) return res.status(400).json({ error: "Solicitud inválida" });

  const lookup = deps.lookupClient();
  const secret = deps.ipSecret();
  if (!lookup || !secret) return res.status(503).json(GENERIC_ERROR);

  let status: string;
  let retryAfterSeconds = 60;
  try {
    const { ip, net } = clientKeys(req, secret);
    const { data, error } = await lookup.rpc("auth_email_lookup", {
      p_email: email,
      p_ip: ip,
      p_net: net,
    });
    if (error || !data || typeof data !== "object")
      return res.status(502).json(GENERIC_ERROR);
    const out = data as { status?: unknown; retryAfterSeconds?: unknown };
    if (typeof out.status !== "string") return res.status(502).json(GENERIC_ERROR);
    status = out.status;
    if (
      typeof out.retryAfterSeconds === "number" &&
      Number.isFinite(out.retryAfterSeconds)
    ) {
      retryAfterSeconds = Math.min(3600, Math.max(1, Math.ceil(out.retryAfterSeconds)));
    }
  } catch {
    return res.status(502).json(GENERIC_ERROR);
  }

  if (status === "rate_limited") {
    res.setHeader("Retry-After", String(retryAfterSeconds));
    return res.status(429).json({ status: "rate_limited", retryAfterSeconds });
  }
  if (status === "invalid") return res.status(400).json({ error: "Solicitud inválida" });
  if (status === "none") return res.status(200).json({ status: "unregistered" });
  if (status === "unconfirmed") return res.status(200).json({ status: "unconfirmed" });
  if (status === "confirmed") return res.status(200).json({ status: "confirmed" });
  // Cualquier valor desconocido es un fallo técnico, NUNCA «inexistente».
  return res.status(502).json(GENERIC_ERROR);
}
