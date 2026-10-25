-- ghost: run a write through your real database's logic, see exactly what it would change, keep nothing.
--
-- Install once (psql -f, a migration, or the Supabase SQL editor), then `select ghost.install();`.
-- Re-run `select ghost.install();` after a migration adds tables, trigger functions or sequences.
--
-- How it stays safe:
--   * every run happens inside a subtransaction that always rolls back;
--   * a session's earlier changes are replayed as exact rows with every trigger skipped (a guard at the top of each
--     trigger function), and any transaction that replays queues a deferred trigger that refuses to commit;
--   * only the runners can mint the token that quiets that trigger mid-run, and the token lives in the rolled-back
--     subtransaction, so it is never valid at a real commit;
--   * while a run or replay is on, nextval draws from a ghost twin of each sequence, so no real number is used up.
--
-- Targets the `public` schema. Entry points live in `public` (so PostgREST can reach them); everything else in `ghost`.
-- The functions that run your code (your RPCs, table writes, branch migrations) keep the caller's search_path, so
-- functions of yours without their own SET search_path behave as they do outside ghost.

begin;

create schema if not exists ghost;
grant usage on schema ghost to public;

-- ---------------------------------------------------------------------------------------------------------------------
-- Never commit

create table if not exists ghost.replay_marker (txid bigint primary key);
revoke all on table ghost.replay_marker from public;

create table if not exists ghost.secret (id boolean primary key default true check (id), secret text not null);
insert into ghost.secret (secret) values (md5(random()::text || clock_timestamp()::text) || md5(random()::text))
  on conflict (id) do nothing;
revoke all on table ghost.secret from public;

create or replace function ghost.dispatch_token()
returns text language sql stable security definer set search_path = '' as $function$
  select pg_catalog.md5(s.secret || ':' || pg_catalog.txid_current()::text) from ghost.secret s;
$function$;
revoke all on function ghost.dispatch_token() from public;

create or replace function ghost.never_commits()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if pg_catalog.current_setting('ghost.dispatch', true) = ghost.dispatch_token() then
    return null;
  end if;
  raise exception 'A ghost replay can never commit.' using errcode = 'P0001';
end;
$function$;

drop trigger if exists never_commits on ghost.replay_marker;
create constraint trigger never_commits
  after insert on ghost.replay_marker deferrable initially deferred
  for each row execute function ghost.never_commits();

create or replace function ghost.replay_lock()
returns void language sql security definer set search_path = '' as $function$
  insert into ghost.replay_marker (txid) values (pg_catalog.txid_current()) on conflict do nothing;
$function$;
grant execute on function ghost.replay_lock() to public;

-- ---------------------------------------------------------------------------------------------------------------------
-- Rewrite hooks: called after ghost rewrites one of your functions, with its definition before and after. Use one when
-- something of yours fingerprints function bodies, to re-attest exactly the hash ghost moved.
--   create function my_repin(p_fn regprocedure, p_old text, p_new text) returns void ...;
--   insert into ghost.rewrite_hooks values ('my_repin(regprocedure, text, text)');

create table if not exists ghost.rewrite_hooks (hook regprocedure primary key);
revoke all on table ghost.rewrite_hooks from public;

create or replace function ghost.rewrite(p_fn oid, p_new_def text)
returns void language plpgsql security definer set search_path = '' as $function$
declare
  v_old text := pg_catalog.pg_get_functiondef(p_fn);
  h record;
begin
  execute p_new_def;
  perform pg_catalog.set_config('search_path', '"$user", public', true);
  for h in select hook from ghost.rewrite_hooks loop
    execute pg_catalog.format('select %s($1, $2, $3)', h.hook::oid::regproc)
      using p_fn::regprocedure, v_old, pg_catalog.pg_get_functiondef(p_fn);
  end loop;
end;
$function$;
revoke all on function ghost.rewrite(oid, text) from public;

-- ---------------------------------------------------------------------------------------------------------------------
-- Ghost counters

create table if not exists ghost.sequence_map (real_seq regclass primary key, ghost_seq regclass not null unique);
revoke all on table ghost.sequence_map from public;

create or replace function ghost.counting()
returns boolean language sql stable set search_path = '' as $function$
  select coalesce(pg_catalog.current_setting('ghost.capture', true), '') = 'on'
      or coalesce(pg_catalog.current_setting('ghost.replay', true), '') = 'on';
$function$;

create or replace function ghost.nextval(p_seq regclass)
returns bigint language plpgsql volatile security definer set search_path = '' as $function$
declare
  v_ghost regclass;
