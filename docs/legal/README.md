# Base legal de UPMINA Web — Fases 1 y 2B (borradores locales, nada publicado)

Rama de trabajo: `legal/phase1` (sobre `main` publicado + el commit legal previo). **No se ha hecho push, despliegue, migración ni cambio en Production/DEV.**

## Documentos (ES referencia · EN · DE)
| Documento | ES | EN | DE | Estado |
|---|---|---|---|---|
| Términos y condiciones | `TERMINOS-Y-CONDICIONES.borrador.md` v0.3 | `en/TERMS-AND-CONDITIONS.draft.md` | `de/NUTZUNGSBEDINGUNGEN.entwurf.md` | Borrador · revisión jurídica pendiente |
| Aviso de privacidad | `AVISO-DE-PRIVACIDAD.borrador.md` v0.3 | `en/PRIVACY-NOTICE.draft.md` | `de/DATENSCHUTZERKLAERUNG.entwurf.md` | Borrador · revisión jurídica pendiente |
| Normas de comunidad | `NORMAS-DE-COMMUNITY.borrador.md` v0.3 | `en/COMMUNITY-RULES.draft.md` | `de/COMMUNITY-REGELN.entwurf.md` | Borrador · coincide con el sistema real |
| Aviso legal | `AVISO-LEGAL.borrador.md` v0.2 | `en/LEGAL-NOTICE.draft.md` | `de/RECHTLICHER-HINWEIS.entwurf.md` | Borrador · faltan datos del responsable |
| Reclamaciones de derechos de autor | `RECLAMACIONES-DE-DERECHOS-DE-AUTOR.borrador.md` v0.2 | `en/COPYRIGHT-CLAIMS.draft.md` | `de/URHEBERRECHTSANSPRUECHE.entwurf.md` | Borrador · describe el flujo real |
| Menores (evaluación) | `MENORES-EVALUACION.md` | — | — | Propuesta, no implementada |
| Datos que debe aportar el propietario | `DATOS-PENDIENTES.md` | — | — | Lista de decisiones |
| Licencia y footer | `REVISION-LICENCIA-Y-FOOTER.md` | — | — | Hallazgos |

Las traducciones EN/DE son de trabajo y requieren revisión profesional (no se verificó equivalencia jurídica; en DE se evitó «Impressum» a propósito). Las secciones de UI (footer) sí están en el sistema i18n (`common.json` ES/EN/DE).

## Estado de implementación
| Elemento | Estado |
|---|---|
| Footer corregido (enlace roto, copyright aclarado, sin MIT, ES/EN/DE) | **Preparado localmente**, no publicado |
| Rutas `/community-rules` y `/legal` | **Preparadas** (placeholders) y desactivadas: `VITE_LEGAL_DOCS_ENABLED` (y `VITE_SIGNUP_LEGAL_CONSENT` para reglas) |
| Casillas de aceptación + «Aceptar todo» | Implementadas (commit previo), **desactivadas** (`VITE_SIGNUP_LEGAL_CONSENT`) |
| Registro de aceptación (`20261118120000_legal_acceptances.sql`) | Escrita, **no aplicada** |
| Declaración de edad ≥ 13 | **No implementada** (propuesta en `MENORES-EVALUACION.md`) |
| Publicación de `/terms` y `/privacy` nuevas | **No realizada** (siguen las antiguas, en inglés) |

## Contrato de consentimiento (revisado, sin cambios)
Cliente: envía `options.data.legal_acceptance = {terms, privacy, community_rules → versión}` solo si el flag está activo. BD: trigger `AFTER INSERT` en `auth.users` valida contra `legal_document_versions` (vacía) y registra en `legal_acceptances` (sin IP); `legal_settings.enforce_signup=false` por defecto, nunca bloquea mientras esté apagado.
Dependencias pendientes: (1) las versiones del cliente (`v0.1`) deben igualarse a la versión aprobada de cada documento; (2) `AdminSignupPage` no envía aceptaciones (hay que añadirlo antes de activar el bloqueo); (3) un documento de edad/menores, si se decide; (4) decidir si la evidencia se conserva tras eliminar la cuenta (sin FK por diseño); (5) mecanismo de re-aceptación al publicar versiones nuevas (no implementado; no bloquear a usuarios existentes ni el ejercicio de derechos).

## Fase 2B — decisiones del propietario incorporadas (solo documentación)
- Responsable: persona física establecida en México; contacto legal/privacidad **upminaaweb@gmail.com**; identidad legal y domicilio/medio de notificaciones: **pendientes** de revisión jurídica (no se publica domicilio particular).
- Código **privado**, sin licencia MIT ni de libre reutilización; el archivo `LICENSE` se resolvió en la Fase 4 (aviso de software propietario).
- Contenido apto para todos los públicos; publicaciones y perfiles **públicos**, sin perfiles privados ni etiquetas de edad.
- Menores: edad mínima 13; 13–17 según la jurisdicción y autorización parental cuando corresponda; **no se afirma** verificación de edad ni de autorizaciones (no implementadas).
- Conservación: **sin plazos definidos ni purgas automáticas**; los textos describen el estado real (`CONSERVACION-Y-RESPALDOS.md`). Plazos `[PENDIENTE: revisión jurídica]`.
- Eliminación: asíncrona; si falla, la cuenta permanece bloqueada y puede requerir **reintento manual** (Developer). **No se promete ni se implementará** reintento automático (`account-deletion-tick` sin activar).
- Respaldos: **no se adopta ninguna política** (rotación, cifrado, destrucción); los textos solo dicen que pueden existir copias propias y de proveedores.
- Versiones: Términos, Privacidad y Normas v0.3; Aviso legal y Reclamaciones v0.2. Las versiones del cliente de consentimiento (`legal-consent.ts`, `v0.1`) siguen sin igualarse (pendiente al aprobar).
- Community, código, migraciones y sistemas **no modificados** en esta fase.

## Fase 4 — licencia y coherencia (solo documentación)
- `LICENSE`: aviso de software propietario / derechos reservados (sin titular legal inventado). `README.md` raíz y `docs/LEGAL.md` alineados (sin MIT, sin «72 horas»).
- Términos ES/EN/DE: licencia limitada de publicaciones (§6, pendiente de revisión profesional), código propietario (§7) y ley aplicable de México sin excluir derechos imperativos (§11, jurisdicción pendiente).
- Strikes: redacción documental corregida (cuenta activa: historial para la escalada; tras eliminar: hasta 12 meses propuestos, sin purga automática implementada). Sin cambios en Community.
