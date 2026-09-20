# Funcionalidades del Proyecto UPMINA Web

Este documento describe en detalle **qué hace cada módulo**, **por qué existe**
y **cómo se espera que funcione**. Sirve como especificación funcional para
desarrollo, diseño y QA.

---

## 1. Módulo: Estado en Vivo de Twitch

### 🎯 Objetivo
Informar a los visitantes en tiempo real si UPMINA está transmitiendo en Twitch.

### 👤 Historias de usuario
- Como visitante, quiero ver un banner que diga "EN VIVO" o "OFFLINE".
- Como visitante, cuando está en vivo, quiero ver título y espectadores.
- Como visitante, quiero poder ver el stream directamente en la web.

### ⚙️ Comportamiento esperado
1. Al cargar la página, se consulta el estado del canal.
2. El banner (`<LiveBadge>`) tiene 4 estados visuales, nunca solo "en vivo u offline":
   - **Cargando** ("Comprobando…"): mientras la primera consulta está en curso. No debe
     mostrarse como "OFFLINE" antes de tener una respuesta real.
   - **EN VIVO**: fondo rojo/neón, conteo de viewers.
   - **OFFLINE**: fondo gris oscuro, consulta exitosa y el canal no está transmitiendo.
   - **Sin datos**: la consulta falló (Twitch caído, sin credenciales); fondo gris oscuro,
     texto distinto de "OFFLINE" para no dar una respuesta que no se pudo confirmar.
3. Si está online, aparece un reproductor oficial de Twitch embebido
   (`player.twitch.tv`) con el canal que devolvió el backend (nunca un canal
   hardcodeado en el frontend), más un enlace "Ver en Twitch" como alternativa.
4. Si está offline, se intenta mostrar el último VOD grabado como fallback:
   reproductor embebido, título, fecha relativa, duración y enlace directo al
   VOD en twitch.tv.
