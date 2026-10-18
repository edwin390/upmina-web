import { parseMinaFeatures, type MinaFeature } from "./mina-features";

// Solo presentación (navegación, rutas, tarjetas). NO es una frontera de seguridad: el servidor repite el control en cada endpoint.
// __MINA_FEATURES__ lo inyecta vite.config.ts en la COMPILACIÓN desde MINA_FEATURES_ENABLED (en pruebas: todas activas).
const enabled = parseMinaFeatures(
  typeof __MINA_FEATURES__ === "string" ? __MINA_FEATURES__ : "",
);

export const isMinaFeatureEnabled = (feature: MinaFeature): boolean =>
  enabled.has(feature);
