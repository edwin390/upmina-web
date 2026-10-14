-- Rollback de 20261114120000_account_deletion_runtime.sql (solo local/operador). Si se programó el job, quitarlo antes:
--   select cron.unschedule('account-deletion-tick');
drop function public.account_deletion_tick();
drop function public.account_deletion_backlog();
drop function public.account_deletion_revoke_sessions(uuid, text);
