import {
  INSTAGRAM_EXPIRING_SOON_MS,
  isInstagramAccessTokenExpired,
} from "./instagram-connection.js";
import { isTikTokRefreshTokenExpired } from "./tiktok-connection.js";

// Modelo ÚNICO del ciclo de vida de una conexión social para /admin (Fase 9H-3). Función pura:
// solo lee las columnas de expiración ya guardadas (nunca tokens ni proveedor remoto), con un reloj
// inyectado. Es la misma regla de caducidad que usa el feed (isInstagramAccessTokenExpired /
// isTikTokRefreshTokenExpired), así que panel y feed nunca discrepan.
//
// Estados:
//   not_connected     — no hay fila para el proveedor (o se desconectó).
//   reauth_required   — la fila existe pero sus credenciales ya no sirven:
//                         Instagram: access token caducado o a ≤ 60 s de caducar;
//                         TikTok:    refresh token caducado (un access token caducado con refresh
//                                    vigente es RECUPERABLE: sigue "connected");
//                         o una fecha de expiración ausente/ilegible (fail closed: nunca se declara
//                         sana una credencial cuya vigencia no se puede leer);
//                         o el proveedor rechazó la autorización (190 / invalid_grant): eso se
//                         persiste como caducidad = momento del rechazo, ver
//                         markInstagramAuthorizationInvalid / markTikTokAuthorizationInvalid.
//   expiring_soon     — sigue utilizable pero la credencial que exige una persona para renovarse
//                         caduca pronto: Instagram ≤ 7 días (la ventana de renovación perezosa: si
//                         sigue ahí, nadie la renovó); TikTok refresh token ≤ 14 días (no se
//                         renueva sin reautorizar).
//   connected         — utilizable y lejos de caducar. NO prueba que el proveedor no la haya
//                         revocado antes de la fecha (no se consulta al proveedor al abrir /admin).
//
// `expiresAt`: la fecha que gobierna el estado (Instagram: access token; TikTok: refresh token),
// solo si es un ISO legible. No mezcla nada de autorización/MFA.

export type SocialLifecycleProvider = "instagram" | "tiktok";
export type SocialLifecycleStatus =
  "connected" | "expiring_soon" | "reauth_required" | "not_connected";

export interface SocialLifecycle {
  status: SocialLifecycleStatus;
  expiresAt?: string;
}

/** Aviso de TikTok: el refresh token dura ~365 días y solo se renueva reautorizando. */
export const TIKTOK_EXPIRING_SOON_MS = 14 * 24 * 60 * 60_000;

export interface SocialConnectionRow {
  provider?: unknown;
  access_token_expires_at?: unknown;
  refresh_token_expires_at?: unknown;
}

function readableDate(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

export function socialLifecycle(
  provider: SocialLifecycleProvider,
  rows: SocialConnectionRow[],
  now: number,
): SocialLifecycle {
  const row = rows.find((r) => r.provider === provider);
  if (!row) return { status: "not_connected" };

  if (provider === "instagram") {
    const expiresAt = readableDate(row.access_token_expires_at);
    if (!expiresAt || isInstagramAccessTokenExpired(expiresAt, now)) {
      return expiresAt
        ? { status: "reauth_required", expiresAt }
        : { status: "reauth_required" };
    }
    const soon = Date.parse(expiresAt) - now <= INSTAGRAM_EXPIRING_SOON_MS;
    return { status: soon ? "expiring_soon" : "connected", expiresAt };
  }

  const refreshExpiresAt = readableDate(row.refresh_token_expires_at);
  // TikTok también necesita un access_token_expires_at legible: sin él el feed falla por formato.
  const accessReadable = readableDate(row.access_token_expires_at) !== null;
  if (
    !refreshExpiresAt ||
    !accessReadable ||
    isTikTokRefreshTokenExpired(refreshExpiresAt, now)
  ) {
    return refreshExpiresAt
      ? { status: "reauth_required", expiresAt: refreshExpiresAt }
      : { status: "reauth_required" };
  }
  const soon = Date.parse(refreshExpiresAt) - now <= TIKTOK_EXPIRING_SOON_MS;
  return { status: soon ? "expiring_soon" : "connected", expiresAt: refreshExpiresAt };
}
