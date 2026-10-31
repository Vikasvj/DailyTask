import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('FCM migration protects device ownership and enqueues one push per notification', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role;
      create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      create table public.water_goals(user_id uuid primary key, timezone text);
      create table public.step_goals(user_id uuid primary key, timezone text);
      create table public.notifications(
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references auth.users(id), type text not null,
        title text not null, body text not null, data jsonb not null default '{}',
        created_at timestamptz not null default now(), read_at timestamptz,
        expires_at timestamptz, event_key text,
        unique(user_id, event_key)
      );
      insert into auth.users(id) values
        ('00000000-0000-4000-8000-000000000001'),
        ('00000000-0000-4000-8000-000000000002');
    `);
    await db.exec(await readFile(new URL(
      '../supabase/migrations/20261031120000_fcm_devices_and_reminders.sql', import.meta.url,
    ), 'utf8'));

    await db.exec("set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001'");
    const registered = await db.query(
      "select * from public.register_fcm_device('fid_12345678901234567890', 'android')",
    );
    assert.equal(registered.rows[0].user_id, '00000000-0000-4000-8000-000000000001');
    const preferences = await db.query(
      "select timezone from public.notification_preferences where user_id = '00000000-0000-4000-8000-000000000001'",
    );
    assert.equal(preferences.rows[0].timezone, 'Asia/Kolkata');

    await db.exec("set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000002'");
    await assert.rejects(db.query(
      "select * from public.register_fcm_device('fid_12345678901234567890', 'android')",
    ));
    await db.exec("set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001'");
    await db.query(
      "select public.unregister_fcm_device('fid_12345678901234567890')",
    );
    await db.exec("set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000002'");
    await db.query(
      "select * from public.register_fcm_device('fid_12345678901234567890', 'android')",
    );
    const owner = await db.query(
      "select user_id from public.notification_devices where fid = 'fid_12345678901234567890'",
    );
    assert.equal(owner.rows[0].user_id, '00000000-0000-4000-8000-000000000002');

    await db.query(`insert into public.notifications(user_id, type, title, body, event_key)
      values ('00000000-0000-4000-8000-000000000002', 'habit_reminder', 'Habit', 'Do it', 'same-event')`);
    const outbox = await db.query('select notification_id from public.notification_push_outbox');
    assert.equal(outbox.rows.length, 1);
  } finally {
    await db.close();
  }
});
