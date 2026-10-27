import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import test from 'node:test';

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const migration = await readFile(new URL('../supabase/migrations/20261026162943_harden_step_tracking.sql', import.meta.url), 'utf8');
const fixture = `
  create role anon nologin; create role authenticated nologin; create schema auth;
  create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated;
`;
const upsert = `insert into public.daily_steps(user_id, step_date, steps) values ($1, $2, $3)
  on conflict(user_id, step_date) do update set user_id = excluded.user_id,
    step_date = excluded.step_date, steps = excluded.steps returning *`;

test('steps migration, aggregate merge and PostgreSQL ownership', async (t) => {
  const db = await PGlite.create();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec(migration);
  await db.query('insert into auth.users values ($1), ($2)', [alice, bob]);
  const asUser = async (id, action) => {
    await db.exec('set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
    try { return await action(); } finally { await db.exec('reset role'); }
  };
  const reject = (query, args, code) => assert.rejects(() => db.query(query, args), (error) => error.code === code);
  let saved;

  await t.test('both tables enable RLS and functions never use definer security', async () => {
    assert.equal((await db.query("select count(*)::int n from pg_tables where schemaname='public' and tablename in ('daily_steps','step_goals') and rowsecurity")).rows[0].n, 2);
    assert.equal((await db.query("select count(*)::int n from pg_policies where policyname like 'steps_v1_%'")).rows[0].n, 8);
    const { rows } = await db.query("select prosecdef, proconfig from pg_proc where proname like 'steps_v1_%'");
    assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => !row.prosecdef && row.proconfig.some((value) => value.startsWith('search_path='))));
  });
  await asUser(alice, async () => {
    await t.test('first daily sync creates one dated aggregate', async () => {
      saved = (await db.query(upsert, [alice, '2026-01-01', 1000])).rows[0];
      assert.equal(saved.steps, 1000);
      assert.ok(saved.id && saved.created_at && saved.updated_at);
    });
    await t.test('same-date replay keeps one row and unchanged timestamp', async () => {
      const replay = (await db.query(upsert, [alice, '2026-01-01', 1000])).rows[0];
      assert.equal(replay.id, saved.id);
      assert.equal(+replay.updated_at, +saved.updated_at);
      assert.equal((await db.query('select * from public.daily_steps')).rows.length, 1);
    });
    await t.test('stale lower aggregate cannot regress the saved total', async () => {
      const higher = (await db.query(upsert, [alice, '2026-01-01', 2000])).rows[0];
      const stale = (await db.query(upsert, [alice, '2026-01-01', 1500])).rows[0];
      assert.equal(stale.steps, 2000);
      assert.equal(+stale.updated_at, +higher.updated_at);
      assert.equal(stale.id, saved.id);
    });
    await t.test('direct database updates cannot bypass monotonic merging', async () => {
      assert.equal((await db.query('update public.daily_steps set steps = 2 returning steps')).rows[0].steps, 2000);
      await reject('update public.daily_steps set steps = -1', [], '23514');
    });
    await t.test('unique user/date rejects a plain duplicate insert', async () => {
      await reject("insert into public.daily_steps(user_id,step_date,steps) values ($1,'2026-01-01',0)", [alice], '23505');
    });
    await t.test('negative, null, oversized, impossible and future dates are rejected', async () => {
      for (const count of [-1, 200001, null]) await reject(upsert, [alice, '2026-01-02', count], '23514');
      await reject(upsert, [alice, '2026-02-30', 5], '22008');
      await reject(upsert, [alice, '9998-12-31', 5], '23514');
      await reject(upsert, [alice, 'infinity', 5], '23514');
    });
    await t.test('zero is a valid first daily aggregate', async () => {
      assert.equal((await db.query(upsert, [alice, '2026-01-02', 0])).rows[0].steps, 0);
    });
    await t.test('a failed request can be retried without duplicates or losing existing data', async () => {
      await reject(upsert, [alice, '2026-01-01', -10], '23514');
      assert.equal((await db.query(upsert, [alice, '2026-01-01', 2100])).rows[0].steps, 2100);
      assert.equal((await db.query('select * from public.daily_steps')).rows.length, 2);
    });
    await t.test('goal defaults and partial updates match the service', async () => {
      const goal = (await db.query('insert into public.step_goals(user_id) values ($1) returning *', [alice])).rows[0];
      assert.equal(goal.daily_goal, 10000); assert.equal(goal.timezone, 'Asia/Kolkata');
      assert.equal((await db.query('update public.step_goals set daily_goal=7500 returning daily_goal')).rows[0].daily_goal, 7500);
      assert.equal((await db.query("update public.step_goals set timezone='America/New_York' returning timezone")).rows[0].timezone, 'America/New_York');
      for (const count of [-1, 0, 200001]) await reject('update public.step_goals set daily_goal=$1', [count], '23514');
      await reject("update public.step_goals set timezone='Unknown/Zone'", [], '23514');
    });
    await t.test('ownership, date, id and server timestamps cannot be changed', async () => {
      await reject('update public.daily_steps set user_id=$1', [bob], '23514');
      await reject("update public.daily_steps set step_date='2026-01-03'", [], '23514');
      await reject('update public.daily_steps set id=gen_random_uuid()', [], '42501');
      await reject('update public.daily_steps set updated_at=now()', [], '42501');
      await reject('update public.step_goals set user_id=$1', [bob], '42501');
      await reject('delete from public.daily_steps', [], '42501');
    });
  });
  await asUser(bob, async () => {
    await t.test('another user cannot read/update aggregates or goals', async () => {
      assert.equal((await db.query('select * from public.daily_steps')).rows.length, 0);
      assert.equal((await db.query('select * from public.step_goals')).rows.length, 0);
      assert.equal((await db.query('update public.daily_steps set steps=500 returning *')).rows.length, 0);
      assert.equal((await db.query('update public.step_goals set daily_goal=500 returning *')).rows.length, 0);
      await reject(upsert, [alice, '2026-01-03', 10], '42501');
      await reject('insert into public.step_goals(user_id) values ($1)', [alice], '42501');
    });
    await t.test('the same date is independent for another user', async () => {
      assert.equal((await db.query(upsert, [bob, '2026-01-01', 50])).rows[0].steps, 50);
    });
  });
  await t.test('existing overly broad policies cannot bypass the restrictive ownership guard', async () => {
    await db.exec('create policy legacy_broad_policy on public.daily_steps for all to authenticated using (true) with check (true)');
    await asUser(bob, async () => {
      assert.equal((await db.query('select * from public.daily_steps')).rows.length, 1);
      await reject(upsert, [alice, '2026-01-03', 10], '42501');
    });
  });
  await t.test('missing subject and anonymous roles cannot access records', async () => {
    await asUser('', async () => assert.equal((await db.query('select * from public.daily_steps')).rows.length, 0));
    await db.exec('set role anon');
    try {
      await reject('select * from public.daily_steps', [], '42501');
      await reject('select * from public.step_goals', [], '42501');
    } finally { await db.exec('reset role'); }
  });
  await t.test('deleting an auth user cascades only their steps and goal', async () => {
    await db.query('delete from auth.users where id=$1', [alice]);
    assert.equal((await db.query('select * from public.daily_steps')).rows.length, 1);
    assert.equal((await db.query('select * from public.step_goals')).rows.length, 0);
  });
});

