begin;

-- Adopt compatible existing tables; never delete/deduplicate historical data.
-- Any incompatible columns, invalid rows or duplicates abort this transaction.
create table if not exists public.daily_steps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  step_date date not null,
  steps integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.step_goals (
  user_id uuid primary key default auth.uid(),
  daily_goal integer not null default 10000,
  timezone text not null default 'Asia/Kolkata',
  updated_at timestamptz not null default now()
);
alter table public.daily_steps add column if not exists created_at timestamptz not null default now();
alter table public.daily_steps add column if not exists updated_at timestamptz not null default now();
alter table public.step_goals add column if not exists updated_at timestamptz not null default now();

do $$
declare item record;
begin
  for item in select * from (values
    ('daily_steps', 'id', 'uuid'), ('daily_steps', 'user_id', 'uuid'),
    ('daily_steps', 'step_date', 'date'), ('daily_steps', 'steps', 'int4'),
    ('daily_steps', 'created_at', 'timestamptz'), ('daily_steps', 'updated_at', 'timestamptz'),
    ('step_goals', 'user_id', 'uuid'), ('step_goals', 'daily_goal', 'int4'),
    ('step_goals', 'timezone', 'text'), ('step_goals', 'updated_at', 'timestamptz')
  ) as required(table_name, column_name, type_name)
  loop
    if not exists (select 1 from information_schema.columns c where c.table_schema = 'public'
      and c.table_name = item.table_name and c.column_name = item.column_name and c.udt_name = item.type_name) then
      raise exception 'Incompatible steps schema: %.% must be %. Inspect before applying.',
        item.table_name, item.column_name, item.type_name;
    end if;
  end loop;
end $$;

alter table public.daily_steps
  alter column id set default gen_random_uuid(), alter column id set not null,
  alter column user_id set default auth.uid(), alter column user_id set not null,
  alter column step_date set not null, alter column steps set not null,
  alter column created_at set default now(), alter column created_at set not null,
  alter column updated_at set default now(), alter column updated_at set not null,
  add constraint steps_v1_daily_id_unique unique (id),
  add constraint steps_v1_daily_user_date_unique unique (user_id, step_date),
  add constraint steps_v1_daily_user_fk foreign key (user_id) references auth.users(id) on delete cascade,
  add constraint steps_v1_daily_count check (steps between 0 and 200000),
  add constraint steps_v1_daily_date check (isfinite(step_date) and step_date between date '0001-01-01' and date '9998-12-31'),
  add constraint steps_v1_daily_timestamps check (isfinite(created_at) and isfinite(updated_at));

create function public.steps_v1_valid_timezone(value text)
returns boolean language sql stable security invoker set search_path = '' as $$
  select length(value) <= 100 and (value = 'UTC' or position('/' in value) > 0)
    and exists (select 1 from pg_catalog.pg_timezone_names where name = value);
$$;

alter table public.step_goals
  alter column user_id set default auth.uid(), alter column user_id set not null,
  alter column daily_goal set default 10000, alter column daily_goal set not null,
  alter column timezone set default 'Asia/Kolkata', alter column timezone set not null,
  alter column updated_at set default now(), alter column updated_at set not null,
  add constraint steps_v1_goal_user_unique unique (user_id),
  add constraint steps_v1_goal_user_fk foreign key (user_id) references auth.users(id) on delete cascade,
  add constraint steps_v1_goal_count check (daily_goal between 1 and 200000),
  add constraint steps_v1_goal_timezone check (public.steps_v1_valid_timezone(timezone)),
  add constraint steps_v1_goal_timestamp check (isfinite(updated_at));

-- ON CONFLICT locks the conflicting row before this UPDATE trigger runs.
-- Taking the maximum here is atomic, including concurrent/out-of-order clients.
-- A repeated/lower total also preserves updated_at. Counts are aggregates, not deltas.
create function public.steps_v1_guard_daily()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare account_timezone text;
begin
  if new.steps is null or new.steps < 0 or new.steps > 200000 then
    raise exception 'Invalid daily step count' using errcode = '23514';
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
create trigger zz_steps_v1_guard_daily before insert or update on public.daily_steps
  for each row execute function public.steps_v1_guard_daily();

create function public.steps_v1_touch_goal()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then
    raise exception 'Step goal owner is immutable' using errcode = '23514';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end $$;
create trigger zz_steps_v1_touch_goal before insert or update on public.step_goals
  for each row execute function public.steps_v1_touch_goal();

alter table public.daily_steps enable row level security;
alter table public.step_goals enable row level security;
-- Restrictive policies AND with existing permissive policies. Keep existing
-- policies intact while preventing any of them from exposing another owner.
create policy steps_v1_daily_owner_guard on public.daily_steps as restrictive for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy steps_v1_goal_owner_guard on public.step_goals as restrictive for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy steps_v1_daily_select on public.daily_steps for select to authenticated using ((select auth.uid()) = user_id);
create policy steps_v1_daily_insert on public.daily_steps for insert to authenticated with check ((select auth.uid()) = user_id);
create policy steps_v1_daily_update on public.daily_steps for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy steps_v1_goal_select on public.step_goals for select to authenticated using ((select auth.uid()) = user_id);
create policy steps_v1_goal_insert on public.step_goals for insert to authenticated with check ((select auth.uid()) = user_id);
create policy steps_v1_goal_update on public.step_goals for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

revoke all on public.daily_steps, public.step_goals from public, anon, authenticated;
-- Table-level REVOKE alone does not remove pre-existing column grants.
revoke all (id, user_id, step_date, steps, created_at, updated_at) on public.daily_steps from public, anon, authenticated;
revoke all (user_id, daily_goal, timezone, updated_at) on public.step_goals from public, anon, authenticated;
grant usage on schema public to authenticated;
grant select on public.daily_steps, public.step_goals to authenticated;
grant insert (user_id, step_date, steps) on public.daily_steps to authenticated;
-- PostgREST merge-duplicates includes the conflict columns in its UPDATE.
grant update (user_id, step_date, steps) on public.daily_steps to authenticated;
grant insert (user_id, daily_goal, timezone) on public.step_goals to authenticated;
grant update (daily_goal, timezone) on public.step_goals to authenticated;
revoke all on function public.steps_v1_valid_timezone(text), public.steps_v1_guard_daily(), public.steps_v1_touch_goal()
  from public, anon, authenticated;
grant execute on function public.steps_v1_valid_timezone(text) to authenticated;

notify pgrst, 'reload schema';
commit;
