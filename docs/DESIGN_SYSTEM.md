# Sistema de Diseño — UPMINA Web

Documento que define los tokens visuales y las reglas de diseño para mantener
coherencia estética con la marca UPMINA.

---

## 🎨 Paleta de colores

Fuente de verdad: variables CSS `--c-*` (canales RGB) en `src/styles/globals.css`, expuestas como colores de Tailwind en
`tailwind.config.js` (`rgb(var(--c-…) / <alpha-value>)`). La identidad actual es **azul y rosa sobre azul noche**; la anterior
(fucsia `#ff2d95` + cian `#00f0ff` sobre `#0a0a0a`) **está retirada** y no debe reutilizarse.

### Tema oscuro (por defecto, `:root`)
| Token | Canales RGB | Valor | Uso |
|---|---|---|---|
| `bg-base` | `11 13 19` | `#0b0d13` | Fondo principal (también `theme-color` en `index.html`) |
| `bg-surface` | `23 31 48` | `#171f30` | Tarjetas, secciones |
| `bg-elevated` | `33 44 66` | `#212c42` | Modales, menús |
| `border-subtle` / `border-strong` | `40 52 76` / `58 72 102` | `#28344c` / `#3a4866` | Bordes |
| `accent-primary` | `116 184 244` | `#74b8f4` | Azul de acento (CTA, enlaces) |
| `accent-secondary` | `168 212 250` | `#a8d4fa` | Azul claro (resaltes) |
| `accent-pink` | `255 77 166` | `#ff4da6` | Rosa de acento |
| `accent-live` | `255 0 51` | `#ff0033` | Estado EN VIVO / error |
| `accent-success` | `0 255 136` | `#00ff88` | Confirmaciones |
| `accent-warning` | `255 184 0` | `#ffb800` | Advertencias |
| `text-primary` / `secondary` / `muted` | `231 240 252` / `169 184 206` / `124 140 166` | `#e7f0fc` / `#a9b8ce` / `#7c8ca6` | Texto |
| `text-inverse` | `11 13 19` | `#0b0d13` | Texto sobre acentos claros |

### Tema claro (`:root[data-theme="light"]`)
Fondo `234 242 252`, superficie `248 251 255`, elevado `221 233 247`; acento primario `79 115 159`, secundario `56 94 143`,
rosa `190 70 135`, live `207 0 41`, éxito `11 133 80`, aviso `150 98 0`; texto `37 59 86` / `66 92 123` / `84 108 138`;
`text-inverse` blanco. Los acentos del tema claro son más oscuros para mantener el contraste. El tema se alterna con el
atributo `data-theme` (ver `src/theme/theme.ts`); los corazones decorativos tienen variante oscura y clara
(`public/images/hearts-*.svg`).

## 🔤 Tipografía

### Familias
- **Display / Títulos**: `Bebas Neue` (mayúsculas, condensada, contundente)
- **Body / UI**: `Inter` (legible, moderna, amplia gama de pesos)
- **Monoespaciada**: `JetBrains Mono` (para código o datos técnicos)

### Escala
| Token | Tamaño | Uso |
|---|---|---|
| `text-xs` | 0.75rem | Labels, badges |
| `text-sm` | 0.875rem | Texto secundario |
| `text-base` | 1rem | Cuerpo de texto |
| `text-lg` | 1.125rem | Subtítulos |
| `text-xl` | 1.25rem | Títulos de tarjetas |
| `text-3xl` | 1.875rem | Títulos de sección |
| `text-5xl` | 3rem | Hero |
| `text-7xl` | 4.5rem | Nombre "UPMINA" |

---

## 📐 Espaciados

Base de 4px. Escala de Tailwind estándar:

`0, 1 (4px), 2 (8px), 3 (12px), 4 (16px), 6 (24px), 8 (32px), 12 (48px), 16 (64px)`

---

## 🔘 Bordes y radios

| Token | Valor | Uso |
|---|---|---|
| `rounded-sm` | 4px | Badges pequeños |
| `rounded-md` | 8px | Botones, inputs |
| `rounded-lg` | 12px | Tarjetas |
| `rounded-xl` | 16px | Modales |
| `rounded-full` | 9999px | Avatares, pills |

---

## 🌟 Efectos visuales

- **Glow**: sombras `shadow-glow-primary` (azul) y `shadow-glow-secondary` (rosa) con opacidad `--glow-alpha` (0.5 oscuro, 0.22 claro).
- **Gradientes y fondo ambiental**: variables `--amb-*` (azules) y rejilla `--amb-grid`; respetan `prefers-reduced-motion`.
- **Ruido sutil**: textura de grano al 3% de opacidad en fondos.
- **Backdrop blur**: `backdrop-blur-md` en headers sticky y modales.

---

## 🧩 Componentes base (HeroUI)

| Componente | Uso |
|---|---|
| `Button` | CTA, acciones |
| `Card` | Contenedores de contenido |
| `Modal` | Diálogos, previews |
| `Input` / `Textarea` | Formularios |
| `Avatar` | Perfiles de usuario |
| `Badge` | Estados (LIVE, pending) |
| `Tabs` | Navegación dentro de secciones |
| `Tooltip` | Información contextual |

