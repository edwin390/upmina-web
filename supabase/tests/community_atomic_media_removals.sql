-- Solo Testing verificado. Fixtures aleatorias sin objetos R2; TODO revierte al terminar.
begin;
do $$
declare
  actor uuid := gen_random_uuid();
  assets uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  target_post uuid;
  other_post_id uuid;
  attachments uuid[];
  foreign_attachment uuid;
  result jsonb;
  final_media jsonb;
  removals uuid[];
  expected_error text;
  before_state jsonb;
  after_state jsonb;
  scenario integer;
  expected_version integer;
begin
  insert into auth.users(id) values (actor);
  insert into public.profiles(user_id, username) values (actor, 'fix83_' || substr(replace(actor::text, '-', ''), 1, 16));
  insert into public.media_assets(id, domain, kind, status, created_by, pipeline_version)
    select id, 'community', 'image', 'ready', actor, 'fix83_test' from unnest(assets) as a(id);
  result := public.community_post_save_atomic(actor, null, null, 'Original',
    jsonb_build_array(jsonb_build_object('asset_id',assets[1],'position',0),
      jsonb_build_object('asset_id',assets[2],'position',1),
      jsonb_build_object('asset_id',assets[3],'position',2)), array[]::uuid[]);
  target_post := (result->'post'->>'id')::uuid;
  assert (result->'post'->>'version')::integer = 1, 'create_version';
  -- Calificar columnas evita ambigüedad con las variables del bloque.
  select array_agg(m.id order by m.position) into attachments from public.community_post_media m where m.post_id = (result->'post'->>'id')::uuid;
  result := public.community_post_save_atomic(actor, null, null, 'Other',
    jsonb_build_array(jsonb_build_object('asset_id',assets[5],'position',0)), array[]::uuid[]);
  other_post_id := (result->'post'->>'id')::uuid;
  foreign_attachment := (result->'media'->0->>'id')::uuid;

  for scenario in 1..13 loop
    removals := array[]::uuid[];
    expected_error := null;
    expected_version := 1;
    final_media := jsonb_build_array(jsonb_build_object('asset_id',assets[1],'position',0),
      jsonb_build_object('asset_id',assets[2],'position',1),jsonb_build_object('asset_id',assets[3],'position',2));
    if scenario in (2,3,5,7,8,9,11,12,13) then
      final_media := jsonb_build_array(jsonb_build_object('asset_id',assets[1],'position',0),jsonb_build_object('asset_id',assets[3],'position',1));
      if scenario <> 3 then removals := array[attachments[2]]; end if;
    end if;
    if scenario in (4,5) then
      final_media := jsonb_build_array(jsonb_build_object('asset_id',assets[3],'position',0),jsonb_build_object('asset_id',assets[1],'position',1));
      if scenario = 4 then final_media := final_media || jsonb_build_array(jsonb_build_object('asset_id',assets[2],'position',2)); end if;
    end if;
    if scenario in (6,7) then
      final_media := final_media || jsonb_build_array(jsonb_build_object('asset_id',assets[4],'position',jsonb_array_length(final_media)));
    end if;
    if scenario = 8 then
      final_media := jsonb_build_array(jsonb_build_object('asset_id',assets[4],'position',0),jsonb_build_object('asset_id',assets[3],'position',1),jsonb_build_object('asset_id',assets[1],'position',2));
    end if;
    if scenario = 3 then expected_error := 'media_missing_existing'; end if;
    if scenario = 9 then removals := array[foreign_attachment]; expected_error := 'media_not_found'; end if;
    if scenario = 10 then removals := array[attachments[2]]; expected_error := 'invalid_argument'; end if;
    if scenario = 11 then removals := array[attachments[2],attachments[2]]; expected_error := 'invalid_argument'; end if;
    if scenario = 12 then expected_version := 0; expected_error := 'version_conflict'; end if;
    if scenario = 13 then expected_error := 'forced_transaction_failure'; end if;
    select jsonb_build_object('post',to_jsonb(p),'media',
      (select jsonb_agg(to_jsonb(m) order by m.position) from public.community_post_media m where m.post_id=p.id),
      'assets',(select jsonb_agg(to_jsonb(a) order by a.id) from public.media_assets a where a.id=any(assets)))
      into before_state from public.community_posts p where p.id=target_post;
    begin
      result := public.community_post_save_atomic(actor, target_post, expected_version, 'Editado', final_media, removals);
      if scenario = 13 then raise exception 'forced_transaction_failure'; end if;
      assert expected_error is null, 'expected_rejection';
      assert (result->'post'->>'id')::uuid = target_post, 'post_identity';
      assert (result->'post'->>'version')::integer = 2, 'version_once';
      assert (result->'post'->>'text') = 'Editado', 'text_update';
      assert (select jsonb_agg(jsonb_build_object('asset_id',m.asset_id,'position',m.position) order by m.position)
        from public.community_post_media m where m.post_id=target_post) = final_media, 'final_media_order';
      if cardinality(removals)>0 then
        assert not exists(select 1 from public.community_post_media m where m.id=attachments[2]), 'removed_attachment';
        assert (select a.status from public.media_assets a where a.id=assets[2]) = 'deleting', 'removed_lifecycle';
        assert result->'cleanup_asset_ids' = to_jsonb(array[assets[2]]), 'server_cleanup_candidate';
      end if;
      raise exception 'rollback_success_case';
    exception when raise_exception then
      if expected_error is null then
        if sqlerrm <> 'rollback_success_case' then raise; end if;
      elsif sqlerrm <> expected_error then raise; end if;
    end;
    select jsonb_build_object('post',to_jsonb(p),'media',
      (select jsonb_agg(to_jsonb(m) order by m.position) from public.community_post_media m where m.post_id=p.id),
      'assets',(select jsonb_agg(to_jsonb(a) order by a.id) from public.media_assets a where a.id=any(assets)))
      into after_state from public.community_posts p where p.id=target_post;
    assert after_state = before_state, 'full_rollback';
  end loop;
end;
$$;
rollback;
select 'PASS: create + 13 atomic scenarios; fixtures rolled back; no R2 operations' as fix83_result;
