import type { VercelResponse } from "@vercel/node";
import { parseMinaFeatures, type MinaFeature } from "./mina-features.js";

// Autoridad en el SERVIDOR: lee MINA_FEATURES_ENABLED en cada petición (nunca una variable pública ni nada del navegador).
export function minaFeatureEnabled(
  feature: MinaFeature,
  raw: string | undefined = process.env.MINA_FEATURES_ENABLED,
): boolean {
  return parseMinaFeatures(raw).has(feature);
}

export const FEATURE_UNAVAILABLE_BODY = {
  error: "Función no disponible",
  code: "feature_unavailable",
} as const;

/** true = la función está activa y la petición puede continuar. false = ya se respondió 503 (neutral, sin detalles ni caché). */
export function requireMinaFeature(feature: MinaFeature, res: VercelResponse): boolean {
  if (minaFeatureEnabled(feature)) return true;
  res.setHeader("Cache-Control", "no-store");
  res.status(503).json(FEATURE_UNAVAILABLE_BODY);
  return false;
}
