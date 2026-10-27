import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import test from 'node:test';

test('water migration and PostgreSQL RLS', async (t) => {
const db = await PGlite.create();
const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';


async function check(name, action) { await t.test(name, action); }

async function asUser(id, action) {
  await db.exec('reset role; set role authenticated;');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  try { return await action(); }
  finally { await db.exec('reset role;'); }
}

async function rejectsCode(query, params, code) {
  await assert.rejects(() => db.query(query, params), (error) => error.code === code);
}

try {
  // Minimal local fixtures for Supabase roles and auth.uid(); no live Auth users.
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);

  const migration = await readFile(new URL('../supabase/migrations/20261026051059_create_water_tracking.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  await check('migration executes successfully', async () => {
    const { rows } = await db.query("select count(*)::int as count from pg_tables where schemaname = 'public' and tablename in ('water_entries', 'water_goals') and rowsecurity");
    assert.equal(rows[0].count, 2);
  });

  await check('seven ownership policies exist and functions use invoker security', async () => {
    const policies = await db.query("select count(*)::int as count from pg_policies where schemaname = 'public' and tablename in ('water_entries', 'water_goals')");
    assert.equal(policies.rows[0].count, 7);
    const functions = await db.query("select proname, prosecdef, proconfig from pg_proc join pg_namespace on pg_namespace.oid = pronamespace where nspname = 'public' and proname in ('is_valid_water_timezone', 'water_daily_totals')");
    assert.equal(functions.rows.length, 2);
    assert.ok(functions.rows.every((fn) => !fn.prosecdef && fn.proconfig?.some((value) => value.startsWith('search_path='))));
  });

  await db.query('insert into auth.users(id) values ($1), ($2)', [alice, bob]);
  const bobEntry = (await db.query("insert into public.water_entries(user_id, amount_ml, consumed_at) values ($1, 900, '2026-10-26T08:00:00Z') returning id", [bob])).rows[0].id;
  await db.query('insert into public.water_goals(user_id, daily_goal_ml) values ($1, 3000)', [bob]);
  let aliceEntry;

  await asUser(alice, async () => {
    await check('own insert assigns the authenticated UUID and automatic timestamp', async () => {
      const result = await db.query('insert into public.water_entries(amount_ml) values (250) returning *');
      aliceEntry = result.rows[0].id;
      assert.equal(result.rows[0].user_id, alice);
      assert.equal(result.rows[0].amount_ml, 250);
      assert.ok(result.rows[0].consumed_at);
      assert.ok(result.rows[0].created_at);
    });
    await check('own records can be read', async () => {
      assert.equal((await db.query('select * from public.water_entries')).rows.length, 1);
    });
    await check('other users records cannot be read', async () => {
      assert.equal((await db.query('select * from public.water_entries where id = $1', [bobEntry])).rows.length, 0);
      assert.equal((await db.query('select * from public.water_goals where user_id = $1', [bob])).rows.length, 0);
    });
    await check('forged ownership is rejected on water inserts', async () => {
      await rejectsCode('insert into public.water_entries(user_id, amount_ml) values ($1, 250)', [bob], '42501');
    });
    await check('other users records cannot be updated or deleted', async () => {
      assert.equal((await db.query('update public.water_entries set amount_ml = 1 where id = $1 returning id', [bobEntry])).rows.length, 0);
      assert.equal((await db.query('delete from public.water_entries where id = $1 returning id', [bobEntry])).rows.length, 0);
      assert.equal((await db.query('update public.water_goals set daily_goal_ml = 1 where user_id = $1 returning user_id', [bob])).rows.length, 0);
    });
    await check('own water amount and timestamp can be edited', async () => {
      const result = await db.query("update public.water_entries set amount_ml = 500, consumed_at = '2026-10-26T08:30:00Z' where id = $1 returning amount_ml, consumed_at", [aliceEntry]);
      assert.equal(result.rows[0].amount_ml, 500);
      assert.equal(new Date(result.rows[0].consumed_at).toISOString(), '2026-10-26T08:30:00.000Z');
    });
    await check('water owner, UUID and creation timestamp are immutable to API callers', async () => {
      await rejectsCode('update public.water_entries set user_id = $1 where id = $2', [bob, aliceEntry], '42501');
      await rejectsCode('update public.water_entries set id = $1 where id = $2', [bob, aliceEntry], '42501');
      await rejectsCode('update public.water_entries set created_at = now() where id = $1', [aliceEntry], '42501');
      await rejectsCode('insert into public.water_entries(amount_ml, created_at) values (200, now())', [], '42501');
    });
    await check('positive amounts and finite timestamps are enforced by the database', async () => {
      await rejectsCode('insert into public.water_entries(amount_ml) values (0)', [], '23514');
      await rejectsCode('insert into public.water_entries(amount_ml) values (-1)', [], '23514');
      await rejectsCode('insert into public.water_entries(amount_ml) values (null)', [], '23502');
      await rejectsCode("insert into public.water_entries(amount_ml, consumed_at) values (200, 'infinity')", [], '23514');
    });
    await check('goal defaults persist with the account', async () => {
      const result = await db.query('insert into public.water_goals(user_id) values ($1) returning *', [alice]);
      assert.equal(result.rows[0].daily_goal_ml, 2000);
      assert.equal(result.rows[0].timezone, 'Asia/Kolkata');
    });
    await check('goal upserts work with PostgREST-style conflict-column updates', async () => {
      const result = await db.query(`
        insert into public.water_goals(user_id, daily_goal_ml, timezone) values ($1, 2500, 'Asia/Kolkata')
        on conflict(user_id) do update set user_id = excluded.user_id,
          daily_goal_ml = excluded.daily_goal_ml, timezone = excluded.timezone
        returning daily_goal_ml`, [alice]);
      assert.equal(result.rows[0].daily_goal_ml, 2500);
    });
    await check('RLS WITH CHECK prevents transferring a goal to another user', async () => {
      await rejectsCode('update public.water_goals set user_id = $1 where user_id = $2', [bob, alice], '42501');
      await rejectsCode('insert into public.water_goals(user_id) values ($1)', [bob], '42501');
    });
    await check('invalid goals and unknown timezones are rejected', async () => {
      await rejectsCode('update public.water_goals set daily_goal_ml = 0', [], '23514');
      await rejectsCode("update public.water_goals set timezone = 'Unknown/Timezone'", [], '23514');
    });
    await check('own entries can be deleted', async () => {
      assert.equal((await db.query('delete from public.water_entries where id = $1 returning id', [aliceEntry])).rows.length, 1);
    });

    // Around local midnight in Asia/Kolkata: UTC+05:30.
    await db.exec(`
      insert into public.water_entries(amount_ml, consumed_at) values
        (100, '2026-10-25T18:29:59.999Z'),
        (200, '2026-10-25T18:30:00Z'),
        (300, '2026-10-26T18:29:59.999Z'),
        (400, '2026-10-26T18:30:00Z');
    `);
    await check('daily boundaries are inclusive at midnight and exclusive at next midnight', async () => {
      const { rows } = await db.query("select * from public.water_daily_totals('2026-10-26', '2026-10-27')");
      assert.equal(rows.length, 1);
      assert.equal(String(rows[0].total_ml), '500');
      assert.equal(String(rows[0].entry_count), '2');
      assert.equal(rows[0].timezone, 'Asia/Kolkata');
      assert.equal(new Date(rows[0].start_at).toISOString(), '2026-10-25T18:30:00.000Z');
      assert.equal(new Date(rows[0].end_at).toISOString(), '2026-10-26T18:30:00.000Z');
    });
    await check('history includes zero-intake days', async () => {
      const { rows } = await db.query("select * from public.water_daily_totals('2026-10-27', '2026-10-29')");
      assert.deepEqual(rows.map((row) => String(row.total_ml)), ['400', '0']);
    });
    await check('weekly and monthly aggregation excludes other users', async () => {
      const week = await db.query("select * from public.water_daily_totals('2026-10-26', '2026-11-02')");
      assert.equal(week.rows.length, 7);
      assert.equal(week.rows.reduce((sum, row) => sum + Number(row.total_ml), 0), 900);
      const month = await db.query("select * from public.water_daily_totals('2026-10-01', '2026-11-01')");
      assert.equal(month.rows.length, 31);
      assert.equal(month.rows.reduce((sum, row) => sum + Number(row.total_ml), 0), 1000);
    });
    await check('aggregation includes more than 1000 entries without API pagination', async () => {
      await db.exec("insert into public.water_entries(amount_ml, consumed_at) select 1, '2026-10-26T08:00:00Z'::timestamptz from generate_series(1, 1005)");
      const { rows } = await db.query("select * from public.water_daily_totals('2026-10-26', '2026-10-27')");
      assert.equal(String(rows[0].total_ml), '1505');
      assert.equal(String(rows[0].entry_count), '1007');
    });
    await check('empty, reversed, infinite and overlong report ranges are rejected', async () => {
      for (const [start, end] of [
        ['2026-10-26', '2026-10-26'],
        ['2026-10-27', '2026-10-26'],
        ['2026-10-01', '2026-11-02'],
        ['infinity', 'infinity'],
      ]) {
        await rejectsCode('select * from public.water_daily_totals($1, $2)', [start, end], '22023');
      }
    });

    await db.exec(`
      update public.water_goals set timezone = 'America/New_York';
      insert into public.water_entries(amount_ml, consumed_at) values
        (250, '2026-03-08T05:00:00Z'),
        (250, '2026-03-09T03:59:59.999Z'),
        (999, '2026-03-09T04:00:00Z'),
        (300, '2026-11-01T05:30:00Z'),
        (450, '2026-11-01T06:30:00Z');
    `);
    await check('spring DST transition has a 23-hour day with correct totals', async () => {
      const { rows } = await db.query("select * from public.water_daily_totals('2026-03-08', '2026-03-09')");
      assert.equal(String(rows[0].total_ml), '500');
      assert.equal((new Date(rows[0].end_at) - new Date(rows[0].start_at)) / 3600000, 23);
    });
    await check('fall DST transition counts both repeated hours in a 25-hour day', async () => {
      const { rows } = await db.query("select * from public.water_daily_totals('2026-11-01', '2026-11-02')");
      assert.equal(String(rows[0].total_ml), '750');
      assert.equal(String(rows[0].entry_count), '2');
      assert.equal((new Date(rows[0].end_at) - new Date(rows[0].start_at)) / 3600000, 25);
    });
    await check('no-argument summary uses today in the account timezone', async () => {
      const { rows } = await db.query("select day::text, timezone from public.water_daily_totals()");
      const expected = await db.query("select ((now() at time zone 'America/New_York')::date)::text as day");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].day, expected.rows[0].day);
      assert.equal(rows[0].timezone, 'America/New_York');
    });
  });

  await asUser('', async () => {
    await check('an authenticated role without a subject cannot access data', async () => {
      assert.equal((await db.query('select * from public.water_entries')).rows.length, 0);
      await rejectsCode('insert into public.water_entries(amount_ml) values (250)', [], '42501');
      await rejectsCode('select * from public.water_daily_totals()', [], '42501');
    });
  });
  await asUser('33333333-3333-4333-8333-333333333333', async () => {
    await check('water records require an existing Supabase user', async () => {
      await rejectsCode('insert into public.water_entries(amount_ml) values (250)', [], '23503');
    });
    await check('accounts without saved settings use the documented defaults for summaries', async () => {
      const { rows } = await db.query("select * from public.water_daily_totals('2026-10-26', '2026-10-27')");
      assert.equal(rows[0].timezone, 'Asia/Kolkata');
      assert.equal(String(rows[0].total_ml), '0');
    });
  });

  await db.exec('set role anon;');
  try {
    await check('anonymous callers have no table or RPC access', async () => {
      await rejectsCode('select * from public.water_entries', [], '42501');
      await rejectsCode('select * from public.water_goals', [], '42501');
      await rejectsCode('select * from public.water_daily_totals()', [], '42501');
      await rejectsCode("select public.is_valid_water_timezone('UTC')", [], '42501');
    });
  } finally {
    await db.exec('reset role;');
  }

  await check('deleting an Auth user cascades to entries and goal', async () => {
    await db.query('delete from auth.users where id = $1', [bob]);
    assert.equal((await db.query('select * from public.water_entries where user_id = $1', [bob])).rows.length, 0);
    assert.equal((await db.query('select * from public.water_goals where user_id = $1', [bob])).rows.length, 0);
  });

} finally {
  await db.close();
}

});
