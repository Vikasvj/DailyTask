import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import test from 'node:test';

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const carol = '33333333-3333-4333-8333-333333333333';
const files = [
  '20261026051059_create_water_tracking.sql',
  '20261026162943_harden_step_tracking.sql',
  '20261027021227_automatic_habit_notifications.sql',
];
const migrations = await Promise.all(files.map((name) =>
  readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8')));
const fixture = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;
const legacyTable = `
  create table public.notifications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    type text not null,
    title text not null,
    body text not null,
    data jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    read_at timestamptz,
    expires_at timestamptz
  );
`;
const upsertSteps = `
  insert into public.daily_steps(user_id, step_date, steps) values ($1, $2, $3)
  on conflict(user_id, step_date) do update set user_id=excluded.user_id,
    step_date=excluded.step_date, steps=excluded.steps returning *
`;

async function prepare(t) {
  const db = await PGlite.create();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec(migrations[0]);
  await db.exec(migrations[1]);
  await db.query('insert into auth.users values ($1), ($2), ($3)', [alice, bob, carol]);
  return db;
}

async function asUser(db, userId, action) {
  await db.exec('set role authenticated');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
  try { return await action(); } finally { await db.exec('reset role'); }
}

const sync = async (db) => (await db.query(
  'select public.sync_habit_notifications() as created_count',
)).rows[0].created_count;
const rows = async (db) => (await db.query(
  'select * from public.notifications order by event_key',
)).rows;
const rejectCode = (db, query, values, code = '42501') =>
  assert.rejects(() => db.query(query, values), (cause) => cause.code === code);
const localDate = async (db, timezone) => (await db.query(
  "select (current_timestamp at time zone $1)::date::text as day", [timezone],
)).rows[0].day;

test('automatic notifications use actual daily totals and are idempotent', async (t) => {
  const db = await prepare(t);
  await db.exec(migrations[2]);
  const day = await localDate(db, 'Asia/Kolkata');
  let welcome;
  let water;
  let steps;

  await asUser(db, alice, async () => {
    await t.test('first authenticated evaluation creates one welcome; retry creates none', async () => {
      assert.equal(await sync(db), 1);
      [welcome] = await rows(db);
      assert.equal(welcome.user_id, alice);
      assert.equal(welcome.type, 'welcome');
      assert.equal(welcome.event_key, 'welcome:v1');
      assert.deepEqual(welcome.data, {});
      assert.equal(welcome.read_at, null);
      assert.ok(welcome.title && welcome.body && welcome.created_at && welcome.id);
      assert.equal(await sync(db), 0);
      assert.equal((await rows(db))[0].id, welcome.id);
    });

    await t.test('below-goal persisted sensor and water totals create no achievement', async () => {
      await db.query(`insert into public.water_entries(user_id,amount_ml,consumed_at)
        values ($1,1000,($2::date + time '12:00') at time zone 'Asia/Kolkata')`, [alice, day]);
      await db.query(upsertSteps, [alice, day, 9999]);
      assert.equal(await sync(db), 0);
      assert.equal((await rows(db)).length, 1);
    });

    await t.test('meeting default goals creates exactly one achievement per habit/date', async () => {
      await db.query(`insert into public.water_entries(user_id,amount_ml,consumed_at)
        values ($1,1000,($2::date + time '13:00') at time zone 'Asia/Kolkata')`, [alice, day]);
      await db.query(upsertSteps, [alice, day, 10000]);
      assert.equal(await sync(db), 2);
      const notifications = await rows(db);
      assert.equal(notifications.length, 3);
      water = notifications.find((item) => item.type === 'water_goal');
      steps = notifications.find((item) => item.type === 'step_goal');
      assert.equal(water.event_key, 'water-goal:' + day);
      assert.equal(steps.event_key, 'step-goal:' + day);
      assert.deepEqual(water.data, {
        date: day, timezone: 'Asia/Kolkata', total_ml: 2000, daily_goal_ml: 2000,
      });
      assert.deepEqual(steps.data, {
        date: day, timezone: 'Asia/Kolkata', steps: 10000, daily_goal: 10000,
      });
      assert.ok(water.title && water.body && steps.title && steps.body);
      assert.equal(water.read_at, null);
      assert.equal(steps.read_at, null);
      assert.equal(await sync(db), 0);
    });

    await t.test('read state and achievement snapshots survive stale retries and changed goals', async () => {
      await db.query('update public.notifications set read_at=now() where id=$1', [water.id]);
      const readAt = (await db.query('select read_at from public.notifications where id=$1', [water.id])).rows[0].read_at;
      const stale = (await db.query(upsertSteps, [alice, day, 5])).rows[0];
      assert.equal(stale.steps, 10000);
      await db.query(`insert into public.water_entries(user_id,amount_ml,consumed_at)
        values ($1,500,($2::date + time '14:00') at time zone 'Asia/Kolkata')`, [alice, day]);
      await db.query('insert into public.water_goals(user_id,daily_goal_ml) values ($1,1000)', [alice]);
      await db.query('insert into public.step_goals(user_id,daily_goal) values ($1,5000)', [alice]);
      assert.equal(await sync(db), 0);
      await db.query('update public.water_goals set daily_goal_ml=5000 where user_id=$1', [alice]);
      await db.query('update public.step_goals set daily_goal=20000 where user_id=$1', [alice]);
      assert.equal(await sync(db), 0);
      const notifications = await rows(db);
      assert.equal(notifications.length, 3);
      const currentWater = notifications.find((item) => item.id === water.id);
      assert.equal(+currentWater.read_at, +readAt);
      assert.deepEqual(currentWater.data, water.data);
      assert.deepEqual(notifications.find((item) => item.id === steps.id).data, steps.data);
    });

    await t.test('changing timezone without changing the date cannot duplicate achievements', async () => {
      // Kolkata and Colombo have the same UTC offset throughout the year.
      await db.query("update public.water_goals set daily_goal_ml=1,timezone='Asia/Colombo' where user_id=$1", [alice]);
      await db.query("update public.step_goals set daily_goal=1,timezone='Asia/Colombo' where user_id=$1", [alice]);
      assert.equal(await localDate(db, 'Asia/Colombo'), day);
      assert.equal(await sync(db), 0);
      assert.equal((await rows(db)).length, 3);
    });
  });

  await asUser(db, bob, async () => {
    const timezone = 'America/New_York';
    const bobDay = await localDate(db, timezone);
    await t.test('new goals use account-local boundaries and exclude old/future entries', async () => {
      await db.query('insert into public.water_goals(user_id,daily_goal_ml,timezone) values ($1,100,$2)', [bob, timezone]);
      await db.query('insert into public.step_goals(user_id,daily_goal,timezone) values ($1,10,$2)', [bob, timezone]);
      await db.query(`insert into public.water_entries(user_id,amount_ml,consumed_at) values
        ($1,10000,($2::date::timestamp at time zone $3)-interval '1 microsecond'),
        ($1,10000,(($2::date+1)::timestamp at time zone $3)),
        ($1,40,($2::date::timestamp at time zone $3)),
        ($1,59,(($2::date+1)::timestamp at time zone $3)-interval '1 microsecond')`, [bob, bobDay, timezone]);
      const yesterday = (await db.query('select ($1::date-1)::text as day', [bobDay])).rows[0].day;
      await db.query(upsertSteps, [bob, yesterday, 20000]);
      assert.equal(await sync(db), 1);
      assert.deepEqual((await rows(db)).map((item) => item.type), ['welcome']);
      await db.query(`insert into public.water_entries(user_id,amount_ml,consumed_at)
        values ($1,1,($2::date + time '12:00') at time zone $3)`, [bob, bobDay, timezone]);
      await db.query(upsertSteps, [bob, bobDay, 10]);
      assert.equal(await sync(db), 2);
      const notifications = await rows(db);
      assert.deepEqual(notifications.find((item) => item.type === 'water_goal').data, {
        date: bobDay, timezone, total_ml: 100, daily_goal_ml: 100,
      });
      assert.deepEqual(notifications.find((item) => item.type === 'step_goal').data, {
        date: bobDay, timezone, steps: 10, daily_goal: 10,
      });
      assert.equal(await sync(db), 0);
    });

    await t.test('another owner cannot read or mark Alice notifications', async () => {
      assert.ok((await rows(db)).every((item) => item.user_id === bob));
      assert.equal((await db.query('select * from public.notifications where user_id=$1', [alice])).rows.length, 0);
      assert.equal((await db.query('update public.notifications set read_at=now() where id=$1 returning id', [steps.id])).rows.length, 0);
    });

    await t.test('clients cannot forge events, alter content/ownership or delete notifications', async () => {
      await rejectCode(db, `insert into public.notifications(user_id,type,title,body,event_key)
        values ($1,'welcome','Forged','Forged','forged')`, [bob]);
      await rejectCode(db, "update public.notifications set title='Changed'", []);
      await rejectCode(db, 'update public.notifications set user_id=$1', [alice]);
      await rejectCode(db, "update public.notifications set event_key='forged'", []);
      await rejectCode(db, "update public.notifications set data='{}'::jsonb", []);
      await rejectCode(db, 'update public.notifications set created_at=now()', []);
      await rejectCode(db, 'delete from public.notifications', []);
    });
  });

  await t.test('no subject and anonymous calls cannot generate notifications', async () => {
    await asUser(db, '', async () => {
      await rejectCode(db, 'select public.sync_habit_notifications()', []);
      assert.equal((await rows(db)).length, 0);
    });
    await db.exec('set role anon');
    try {
      await rejectCode(db, 'select public.sync_habit_notifications()', []);
      await rejectCode(db, 'select * from public.notifications', []);
    } finally { await db.exec('reset role'); }
  });

  await t.test('only the narrowly scoped private generator has definer privileges', async () => {
    const functions = (await db.query(`select n.nspname,p.proname,p.prosecdef,p.proconfig
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where (n.nspname='public' and p.proname='sync_habit_notifications')
        or (n.nspname='habit_notifications_private' and p.proname='generate_daily')`)).rows;
    assert.equal(functions.length, 2);
    assert.equal(functions.find((item) => item.nspname === 'public').prosecdef, false);
    assert.equal(functions.find((item) => item.nspname === 'habit_notifications_private').prosecdef, true);
    assert.ok(functions.every((item) => item.proconfig?.some((value) => value.startsWith('search_path='))));
    const grants = (await db.query(`select
      has_function_privilege('anon','public.sync_habit_notifications()','EXECUTE') as anon_public,
      has_function_privilege('anon','habit_notifications_private.generate_daily()','EXECUTE') as anon_private,
      has_table_privilege('authenticated','public.notifications','INSERT') as direct_insert,
      has_table_privilege('authenticated','public.notifications','DELETE') as direct_delete`)).rows[0];
    assert.deepEqual(grants, { anon_public: false, anon_private: false, direct_insert: false, direct_delete: false });
  });

  await t.test('unique user/event key prevents duplicate rows even outside evaluator', async () => {
    await rejectCode(db, `insert into public.notifications(user_id,type,title,body,event_key)
      values ($1,'welcome','Duplicate','Duplicate','welcome:v1')`, [alice], '23505');
    assert.equal((await db.query('select * from public.notifications where user_id=$1', [alice])).rows.length, 3);
  });

  await t.test('deleting one Auth account cascades only its own notifications', async () => {
    await db.query('delete from auth.users where id=$1', [alice]);
    const remaining = await rows(db);
    assert.equal(remaining.length, 3);
    assert.ok(remaining.every((item) => item.user_id === bob));
  });
});

test('notifications migration adopts compatible records and retains legacy policies safely', async (t) => {
  const db = await prepare(t);
  await db.exec(legacyTable);
  await db.exec(`alter table public.notifications enable row level security;
    create policy legacy_notifications_policy on public.notifications for all to authenticated
      using(true) with check(true);
    grant update(title),insert(user_id,type,title,body) on public.notifications to authenticated;`);
  const legacy = (await db.query(`insert into public.notifications(user_id,type,title,body,data,read_at)
    values ($1,'system','Existing title','Existing body','{"legacy":true}',now()) returning *`, [alice])).rows[0];
  await db.exec(migrations[2]);
  const saved = (await db.query('select * from public.notifications where id=$1', [legacy.id])).rows[0];
  for (const field of ['id', 'user_id', 'type', 'title', 'body']) assert.equal(saved[field], legacy[field]);
  assert.equal(+saved.read_at, +legacy.read_at);
  assert.equal(+saved.created_at, +legacy.created_at);
  assert.deepEqual(saved.data, legacy.data);
  assert.equal(saved.event_key, null);
  assert.equal((await db.query("select * from pg_policies where policyname='legacy_notifications_policy'")).rows.length, 1);
  await asUser(db, bob, async () => {
    assert.equal((await rows(db)).length, 0);
    assert.equal((await db.query('update public.notifications set read_at=now() where id=$1 returning id', [legacy.id])).rows.length, 0);
    await rejectCode(db, "update public.notifications set title='forged'", []);
    await rejectCode(db, `insert into public.notifications(user_id,type,title,body)
      values ($1,'system','forged','forged')`, [bob]);
    assert.equal(await sync(db), 1);
  });
  await asUser(db, alice, async () => {
    assert.equal(await sync(db), 1);
    assert.equal((await rows(db)).length, 2);
  });
});

test('incompatible existing notification schema aborts without changing data', async (t) => {
  const db = await prepare(t);
  await db.exec(legacyTable.replace('title text not null', 'title integer not null'));
  await db.query(`insert into public.notifications(user_id,type,title,body)
    values ($1,'system',42,'Preserve me')`, [alice]);
  await assert.rejects(() => db.exec(migrations[2]));
  await db.exec('rollback');
  assert.equal((await rowsWithoutKey(db))[0].title, 42);
  assert.equal((await db.query(`select * from information_schema.columns
    where table_schema='public' and table_name='notifications' and column_name='event_key'`)).rows.length, 0);
  assert.equal((await db.query("select to_regprocedure('public.sync_habit_notifications()') as fn")).rows[0].fn, null);
});

test('duplicate existing event keys abort rather than deleting or deduplicating data', async (t) => {
  const db = await prepare(t);
  await db.exec(legacyTable);
  await db.exec('alter table public.notifications add column event_key text');
  await db.query(`insert into public.notifications(user_id,type,title,body,event_key) values
    ($1,'welcome','First','Keep first','welcome:v1'),
    ($1,'welcome','Second','Keep second','welcome:v1')`, [alice]);
  await assert.rejects(() => db.exec(migrations[2]), (cause) => cause.code === '23505');
  await db.exec('rollback');
  assert.equal((await rows(db)).length, 2);
});

async function rowsWithoutKey(db) {
  return (await db.query('select * from public.notifications')).rows;
}