5. Si la consulta tuvo éxito pero el canal nunca ha transmitido (no hay VOD),
   se muestra un estado vacío explícito ("Todavía no hay contenido de Twitch
   disponible."), distinto del estado de carga y del de error.
6. El estado se refresca cada 60 segundos.

### 🔧 Implementación
- Proxy en `api/twitch-status.ts` (usa `src/lib/twitch-shared.ts` para el token y el
  broadcaster; ese archivo no es un endpoint, vive fuera de `api/` a propósito).
- Hook `useTwitchStatus` con TanStack Query (`refetchInterval: 60000`). La respuesta incluye
  `channel`: es la única fuente de verdad del canal (viene de `TWITCH_CHANNEL` en el
  backend), tanto para el reproductor como para el enlace "Ver canal".
- Componentes `<LiveBadge>` y `<TwitchPlayer>`.

---

## 2. Módulo: Clips de Twitch

### 🎯 Objetivo
Mostrar los mejores o más recientes momentos de los directos.

### ⚙️ Comportamiento esperado
1. Se obtienen los 12 clips reales MÁS RECIENTES del canal vía Twitch Helix API
   (`Get Clips`), ordenados por fecha de creación descendente (el más nuevo
   primero); las vistas nunca deciden el orden. Si el canal tiene menos de 12,
   se muestran solo los que existen (nunca se inventa contenido), y si no tiene
   ninguno se muestra un estado vacío ("Todavía no hay clips disponibles.").
   Cómo se obtienen y por qué: ver "Twitch" en `docs/ARCHITECTURE.md`.
2. Grid responsive (3/2/1 columnas), renderizada directamente en `<TwitchSection>`.
3. Cada clip es un iframe embebido de `clips.twitch.tv`, y muestra además
   título, creador (`creator_name`), vistas (con singular "1 vista") y fecha relativa, más un enlace
   "Ver en Twitch" directo al clip (`url` de Helix) como alternativa si el
   embed no carga.
4. Si Twitch no está configurado (sin credenciales), el mensaje dice explícitamente que
   falta configuración. Si Twitch responde con un error temporal (caído, rate limit), el
   mensaje es distinto y no menciona configuración, para no confundir un problema puntual
   con uno de setup.

### 🔧 Implementación
- Proxy en `api/twitch-clips.ts`.
- Componente `<TwitchClip>`.

---

## 3. Módulo: Feed de Instagram

### 🎯 Objetivo
Mostrar las fotos y reels más recientes de la cuenta de Instagram.

### ⚙️ Comportamiento esperado
1. Se consulta la Graph API con token de 60 días.
2. Grid mosaico con imágenes y videos.
3. Reels con icono de "play" superpuesto.
4. Caché de 1 hora (rate limit 200/h).

### 🔧 Implementación
- Proxy en `api/instagram-feed.ts`.
- Hook `useInstagramFeed` (`staleTime: 3600000`).
- Componente `<InstagramGrid>`.

### ⚠️ Requisitos
- Cuenta Business o Creator vinculada a página de Facebook.
- Renovación de token cada 60 días (automatizable con Vercel Cron).

---

## 4. Módulo: Feed de TikTok

### 🎯 Objetivo
Mostrar los videos más recientes de TikTok.

### ⚙️ Comportamiento esperado
1. Se obtiene la lista vía Display API (`/v2/video/list/`).
2. Grid de tarjetas verticales (formato 9:16).
3. Cada tarjeta muestra la portada (`cover_image_url`) con un indicador de reproducción. Al hacer clic se abre un visor vertical dentro de la web (`<TikTokViewer>`) con la portada 9:16, título, fecha y "Ver en TikTok" (`share_url`, pestaña nueva). Navegación circular: ↓/↑ y swipe vertical (arriba = siguiente); Escape cierra. `video.list` no entrega un archivo de vídeo reproducible, así que no se reproduce ni se incrusta el reproductor de TikTok.
4. Caché de 30 minutos.

### 🔧 Implementación
- Proxy en `api/tiktok-videos.ts`.
- Componentes en `src/components/tiktok/`: `TikTokSection` (rejilla), `TikTokCard` (tarjeta 9:16), `TikTokViewer` (visor vertical) y `TikTokCover` (portada con fallback).

---

## Enlaces sociales

El Footer enlaza a los perfiles oficiales externos de UPMINA:

- [YouTube](https://www.youtube.com/@upminaa)
- [Instagram](https://www.instagram.com/upminaa/?hl=es)
- [TikTok](https://www.tiktok.com/@upminaa.cos?lang=es)
- [Reddit](https://www.reddit.com/user/upminaa/)

---

## 5. Módulo: YouTube

### 🎯 Objetivo
Dar máximo protagonismo al contenido de YouTube de UPMINA. El video más
reciente se muestra en grande como pieza central, y debajo se lista el
catálogo anterior para explorar.

### 👤 Historias de usuario
- Como visitante, quiero ver el último video en grande con miniatura,
  título y fecha.
- Como visitante, quiero reproducirlo directamente en la web.
- Como visitante, quiero ver una lista de videos anteriores con miniaturas,
  títulos, fechas y duración.
- Como visitante, quiero hacer clic en cualquier video de la lista para que
  se cargue en el reproductor grande sin recargar la página.
- Como visitante, quiero ordenar o filtrar los videos.

### ⚙️ Comportamiento esperado
1. Al cargar la sección, se consulta el canal vía YouTube Data API v3.
2. Último video → **reproductor grande** 16:9 con overlay de título y metadata.
3. Debajo, **grid** con los siguientes videos (mínimo 12), cada uno con:
   - Miniatura (`thumbnail.high.url`)
   - Título
   - Fecha de publicación (formateada como "Hace X días")
   - Duración parseada de ISO 8601 a `HH:MM:SS`
   - Badge "Último video" para el primero
4. Clic en un video de la lista → el reproductor grande se actualiza con
   transición suave (fade/crossfade).
5. El video activo se resalta con borde `accent-primary` y badge "Reproduciendo".
6. Caché de 15 minutos para no agotar la cuota diaria.

### 🔧 Implementación
- Proxies: `api/youtube-latest.ts` y `api/youtube-videos.ts`.
- Hook: `useYouTubeVideos` (`staleTime: 900000`).
- Componentes: `<HeroVideo>`, `<VideoGrid>`, `<VideoCard>`.
- Estado compartido: `selectedVideoId` en el padre `<YouTubeSection>` o Zustand.

### ⚠️ Consideraciones sobre la cuota
- **YouTube Data API v3** tiene cuota diaria gratuita de **10,000 unidades**.
- `playlistItems.list` = 1 unidad por llamada.
- `videos.list` (para duración) = 1 unidad por llamada.
- Con caché de 15 minutos: ~200 unidades/día. Muy por debajo del límite.

### 🎨 Layout

```
┌─────────────────────────────────────────────────────────┐
│  YOUTUBE                                                 │
│                                                           │
│  ┌─────────────────────────────────────────────────┐    │
│  │                                                   │    │
│  │         [  VIDEO MÁS RECIENTE 16:9  ]            │    │
│  │                                                   │    │
│  │  ▶ Título del último video                       │    │
│  │    Hace 3 días · 12:45                           │    │
│  └─────────────────────────────────────────────────┘    │
│                                                           │
│  Más videos                                              │
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐                             │
│  │ ▶  │ │ ▶  │ │ ▶  │ │ ▶  │                             │
│  └────┘ └────┘ └────┘ └────┘                             │
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐                             │
│  │ ▶  │ │ ▶  │ │ ▶  │ │ ▶  │                             │
│  └────┘ └────┘ └────┘ └────┘                             │
└─────────────────────────────────────────────────────────┘
```

### 🔄 Interacción clave
- El **HeroVideo** y la **VideoGrid** comparten `selectedVideoId`.
- Al hacer clic en una card, el HeroVideo se actualiza con transición suave.
- La card seleccionada recibe borde `accent-primary` y badge "Reproduciendo".

---

## 6. Módulo: Comunidad de Edits

### 🎯 Objetivo
Crear un espacio donde los fans puedan subir edits creados a partir de los
directos de UPMINA, votarlos y compartirlos con la comunidad.

### 👤 Historias de usuario
- Como usuario registrado, quiero subir un edit (video) con título y descripción.
- Como usuario registrado, quiero votar positiva o negativamente otros edits.
- Como usuario registrado, quiero ver mi perfil con mis edits subidos.
- Como moderador, quiero aprobar o rechazar edits antes de que sean públicos.
- Como visitante, quiero ver los edits aprobados ordenados por votos o fecha.

### ⚙️ Comportamiento esperado
1. Un usuario se registra con email o con proveedor OAuth (Discord, Google).
2. Sube un video (max 100MB, mp4/webm) + título + descripción.
3. El edit entra en estado `pending` y no es visible públicamente.
4. Un moderador lo revisa y cambia el estado a `approved` o `rejected`.
5. Los edits aprobados aparecen en el feed público con sistema de votos.
6. Los edits más votados suben en el ranking semanal.

### 🔧 Implementación
- **Supabase** para auth, storage y base de datos.
- Tablas: `profiles`, `edits`, `votes`, `reports`.
- Row-Level Security para asegurar que solo el autor edite su contenido.
- Panel de moderación protegido por rol (`moderator`).

### 🛡️ Reglas de contenido
- Solo se permite contenido original creado por el usuario.
- Se prohíbe contenido sexual explícito, violento o de odio.
- Los edits deben respetar los derechos de autor (uso transformativo).
- Cualquier edit puede ser reportado por la comunidad.

---

## 7. Módulo: Perfil de Usuario

### 🎯 Objetivo
Que cada miembro de la comunidad tenga su espacio con sus aportes.

### 👤 Historias de usuario
- Como usuario, quiero ver mi avatar, nombre y bio.
- Como usuario, quiero ver la lista de mis edits y sus votos.
- Como usuario, quiero editar mi perfil (avatar, bio, redes).

### 🔧 Implementación
- Tabla `profiles` con FK a `auth.users`.
- Storage bucket `avatars` con políticas de acceso.
- Página `/profile/:username` y `/settings`.

---

## 8. Módulo: Navegación y Layout

### 🎯 Objetivo
Proporcionar una experiencia de navegación fluida y consistente.

### Características
- Header sticky con logo UPMINA, enlaces de sección y CTA "Ver en Twitch".
- Footer con enlaces a todas las redes y aviso legal.
- Navegación por anclas en la home (`#twitch`, `#youtube`, `#instagram`,
  `#tiktok`, `#comunidad`).
- Menú hamburguesa en móvil.
- Modo oscuro como única opción (fiel a la estética de la marca).

---

## 9. Módulos Futuros (backlog)

- **Chat de Twitch embebido** en la sección live.
- **Notificaciones por email** cuando UPMINA entra en directo (vía Resend).
- **Ranking semanal de edits** con premios simbólicos.
- **Sistema de comentarios** en los edits.
- **PWA** instalable con soporte offline básico.
- **Multi-idioma** (español, inglés, alemán — dado el público de UPMINA).
- **Integración con Discord** (roles automáticos según actividad en la web).
- **Dashboard de analytics** para la creadora.