begin
  if ghost.counting() then
    select m.ghost_seq into v_ghost from ghost.sequence_map m where m.real_seq = p_seq;
    if v_ghost is null then
      raise exception 'ghost has no counter for %; run select ghost.install().', p_seq using errcode = 'P0001';
    end if;
    return pg_catalog.nextval(v_ghost);
  end if;
  return pg_catalog.nextval(p_seq);
end;
$function$;

create or replace function ghost.nextval(p_seq text)
returns bigint language sql volatile as $function$
  select ghost.nextval(p_seq::regclass);
$function$;

create or replace function ghost.setval(p_seq regclass, p_value bigint, p_called boolean default true)
returns bigint language plpgsql volatile security definer set search_path = '' as $function$
begin
  if ghost.counting() then
    return p_value;
  end if;
  return pg_catalog.setval(p_seq, p_value, p_called);
end;
$function$;

create or replace function ghost.setval(p_seq text, p_value bigint, p_called boolean default true)
returns bigint language sql volatile as $function$
  select ghost.setval(p_seq::regclass, p_value, p_called);
$function$;

grant execute on function ghost.counting(), ghost.nextval(regclass), ghost.nextval(text),
  ghost.setval(regclass, bigint, boolean), ghost.setval(text, bigint, boolean) to public;

-- Twins every public sequence, then points every public function and column default that calls nextval/setval at the
-- ghost versions, rewritten from the LIVE definition so nothing stale is reapplied.
create or replace function ghost.install_counters()
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  r record;
  v_name text;
  v_start bigint;
  v_def text;
  v_twins int := 0;
  v_functions int := 0;
  v_defaults int := 0;
  v_failed jsonb := '[]'::jsonb;
  v_identity jsonb;
  v_call constant text := '(^|[^A-Za-z0-9_."])(pg_catalog\.)?(nextval|setval)\s*\(';
begin
  for r in
    select c.oid, c.relname, s.last_value, s.max_value
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    left join pg_catalog.pg_sequences s on s.schemaname = n.nspname and s.sequencename = c.relname
    where n.nspname = 'public' and c.relkind = 'S'
      and not exists (select 1 from ghost.sequence_map m where m.real_seq = c.oid)
  loop
    v_name := left('seq_' || r.relname, 63);
    -- Far above anything real, so a ghost row never collides with a real one and reads as ghost; within the type.
    v_start := greatest(9000001, coalesce(r.last_value, 0) * 10 + 1);
    v_start := least(v_start, coalesce(r.last_value, 0) + (coalesce(r.max_value, 9223372036854775807) - coalesce(r.last_value, 0)) / 2);
    execute pg_catalog.format('create sequence if not exists ghost.%I start with %s maxvalue %s', v_name, v_start,
      coalesce(r.max_value, 9223372036854775807));
    execute pg_catalog.format('grant usage, select on sequence ghost.%I to public', v_name);
    insert into ghost.sequence_map (real_seq, ghost_seq) values (r.oid, pg_catalog.format('ghost.%I', v_name)::regclass);
    v_twins := v_twins + 1;
  end loop;

  for r in
    select p.oid, p.proname
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_language l on l.oid = p.prolang
    where n.nspname = 'public' and l.lanname in ('plpgsql', 'sql') and p.prokind = 'f'
      and p.proname not like 'ghost\_%'
  loop
    v_def := pg_catalog.pg_get_functiondef(r.oid);
    continue when v_def !~* v_call;
    begin
      perform ghost.rewrite(r.oid, pg_catalog.regexp_replace(v_def, v_call, '\1ghost.\3(', 'gi'));
      v_functions := v_functions + 1;
    exception when others then
      v_failed := v_failed || jsonb_build_object('fn', r.proname, 'why', sqlerrm);
    end;
  end loop;

  for r in
    select c.relname, a.attname, pg_catalog.pg_get_expr(d.adbin, d.adrelid) as expr
    from pg_catalog.pg_attrdef d
    join pg_catalog.pg_class c on c.oid = d.adrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
    where n.nspname = 'public' and pg_catalog.pg_get_expr(d.adbin, d.adrelid) ~* '(^|[^A-Za-z0-9_.])nextval\('
  loop
    begin
      execute pg_catalog.format('alter table public.%I alter column %I set default %s', r.relname, r.attname,
        pg_catalog.regexp_replace(r.expr, '(^|[^A-Za-z0-9_.])nextval\(', '\1ghost.nextval(', 'gi'));
      v_defaults := v_defaults + 1;
    exception when others then
      v_failed := v_failed || jsonb_build_object('default', r.relname || '.' || r.attname, 'why', sqlerrm);
    end;
  end loop;

  -- Identity columns take their number before any default or trigger runs, so a ghost insert still uses one up.
  select coalesce(jsonb_agg(c.relname || '.' || a.attname), '[]'::jsonb) into v_identity
  from pg_catalog.pg_attribute a
  join pg_catalog.pg_class c on c.oid = a.attrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and a.attidentity <> '' and not a.attisdropped;

  return jsonb_build_object('twins', v_twins, 'functions', v_functions, 'defaults', v_defaults,
    'identityColumnsStillCounting', v_identity, 'failed', v_failed);
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Capture and replay guards

