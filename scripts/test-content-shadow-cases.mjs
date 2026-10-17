// SQL integration cases. Synthetic local fixtures only, never provider responses.
export const helpers = `
create temporary table shadow_test_context(k text primary key, v uuid);
create function pg_temp.ctx(k text) returns uuid language sql as
  $$select v from shadow_test_context where shadow_test_context.k=$1$$;
create function pg_temp.check_ok(ok boolean, label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERT: %',label; end if; end $$;
create function pg_temp.expect_error(q text, expected text) returns void language plpgsql as $$
begin
  begin execute q; exception when others then
    if sqlerrm=expected or sqlstate=expected then return; end if;
    raise exception 'Unexpected test error: % / %',sqlstate,sqlerrm;
  end;
  raise exception 'Expected failure: %',expected;
end $$;
create function pg_temp.new_asset(kind text default 'image', owner_id uuid default '33333333-3333-4333-8333-333333333333')
returns uuid language plpgsql as $$declare a uuid:=gen_random_uuid(); begin
  insert into media_assets(id,domain,status,kind,created_by) values(a,'community','ready',kind,owner_id);
  return a;
end $$;
create function pg_temp.make_post(t text default 'Original', held boolean default false, kind text default 'image')
returns uuid language plpgsql as $$declare r jsonb; a uuid:=pg_temp.new_asset(kind); begin
  if held then r:=community_post_create_held('33333333-3333-4333-8333-333333333333',t,
    jsonb_build_array(jsonb_build_object('asset_id',a,'position',0)));
  else r:=community_post_save_atomic('33333333-3333-4333-8333-333333333333',null,null,t,
    jsonb_build_array(jsonb_build_object('asset_id',a,'position',0)),'{}'); end if;
  return (r->'post'->>'id')::uuid;
end $$;
create function pg_temp.submit_edit(p uuid) returns uuid language plpgsql as $$declare r jsonb; begin
  r:=community_post_pending_edit_submit('33333333-3333-4333-8333-333333333333',p,1,'Propuesta',
    (select jsonb_agg(jsonb_build_object('asset_id',asset_id,'position',position) order by position)
      from community_post_media where post_id=p),'{}');
  return (r->'edit'->>'id')::uuid;
end $$;
create function pg_temp.success_results(j uuid) returns jsonb language sql as $$
  -- Deliberately named fixture values: these are NOT OpenAI evaluations.
  select coalesce(jsonb_agg(c || jsonb_build_object('state','succeeded','model_requested','fixture-model',
    'model_returned','fixture-model','provider_response_id','fixture_response','flagged',false,
    'categories',jsonb_build_object('violence',false),'category_scores',jsonb_build_object('violence',0.1),
    'category_applied_input_types',jsonb_build_object('violence',jsonb_build_array(modality)))), '[]')
  from (select jsonb_build_object('component_kind','text') c,'text' modality
      from community_shadow_jobs where id=j and snapshot_text is not null
    union all select jsonb_build_object('component_kind','image','asset_id',a->>'asset_id'),'image'
      from community_shadow_jobs, jsonb_array_elements(assets) a where id=j and a->>'kind'='image') q
$$;
`;
const flush = 'set constraints all immediate; set constraints all deferred;';
const create = "insert into shadow_test_context values('p',pg_temp.make_post());";
const post = "pg_temp.ctx('p')";
const jobs = `select * from community_shadow_jobs where post_id=${post} and target_kind='post'`;
const claim = `create temporary table claimed on commit drop as select * from community_shadow_claim(10,60);`;
const finish = (state = 'completed') => `select pg_temp.check_ok(community_shadow_finish(id,claim_token,'${state}',
  pg_temp.success_results(id))='finished','finish') from claimed;`;

