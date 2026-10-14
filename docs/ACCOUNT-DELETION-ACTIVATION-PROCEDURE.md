# Activación de `account-deletion-tick` en Production — procedimiento (NO ejecutado)

Estado al 2026-10-14: **NO activado.** Condición pendiente: revisión jurídica de privacidad/retención y autorización expresa de la persona responsable.

## 0. Prerrequisitos de Production (verificados el 2026-10-14, solo lectura)
- Proyecto Supabase `dmtuvzfdaectvqczwfhx`; Vercel `upmina-web`; código con el ejecutor desplegado (`POST /api/admin/account-deletion-run` sin firma → 401, otros métodos → 405).
- `account_deletion_tick()` existe; Vault contiene `account_deletion_shared_secret` y `account_deletion_endpoint_url` (https://upminaa-web.com/api/admin/account-deletion-run; la función exige ese patrón exacto).
- Cron: solo `community-media-purge-tick`. 0 solicitudes de eliminación, 0 bloqueos. Con backlog 0 el tick no llama al endpoint.
- Supervisión y reintentos de fallos: panel Developer (`DeveloperAccountDeletionsSection`); el sistema nunca restaura acceso a cuentas bloqueadas.

## 1. Comprobaciones inmediatamente antes de activar (SQL Editor de Production, solo lectura)
```sql
select current_database(), (select count(*) from cron.job where jobname = 'account-deletion-tick') as ya_existe;   -- ya_existe debe ser 0
select status, count(*) from public.account_deletion_requests group by 1;                                         -- esperado: vacío (o conocido)
select public.account_deletion_backlog();                                                                         -- esperado: 0
select name from vault.secrets where name like 'account_deletion%' order by 1;                                    -- 2 filas
```
Si hay solicitudes o backlog inesperados: NO activar e investigar.

## 2. Activación (solo tras autorización expresa)
```sql
select cron.schedule('account-deletion-tick', '* * * * *', $$select public.account_deletion_tick();$$);
```
`cron.schedule(nombre, …)` es upsert por nombre: repetirlo no crea duplicados.

## 3. Verificación posterior
```sql
select jobname, schedule, active from cron.job where jobname in ('account-deletion-tick','community-media-purge-tick');
select status, start_time from cron.job_run_details d join cron.job j using (jobid) where j.jobname = 'account-deletion-tick' order by start_time desc limit 5;  -- succeeded
select public.account_deletion_tick();                                                                              -- {"status":"idle",...} con backlog 0
```
Sin datos reales: el resultado esperado es `idle`. No procesar cuentas manualmente.

## 4. Desactivación / reversión
```sql
select cron.unschedule('account-deletion-tick');
```

## 5. Discrepancia en el historial de migraciones (documentada, NO corregida)
La migración `developer_mfa_cleanup_retry` se aplicó en Production con el MCP y quedó registrada como versión `20261014213056`; el archivo del repositorio es `20261117120000_developer_mfa_cleanup_retry.sql`. Efecto: el siguiente `supabase db push` vería `20261117120000` como pendiente y fallaría con «function already exists» (la función ya existe).
Solución segura (cuando se autorice; antes de cualquier `db push`):
1. `supabase migration repair --status reverted 20261014213056` y `supabase migration repair --status applied 20261117120000`, con el directorio de trabajo aislado apuntando al `project-ref` de Production (como en el runbook §3). Equivale a actualizar la fila en `supabase_migrations.schema_migrations`.
2. Comprobar con `supabase migration list` que ambas columnas (local/remoto) coinciden.
No es urgente: no afecta al funcionamiento de la aplicación.

## 6. Pendientes jurídicos (bloquean la activación)
Plazos de conservación de reportes, casos, strikes, reclamaciones, auditoría y registro de eliminación (hoy `pending_legal_review`); texto del Aviso de Privacidad; anonimización del contacto de apelaciones de Copyright. Ver `docs/legal/AVISO-DE-PRIVACIDAD.borrador.md`.
