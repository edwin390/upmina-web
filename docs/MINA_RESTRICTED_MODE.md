# Modo operativo restringido (sin IA y sin las funciones que dependen de Mina)

Estado: implementado en local (migración y despliegue pendientes de autorización). No se ha borrado ninguna función, componente, tabla ni dato.

## 1. Las tres funciones restringidas

Son las tres que ya muestran «estamos esperando el permiso de Mina» (`PermissionPendingNotice`, usado solo por estas secciones):

| Función   | Dónde                                                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| Instagram | `/instagram`; API `feed`, `profile`, `media`, `comments`; `api/instagram-callback`; conexión OAuth                |
| TikTok    | `/tiktok`; API `videos`, `callback`; conexión OAuth                                                               |
| Cosplays  | `/cosplay`, `/cosplay/:slug`; API `cosplay-list`, `cosplay-post`; editor de administración y subida de sus medios |

Variable única: `MINA_FEATURES_ENABLED` = lista separada por comas con `instagram`, `tiktok` y/o `cosplay`. **Ausente o vacía = las tres
desactivadas.** Valores desconocidos se ignoran. El servidor la lee en cada petición (`src/lib/mina-feature-guard.ts`); la interfaz la
recibe en la compilación (`vite.config.ts` → `__MINA_FEATURES__`) solo para ocultar enlaces y mostrar un estado neutral. La interfaz
no es una frontera de seguridad: ni cabeceras, ni parámetros ni el navegador activan nada.

## 2. Qué queda público

Inicio, Twitch, YouTube, Community (feed, perfiles, detalle, publicar, editar, reportar), moderación humana, denuncias, copyright,
strikes, cuentas, eliminación de cuentas, páginas legales y panel de administración/Developer. Los enlaces del pie a las cuentas de
Instagram y TikTok son enlaces externos normales y se conservan.

## 3. Qué queda desactivado

- Interfaz: enlaces de navegación y tarjetas de la home de las tres funciones; sus rutas muestran «Sección no disponible».
- Servidor (503 `feature_unavailable`, `Cache-Control: no-store`): todas las rutas de Instagram y TikTok (incluido el callback OAuth),
  `cosplay-list` y `cosplay-post`, las escrituras del editor de Cosplay (`cosplay-post-save`, `-reorder`, `cosplay-media-detach`), la
  reserva, completado y aborto de medios del dominio `cosplay`, y `social-connect` de Instagram y TikTok.
- Siguen disponibles a propósito: `cosplay-post-delete` y las lecturas de administración (retirar o revisar lo existente), y
  `social-status` / `social-disconnect` (poder desconectar credenciales).
- IA: `CONTENT_SHADOW_RUN_ENABLED` debe ser `false` (ver sección 5). Proveedor fake, sin `OPENAI_API_KEY`.

## 4. Datos que se conservan

Todo. Tablas de Cosplay y sus imágenes en R2, conexiones sociales (`social_connections`) y tokens guardados, Community, reportes,
copyright, strikes y auditoría. Solo se dejan de servir o de poder modificar.

## 5. IA desactivada y captura shadow

- Despliegue DEV: poner `CONTENT_SHADOW_RUN_ENABLED=false` (o eliminarla) en Preview; dejar `CONTENT_SHADOW_PROVIDER` sin definir y no
  definir `OPENAI_API_KEY`. Con eso el endpoint de procesamiento responde 503 (probado). Es una variable de Vercel: requiere un
  despliegue nuevo.
- Captura: sin cambios, los triggers de la base de datos siguen creando jobs con copia del texto. Se añade la migración
  `20261126120000_community_shadow_capture_switch.sql` (**solo DEV, depende de `20261122`–`20261125`**): una tabla con un interruptor
  que la deja **apagada**. Apagada, `capture()` sigue obsoletando y borrando la copia del texto de jobs anteriores cuando el contenido
  cambia, pero no crea jobs nuevos. Los triggers y Community no se tocan (la captura ya ignoraba sus propios fallos).
- Reactivar la captura: `update public.community_shadow_capture_control set enabled = true;` (SQL de administrador) y, para recoger el
  contenido de las últimas 24 h, `select public.community_shadow_reconcile(100);`.
- Retención: `community_shadow_maintain` (borrar copias a las 24 h y filas a los 30 días) solo se ejecuta dentro del endpoint de
  procesamiento. Con el procesamiento parado, ejecutarla a mano periódicamente: `select public.community_shadow_maintain(100);`.
- Production no tiene las migraciones shadow (nunca se aplicaron allí): no hay captura ni procesamiento shadow en Production.

## 6. Cómo reactivar cada función

1. Definir `MINA_FEATURES_ENABLED` en el entorno de Vercel que corresponda con las funciones deseadas (p. ej. `cosplay`). Se lee al
   **compilar** (interfaz) y al **ejecutar** (servidor): hace falta un despliegue nuevo.
2. Instagram y TikTok además necesitan sus variables OAuth ya existentes (`INSTAGRAM_*`, `TIKTOK_*`, ver `.env.example`) y que el
   administrador vuelva a conectar la cuenta si el token caducó. Cosplays no necesita variables ni migraciones nuevas.
3. No hace falta ninguna migración para reactivar estas tres funciones. Para la IA, ver `docs/OPENAI_SHADOW_REACTIVATION.md`.

## 7. Riesgos pendientes antes de Production

- Desplegar este código en Production desactiva de inmediato las tres funciones (valor por defecto). Es lo deseado, pero hay que
  confirmarlo. Para mantener alguna activa, definir `MINA_FEATURES_ENABLED` en Production antes del despliegue.
- Los archivos públicos de Cosplay siguen en R2 y el Worker de entrega los sirve por URL directa (con caché larga). Esta fase solo
  deja de publicar sus URLs; quien ya las tenga puede seguir viéndolas. Retirarlos exige cambios en Worker/R2, no hechos.
- La interfaz usa un valor fijado en la compilación; una discrepancia con el servidor nunca abre nada (manda el servidor).
- La migración del interruptor no se ha aplicado en ningún entorno y solo se ha probado en PGlite.
- No hay revisión visual en navegador de las pantallas ocultas.
