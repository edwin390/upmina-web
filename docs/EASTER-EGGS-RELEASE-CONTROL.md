# Easter Eggs — control de release

Estado a 2026-10-18.

## Antiguos (RETIRADOS de la línea de release)

| Easter egg       | Activador                                         | Dónde estaba                                                                                          |
| ---------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Echidna          | Código Konami (↑↑↓↓←→←→ B A)                      | `src/App.tsx` (listener `keydown` + overlay) y `public/images/echidna.gif`                            |
| Modo Sukuna      | Doble clic en el logo UPMINAA                     | `Header.tsx` (`onLogoDoubleClick`), `App.tsx`, estilos `.sukuna-*` en `globals.css`, `title` del logo |
| Estrella de Mina | Clic en la estrella flotante que aparecía al azar | `AmbientBackground.tsx` (botón + cooldown), `App.tsx`, `.ambient-star`/`star-pop` en `globals.css`    |

Se eliminaron también las claves `site.header.surprise` y `site.header.logoTitle` (ES/EN/DE), que solo servían a esos activadores. No hay
estado persistente de ninguno de ellos (todo era memoria de la pestaña): no queda nada que reactivar desde `localStorage` ni rutas.
`src/easter-eggs-release-guard.test.ts` falla si alguno reaparece.

## Nuevos (sistema `src/secrets`) — NO están en esta rama

El módulo nuevo (67 archivos en `src/secrets`, documentos `docs/9N-EASTER-EGGS*.md`, integración en `App.tsx` con `SecretsProvider` y
`SecretsOverlay`) **no se confirmó nunca en `main` ni en esta rama**: solo existe en el snapshot
`archive/main-worktree-wip-2026-10-18` (commit `e03eb75`, base `dbb06aa`, anterior a la consolidación legal/i18n/eliminación de cuentas).
Por tanto, publicar esta rama **no puede** exponer ni activar los Easter Eggs nuevos: su código no está en el árbol ni en el bundle (se
comprobó con el build de producción).

### Cómo se reanuda

- Rama local `feat/easter-eggs` (apunta a `e03eb75`). Ese commit está respaldado en el remoto privado `archive-backup` (rama `archive/main-worktree-wip-2026-10-18`); la rama `feat/easter-eggs` en sí es solo local.
- No fusionar `feat/easter-eggs` a la rama de release tal cual: su `App.tsx`/`Header`/`globals.css` parten de una base antigua y revertirían
  cambios posteriores. Portar el módulo por partes sobre la línea actual.
- Memoria del proyecto: `project-secrets-module` y `original-easter-egg-spec` (reglas de trabajo y especificación original).

### Regla para volver a publicarlos

1. Puerta de **compilación**, no de CSS ni solo de variable de runtime: importar el módulo únicamente detrás de una constante que Vite
   sustituya en build (p. ej. `import.meta.env.VITE_SECRETS_ENABLED === "true"` con `import()` dinámico), de modo que, desactivado, el código no
   entre en el bundle. Una variable de entorno de runtime por sí sola **no** elimina código.
2. Desactivado por defecto; sin endpoints propios sin autorización server-side; sin recompensas desbloqueables mientras esté apagado.
3. Actualizar `easter-eggs-release-guard.test.ts` en el mismo cambio, de forma explícita.