export const cases = [
  ['audit: reconciliation skips invalid pending candidates before bounding the batch', `
    ${create} ${flush}
    insert into shadow_test_context values('e',pg_temp.submit_edit(${post})); ${flush}
    select community_post_save_atomic('33333333-3333-4333-8333-333333333333',${post},1,'Nueva versión',
      (select jsonb_agg(jsonb_build_object('asset_id',asset_id,'position',position)) from community_post_media where post_id=${post}),'{}'); ${flush}
    update community_post_pending_edits set created_at=clock_timestamp()-interval '1 hour' where id=pg_temp.ctx('e'); ${flush}
    select pg_temp.check_ok(obsolete_reason='version_changed','stale base version is not a closed edit')
      from community_shadow_jobs where edit_id=pg_temp.ctx('e');
    alter table community_shadow_jobs add constraint audit_missing_capture check(false) not valid;
    insert into shadow_test_context values('missing',pg_temp.make_post('Faltante')); ${flush}
    alter table community_shadow_jobs drop constraint audit_missing_capture;
    select pg_temp.check_ok(community_shadow_reconcile(1)=1,'valid missing job must not starve');
    select pg_temp.check_ok(count(*)=1,'missing recovered') from community_shadow_jobs where post_id=pg_temp.ctx('missing');
  `],
  ...['post','account'].map(target => [`audit: cached token after ${target} deletion cannot recreate results`, `
    ${create} ${flush} ${claim}
    ${target === 'post' ? `select community_post_delete('33333333-3333-4333-8333-333333333333',${post},1);`
      : "delete from auth.users where id='33333333-3333-4333-8333-333333333333';"} ${flush}
    select pg_temp.check_ok(community_shadow_finish(id,claim_token,'completed','[]')='not_found','deleted target') from claimed;
    select pg_temp.check_ok(count(*)=0,'no residual jobs or text') from community_shadow_jobs;
    select pg_temp.check_ok(count(*)=0,'no recreated results') from community_shadow_results;
  `]),
  ...['approve','reject','cancel'].map(decision => [`audit: ${decision} pending edit rejects cached token`, `
    ${create} ${flush}
    insert into shadow_test_context values('e',pg_temp.submit_edit(${post})); ${flush} ${claim}
    ${decision === 'cancel' ? `select community_post_pending_edit_cancel('33333333-3333-4333-8333-333333333333',${post});`
      : `select community_content_review_decide('55555555-5555-4555-8555-555555555551','pending_edit',pg_temp.ctx('e'),1,'${decision}');`} ${flush}
    select pg_temp.check_ok(community_shadow_finish(id,claim_token,'completed','[]')='stale_claim','closed edit token')
      from claimed where edit_id=pg_temp.ctx('e');
    select pg_temp.check_ok(version=${decision === 'approve' ? 2 : 1} and text='${decision === 'approve' ? 'Propuesta' : 'Original'}','public decision intact')
      from community_posts where id=${post};
    select pg_temp.check_ok(count(*)=${decision === 'cancel' ? 0 : 1},'human audit count') from moderation_audit_log;
  `]),
  ['audit: historical result remains attached to original edit and becomes obsolete', `
    ${create} ${flush}
    insert into shadow_test_context values('e',pg_temp.submit_edit(${post})); ${flush} ${claim}
    select pg_temp.check_ok(community_shadow_finish(id,claim_token,'completed',pg_temp.success_results(id))='finished','historical finish')
      from claimed where edit_id=pg_temp.ctx('e');
    select community_content_review_decide('55555555-5555-4555-8555-555555555551','pending_edit',pg_temp.ctx('e'),1,'approve'); ${flush}
    select pg_temp.check_ok(state='completed' and obsolete_at is not null and version=1 and base_version=1 and snapshot_text is null,'history identity')
      from community_shadow_jobs where edit_id=pg_temp.ctx('e');
    select pg_temp.check_ok(count(*)=2,'historical results stay on that job') from community_shadow_results r
      join community_shadow_jobs j on j.id=r.job_id where j.edit_id=pg_temp.ctx('e') and j.version=1;
  `],
  ['audit: maintenance failure rolls back scrub and deletion together; retry is idempotent', `
    ${create}
    insert into shadow_test_context values('retained',pg_temp.make_post('Otro')); ${flush}
    update community_shadow_jobs set snapshot_expires_at=clock_timestamp()-interval '1 second';
    update community_shadow_jobs set retain_until=clock_timestamp()-interval '1 second' where post_id=pg_temp.ctx('retained');
    create function pg_temp.audit_delete_failure() returns trigger language plpgsql as $$begin raise exception 'audit_maintenance_failure'; end $$;
    create trigger audit_delete_failure before delete on community_shadow_jobs for each row execute function pg_temp.audit_delete_failure();
    select pg_temp.expect_error('select community_shadow_maintain(100)','audit_maintenance_failure');
    select pg_temp.check_ok(count(*)=2 and bool_and(snapshot_text is not null and state='queued'),'no partial maintenance') from community_shadow_jobs;
    drop trigger audit_delete_failure on community_shadow_jobs;
    select pg_temp.check_ok(community_shadow_maintain(100)='{"scrubbed":2,"removed":1}'::jsonb,'maintenance retry');
    select pg_temp.check_ok(community_shadow_maintain(100)='{"scrubbed":0,"removed":0}'::jsonb,'maintenance idempotent');
    select pg_temp.check_ok(snapshot_text is null and state='expired','expired remaining row') from (${jobs}) q;
  `],
  ['multiple assets preserve canonical order and preprocessing affects hash', `
    insert into shadow_test_context values('a',pg_temp.new_asset()),('b',pg_temp.new_asset());
    insert into shadow_test_context select 'p',(community_post_save_atomic('33333333-3333-4333-8333-333333333333',null,null,'Orden',
      jsonb_build_array(jsonb_build_object('asset_id',pg_temp.ctx('b'),'position',0),
        jsonb_build_object('asset_id',pg_temp.ctx('a'),'position',1)),'{}')->'post'->>'id')::uuid; ${flush}
    select pg_temp.check_ok(assets->0->>'asset_id'=pg_temp.ctx('b')::text
      and assets->1->>'asset_id'=pg_temp.ctx('a')::text,'canonical order') from (${jobs}) q;
    select pg_temp.check_ok(snapshot_hash=community_shadow_private.fingerprint('Orden',assets)
      and snapshot_hash<>community_shadow_private.fingerprint('Orden',jsonb_build_array(assets->1,assets->0)),'hash order') from (${jobs}) q;
  `],
  ['normal create: final snapshot, ordered assets and normalized text', `
    insert into shadow_test_context values('p',pg_temp.make_post('  Café  ')); ${flush}
    select pg_temp.check_ok(count(*)=1 and min(snapshot_text)='Café' and min(version)=1,'snapshot') from (${jobs}) q;
    select pg_temp.check_ok(assets=(select jsonb_agg(jsonb_build_object('asset_id',m.asset_id,'kind','image',
      'position',m.position) order by m.position) from community_post_media m where m.post_id=${post}),'assets') from (${jobs}) q;
  `],
  ['normal edit: distinct versions, old observation obsolete', `${create} ${flush}
    select community_post_save_atomic('33333333-3333-4333-8333-333333333333',${post},1,'Nueva',
      (select jsonb_agg(jsonb_build_object('asset_id',asset_id,'position',position)) from community_post_media where post_id=${post}),'{}');
    ${flush}
    select pg_temp.check_ok(count(*)=2 and count(*) filter(where obsolete_at is null and version=2)=1
      and count(*) filter(where version=1 and state='cancelled' and snapshot_text is null)=1,'versions') from (${jobs}) q;
  `],
  ['held create: no provisional published snapshot', `
    insert into shadow_test_context values('p',pg_temp.make_post('Retenida',true)); ${flush}
    select pg_temp.check_ok(count(*)=1 and min(version)=1,'one held job') from (${jobs}) q;
    select pg_temp.check_ok(status='held_for_review','held intact') from community_posts where id=${post};
  `],
  ['pending proposal: reverted validation produces no public job', `${create} ${flush}
    insert into shadow_test_context values('e',pg_temp.submit_edit(${post})); ${flush}
    select pg_temp.check_ok(count(*)=2 and count(*) filter(where target_kind='post' and version=1)=1
      and count(*) filter(where target_kind='pending_edit' and base_version=1 and snapshot_text='Propuesta')=1,'proposal jobs')
      from community_shadow_jobs where post_id=${post};
    select pg_temp.check_ok(text='Original' and version=1,'public original') from community_posts where id=${post};
  `],
  ['repeated capture is idempotent, different config can reevaluate', `${create} ${flush}
    select pg_temp.check_ok(not community_shadow_private.capture('post',${post}),'duplicate');
    select pg_temp.check_ok(count(*)=1,'unique') from (${jobs}) q;
    insert into community_shadow_jobs(environment,target_kind,post_id,author_user_id,version,snapshot_text,assets,
      snapshot_hash,config_revision,snapshot_expires_at) select environment,target_kind,post_id,author_user_id,version,
      snapshot_text,assets,snapshot_hash,'shadow-v2',snapshot_expires_at from (${jobs}) q;
    select pg_temp.check_ok(count(*)=2,'config identity') from (${jobs}) q;
  `],
  ['rolled back subtransaction leaves no post or job', `
    do $$begin begin perform pg_temp.make_post(); set constraints all immediate;
      raise exception 'fixture_rollback'; exception when others then
      if sqlerrm<>'fixture_rollback' then raise; end if; end; end $$;
    select pg_temp.check_ok(count(*)=0,'no ghosts') from community_shadow_jobs;
    select pg_temp.check_ok(count(*)=0,'no ghost posts') from community_posts;
  `],
  ['capture failure is fail-open and reconciliation repairs current snapshot', `
    alter table community_shadow_jobs add constraint fixture_capture_failure check(false);
    ${create} ${flush}
    select pg_temp.check_ok(count(*)=1,'post saved') from community_posts where id=${post};
    select pg_temp.check_ok(count(*)=0,'capture failed') from community_shadow_jobs;
    alter table community_shadow_jobs drop constraint fixture_capture_failure;
    select pg_temp.check_ok(community_shadow_reconcile(10)=1,'reconciled');
    select pg_temp.check_ok(community_shadow_reconcile(10)=0,'reconcile idempotent');
  `],
  ['primary save failures remain failures', `
    select pg_temp.expect_error($q$select community_post_save_atomic('33333333-3333-4333-8333-333333333333',
      null,null,'No media','[]','{}')$q$,'media_required');
    select pg_temp.check_ok(count(*)=0,'no shadow ghost') from community_shadow_jobs;
  `],
  ['RLS and ACL: no direct API role access, only bounded RPCs', `
    select pg_temp.check_ok(bool_and(relrowsecurity and relforcerowsecurity),'rls') from pg_class
      where oid in ('community_shadow_jobs'::regclass,'community_shadow_results'::regclass);
    do $$declare r text; t text; f text; begin
      foreach r in array array['anon','authenticated','service_role'] loop
        foreach t in array array['community_shadow_jobs','community_shadow_results'] loop
          perform pg_temp.check_ok(not has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),'direct ACL');
        end loop;
        foreach f in array array['community_shadow_claim(integer,integer)','community_shadow_finish(uuid,uuid,text,jsonb,text)',
          'community_shadow_reconcile(integer)','community_shadow_maintain(integer)'] loop
          perform pg_temp.check_ok(has_function_privilege(r,f,'execute')=(r='service_role'),'RPC ACL');
        end loop;
        perform pg_temp.check_ok(not has_schema_privilege(r,'community_shadow_private','usage'),'private schema');
      end loop;
    end $$;
    ${create} ${flush}
    set local role anon;
    select pg_temp.expect_error('select * from public.community_shadow_jobs','42501');
    reset role;
    set local role authenticated;
    select pg_temp.expect_error('select * from public.community_shadow_results','42501');
    reset role;
    set local role service_role;
    select pg_temp.expect_error('select * from public.community_shadow_jobs','42501');
    select pg_temp.check_ok(count(*)=1,'service claim') from community_shadow_claim(1,60);
    reset role;
  `],
  ['delete post via existing RPC erases shadow data', `${create} ${flush} ${claim} ${finish()}
    select community_post_delete('33333333-3333-4333-8333-333333333333',${post},1); ${flush}
    select pg_temp.check_ok(count(*)=0,'jobs gone') from community_shadow_jobs;
    select pg_temp.check_ok(count(*)=0,'results gone') from community_shadow_results;
  `],
  ['copyright guard in the current deletion RPC still rejects protected content', `${create} ${flush}
    create or replace function public.copyright_post_protected(uuid) returns boolean language sql stable as $$ select true $$;
    select pg_temp.expect_error(format('select community_post_delete(%L,%L,1)',
      '33333333-3333-4333-8333-333333333333',${post}),'post_copyright_protected');
    select pg_temp.check_ok(count(*)=1,'protected post retained') from community_posts where id=${post};
    select pg_temp.check_ok(count(*)=1,'shadow does not override copyright') from (${jobs}) q;
  `],
  ['delete Auth account cascades observations and results', `${create} ${flush} ${claim} ${finish()}
    delete from auth.users where id='33333333-3333-4333-8333-333333333333'; ${flush}
    select pg_temp.check_ok(count(*)=0,'account jobs gone') from community_shadow_jobs;
    select pg_temp.check_ok(count(*)=0,'account results gone') from community_shadow_results;
  `],
  ['new version invalidates outstanding token; late result cannot affect content', `${create} ${flush} ${claim}
    select community_post_save_atomic('33333333-3333-4333-8333-333333333333',${post},1,'Actualizada',
      (select jsonb_agg(jsonb_build_object('asset_id',asset_id,'position',position)) from community_post_media where post_id=${post}),'{}');
    ${flush}
    select pg_temp.check_ok(community_shadow_finish(id,claim_token,'completed',pg_temp.success_results(id))='stale_claim','late token') from claimed;
    select pg_temp.check_ok(count(*)=0,'no late result') from community_shadow_results;
    select pg_temp.check_ok(text='Actualizada' and version=2,'public untouched') from community_posts where id=${post};
  `],
  ['finalization checks live version even before deferred invalidation runs', `${create} ${flush} ${claim}
    select community_post_save_atomic('33333333-3333-4333-8333-333333333333',${post},1,'Más nueva',
      (select jsonb_agg(jsonb_build_object('asset_id',asset_id,'position',position)) from community_post_media where post_id=${post}),'{}');
    select pg_temp.check_ok(community_shadow_finish(id,claim_token,'completed','[]')='obsolete','live guard') from claimed;
    select pg_temp.check_ok(count(*)=0,'no obsolete result') from community_shadow_results; ${flush}
  `],
  ['snapshot expires after 24h; maintenance scrubs and never resurrects text', `${create} ${flush}
    update community_shadow_jobs set snapshot_expires_at=clock_timestamp()-interval '1 second';
    select pg_temp.check_ok(count(*)=0,'expired cannot claim') from community_shadow_claim(10,60);
    select pg_temp.check_ok(snapshot_text is null and state='expired','scrubbed') from (${jobs}) q;
    select pg_temp.check_ok(community_shadow_reconcile(10)=0,'no resurrection');
  `],
  ['30 day retention deletes observations and component results', `${create} ${flush} ${claim} ${finish()}
    update community_shadow_jobs set retain_until=clock_timestamp()-interval '1 second';
    select community_shadow_maintain(10);
    select pg_temp.check_ok(count(*)=0,'retention jobs') from community_shadow_jobs;
    select pg_temp.check_ok(count(*)=0,'retention results') from community_shadow_results;
  `],
  ['expired lease refuses completion and reclaim rotates token', `${create} ${flush} ${claim}
    update community_shadow_jobs set lease_until=clock_timestamp()-interval '1 second';
    select pg_temp.check_ok(community_shadow_finish(id,claim_token,'completed','[]')='stale_claim','expired') from claimed;
    create temporary table reclaimed on commit drop as select * from community_shadow_claim(10,60);
    select pg_temp.check_ok(r.claim_token<>c.claim_token and r.attempts=2,'rotated') from reclaimed r join claimed c using(id);
    select pg_temp.check_ok(community_shadow_finish(id,claim_token,'completed','[]')='stale_claim','old lease') from claimed;
  `],
  ['finish is atomic and repeat completion cannot duplicate results', `${create} ${flush} ${claim}
    select pg_temp.expect_error(format('select community_shadow_finish(%L,%L,%L,%L::jsonb)',id,claim_token,
      'completed',pg_temp.success_results(id) || pg_temp.success_results(id)), '23505') from claimed;
    select pg_temp.check_ok(count(*)=0,'atomic results rollback') from community_shadow_results;
    ${finish()}
    select pg_temp.check_ok(community_shadow_finish(id,claim_token,'completed','[]')='stale_claim','repeat') from claimed;
    select pg_temp.check_ok(count(*)=2,'two distinct components') from community_shadow_results;
  `],
  ['video coverage cannot be completed by evaluating only text', `
    insert into shadow_test_context values('p',pg_temp.make_post('Texto vídeo',false,'video')); ${flush} ${claim}
    select pg_temp.expect_error(format('select community_shadow_finish(%L,%L,%L,%L::jsonb)',id,claim_token,
      'completed',pg_temp.success_results(id)),'invalid_coverage') from claimed;
    ${finish('partial')}
    select pg_temp.check_ok(coverage->>'overall'='partial' and coverage->>'video'='unsupported_video','partial video') from (${jobs}) q;
  `],
  ['video without text is unsupported, absent modalities are not applicable', `
    insert into shadow_test_context values('p',pg_temp.make_post(null,false,'video')); ${flush} ${claim} ${finish('partial')}
    select pg_temp.check_ok(coverage->>'overall'='unsupported_video' and coverage->>'text'='not_applicable'
      and coverage->>'images'='not_applicable','unsupported') from (${jobs}) q;
  `],
  ['image-only coverage can complete without inventing a text result', `
    insert into shadow_test_context values('p',pg_temp.make_post(null)); ${flush} ${claim} ${finish()}
    select pg_temp.check_ok(coverage->>'overall'='complete' and coverage->>'text'='not_applicable','image only') from (${jobs}) q;
  `],
  ['cancel pending edit invalidates its claim, preserving original public version', `${create} ${flush}
    insert into shadow_test_context values('e',pg_temp.submit_edit(${post})); ${flush} ${claim}
    select community_post_pending_edit_cancel('33333333-3333-4333-8333-333333333333',${post}); ${flush}
    select pg_temp.check_ok(state='cancelled' and obsolete_reason='edit_closed','cancelled') from community_shadow_jobs where edit_id=pg_temp.ctx('e');
    select pg_temp.check_ok(text='Original' and version=1,'original remains') from community_posts where id=${post};
  `],
  ['asset deleting invalidates jobs; physical row deletion leaves no shadow references', `${create} ${flush} ${claim}
    update media_assets set status='deleting' where id in (select asset_id from community_post_media where post_id=${post});
    select pg_temp.check_ok(state='cancelled' and obsolete_reason='asset_unavailable','asset unavailable') from (${jobs}) q;
    delete from community_post_media where post_id=${post};
    delete from media_assets; ${flush}
    select pg_temp.check_ok(count(*)=0,'original observation erased') from community_shadow_jobs where id in (select id from claimed);
    select pg_temp.check_ok(not exists(select 1 from community_shadow_jobs j,jsonb_array_elements(j.assets) a
      where not exists(select 1 from media_assets m where m.id=(a->>'asset_id')::uuid)),'no dangling asset references');
  `],
  ['retry is idempotent and attempts are bounded', `${create} ${flush} ${claim}
    select pg_temp.check_ok(community_shadow_finish(id,claim_token,'retry_wait','[]','provider_timeout')='finished','retry') from claimed;
    update community_shadow_jobs set next_attempt_at=clock_timestamp()-interval '1 second';
    select pg_temp.check_ok(attempts=2,'second attempt') from community_shadow_claim(10,60);
    update community_shadow_jobs set attempts=3,lease_until=clock_timestamp()-interval '1 second';
    select pg_temp.check_ok(count(*)=0,'exhausted') from community_shadow_claim(10,60);
    select pg_temp.check_ok(state='failed' and last_error_code='attempts_exhausted' and snapshot_text is null,'bounded') from (${jobs}) q;
  `],
  ['foreign component, raw errors, invalid scores and image-only categories are refused', `${create} ${flush} ${claim}
    select pg_temp.expect_error(format('select community_shadow_finish(%L,%L,%L,%L::jsonb)',id,claim_token,'failed',
      '[{"component_kind":"text","error":"raw secret"}]'),'invalid_argument') from claimed;
    select pg_temp.expect_error(format('select community_shadow_finish(%L,%L,%L,%L::jsonb)',id,claim_token,'failed',
      '[{"component_kind":"image","asset_id":"99999999-9999-4999-8999-999999999999"}]'),'invalid_argument') from claimed;
    select pg_temp.check_ok(not community_shadow_private.valid_categories('{"violence":1.1}',true),'score range');
    select pg_temp.check_ok(not community_shadow_private.valid_input_types('{"sexual/minors":["image"]}'),'modality');
    select pg_temp.check_ok(count(*)=0,'no invalid results') from community_shadow_results;
  `],
  ['human decisions and mandatory audit remain unchanged', `
    insert into shadow_test_context values('p',pg_temp.make_post('Retenida',true)); ${flush}
    select community_content_review_decide('55555555-5555-4555-8555-555555555551','held_post',${post},1,'approve'); ${flush}
    ${claim} ${finish()}
    select pg_temp.check_ok(status='published' and version=2,'human result unchanged') from community_posts where id=${post};
    select pg_temp.check_ok(count(*)=1 and min(action)='content_hold_released','one human audit') from moderation_audit_log;
    select pg_temp.expect_error('delete from moderation_audit_log','moderation_audit_log_immutable');
  `],
];