### Botones secundarios de cancelación

Regla contextual: **compactos por defecto, centrados solo si la composición lo justifica**.

1. Son compactos: ancho proporcional al contenido (`inline-flex`/`px-4`), nunca estirados por accidente.
2. Un `flex-col` sin `items-*` estira a sus hijos: en ese caso se fija la alineación del botón (`self-start` o `self-center`).
3. Se centran (`self-center`) únicamente en formularios pequeños cuya acción principal ocupa todo el ancho (p. ej. `ResetPasswordPage`).
4. En modales, diálogos y paneles ADMIN/DEVELOPER van en el grupo de acciones (`flex flex-wrap gap-2|3`), junto a la acción principal; si están solos en un contenedor alineado a la izquierda (p. ej. `CosplayInlineMfa`) usan `self-start`.
5. Ancho completo (`w-full`) solo cuando sea intencional, sobre todo en móvil; no se aplica `self-center` ni `w-full` de forma universal ni con una regla CSS global.
6. Altura táctil de 44 px (`min-h-11`); los controles compactos de 36 px (`min-h-9`) de los diálogos de borrado de Community/Cosplay son una excepción pendiente de revisión.
7. Conservan el estilo secundario (borde `border-subtle`, texto secundario), con hover, `focus-visible` y `disabled` iguales a los de los demás secundarios; nunca adoptan el color de la acción principal ni el de peligro.

---

## 📱 Breakpoints

| Nombre | Ancho mínimo |
|---|---|
| `sm` | 640px |
| `md` | 768px |
| `lg` | 1024px |
| `xl` | 1280px |
| `2xl` | 1536px |

---

## ♿ Accesibilidad

- Contraste mínimo WCAG AA (4.5:1 en texto normal, 3:1 en grande).
- Foco visible en todos los elementos interactivos (outline cian).
- Navegación completa por teclado.
- `aria-label` en todos los iconos sin texto.
- Respeto por `prefers-reduced-motion`.

---

## 🧱 Páginas HTML autónomas (callbacks OAuth)

`src/lib/social-oauth-page.ts` genera HTML sin React ni Tailwind y con una CSP estricta (`default-src 'none'`, solo estilos en
línea y un script fijado por hash). Reglas: variables CSS propias con los mismos valores de los tokens (oscuro por defecto,
claro con `prefers-color-scheme: light`), marca como **texto** `UPMINAA` (sin imágenes ni fuentes remotas, que la CSP bloquearía),
botón primario azul con texto `text-inverse`, rosa para foco y hover, y estados semánticos (éxito/error/aviso) con los tokens
`accent-success`, `accent-live` y `accent-warning`. No cambiar la CSP para añadir recursos externos sin una decisión de seguridad.

## ✉️ Correos electrónicos

Solo código en el repositorio: `src/lib/mfa-recovery-mail.ts` (vía Resend). Reglas: tablas (`role="presentation"`) y CSS en línea,
sin JavaScript, sin CSS externo, sin imágenes remotas (cabecera de texto `UPMINAA WEB`), colores del **tema oscuro** de arriba
(`#0b0d13` fondo, `#171f30` tarjeta, `#74b8f4` acento), enlaces con botón (igual que el botón primario de la web: azul `#74b8f4`; hover y foco `#a8d4fa`, nunca rosa) y dirección visible como alternativa, ancho máximo 560 px,
texto plano siempre presente y HTML solo ASCII. Los correos de Supabase Auth se gestionan en el panel de Supabase y aún no se han revisado ni adaptado a esta identidad.

## ♿ Compatibilidad y responsive

Diseño móvil primero; breakpoints de Tailwind más `short` (`max-height: 520px`, móvil apaisado). Contraste: el texto primario y los
acentos se han elegido para AA sobre sus fondos en ambos temas; no usar `text-muted` para información esencial. Respetar
`prefers-reduced-motion`.

---

## 🎬 Componentes específicos: YouTube

### `<HeroVideo>`
- Contenedor con aspecto 16:9 y ancho completo de su sección.
- Sombra externa con `accent-primary` al 30% para destacar.
- Overlay inferior con gradiente `linear-gradient(to top, rgba(0,0,0,0.9), transparent)`.
- Título en `text-2xl` (desktop) / `text-lg` (móvil), con `font-display`.
- Metadatos en `text-sm` y `text-secondary`: fecha relativa + duración.
- Botón "Ver en YouTube" con icono, en `text-muted` al hover.

### `<VideoCard>`
- Aspecto 16:9 para la miniatura.
- Radio `rounded-lg`.
- Borde de `2px` transparente por defecto.
- Al hover: borde `accent-secondary` y ligera elevación (`translateY(-2px)`).
- Cuando está seleccionado: borde `accent-primary` + badge "Reproduciendo".
- Duración superpuesta en la esquina inferior derecha con fondo negro
  semitransparente y texto blanco.
- Título limitado a 2 líneas con `line-clamp-2`.

### `<VideoGrid>`
- 4 columnas en `lg`, 3 en `md`, 2 en `sm`, 1 en móvil.
- Gap de `gap-4`.
- Scroll infinito o paginación en fase futura.
