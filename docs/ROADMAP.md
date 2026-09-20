# Roadmap de Desarrollo

Plan por fases desde el setup hasta el lanzamiento público.

---

## 🎯 Fase 0 — Fundaciones (Semana 1)

**Objetivo:** Tener el esqueleto del proyecto funcionando.

- [ ] Crear repositorio y estructura de carpetas
- [ ] Configurar Vite + React + TypeScript
- [ ] Configurar Tailwind + HeroUI
- [ ] Definir design tokens (colores, tipografía, espaciados)
- [ ] Configurar ESLint + Prettier + Husky
- [ ] Configurar Vitest + Playwright
- [ ] Crear layout base (Header, Footer, contenedor)
- [ ] Deploy inicial a Vercel

**Entregable:** URL con landing estática de la marca.

---

## 🎯 Fase 1 — Integración Twitch (Semana 2)

**Objetivo:** Módulo live y clips completos.

- [x] Registrar app en Twitch Developer Console (credenciales configuradas en el entorno
      Development de Vercel; validado contra Twitch real el 2026-09-19. Pendiente el mismo
      alta de variables en Preview/Production antes del despliegue público)
- [x] Implementar `api/twitch-status.ts`
- [x] Implementar `api/twitch-clips.ts`
- [x] Crear hook `useTwitchStatus`
- [x] Crear componente `<LiveBadge>` (con estado `loading`/`live`/`offline`/`error`)
- [x] Integrar `<TwitchPlayer>` cuando esté online (con fallback al último VOD si está offline)
- [x] Renderizar la grid de los 12 clips más recientes (ordenados por fecha, ver `docs/ARCHITECTURE.md`) directamente
      en `<TwitchSection>`. Se descartó un `<ClipGrid>` separado: la sección ya es un único
      `grid` responsive (3/2/1 columnas) sin lógica adicional que justifique extraer un
      componente, y "12" reemplaza a los "6" originales de este roadmap porque así quedó
      implementado desde el principio sin que afectara la UX.
- [x] Manejo de errores y estado offline (mensajes distintos para "no configurado" vs.
      "error temporal", ver `docs/FEATURES.md`)

**Entregable:** Sección Twitch funcional con datos reales.

**Validación real (Development, canal `upminaa`):** los tres endpoints responden 200 con datos
de Twitch; estado OFFLINE con último VOD (miniatura, fecha, duración y enlace) y 12 clips
reales renderizados con el embed oficial (`parent=localhost`). Pendiente: validación visual
del estado EN VIVO cuando el canal transmita (solo cubierto por tests unitarios del mapeo).

---

## 🎯 Fase 2 — Integración Instagram (Semana 3)

**Objetivo:** Feed visual de Instagram integrado.

- [ ] Verificar cuenta Business/Creator de UPMINA
- [ ] Crear app en Meta for Developers
- [ ] Implementar `api/instagram-feed.ts`
- [ ] Crear hook `useInstagramFeed`
- [ ] Crear componente `<InstagramGrid>`
- [ ] Distinguir visualmente reels vs fotos
- [ ] Configurar cron de renovación de token

> Nota: cuando se implemente `api/instagram-refresh-token.ts`, volver a añadir
> el bloque `crons` correspondiente en `vercel.json`.

**Entregable:** Grid de Instagram con contenido reciente.

---

## 🎯 Fase 3 — Integración YouTube (Semana 3.5)

**Objetivo:** Hero video + grid de videos anteriores.

- [ ] Crear proyecto en Google Cloud Console
- [ ] Habilitar YouTube Data API v3
- [ ] Generar API Key y restringirla al dominio
- [ ] Implementar `api/youtube-latest.ts`
- [ ] Implementar `api/youtube-videos.ts`
- [ ] Crear hook `useYouTubeVideos`
- [ ] Crear componente `<HeroVideo>` con reproductor grande
- [ ] Crear componente `<VideoGrid>` con cards clicables
- [ ] Crear componente `<VideoCard>` con miniatura y metadata
- [ ] Implementar estado compartido `selectedVideoId`
- [ ] Parsear duración ISO 8601 a formato legible
- [ ] Configurar caché de 15 minutos

**Entregable:** Sección YouTube con hero video y lista funcional.

---

## 🎯 Fase 4 — Integración TikTok (Semana 4)

**Objetivo:** Videos de TikTok embebidos.

- [ ] Crear app en TikTok Developer Portal
- [ ] Implementar flujo OAuth (una vez autorizado)
- [ ] Implementar `api/tiktok-videos.ts`
- [ ] Crear hook `useTikTokVideos`
- [ ] Crear `<TikTokGrid>` con oEmbed
- [ ] Configurar refresh de tokens

**Entregable:** Cuadrícula de videos de TikTok.

---

## 🎯 Fase 5 — Comunidad (Semanas 5-7)

**Objetivo:** Sistema completo de subida y votación de edits.

- [ ] Crear proyecto en Supabase
- [ ] Definir tablas, RLS y storage buckets
- [ ] Implementar auth (email + Discord OAuth)
- [ ] Crear flujo de subida de edits
- [ ] Implementar sistema de votos
- [ ] Crear feed público con filtros (recientes, top semanal)
- [ ] Crear perfil de usuario público
- [ ] Crear página de ajustes de perfil

**Entregable:** Comunidad funcional con contenido real de usuarios.

---

## 🎯 Fase 6 — Moderación (Semana 8)

**Objetivo:** Herramientas para mantener la comunidad sana.

- [ ] Panel de moderación (`/moderation`)
- [ ] Vista de edits pendientes
- [ ] Aprobación / rechazo con nota
- [ ] Sistema de reportes de usuarios
- [ ] Log de acciones de moderación
- [ ] Roles y permisos

**Entregable:** Panel de moderación operativo.

---

## 🎯 Fase 7 — Pulido y lanzamiento (Semana 9)

**Objetivo:** Preparar para producción.

- [ ] Optimización de imágenes (next-gen formats)
- [ ] Lazy loading de iframes y videos
- [ ] Auditoría de accesibilidad (WCAG AA)
- [ ] SEO on-page (meta tags, Open Graph)
- [ ] Tests E2E de flujos críticos
- [ ] Documentación final
- [ ] Contacto con UPMINA / management para autorización

**Entregable:** Web lista para presentar a la creadora.

---

## 🔮 Post-lanzamiento (Backlog)

- Notificaciones por email de "está en vivo"
- Multi-idioma (ES / EN / DE)
- PWA con soporte offline
- Chat de Twitch embebido
- Rankings semanales con premios
- Dashboard de analytics para la creadora
- Integración con Discord (roles automáticos)
