begin;

-- Validate named PostgreSQL/IANA timezones without bypassing caller permissions.
create function public.is_valid_water_timezone(value text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1 from pg_catalog.pg_timezone_names as zone
    where zone.name = value
  );
$$;

revoke all on function public.is_valid_water_timezone(text) from public, anon;
grant execute on function public.is_valid_water_timezone(text) to authenticated;

create table public.water_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid()
    references auth.users(id) on delete cascade,
  amount_ml integer not null,
  consumed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint water_entries_amount_positive check (amount_ml > 0),
  constraint water_entries_consumed_at_finite check (isfinite(consumed_at))
);

create index water_entries_user_consumed_id_idx
  on public.water_entries (user_id, consumed_at desc, id desc);

create table public.water_goals (
  user_id uuid primary key default auth.uid()
    references auth.users(id) on delete cascade,
  daily_goal_ml integer not null default 2000,
  timezone text not null default 'Asia/Kolkata',
  constraint water_goals_amount_positive check (daily_goal_ml > 0),
  constraint water_goals_timezone_valid check (public.is_valid_water_timezone(timezone))
);

alter table public.water_entries enable row level security;
alter table public.water_goals enable row level security;

create policy water_entries_select_own on public.water_entries
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy water_entries_insert_own on public.water_entries
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy water_entries_update_own on public.water_entries
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy water_entries_delete_own on public.water_entries
  for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy water_goals_select_own on public.water_goals
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy water_goals_insert_own on public.water_goals
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy water_goals_update_own on public.water_goals
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Explicit grants are needed even when a project's Data API defaults change.
revoke all on table public.water_entries, public.water_goals
  from public, anon, authenticated;

grant usage on schema public to authenticated;
grant select, delete on table public.water_entries to authenticated;
grant insert (user_id, amount_ml, consumed_at)
  on public.water_entries to authenticated;
grant update (amount_ml, consumed_at)
  on public.water_entries to authenticated;

grant select on table public.water_goals to authenticated;
grant insert (user_id, daily_goal_ml, timezone)
  on public.water_goals to authenticated;
-- PostgREST upserts include the conflict column in their UPDATE statement.
-- The WITH CHECK policy still forbids transferring ownership.
grant update (user_id, daily_goal_ml, timezone)
  on public.water_goals to authenticated;

-- Dates are local calendar dates. The ending date is exclusive.
-- No arguments means today in the account timezone.
-- Limit to one calendar month (31 days) so callers cannot request unbounded work.
create function public.water_daily_totals(
  p_start_date date default null,
  p_end_date date default null
)
returns table (
  day date,
  timezone text,
  start_at timestamptz,
  end_at timestamptz,
  total_ml bigint,
  entry_count bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_timezone text;
  v_start date;
  v_end date;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required.';
  end if;

  select coalesce(
    (select goal.timezone from public.water_goals as goal where goal.user_id = v_user_id),
    'Asia/Kolkata'
  ) into v_timezone;

  v_start := coalesce(p_start_date, (now() at time zone v_timezone)::date);
  v_end := coalesce(p_end_date, v_start + 1);

  if not isfinite(v_start) or not isfinite(v_end) then
    raise exception using errcode = '22023', message = 'Dates must be finite.';
  end if;
  if v_end <= v_start or v_end - v_start > 31 then
    raise exception using errcode = '22023', message = 'Date range must contain 1 to 31 days.';
  end if;

  return query
  with days as (
    select v_start + series.day_number as local_day
    from pg_catalog.generate_series(0, v_end - v_start - 1) as series(day_number)
  ),
  totals as (
    select
      (entry.consumed_at at time zone v_timezone)::date as local_day,
      sum(entry.amount_ml) as intake_ml,
      count(*) as intake_count
    from public.water_entries as entry
    where entry.user_id = v_user_id
      and entry.consumed_at >= (v_start::timestamp at time zone v_timezone)
      and entry.consumed_at < (v_end::timestamp at time zone v_timezone)
    group by (entry.consumed_at at time zone v_timezone)::date
  )
  select
    days.local_day,
    v_timezone,
    days.local_day::timestamp at time zone v_timezone,
    (days.local_day + 1)::timestamp at time zone v_timezone,
    coalesce(totals.intake_ml, 0::bigint),
    coalesce(totals.intake_count, 0::bigint)
  from days
  left join totals on totals.local_day = days.local_day
  order by days.local_day;
end;
$$;

revoke all on function public.water_daily_totals(date, date) from public, anon;
grant execute on function public.water_daily_totals(date, date) to authenticated;

commit;

