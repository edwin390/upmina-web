# Cierre del desarrollo activo (2026-10-18)

Motivo técnico: pausa indefinida del desarrollo activo. El proyecto se preserva íntegro y recuperable; no se elimina.

## Estado final

- Rama de cierre: `legal/phase1` (12 commits por delante de `origin/main`, 44 por delante de `main` local). Commit de código previo
  al cierre: `7f31941`. El commit final de documentación se registra al pie de este archivo.
- Ramas locales a preservar: `main` (`dbb06aa`), `legal/phase1`, `archive/main-worktree-wip-2026-10-18` (instantánea de los cambios
  **sin commit** de `C:/Dev/upmina-web`: MFA recovery, password recovery, módulo de secretos/Easter eggs, etc.), y las ramas
  `feat/community-copyright-integration`, `feat/social-oauth-hardening`, `fix/social-disconnect-cache`, `integration/community-main`,
  `release/r0-privacy-correction`, `release/social-oauth-moderation`.
- Ubicaciones locales: `C:/Dev/upmina-web` (worktree principal, contiene `.git`, en `main` con 110 cambios sin commit) y
  `C:/Dev/upmina-web-r5f` (worktree enlazado, `legal/phase1`). Además un worktree temporal de la sesión de `release/r0-privacy-correction`.
- **Respaldo remoto: PENDIENTE.** No se hizo push. Motivo: el proyecto Vercel `upmina-web` está enlazado al repositorio y no fue posible
  demostrar que un push no desencadene despliegues (ver `DEPLOYMENT_AND_RECOVERY.md` §8). Método de verificación una vez publicado:
  `git ls-remote origin` y comparar hashes con `git rev-parse` de cada rama.
- **Consolidación en una sola carpeta: PENDIENTE de autorización.** `C:/Dev/upmina-web` es el worktree principal; `r5f` es un
  worktree enlazado. Plan: (1) publicar/respaldar ramas; (2) en `C:/Dev/upmina-web`, con los cambios ya preservados en la rama de
  archivo, `git switch legal/phase1` (requiere resolver los 110 cambios locales: no se debe cambiar HEAD con cambios sin guardar);
  (3) `git worktree remove C:/Dev/upmina-web-r5f` solo tras comprobar que no contiene archivos únicos (hoy solo `.env.example`
  modificado, ignorados regenerables). Reversión: `git worktree add` de la rama y recuperar desde la rama de archivo.

## Qué quedó sin desplegar

Todo lo posterior a los despliegues de Production: modo restringido, captura shadow/interruptor, Worker restringido, correcciones
de Community recientes. Production no recibió ningún cambio en este cierre.

## No modificar sin nueva autorización

Production (Supabase `dmtuvzfdaectvqczwfhx`, Worker `upmina-media-delivery-prod`, `upminaa-web.com`), migraciones ya aplicadas, el
sistema de invitación ADMIN, `SUPABASE_SERVICE_ROLE_KEY`, la activación de IA/OpenAI.

## Pasos para retomar

1. Recuperar el repositorio y las ramas (ver `DEPLOYMENT_AND_RECOVERY.md`); restaurar secretos desde el respaldo privado.
2. Leer `PROJECT_STATUS.md` y `MINA_RESTRICTED_MODE.md`.
3. Revisar la rama `archive/main-worktree-wip-2026-10-18` (trabajo sin revisar) y decidir qué incorporar.
4. Completar las comprobaciones A, B y C con una sesión developer/admin con MFA.
5. Decidir el despliegue a Production (migraciones, Worker, variables) con revisión previa.

## Limitaciones del respaldo

Git no incluye archivos ignorados, secretos, datos de Supabase ni objetos de R2. Ver la lista en `DEPLOYMENT_AND_RECOVERY.md` §1.

## Referencias archivadas

El commit definitivo del cierre se identifica con la etiqueta anotada `archive-2026-10-18` (evita un hash autorreferencial):
`git rev-parse archive-2026-10-18^{commit}`. La rama `archive/upmina-web-2026-10-18` apunta al mismo commit. Referencias fijas:

- Código previo al cierre documental: `7f31941`.
- `archive/main-worktree-wip-2026-10-18`: `e03eb75547e308661ebd43189255e5ce8a8aa0ed` (cambios sin commit de `C:/Dev/upmina-web`).
- `main`: `dbb06aa1ae1e380f19fd4114fa60e76c6fb98a36`.
- Respaldo remoto previsto: repositorio privado `upmina-web-archive` (remoto `archive-backup`), sin integración con Vercel. Estado:
  pendiente de crear por el propietario.
