// Funciones que dependen de la autorización de Mina para compartir su contenido: Instagram, TikTok y Cosplays (son las tres que
// muestran PermissionPendingNotice: «estamos esperando el permiso de Mina»). Una sola lista de funciones activas, DESACTIVADAS por
// defecto: MINA_FEATURES_ENABLED = lista separada por comas, p. ej. "instagram,tiktok,cosplay". Vacía o ausente = todas desactivadas.
// Este módulo no lee el entorno; el servidor (mina-feature-guard.ts) y la interfaz (mina-features-client.ts) lo leen cada uno.
export const MINA_FEATURES = ["instagram", "tiktok", "cosplay"] as const;
export type MinaFeature = (typeof MINA_FEATURES)[number];

export function parseMinaFeatures(
  raw: string | null | undefined,
): ReadonlySet<MinaFeature> {
  const enabled = new Set<MinaFeature>();
  for (const part of (raw ?? "").split(",")) {
    const name = part.trim().toLowerCase();
    if ((MINA_FEATURES as readonly string[]).includes(name))
      enabled.add(name as MinaFeature);
  }
  return enabled;
}
