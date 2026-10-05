-- R4-A-FIX: retain reads and controlled postgres-owned SECURITY DEFINER writes only.
-- No data changes, RLS changes, helper creation, backfill or RPC EXECUTE changes.
revoke insert, update, delete, truncate, references, trigger
  on table public.community_posts, public.community_post_media
  from public, anon, authenticated, service_role;

-- Table-level REVOKE does not remove independent column grants. Close those too,
-- using only trusted catalog identifiers for the two explicitly scoped tables.
do $$
declare r record;
begin
  for r in
    select c.relname, pg_catalog.string_agg(pg_catalog.quote_ident(a.attname), ',' order by a.attnum) as columns
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'public' and c.relname in ('community_posts','community_post_media')
      and a.attnum > 0 and not a.attisdropped
    group by c.relname
  loop
    execute pg_catalog.format('revoke insert(%s), update(%s), references(%s) on table public.%I from public, anon, authenticated, service_role',
      r.columns, r.columns, r.columns, r.relname);
  end loop;
end;
$$;
