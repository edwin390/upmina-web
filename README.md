# UPMINA — Fan Site

> Sitio web dedicado a la streamer y cosplayer **UPMINA** (Mina Min).
> Centraliza sus transmisiones en vivo, contenido de redes sociales y una
> comunidad de creadores que producen edits de sus directos.

---

## 📖 Descripción

**UPMINA Web** es una aplicación web que unifica el contenido público de la
creadora. Ofrece a su comunidad un punto de encuentro donde pueden:

- Ver si está en directo en Twitch en tiempo real.
- Reproducir el último video de YouTube y explorar su catálogo anterior.
- Acceder a sus fotos y reels recientes de Instagram.
- Ver sus videos más recientes de TikTok.
- Disfrutar de sus mejores clips de Twitch.
- Subir, votar y compartir edits creados por la comunidad.

Estética **goth/alt/neón** fiel a la identidad visual de la marca.

### Enlaces oficiales

- [YouTube](https://www.youtube.com/@upminaa)
- [Instagram](https://www.instagram.com/upminaa/?hl=es)
- [TikTok](https://www.tiktok.com/@upminaa.cos?lang=es)
- [Reddit](https://www.reddit.com/user/upminaa/)

---

## ✨ Características

| Módulo | Descripción | Estado |
|---|---|---|
| Estado Twitch | Banner dinámico ONLINE/OFFLINE con viewers | 🚧 |
| Reproductor Twitch | Embed del directo cuando está online | 🚧 |
| Clips Twitch | Cuadrícula con clips recientes | 🚧 |
| YouTube Hero | Video más reciente destacado en grande | 🚧 |
| YouTube Grid | Lista con videos anteriores del canal | 🚧 |
| Instagram Feed | Grid con fotos y reels recientes | 🚧 |
| TikTok Feed | Cuadrícula con videos recientes | 🚧 |
| Comunidad | Subida, votación y moderación de edits | 🚧 |
| Moderación | Aprobación/rechazo de edits | 📋 |
| Responsive | Adaptado a móvil, tablet y escritorio | 🚧 |

---

## 🛠️ Stack

**Frontend:** React 19 + Vite + TypeScript · Tailwind CSS · HeroUI · Zustand · TanStack Query
**Backend:** Vercel Functions (Node.js)
**DB/Auth:** Supabase (PostgreSQL + Auth + Storage + Realtime)
**Integraciones:** Twitch Helix + Embed · YouTube Data API v3 · Instagram Graph · TikTok Display + oEmbed
**Deploy:** Vercel

---

## 🚀 Instalación local

```bash
git clone https://github.com/edwin390/upmina-web.git
cd upmina-web
npm install
# Crea .env.local a partir de .env.example y completa tus credenciales
npm run dev:local
```

Abre http://localhost:3000 en el navegador. El comando `dev:local` usa Vercel para
servir la aplicación y las funciones `/api` juntas. Para trabajar solo con Vite usa
`npm run dev`.

Para que las APIs funcionen localmente, `.env.local` debe contener valores reales
para `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` y `TWITCH_CHANNEL`. Si están definidas en
el entorno Development de Vercel, `vercel env pull .env.local` las descarga; las variables
marcadas como *Sensitive* no se descargan y deben completarse manualmente en `.env.local`.

---

## 🔐 Variables de entorno

Crea un archivo `.env` en la raíz del proyecto con las siguientes variables:

```env
# Twitch
TWITCH_CLIENT_ID=tu_client_id
TWITCH_CLIENT_SECRET=tu_client_secret
TWITCH_CHANNEL=upminaa

# YouTube
YOUTUBE_API_KEY=tu_api_key
YOUTUBE_CHANNEL_ID=tu_channel_id

# Instagram
INSTAGRAM_ACCESS_TOKEN=tu_token_larga_duracion
INSTAGRAM_USER_ID=tu_ig_user_id

# TikTok
TIKTOK_CLIENT_KEY=tu_client_key
TIKTOK_CLIENT_SECRET=tu_client_secret
TIKTOK_ACCESS_TOKEN=tu_access_token

# Supabase
VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=tu_anon_key
SUPABASE_SERVICE_ROLE_KEY=tu_service_role_key

# App: true fuerza datos mock en Twitch/YouTube/Instagram/TikTok sin llamar a sus APIs reales
VITE_DEMO_MODE=false
```

⚠️ Nunca subas el archivo `.env` al repositorio.

---

## 📁 Estructura del proyecto

```
upmina-web/
├── api/                          # Vercel Functions (backend serverless)
│   ├── twitch-status.ts
│   ├── twitch-clips.ts
│   ├── youtube-latest.ts
│   ├── youtube-videos.ts
│   ├── instagram-feed.ts
│   └── tiktok-videos.ts
├── public/
│   ├── fonts/
│   └── images/
├── src/
│   ├── components/
│   │   ├── ui/
│   │   ├── layout/
│   │   ├── twitch/
│   │   ├── youtube/
│   │   ├── instagram/
│   │   ├── tiktok/
│   │   └── community/
│   ├── hooks/
│   ├── lib/
│   ├── pages/
│   ├── styles/
│   └── types/
├── docs/
├── .env.example
├── .gitignore
├── package.json
├── tailwind.config.js
├── tsconfig.json
└── vite.config.ts
```

---

## 🗺️ Roadmap

Consulta `docs/ROADMAP.md` para el plan completo.

| Fase | Descripción |
|---|---|
| 0 | Fundaciones (Vite, React, Tailwind, HeroUI) |
| 1 | Integración Twitch |
| 2 | Integración Instagram |
| 3 | Integración YouTube (hero + grid) |
| 4 | Integración TikTok |
| 5 | Comunidad de edits (Supabase) |
| 6 | Panel de moderación |
| 7 | Pulido y lanzamiento |

---

## 🤝 Contribuir

Consulta `docs/CONTRIBUTING.md`.

---

## ⚖️ Aviso legal

Este es un proyecto no oficial creado por fans. No está afiliado,
patrocinado ni respaldado por UPMINA ni por su management. Consulta
`docs/LEGAL.md` para más detalle.

---

## 📄 Licencia

MIT License. Consulta `LICENSE`.

---

## 👤 Autor

Proyecto desarrollado por Edwin Santiago Ramos Andrade.
Contacto: er179822@gmail.com
