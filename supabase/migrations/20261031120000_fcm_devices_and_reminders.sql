begin;
create table if not exists public.notification_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  fid text not null unique,
  platform text not null check (platform in ('android', 'ios', 'web')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  constraint notification_devices_fid_length check (length(fid) between 20 and 4096)
);
create index if not exists notification_devices_user_active_idx
  on public.notification_devices(user_id, last_used_at desc) where is_active;
alter table public.notification_devices enable row level security;
revoke all on public.notification_devices from public, anon, authenticated;
grant all on public.notification_devices to service_role;

create or replace function public.register_fcm_device(p_fid text, p_platform text)
returns table(id uuid, user_id uuid, platform text, updated_at timestamptz)
language plpgsql security definer set search_path = pg_catalog, public as $$
declare actor uuid := auth.uid();
begin
  if actor is null then raise exception using errcode = '42501'; end if;
  if p_fid is null or length(p_fid) not between 20 and 4096
     or p_platform not in ('android', 'ios', 'web') then
    raise exception using errcode = '22023';
  end if;
  return query
    insert into public.notification_devices as d
      (user_id, fid, platform, is_active, updated_at, last_used_at)
    values (actor, p_fid, p_platform, true, now(), now())
    on conflict (fid) do update set
      user_id = actor, platform = excluded.platform, is_active = true,
      updated_at = now(), last_used_at = now()
    where d.user_id = actor or not d.is_active
    returning d.id, d.user_id, d.platform, d.updated_at;
  if not found then raise exception using errcode = '23505'; end if;
end $$;
revoke all on function public.register_fcm_device(text, text) from public, anon;
grant execute on function public.register_fcm_device(text, text) to authenticated;

create or replace function public.unregister_fcm_device(p_fid text)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare actor uuid := auth.uid();
begin
  if actor is null then raise exception using errcode = '42501'; end if;
  if p_fid is null or length(p_fid) not between 20 and 4096 then
    raise exception using errcode = '22023';
  end if;
  update public.notification_devices d set is_active = false, updated_at = now()
    where d.user_id = actor and d.fid = p_fid and d.is_active;
  return found;
end $$;
revoke all on function public.unregister_fcm_device(text) from public, anon;
grant execute on function public.unregister_fcm_device(text) to authenticated;

create table if not exists public.notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  timezone text not null default 'Asia/Kolkata',
  habit_reminders_enabled boolean not null default true,
  habit_reminder_time time not null default '09:00',
  water_reminders_enabled boolean not null default true,
  water_reminder_times time[] not null default array['10:00'::time, '14:00'::time, '18:00'::time],
  steps_reminders_enabled boolean not null default true,
  steps_reminder_time time not null default '19:00',
  updated_at timestamptz not null default now(),
  constraint notification_preferences_timezone_length check (length(timezone) between 1 and 100),
  constraint notification_preferences_water_times_count check (cardinality(water_reminder_times) <= 8)
);
alter table public.notification_preferences enable row level security;
drop policy if exists notification_preferences_owner on public.notification_preferences;
create policy notification_preferences_owner on public.notification_preferences
  for all to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
revoke all on public.notification_preferences from public, anon;
grant select, insert, update on public.notification_preferences to authenticated;
grant all on public.notification_preferences to service_role;

create or replace function public.create_device_reminder_preferences()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare tz text;
begin
  select coalesce(
    (select g.timezone from public.water_goals g where g.user_id = new.user_id),
    (select g.timezone from public.step_goals g where g.user_id = new.user_id),
    'Asia/Kolkata'
  ) into tz;
  insert into public.notification_preferences(user_id, timezone)
    values (new.user_id, tz) on conflict (user_id) do nothing;
  return new;
end $$;
revoke all on function public.create_device_reminder_preferences() from public, anon, authenticated;
drop trigger if exists notification_device_default_preferences on public.notification_devices;
create trigger notification_device_default_preferences after insert on public.notification_devices
for each row execute function public.create_device_reminder_preferences();

create or replace function public.validate_notification_timezone()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception using errcode = '22023';
  end if;
  return new;
end $$;
revoke all on function public.validate_notification_timezone() from public, anon, authenticated;
drop trigger if exists notification_preferences_timezone_valid on public.notification_preferences;
create trigger notification_preferences_timezone_valid before insert or update of timezone
on public.notification_preferences for each row execute function public.validate_notification_timezone();

create table if not exists public.notification_push_outbox (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null unique references public.notifications(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'processing', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
create index if not exists notification_push_outbox_due_idx
  on public.notification_push_outbox(status, available_at, created_at);
alter table public.notification_push_outbox enable row level security;
revoke all on public.notification_push_outbox from public, anon, authenticated;
grant all on public.notification_push_outbox to service_role;

create table if not exists public.notification_push_deliveries (
  notification_id uuid not null references public.notifications(id) on delete cascade,
  device_id uuid not null references public.notification_devices(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  sent_at timestamptz,
  last_error text,
  primary key (notification_id, device_id)
);
create index if not exists notification_push_deliveries_due_idx
  on public.notification_push_deliveries(notification_id, status, available_at);
alter table public.notification_push_deliveries enable row level security;
revoke all on public.notification_push_deliveries from public, anon, authenticated;
grant all on public.notification_push_deliveries to service_role;

create or replace function public.enqueue_notification_push()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  insert into public.notification_push_outbox(notification_id)
  values (new.id) on conflict (notification_id) do nothing;
  return new;
end $$;
revoke all on function public.enqueue_notification_push() from public, anon, authenticated;
drop trigger if exists notification_push_enqueue on public.notifications;
create trigger notification_push_enqueue after insert on public.notifications
for each row execute function public.enqueue_notification_push();

create or replace function public.claim_notification_pushes(p_limit integer default 100)
returns table(outbox_id uuid, notification_id uuid, user_id uuid, type text,
  title text, body text, data jsonb, attempts integer)
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if p_limit < 1 or p_limit > 500 then raise exception using errcode = '22023'; end if;
  update public.notification_push_outbox set status = 'queued', locked_at = null,
      available_at = now()
    where status = 'processing' and locked_at < now() - interval '10 minutes';
  return query
    with selected as (
      select o.id from public.notification_push_outbox o
      where o.status = 'queued' and o.available_at <= now()
      order by o.created_at for update skip locked limit p_limit
    ), claimed as (
      update public.notification_push_outbox o set status = 'processing',
        locked_at = now(), attempts = o.attempts + 1
      from selected s where o.id = s.id returning o.id, o.notification_id, o.attempts
    )
    select c.id, n.id, n.user_id, n.type, n.title, n.body, n.data, c.attempts
      from claimed c join public.notifications n on n.id = c.notification_id;
end $$;
revoke all on function public.claim_notification_pushes(integer) from public, anon, authenticated;
grant execute on function public.claim_notification_pushes(integer) to service_role;
commit;