test('steps migration adopts compatible existing tables without touching Water', async (t) => {
  const db = await PGlite.create(); t.after(() => db.close());
  await db.exec(fixture);
  await db.query('insert into auth.users values ($1)', [alice]);
  await db.exec(`create table public.water_entries (id int primary key, amount_ml int);
    insert into public.water_entries values (1,250);
    create table public.daily_steps(id uuid primary key default gen_random_uuid(), user_id uuid, step_date date, steps integer);
    create table public.step_goals(user_id uuid primary key, daily_goal integer, timezone text);
    create policy legacy_select on public.daily_steps for select to authenticated using (true);`);
  await db.query("insert into public.daily_steps(user_id,step_date,steps) values ($1,'2026-01-01',1234)", [alice]);
  await db.query("insert into public.step_goals values ($1,7500,'UTC')", [alice]);
  await db.exec(migration);
  assert.equal((await db.query('select steps from public.daily_steps')).rows[0].steps, 1234);
  assert.equal((await db.query('select daily_goal from public.step_goals')).rows[0].daily_goal, 7500);
  assert.equal((await db.query('select amount_ml from public.water_entries')).rows[0].amount_ml, 250);
  assert.equal((await db.query("select * from pg_policies where policyname='legacy_select'")).rows.length, 1);
});

test('duplicate existing daily records abort migration without deleting data', async (t) => {
  const db = await PGlite.create(); t.after(() => db.close());
  await db.exec(fixture);
  await db.query('insert into auth.users values ($1)', [alice]);
  await db.exec('create table public.daily_steps(id uuid default gen_random_uuid(), user_id uuid, step_date date, steps integer)');
  await db.query("insert into public.daily_steps(user_id,step_date,steps) values ($1,'2026-01-01',100),($1,'2026-01-01',200)", [alice]);
  await assert.rejects(() => db.exec(migration), (error) => error.code === '23505');
  await db.exec('rollback');
  assert.equal((await db.query('select * from public.daily_steps')).rows.length, 2);
  assert.equal((await db.query("select to_regclass('public.step_goals') present")).rows[0].present, null);
});
