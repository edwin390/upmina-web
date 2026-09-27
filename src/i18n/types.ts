import type { Messages } from "./messages";
import type { Locale } from "./locale";

// Autocompletado y comprobación de tipos de use-intl: augmenta su AppConfig global con la forma
// REAL de los mensajes en español (fuente de verdad). Una clave que no existe en es/*.json (o un
// argumento de interpolación que falta) es un error de compilación, no un fallo en tiempo de
// ejecución. en/de no se tipan por separado: deben cubrir el mismo árbol de claves que ES (lo
// vigila i18n-parity.test.ts), así que tipar solo ES basta.
declare module "use-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}
