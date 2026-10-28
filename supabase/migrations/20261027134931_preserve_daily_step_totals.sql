begin;

-- Adopt either the existing UUID or BIGINT identity schema without changing
-- tables, IDs, stored rows, ownership policies, or table/sequence privileges.
do $$
declare
  item record;
  step_table oid := pg_catalog.to_regclass('public.daily_steps');
  goal_table oid := pg_catalog.to_regclass('public.step_goals');
  user_column smallint;
  date_column smallint;
begin
  if step_table is null or goal_table is null then
    raise exception 'Step tables are missing. Inspect the existing schema before applying this migration.';
  end if;
  for item in select * from (values
    ('daily_steps', 'user_id', 'uuid'),
    ('daily_steps', 'step_date', 'date'),
    ('daily_steps', 'steps', 'int4'),
    ('daily_steps', 'created_at', 'timestamptz'),
    ('daily_steps', 'updated_at', 'timestamptz'),
    ('step_goals', 'user_id', 'uuid'),
    ('step_goals', 'timezone', 'text')
  ) as required(table_name, column_name, type_name)
  loop
    if not exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = item.table_name
        and c.column_name = item.column_name and c.udt_name = item.type_name
    ) then
      raise exception 'Incompatible steps schema: %.% must be %. No tables were changed.',
        item.table_name, item.column_name, item.type_name;
    end if;
  end loop;
  if not exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = step_table and attname = 'id' and attnum > 0 and not attisdropped
  ) then
    raise exception 'Incompatible steps schema: daily_steps.id is missing.';
  end if;
  select attnum into user_column from pg_catalog.pg_attribute
    where attrelid = step_table and attname = 'user_id' and not attisdropped;
  select attnum into date_column from pg_catalog.pg_attribute
    where attrelid = step_table and attname = 'step_date' and not attisdropped;
  if not exists (
    select 1 from pg_catalog.pg_index i
    where i.indrelid = step_table and i.indisunique and i.indisvalid
      and i.indisready and i.indislive and i.indimmediate
      and i.indnkeyatts = 2 and i.indexprs is null and i.indpred is null
      and ((i.indkey[0] = user_column and i.indkey[1] = date_column)
        or (i.indkey[0] = date_column and i.indkey[1] = user_column))
  ) then
    raise exception 'A usable unique index on daily_steps(user_id, step_date) is required. No tables were changed.';
  end if;
  if exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = step_table and t.tgname = 'zz_steps_v1_guard_daily'
      and (t.tgisinternal or t.tgtype <> 23 or t.tgnargs <> 0
        or t.tgqual is not null or t.tgattr::text <> ''
        or t.tgfoid is distinct from pg_catalog.to_regprocedure('public.steps_v1_guard_daily()'))
  ) then
    raise exception 'Unexpected existing trigger zz_steps_v1_guard_daily. Inspect it before applying this migration.';
  end if;
end $$;

-- ON CONFLICT locks the existing row before its UPDATE trigger runs. Taking
-- the maximum here is atomic for repeated, concurrent and out-of-order totals.
create or replace function public.steps_v1_guard_daily()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare account_timezone text;
begin
  if new.steps is null or new.steps < 0 or new.steps > 200000 then
    raise exception 'Invalid daily step count' using errcode = '23514';
  end if;
  if new.step_date is null or not pg_catalog.isfinite(new.step_date)
    or new.step_date < date '0001-01-01' or new.step_date > date '9998-12-31' then
    raise exception 'Invalid daily step date' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id or new.step_date is distinct from old.step_date
      or new.id is distinct from old.id or new.created_at is distinct from old.created_at then
      raise exception 'Daily step identity is immutable' using errcode = '23514';
    end if;
    new.steps := greatest(old.steps, new.steps);
    new.updated_at := case when new.steps > old.steps then clock_timestamp() else old.updated_at end;
  else
    select timezone into account_timezone from public.step_goals where user_id = new.user_id;
    if new.step_date > (current_timestamp at time zone coalesce(account_timezone, 'Asia/Kolkata'))::date then
      raise exception 'Future step dates are not allowed' using errcode = '23514';
    end if;
    new.created_at := clock_timestamp();
    new.updated_at := new.created_at;
  end if;
  return new;
end $$;

create or replace trigger zz_steps_v1_guard_daily
before insert or update on public.daily_steps
for each row execute function public.steps_v1_guard_daily();

revoke all on function public.steps_v1_guard_daily() from public, anon, authenticated;

commit;
