// Mensajes completos en español, importados de forma ESTÁTICA. Sólo lo usan las pruebas (setupTests) para
// resolver textos sin montar el proveedor de idioma. NO debe importarse desde código de la aplicación:
// metería todos los espacios de nombres en el bundle inicial (la app los carga bajo demanda; ver messages.ts).
import authEs from "./locales/es/auth.json";
import commonEs from "./locales/es/common.json";
import cosplayEs from "./locales/es/cosplay.json";
import mediaEs from "./locales/es/media.json";
import moderationEs from "./locales/es/moderation.json";
import siteEs from "./locales/es/site.json";
import communityEs from "./locales/es/community.json";
import accountEs from "./locales/es/account.json";
import adminEs from "./locales/es/admin.json";
import developerEs from "./locales/es/developer.json";
import type { Messages } from "./messages";

export const ES_MESSAGES: Messages = {
  auth: authEs,
  common: commonEs,
  cosplay: cosplayEs,
  media: mediaEs,
  moderation: moderationEs,
  site: siteEs,
  community: communityEs,
  account: accountEs,
  admin: adminEs,
  developer: developerEs,
};
