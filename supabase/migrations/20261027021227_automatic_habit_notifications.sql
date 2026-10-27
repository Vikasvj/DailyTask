begin;

-- Adopt the existing API's table without deleting/replacing notifications.
-- Incompatible types, orphan owners or duplicate event keys abort the migration.
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  title text not null,
  body text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  expires_at timestamptz,
  event_key text
);
alter table public.notifications add column if not exists event_key text;

do $$
declare item record;
begin
  for item in select * from (values
    ('id', 'uuid'), ('user_id', 'uuid'), ('type', 'text'),
    ('title', 'text'), ('body', 'text'), ('data', 'jsonb'),
    ('created_at', 'timestamptz'), ('read_at', 'timestamptz'),
    ('expires_at', 'timestamptz'), ('event_key', 'text')
  ) as required(column_name, type_name)
  loop
    if not exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = 'notifications'
        and c.column_name = item.column_name
        and (c.udt_name = item.type_name or
          (item.type_name = 'text' and c.udt_name = 'varchar'))
    ) then
      raise exception 'Incompatible notifications schema: % must be %. Inspect before applying.',
        item.column_name, item.type_name;
    end if;
  end loop;
end $$;

alter table public.notifications
  alter column id set default gen_random_uuid(), alter column id set not null,
  alter column user_id set not null,
  alter column type set not null, alter column title set not null,
  alter column body set not null,
  alter column data set default '{}'::jsonb,
  alter column created_at set default now(), alter column created_at set not null,
  add constraint habit_notifications_v1_id_unique unique (id),
  add constraint habit_notifications_v1_user_fk foreign key (user_id)
    references auth.users(id) on delete cascade,
  add constraint habit_notifications_v1_event_length check (length(event_key) <= 100),
  add constraint habit_notifications_v1_timestamps check (
    isfinite(created_at) and (read_at is null or isfinite(read_at))
    and (expires_at is null or isfinite(expires_at))
  );

create unique index habit_notifications_v1_user_event_key_idx
  on public.notifications (user_id, event_key);
create index habit_notifications_v1_user_created_idx
  on public.notifications (user_id, created_at desc);
create index habit_notifications_v1_unread_idx
  on public.notifications (user_id) where read_at is null;

alter table public.notifications enable row level security;
-- Keep existing policies; AND this guard with any broader legacy policy.
create policy habit_notifications_v1_owner_guard on public.notifications
  as restrictive for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy habit_notifications_v1_select on public.notifications
  for select to authenticated using ((select auth.uid()) = user_id);
create policy habit_notifications_v1_read on public.notifications
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.notifications from public, anon, authenticated;
-- Remove pre-existing column grants as well as table-level grants.
do $$
declare columns_sql text;
begin
  select string_agg(quote_ident(column_name), ', ') into columns_sql
  from information_schema.columns
  where table_schema = 'public' and table_name = 'notifications';
  execute 'revoke all (' || columns_sql || ') on public.notifications from public, anon, authenticated';
end $$;
grant usage on schema public to authenticated;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

-- Creation is trusted system work: clients cannot INSERT arbitrary messages.
-- The private definer has no arguments, requires auth.uid(), and calculates only
-- that account's real totals. No service-role key or privileged public RPC.
create schema if not exists habit_notifications_private;
revoke all on schema habit_notifications_private from public, anon, authenticated;
grant usage on schema habit_notifications_private to authenticated;

create function habit_notifications_private.generate_daily()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  account_id uuid := auth.uid();
  water_goal integer;
  water_timezone text;
  water_date date;
  water_total bigint;
  step_goal integer;
  step_timezone text;
  v_step_date date;
  step_total integer;
  inserted integer;
  created_count integer := 0;
begin
  if account_id is null then
    raise exception using errcode = '42501', message = 'Authentication required.';
  end if;

  insert into public.notifications (user_id, event_key, type, title, body, data)
  values (account_id, 'welcome:v1', 'welcome', 'Welcome to Daily Habit',
    'Small steps, steady sips. Your daily habits start here.', '{}'::jsonb)
  on conflict (user_id, event_key) do nothing;
  get diagnostics inserted = row_count;
  created_count := created_count + inserted;

  select g.daily_goal_ml, g.timezone into water_goal, water_timezone
    from public.water_goals g where g.user_id = account_id;
  water_goal := coalesce(water_goal, 2000);
  water_timezone := coalesce(water_timezone, 'Asia/Kolkata');
  water_date := (current_timestamp at time zone water_timezone)::date;
  -- Local midnight boundaries remain correct across DST transitions.
  select coalesce(sum(e.amount_ml), 0) into water_total
    from public.water_entries e where e.user_id = account_id
      and e.consumed_at >= (water_date::timestamp at time zone water_timezone)
      and e.consumed_at < ((water_date + 1)::timestamp at time zone water_timezone);
  if water_total >= water_goal then
    insert into public.notifications (user_id, event_key, type, title, body, data)
    values (account_id, 'water-goal:' || water_date::text, 'water_goal',
      'Water goal reached', 'You reached your daily water goal. Every sip counts.',
      jsonb_build_object('date', water_date, 'timezone', water_timezone,
        'total_ml', water_total, 'daily_goal_ml', water_goal))
    on conflict (user_id, event_key) do nothing;
    get diagnostics inserted = row_count;
    created_count := created_count + inserted;
  end if;

  select g.daily_goal, g.timezone into step_goal, step_timezone
    from public.step_goals g where g.user_id = account_id;
  step_goal := coalesce(step_goal, 10000);
  step_timezone := coalesce(step_timezone, 'Asia/Kolkata');
  v_step_date := (current_timestamp at time zone step_timezone)::date;
  select d.steps into step_total from public.daily_steps d
    where d.user_id = account_id and d.step_date = v_step_date;
  if step_total >= step_goal then
    insert into public.notifications (user_id, event_key, type, title, body, data)
    values (account_id, 'step-goal:' || v_step_date::text, 'step_goal',
      'Step goal reached', 'You reached your daily step goal. Keep that momentum.',
      jsonb_build_object('date', v_step_date, 'timezone', step_timezone,
        'steps', step_total, 'daily_goal', step_goal))
    on conflict (user_id, event_key) do nothing;
    get diagnostics inserted = row_count;
    created_count := created_count + inserted;
  end if;

  return created_count;
end $$;

revoke all on function habit_notifications_private.generate_daily()
  from public, anon, authenticated;
grant execute on function habit_notifications_private.generate_daily() to authenticated;

-- Only this invoker wrapper is exposed through PostgREST. Both entry points
-- require the same authenticated caller; neither accepts an owner or message.
create function public.sync_habit_notifications()
returns integer language sql security invoker set search_path = '' as $$
  select habit_notifications_private.generate_daily();
$$;
revoke all on function public.sync_habit_notifications() from public, anon, authenticated;
grant execute on function public.sync_habit_notifications() to authenticated;

notify pgrst, 'reload schema';
commit;