-- Captured only inside a run: the temp table exists nowhere else.
create or replace function ghost.capture_row()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_pk jsonb;
begin
  if pg_catalog.to_regclass('pg_temp.ghost_changes') is null then
    return null;
  end if;
  select jsonb_object_agg(a.attname, v_row -> a.attname) into v_pk
  from pg_catalog.pg_index i
  join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
  where i.indrelid = tg_relid and i.indisprimary;
  insert into pg_temp.ghost_changes (tbl, op, pk, old_row, new_row)
  values (tg_table_name, tg_op, v_pk,
    case when tg_op <> 'INSERT' then to_jsonb(old) end,
    case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return null;
end;
$function$;

-- Every public table with a primary key gets the capture trigger; real traffic pays one setting check per row.
-- p_from/p_to bound the table names (inclusive, either open) so a big install can go in short batches.
create or replace function ghost.install_capture(p_from text default null, p_to text default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  r record;
  v_added int := 0;
  v_skipped text[] := '{}';
begin
  for r in
    select c.relname, exists (select 1 from pg_catalog.pg_index i where i.indrelid = c.oid and i.indisprimary) as has_pk
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
      and (p_from is null or c.relname >= p_from) and (p_to is null or c.relname <= p_to)
    order by c.relname
  loop
    if not r.has_pk then
      v_skipped := v_skipped || r.relname::text;
      continue;
    end if;
    if not exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = pg_catalog.format('public.%I', r.relname)::regclass
                   and t.tgname = 'zz_ghost_capture') then
      execute pg_catalog.format('create trigger zz_ghost_capture after insert or update or delete on public.%I for each row '
        || 'when (pg_catalog.current_setting(''ghost.capture'', true) = ''on'') execute function ghost.capture_row()', r.relname);
      v_added := v_added + 1;
    end if;
  end loop;
  return jsonb_build_object('added', v_added, 'skippedNoPrimaryKey', to_jsonb(v_skipped));
end;
$function$;

-- The replay guard goes in as the first statement of every plpgsql trigger function in public.
create or replace function ghost.install_guards(p_from text default null, p_to text default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  r record;
  v_def text;
  v_as int;
  v_tag text;
  v_begin int;
  v_patched int := 0;
  v_failed jsonb := '[]'::jsonb;
  v_guard constant text := E'\n  if pg_catalog.current_setting(''ghost.replay'', true) = ''on'' then\n'
    || E'    perform ghost.replay_lock();\n'
    || E'    if tg_level = ''ROW'' then return coalesce(new, old); end if;\n'
    || E'    return null;\n  end if;';
begin
  for r in
    select p.oid, p.proname
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_language l on l.oid = p.prolang
    where n.nspname = 'public' and l.lanname = 'plpgsql' and p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
      and (p_from is null or p.proname >= p_from) and (p_to is null or p.proname <= p_to)
  loop
    v_def := pg_catalog.pg_get_functiondef(r.oid);
    continue when position('ghost.replay' in v_def) > 0;
    v_as := pg_catalog.regexp_instr(v_def, E'\nAS \\$[A-Za-z0-9_]*\\$');
    v_tag := substring(v_def from v_as + 4 for pg_catalog.regexp_instr(v_def, '\$', v_as + 5) - (v_as + 4) + 1);
    v_begin := pg_catalog.regexp_instr(v_def, '\mbegin\M', v_as + 4 + length(v_tag), 1, 1, 'i');
    if v_as = 0 or v_begin = 0 then
      v_failed := v_failed || jsonb_build_object('fn', r.proname, 'why', 'no body begin found');
      continue;
    end if;
    begin
      perform ghost.rewrite(r.oid, left(v_def, v_begin - 1) || v_guard || substring(v_def from v_begin));
      v_patched := v_patched + 1;
    exception when others then
      v_failed := v_failed || jsonb_build_object('fn', r.proname, 'why', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('patched', v_patched, 'failed', v_failed);
end;
$function$;

create or replace function ghost.install(p_from text default null, p_to text default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  return jsonb_build_object(
    'counters', ghost.install_counters(),
    'capture', ghost.install_capture(p_from, p_to),
    'guards', ghost.install_guards(p_from, p_to));
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Replay

create or replace function ghost.columns(p_table text)
returns text[] language sql stable security definer set search_path = '' as $function$
  select coalesce(array_agg(a.attname::text order by a.attnum), '{}')
  from pg_catalog.pg_attribute a
  where a.attrelid = pg_catalog.format('public.%I', p_table)::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = '';
$function$;

create or replace function ghost.pk_where(p_table text, p_pk jsonb, p_alias text default 'x')
returns text language sql stable security definer set search_path = '' as $function$
  select string_agg(pg_catalog.format('%I.%I = (jsonb_populate_record(null::public.%I, %L::jsonb)).%I', p_alias, k, p_table, p_pk, k), ' and ')
  from jsonb_object_keys(p_pk) k;
$function$;

-- Exact row images back, in order, with every trigger skipped by the guard.
create or replace function ghost.apply_changes(p_changes jsonb)
returns int language plpgsql security definer set search_path = '' as $function$
declare
  c jsonb;
  v_cols text[];
  v_list text;
  v_set text;
  v_n int := 0;
  v_rows int;
begin
  perform ghost.replay_lock();
  if p_changes is null or jsonb_array_length(p_changes) = 0 then
    return 0;
  end if;
  perform pg_catalog.set_config('ghost.replay', 'on', true);
  for c in select value from jsonb_array_elements(p_changes)
  loop
    if c ->> 'op' = 'DELETE' then
      execute pg_catalog.format('delete from public.%I x where %s', c ->> 'table', ghost.pk_where(c ->> 'table', c -> 'pk'));
    else
      v_cols := ghost.columns(c ->> 'table');
      select string_agg(pg_catalog.format('%I', col), ', '), string_agg(pg_catalog.format('%I = r.%I', col, col), ', ')
        into v_list, v_set from unnest(v_cols) col;
      execute pg_catalog.format('update public.%I x set %s from jsonb_populate_record(null::public.%I, $1) r where %s',
        c ->> 'table', v_set, c ->> 'table', ghost.pk_where(c ->> 'table', c -> 'pk')) using c -> 'new';
      -- EXECUTE doesn't set FOUND.
      get diagnostics v_rows = row_count;
      if v_rows = 0 then
        execute pg_catalog.format('insert into public.%I (%s) overriding system value select %s from jsonb_populate_record(null::public.%I, $1)',
          c ->> 'table', v_list, v_list, c ->> 'table') using c -> 'new';
      end if;
    end if;
    v_n := v_n + 1;
  end loop;
  perform pg_catalog.set_config('ghost.replay', 'off', true);
  return v_n;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Requests in PostgREST's shapes

create or replace function ghost.filter_sql(p_table text, p_filters jsonb, p_alias text default 'x')
returns text language plpgsql stable security definer set search_path = '' as $function$
declare
  f jsonb;
  v_col text;
  v_op text;
  v_val jsonb;
  v_typed text;
  v_parts text[] := '{}';
  v_cols text[] := (select array_agg(a.attname::text) from pg_catalog.pg_attribute a
    where a.attrelid = pg_catalog.format('public.%I', p_table)::regclass and a.attnum > 0 and not a.attisdropped);
begin
  for f in select value from jsonb_array_elements(coalesce(p_filters, '[]'::jsonb))
  loop
    v_col := f ->> 'col';
    v_op := f ->> 'op';
    v_val := f -> 'value';
    if not (v_col = any (v_cols)) then
      raise exception 'ghost can''t filter on %.%: no such column.', p_table, v_col using errcode = '42703';
    end if;
    v_typed := pg_catalog.format('(jsonb_populate_record(null::public.%I, jsonb_build_object(%L, %L::jsonb))).%I', p_table, v_col, v_val, v_col);
    v_parts := v_parts || case v_op
      when 'eq' then pg_catalog.format('%I.%I = %s', p_alias, v_col, v_typed)
      when 'neq' then pg_catalog.format('%I.%I <> %s', p_alias, v_col, v_typed)
      when 'gt' then pg_catalog.format('%I.%I > %s', p_alias, v_col, v_typed)
      when 'gte' then pg_catalog.format('%I.%I >= %s', p_alias, v_col, v_typed)
      when 'lt' then pg_catalog.format('%I.%I < %s', p_alias, v_col, v_typed)
      when 'lte' then pg_catalog.format('%I.%I <= %s', p_alias, v_col, v_typed)
      when 'like' then pg_catalog.format('%I.%I::text like %L', p_alias, v_col, v_val #>> '{}')
      when 'ilike' then pg_catalog.format('%I.%I::text ilike %L', p_alias, v_col, v_val #>> '{}')
      when 'is' then pg_catalog.format('%I.%I is %s', p_alias, v_col, case coalesce(v_val #>> '{}', 'null') when 'null' then 'null'
        when 'true' then 'true' when 'false' then 'false' else 'unknown' end)
      when 'in' then pg_catalog.format('%I.%I = any (array(select (jsonb_populate_record(null::public.%I, jsonb_build_object(%L, e))).%I from jsonb_array_elements(%L::jsonb) e))',
        p_alias, v_col, p_table, v_col, v_col, v_val)
      else null end;
    if v_parts[array_length(v_parts, 1)] is null then
      raise exception 'ghost can''t run a "%" filter here yet.', v_op using errcode = '0A000';
    end if;
  end loop;
  return coalesce(nullif(array_to_string(v_parts, ' and '), ''), 'true');
end;
$function$;

-- An RPC called the way PostgREST would: by name with named arguments, the overload whose names cover the call.
create or replace function ghost.call_rpc(p_name text, p_args jsonb)
returns jsonb language plpgsql security definer as $function$
declare
  p record;
  v_args text;
  v_out jsonb;
  v_keys text[] := (select coalesce(array_agg(k), '{}') from jsonb_object_keys(coalesce(p_args, '{}'::jsonb)) k);
begin
  select pr.oid, pr.proretset, pr.prorettype, pr.proargnames, pr.proargtypes, pr.pronargs, pr.pronargdefaults
    into p
  from pg_catalog.pg_proc pr join pg_catalog.pg_namespace n on n.oid = pr.pronamespace
  where n.nspname = 'public' and pr.proname = p_name
    and v_keys <@ coalesce(pr.proargnames[1:pr.pronargs], '{}')
    and (pr.pronargs - pr.pronargdefaults) <= cardinality(v_keys)
  order by pr.pronargs
  limit 1;
  if not found then
    raise exception 'Could not find the function public.%(%) in the schema cache', p_name, array_to_string(v_keys, ', ')
      using errcode = 'PGRST202';
  end if;
  select string_agg(pg_catalog.format('%I => %s', k,
      case when t.typname in ('json', 'jsonb') then pg_catalog.format('%L::jsonb::%s', p_args -> k, pg_catalog.format_type(t.oid, null))
        when t.typcategory = 'A' then pg_catalog.format('(select array_agg(e)::%s from jsonb_array_elements_text(%L::jsonb) e)',
          pg_catalog.format_type(t.oid, null), p_args -> k)
        else pg_catalog.format('%L::%s', p_args ->> k, pg_catalog.format_type(t.oid, null)) end), ', ')
    into v_args
  from unnest(v_keys) k
  join lateral (select p.proargtypes[array_position(p.proargnames, k) - 1] as typ) a on true
  join pg_catalog.pg_type t on t.oid = a.typ;
  if p.prorettype = 'pg_catalog.void'::pg_catalog.regtype then
    execute pg_catalog.format('select public.%I(%s)', p_name, coalesce(v_args, ''));
    return 'null'::jsonb;
  elsif p.proretset then
    execute pg_catalog.format('select coalesce(jsonb_agg(to_jsonb(r)), ''[]'') from public.%I(%s) r', p_name, coalesce(v_args, '')) into v_out;
  else
    execute pg_catalog.format('select to_jsonb(public.%I(%s))', p_name, coalesce(v_args, '')) into v_out;
  end if;
  return v_out;
end;
$function$;

create or replace function ghost.table_write(p_request jsonb)
returns jsonb language plpgsql security definer as $function$
declare
  v_table text := p_request ->> 'table';
  v_method text := p_request ->> 'method';
  v_body jsonb := case jsonb_typeof(p_request -> 'body') when 'array' then p_request -> 'body' else jsonb_build_array(p_request -> 'body') end;
  v_keys text[];
  v_list text;
  v_set text;
  v_conflict text;
  v_out jsonb;
begin
  if v_table is null or pg_catalog.to_regclass(pg_catalog.format('public.%I', v_table)) is null then
    raise exception 'Could not find the table public.% in the schema cache', v_table using errcode = 'PGRST205';
  end if;
  if v_method in ('insert', 'upsert') then
    select array_agg(distinct k) into v_keys from jsonb_array_elements(v_body) e, jsonb_object_keys(e) k;
    select string_agg(pg_catalog.format('%I', k), ', '), string_agg(pg_catalog.format('%I = excluded.%I', k, k), ', ')
      into v_list, v_set from unnest(v_keys) k;
    v_conflict := case when v_method = 'upsert' then pg_catalog.format(' on conflict (%s) do %s',
      (select string_agg(pg_catalog.format('%I', c), ', ') from jsonb_array_elements_text(p_request -> 'onConflict') c),
      case when p_request ->> 'ignoreDuplicates' = 'true' then 'nothing' else 'update set ' || v_set end) else '' end;
    execute pg_catalog.format('with w as (insert into public.%I (%s) select %s from jsonb_populate_recordset(null::public.%I, $1)%s returning *) '
      || 'select coalesce(jsonb_agg(to_jsonb(w)), ''[]'') from w', v_table, v_list, v_list, v_table, v_conflict) into v_out using v_body;
  elsif v_method = 'update' then
    select string_agg(pg_catalog.format('%I = r.%I', k, k), ', ') into v_set from jsonb_object_keys(v_body -> 0) k;
    execute pg_catalog.format('with w as (update public.%I x set %s from jsonb_populate_record(null::public.%I, $1) r where %s returning x.*) '
      || 'select coalesce(jsonb_agg(to_jsonb(w)), ''[]'') from w', v_table, v_set, v_table,
      ghost.filter_sql(v_table, p_request -> 'filters')) into v_out using v_body -> 0;
  elsif v_method = 'delete' then
    execute pg_catalog.format('with w as (delete from public.%I x where %s returning x.*) select coalesce(jsonb_agg(to_jsonb(w)), ''[]'') from w',
      v_table, ghost.filter_sql(v_table, p_request -> 'filters')) into v_out;
  else
    raise exception 'ghost can''t run a % on a table.', v_method using errcode = '0A000';
  end if;
  return v_out;
end;
$function$;

create or replace function ghost.table_read(p_request jsonb)
returns jsonb language plpgsql security definer as $function$
declare
  v_table text := p_request ->> 'table';
  v_cols text := coalesce((select string_agg(pg_catalog.format('x.%I', c), ', ') from jsonb_array_elements_text(p_request -> 'select') c), 'x.*');
  v_order text := (select string_agg(pg_catalog.format('x.%I %s nulls %s', o ->> 'col', case when o ->> 'dir' = 'desc' then 'desc' else 'asc' end,
    case when o ->> 'nulls' = 'first' then 'first' when o ->> 'nulls' = 'last' then 'last'
      when o ->> 'dir' = 'desc' then 'first' else 'last' end), ', ') from jsonb_array_elements(coalesce(p_request -> 'order', '[]'::jsonb)) o);
  v_out jsonb;
begin
  if v_table is null or pg_catalog.to_regclass(pg_catalog.format('public.%I', v_table)) is null then
    raise exception 'Could not find the table public.% in the schema cache', v_table using errcode = 'PGRST205';
  end if;
  execute pg_catalog.format('select coalesce(jsonb_agg(to_jsonb(s)), ''[]'') from (select %s from public.%I x where %s%s%s%s) s',
    v_cols, v_table, ghost.filter_sql(v_table, p_request -> 'filters'),
    case when v_order is not null then ' order by ' || v_order else '' end,
    case when p_request ? 'limit' then pg_catalog.format(' limit %s', (p_request ->> 'limit')::int) else '' end,
    case when p_request ? 'offset' then pg_catalog.format(' offset %s', (p_request ->> 'offset')::int) else '' end) into v_out;
  return v_out;
end;
$function$;

-- Deferred checks the write queued, all but ghost's own never-commit trigger.
create or replace function ghost.deferred_checks()
returns void language plpgsql security definer set search_path = '' as $function$
declare
  v_list text := (select string_agg(pg_catalog.format('%I.%I', n.nspname, c.conname), ', ')
    from pg_catalog.pg_constraint c join pg_catalog.pg_namespace n on n.oid = c.connamespace
    where c.condeferrable and not (n.nspname = 'ghost' and c.conname = 'never_commits'));
begin
  if v_list is not null then
    execute 'set constraints ' || v_list || ' immediate';
  end if;
end;
$function$;

create or replace function ghost.error(p_state text, p_message text, p_detail text, p_hint text)
returns jsonb language sql immutable set search_path = '' as $function$
  select jsonb_build_object('error', jsonb_build_object('code', p_state, 'message', p_message, 'details', nullif(p_detail, ''), 'hint', nullif(p_hint, '')));
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Branch migrations: migrations your branch has and the database doesn't, run first inside the same rolled-back run so
-- the request sees what they add. The client strips transaction control and skips speed-only index builds; this
-- refuses, again, anything whose effect would outlive the rollback.

create or replace function ghost.branch_migrations(p_migrations jsonb)
returns void language plpgsql security definer as $function$
declare
  m jsonb;
begin
  if p_migrations is null or jsonb_typeof(p_migrations) <> 'array' or jsonb_array_length(p_migrations) = 0 then
    return;
  end if;
  for m in select value from jsonb_array_elements(p_migrations) loop
    if (m ->> 'sql') ~* '(pg_advisory_(un)?lock(_shared)?\s*\(|\mdblink\M|\mlo_(import|export)\s*\(|\malter\s+system\M|\mset\s+(local\s+)?role\M|\msession\s+authorization\M|\mcopy\M[^;]*\mprogram\M)' then
      raise exception 'Branch migration % does something that would outlive the ghost run.', m ->> 'file' using errcode = '0A000';
    end if;
    begin
      execute m ->> 'sql';
    exception when others then
      raise exception 'Branch migration % failed: %', m ->> 'file', sqlerrm using errcode = sqlstate;
    end;
  end loop;
  perform ghost.install();
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Runners

-- Opens a run in the caller's own transaction, for clients that hold a real connection (node-postgres, postgres.js):
-- begin; select ghost.open_run(...); <your statements>; select ghost.close_run(); rollback;
-- The replay marker goes in first, so that transaction can never commit even if the client tries.
create or replace function ghost.open_run(p_changes jsonb default '[]', p_migrations jsonb default null, p_capture boolean default true)
returns void language plpgsql security definer as $function$
begin
  perform pg_catalog.set_config('lock_timeout', '200ms', true);
  perform ghost.replay_lock();
  create temp table if not exists ghost_changes (seq bigserial, tbl text, op text, pk jsonb, old_row jsonb, new_row jsonb) on commit drop;
  perform ghost.branch_migrations(p_migrations);
  perform ghost.apply_changes(p_changes);
  perform pg_catalog.set_config('ghost.capture', case when p_capture then 'on' else 'off' end, true);
end;
$function$;

create or replace function ghost.close_run()
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_changes jsonb;
begin
  perform pg_catalog.set_config('ghost.capture', 'off', true);
  if pg_catalog.to_regclass('pg_temp.ghost_changes') is null then
    return '[]'::jsonb;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('table', tbl, 'op', op, 'pk', pk, 'old', old_row, 'new', new_row) order by seq), '[]')
    into v_changes from pg_temp.ghost_changes;
  return v_changes;
end;
$function$;

-- One write over HTTP: the session's earlier changes, then the write with capture on, then every deferred check, then
-- a rollback that keeps only the answer and the rows it changed.
create or replace function public.ghost_run(p_changes jsonb, p_request jsonb)
returns jsonb language plpgsql security definer as $function$
declare
  v_result jsonb;
  v_out jsonb;
  v_state text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  perform pg_catalog.set_config('statement_timeout', '5s', true);
  begin
    perform pg_catalog.set_config('ghost.dispatch', ghost.dispatch_token(), true);
    perform ghost.open_run(p_changes, p_request -> 'migrations', false);
    perform pg_catalog.set_config('ghost.capture', 'on', true);
    v_result := case p_request ->> 'kind'
      when 'rpc' then ghost.call_rpc(p_request ->> 'name', p_request -> 'args')
      when 'table' then ghost.table_write(p_request) end;
    perform pg_catalog.set_config('ghost.capture', 'off', true);
    perform ghost.deferred_checks();
    v_out := jsonb_build_object('result', v_result, 'changes', ghost.close_run());
    raise exception using errcode = 'GHOST', message = 'ghost';
  exception
    when sqlstate 'GHOST' then
      return v_out;
    when others then
      get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail, v_hint = pg_exception_hint;
      return ghost.error(v_state, v_message, v_detail, v_hint);
  end;
end;
$function$;

-- One read that sees the session: its changes replayed (no triggers), the read, then a rollback.
create or replace function public.ghost_read(p_changes jsonb, p_request jsonb)
returns jsonb language plpgsql security definer as $function$
declare
  v_out jsonb;
  v_state text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  perform pg_catalog.set_config('statement_timeout', '5s', true);
  begin
    perform pg_catalog.set_config('ghost.dispatch', ghost.dispatch_token(), true);
    perform ghost.open_run(p_changes, p_request -> 'migrations', false);
    v_out := jsonb_build_object('result', case p_request ->> 'kind'
      when 'rpc' then ghost.call_rpc(p_request ->> 'name', p_request -> 'args')
      -- Only the branch migrations: how the client asks whether a heavy one can get its lock yet.
      when 'migrations' then 'null'::jsonb
      else ghost.table_read(p_request) end);
    raise exception using errcode = 'GHOST', message = 'ghost';
  exception
    when sqlstate 'GHOST' then
      return v_out;
    when others then
      get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail, v_hint = pg_exception_hint;
      return ghost.error(v_state, v_message, v_detail, v_hint);
  end;
end;
$function$;

-- What the read patcher needs: every public table and view, with primary keys.
create or replace function public.ghost_relations()
returns jsonb language sql stable security definer set search_path = '' as $function$
  select coalesce(jsonb_object_agg(c.relname, jsonb_build_object('kind', case c.relkind when 'v' then 'view' when 'm' then 'view' else 'table' end,
    'pk', coalesce((select jsonb_agg(a.attname order by array_position(i.indkey, a.attnum))
      from pg_catalog.pg_index i join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
      where i.indrelid = c.oid and i.indisprimary), '[]'::jsonb))), '{}'::jsonb)
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm');
$function$;

-- Which migrations the database has, from Supabase's ledger; empty when there is none.
create or replace function public.ghost_applied_migrations()
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  v_out jsonb;
begin
  if pg_catalog.to_regclass('supabase_migrations.schema_migrations') is null then
    return '[]'::jsonb;
  end if;
  execute 'select coalesce(jsonb_agg(jsonb_build_object(''version'', version, ''name'', name) order by version), ''[]'') '
    || 'from supabase_migrations.schema_migrations' into v_out;
  return v_out;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Session log, for deployments: one person's session, kept across requests and servers, ignored after 12 h idle.

create table if not exists ghost.sessions (
  id text primary key,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create table if not exists ghost.entries (
  session_id text not null references ghost.sessions (id) on delete cascade,
  seq bigserial,
  kind text not null check (kind in ('write', 'held')),
  entry jsonb not null,
  at timestamptz not null default now(),
  primary key (session_id, seq)
);
revoke all on table ghost.sessions, ghost.entries from public;

create or replace function public.ghost_log_add(p_session text, p_kind text, p_entry jsonb)
returns void language plpgsql security definer set search_path = '' as $function$
begin
  delete from ghost.sessions where last_seen_at < now() - interval '12 hours';
  insert into ghost.sessions (id) values (p_session) on conflict (id) do update set last_seen_at = now();
  insert into ghost.entries (session_id, kind, entry) values (p_session, p_kind, p_entry);
end;
$function$;

create or replace function public.ghost_log_entries(p_session text)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select jsonb_build_object(
    'startedAt', (select s.started_at from ghost.sessions s where s.id = p_session and s.last_seen_at > now() - interval '12 hours'),
    'entries', coalesce((select jsonb_agg(jsonb_build_object('seq', e.seq, 'at', e.at, 'kind', e.kind, 'entry', e.entry) order by e.seq)
      from ghost.entries e join ghost.sessions s on s.id = e.session_id
      where e.session_id = p_session and s.last_seen_at > now() - interval '12 hours'), '[]'::jsonb));
$function$;

create or replace function public.ghost_log_reset(p_session text)
returns void language sql security definer set search_path = '' as $function$
  delete from ghost.entries where session_id = p_session;
  update ghost.sessions set started_at = now(), last_seen_at = now() where id = p_session;
$function$;

create or replace function public.ghost_log_end(p_session text)
returns void language sql security definer set search_path = '' as $function$
  delete from ghost.sessions where id = p_session;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Who may call what. The internals are owner-only; the entry points go to service_role on Supabase.

revoke all on function
  ghost.install_counters(), ghost.install_capture(text, text), ghost.install_guards(text, text), ghost.install(text, text),
  ghost.capture_row(), ghost.columns(text), ghost.pk_where(text, jsonb, text), ghost.apply_changes(jsonb),
  ghost.filter_sql(text, jsonb, text), ghost.call_rpc(text, jsonb), ghost.table_write(jsonb), ghost.table_read(jsonb),
  ghost.deferred_checks(), ghost.branch_migrations(jsonb), ghost.open_run(jsonb, jsonb, boolean), ghost.close_run(),
  public.ghost_run(jsonb, jsonb), public.ghost_read(jsonb, jsonb), public.ghost_relations(), public.ghost_applied_migrations(),
  public.ghost_log_add(text, text, jsonb), public.ghost_log_entries(text), public.ghost_log_reset(text), public.ghost_log_end(text)
  from public;

do $grants$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute pg_catalog.format('revoke all on function public.ghost_run(jsonb, jsonb), public.ghost_read(jsonb, jsonb), '
        || 'public.ghost_relations(), public.ghost_applied_migrations(), public.ghost_log_add(text, text, jsonb), '
        || 'public.ghost_log_entries(text), public.ghost_log_reset(text), public.ghost_log_end(text) from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    grant execute on function public.ghost_run(jsonb, jsonb), public.ghost_read(jsonb, jsonb), public.ghost_relations(),
      public.ghost_applied_migrations(), public.ghost_log_add(text, text, jsonb), public.ghost_log_entries(text),
      public.ghost_log_reset(text), public.ghost_log_end(text) to service_role;
  end if;
end;
$grants$;

notify pgrst, 'reload schema';
commit;
