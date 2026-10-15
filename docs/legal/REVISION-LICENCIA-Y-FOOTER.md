# Revisión de licencia MIT y estado del footer

## Licencia
- `LICENSE` (raíz): texto estándar de **MIT**, `Copyright (c) 2026 [Tu Nombre]`. El marcador **no está completado**; solo existe desde el «Initial commit» (2026-09-17) y `package.json` no declara campo `license`.
- `docs/LEGAL.md` afirma «licencia MIT» para el código pero también contenidos no alineados con el sistema actual (retiro en 72 h por correo).
- Conclusión: **la licencia MIT no está acreditada** (no hay titular identificado ni decisión del propietario). Un `LICENSE` con marcador no equivale a una licencia válida de una persona concreta. El footer no debe afirmarla. **No se elimina ni modifica `LICENSE`** (requiere decisión del titular). Pendiente: decidir si licenciar el código, bajo qué términos y a nombre de quién; si no, el código es «todos los derechos reservados» por defecto.
- MIT **no** aplica al contenido mostrado (UPMINA, plataformas, usuarios).

## Footer (cambios locales, no desplegados)
| Problema | Causa | Corrección |
|---|---|---|
| «Aviso legal» devolvía al inicio | `<a href="/docs/LEGAL.md">` apuntaba a un archivo que no se sirve; el SPA reescribe cualquier ruta desconocida a la home | Enlace eliminado; nuevo enlace `/legal` (ruta preparada) que solo aparece con `VITE_LEGAL_DOCS_ENABLED=true` |
| «Copyright» ambiguo | Etiqueta genérica | «Reclamar derechos de autor / Report copyright infringement / Urheberrechtsverletzung melden» + `title` que aclara que es solo para titulares y que los reportes de publicaciones van en el menú de la publicación |
| «Distribuido bajo licencia MIT» | Afirmación no acreditada | Retirada |

Estructura aprobada (con la bandera activada): UPMINAA · redes · Términos · Privacidad · Reglas de comunidad · Reclamar derechos de autor · Aviso legal · aviso de independencia · © año · «Hecho con ♥ por fans». Con la bandera apagada (por defecto) no se enlazan las Reglas ni el Aviso legal (aún borradores) y el aviso de independencia no menciona «aviso legal».
Textos ES/EN/DE en `src/i18n/locales/*/common.json` (`footer`), mismo sistema i18n; el componente se carga de forma perezosa (`FooterLegal.tsx`).

## Pendiente para activar
Aprobar los documentos, publicar `/community-rules` y `/legal` con su contenido, activar `VITE_LEGAL_DOCS_ENABLED`, y actualizar `/terms` y `/privacy` (hoy en inglés, versión anterior).

## Actualización Fase 2B — decisión del propietario
El código **permanece privado**; **no se ofrece licencia MIT** ni de libre reutilización. Los documentos legales lo reflejan (Aviso legal §3) y no afirman ninguna licencia de uso libre. El archivo `LICENSE` (texto MIT con marcador sin completar) **no se modificó ni se eliminó** en esta fase: queda **pendiente su resolución formal** (decisión del titular; p. ej. sustituirlo por un aviso de «todos los derechos reservados» o retirarlo).

## Actualización Fase 4 — resolución
- **Decisión definitiva:** UPMINA Web es **software propietario y privado**; sin licencia MIT ni de libre reutilización. La licencia limitada que conceden los usuarios sobre sus publicaciones es otra cosa (Términos §6).
- **`LICENSE`** sustituido por un aviso breve de derechos reservados, sin titular legal inventado y sin afectar a dependencias ni a contenido de terceros. Sustituir el archivo **no elimina retroactivamente** permisos que pudieran haberse concedido válidamente bajo la licencia anterior (cuestión para revisión jurídica). El repositorio es privado y no consta que se haya distribuido a terceros `[PENDIENTE: confirmar]`.
- **`README.md`** (raíz): su sección «Licencia» decía MIT; corregida. **`docs/LEGAL.md`**: reescrito como documento informativo interno (sin MIT ni «retirada en 72 horas»), no aprobado ni publicado.
- **Footer:** sin referencias a MIT ni enlaces legales incorrectos en la rama legal (no se modificó en esta fase). **El sitio publicado hoy (Production) conserva el footer antiguo** hasta que se publique la rama.
