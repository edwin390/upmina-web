# R5-S1 · Plan de activación controlada en DEV Testing (NO EJECUTADO)

Solo `rkqeqbqwdswhpzwqptac`. Nunca Production. Cada paso remoto necesita autorización expresa.

**Antes de empezar.** Hay que saber que, en cuanto el barrido marca un asset como `deleting`, el cron
de GC existente (cada 5 min) lo borra de R2 y de la BD. **Marcar = borrar. No hay deshacer.**
Estado remoto verificado: DEV tiene aplicadas las migraciones hasta `20261022`. Faltan `20261023`,
`20261024` y `20261025` (strikes / account authority): independientes del SQL de esta fase, pero
requeridas por el backend actual del repositorio.

## 1. Aplicar migraciones (solo DEV) · orden exacto
Orden: `20261023` → `20261024` → `20261025` → `20261026`. `20261026` no depende de las otras tres, pero el
backend del repositorio SÍ necesita `20261023` (`community_author_restriction`) y `20261025`
(`community_account_state`); por eso se aplican todas antes de desplegar.

Usar la CLI de Supabase (el historial remoto usa las versiones exactas de los archivos; el MCP
`apply_migration` estamparía versiones nuevas y desalinearía el historial):
```bash
cat supabase/.temp/linked-project.json              # debe mostrar ref rkqeqbqwdswhpzwqptac (upmina-9g-test)
npx supabase@2.120.0 migration list --linked        # remoto termina en 20261022120000
npx supabase@2.120.0 db push --linked --dry-run     # debe listar EXACTAMENTE esas 4 migraciones, ninguna más
npx supabase@2.120.0 db push --linked               # solo tras revisar la salida anterior
```
La CLI pide la contraseña de la base: la introduce la persona operadora, nunca el chat.

### PARADA 1 (tras aplicar y comprobar la sección 2)
No desplegar ni barrer hasta revisar el resultado de las comprobaciones.

## 2. Comprobar permisos y funciones (SELECT)
```sql
select p.proname, p.prosecdef, pg_get_userbyid(p.proowner) owner, p.proconfig, p.proacl
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in
 ('community_media_asset_discard','media_abandoned_sweep','media_assets_touch_activity','community_asset_gc_objects');
-- esperado: owner postgres, security definer en las 3 RPC, search_path fijado, ACL solo service_role
select has_function_privilege('anon',
  'public.media_abandoned_sweep(interval,interval,interval,integer,boolean)', 'execute');          -- false
select has_function_privilege('authenticated',
  'public.community_media_asset_discard(uuid,uuid)', 'execute');                                   -- false
select tgname, tgenabled from pg_trigger
where tgrelid = 'public.media_assets'::regclass and not tgisinternal;      -- media_assets_touch_activity, O
select jobid, jobname, schedule from cron.job;     -- SIGUE habiendo un único job (community-media-purge-tick)
-- Migraciones 23–25 presentes y datos intactos (sin barrido ni borrados):
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname='public' and p.proname in ('community_account_state','community_author_restriction',
   'community_strike_apply','community_post_set_like_core');                                  -- 4
select (select count(*) from media_assets) assets, (select count(*) from community_posts) posts,
       (select count(*) from media_assets where status='deleting') deleting;                  -- 56+87+6 / 10 / 0
```

### Después de la PARADA 1: desplegar el backend DEV (autorización aparte)

## 3. Prueba real de eliminación voluntaria
Seguir `docs/9K-R5-S1-R2-DELETION-TEST.md` (post sintético, manifiesto previo, borrado por la UI).

## 4. Verificar R2 con HEAD
Quien tenga acceso de lectura a R2 (dashboard o cliente propio con credenciales propias, sin pegarlas
en el chat) comprueba cada clave del manifiesto: 404 = ausente; 403/credenciales/red = BLOCKED, no PASS.

### PARADA 2 (tras HEAD 404 de la prueba real)

## 5. Revisar los assets históricos ANTES de activar nada
Ejecutar `docs/9K-R5-S1-sweep-simulation.sql` (solo SELECT). Simulación del 2026-10-09:
38 assets serían reclamados (32 Community: 27 ready sin publicar, 4 failed, 1 reserved; 6 Cosplay: 5 failed,
1 reserved). Todos exigen revisión manual. Los 78 ready de Cosplay sin publicar quedan fuera por defecto.
No existe forma de «eximir» un asset: lo que se quiera conservar debe publicarse antes, o se pospone el barrido.

### PARADA 3: decisión sobre los 38 assets históricos

## 6. Activación controlada
1. Un barrido manual pequeño: `select media_abandoned_sweep(p_limit => 3);` (SQL editor, operador).
2. Esperar un tick del GC (≤ 5 min) y comprobar: `media_gc_backlog()`, filas desaparecidas,
   HEAD 404 de sus claves canónicas.
3. Si todo es correcto, barrido completo con valores por defecto.
4. **Programarlo es otro bloque** (hoy no hay cron ni endpoint para el barrido): proponer, tras varios
   barridos manuales limpios, una llamada periódica con una migración propia.

## 7. Confirmar que no hay regresiones
- `select * from media_gc_backlog();` → `deleting` 0, `eligibleNow` 0.
- Humo manual: crear, editar, publicar y borrar un post; subir y cancelar una imagen; descartar un ready.
- Posts publicados y sus assets intactos (recuento de `community_post_media` antes/después).
- Suite de tests en verde en CI.
