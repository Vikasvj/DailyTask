import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const date = '2026-10-26';
const profile = (id) => ({ id, email: id === alice ? 'alice@example.com' : 'bob@example.com', created_at: '2026-01-01T00:00:00Z' });
const ids = [
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
];

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
function nextDate(value) {
  const instant = new Date(value + 'T00:00:00Z');
  instant.setUTCDate(instant.getUTCDate() + 1);
  return instant.toISOString().slice(0, 10);
}
function stamp(value) {
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? '';
  return BigInt(Math.floor(Date.parse(value) / 1000)) * 1000000n + BigInt(fraction.padEnd(6, '0').slice(0, 6));
}

test('water HTTP contract through Express and the real Supabase SDK', async (t) => {
  let entries = [];
  let goals = new Map();
  let requests = [];
  let forceError = null;
  let insertRace = false;
  const tokenOwners = new Map([['alice-token', alice], ['alice-second-device', alice], ['bob-token', bob]]);

  const project = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : null;
      const url = new URL(req.url, 'http://localhost');
      const owner = tokenOwners.get(req.headers.authorization?.replace('Bearer ', ''));
      const request = { method: req.method, path: url.pathname, query: url.searchParams, body, headers: req.headers };
      requests.push(request);
      const reply = (status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'X-Supabase-Api-Version': '2024-01-01' });
        res.end(JSON.stringify(value));
      };
      if (url.pathname === '/auth/v1/user') {
        return owner ? reply(200, profile(owner)) : reply(401, { code: 'bad_jwt', message: 'Invalid test token' });
      }
      if (!owner) return reply(401, { code: 'PGRST301', message: 'Invalid test token' });
      if (forceError) return reply(forceError.status, forceError.body);

      const representation = (rows, status = 200) => {
        const columns = url.searchParams.get('select')?.split(',');
        const projected = columns ? rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]]))) : rows;
        return reply(status, req.headers.accept?.includes('vnd.pgrst.object') ? projected[0] : projected);
      };

      if (url.pathname === '/rest/v1/rpc/water_daily_totals') {
        const start = body.p_start_date ?? date;
        const end = body.p_end_date ?? nextDate(start);
        const timezone = goals.get(owner)?.timezone ?? 'Asia/Kolkata';
        const result = [];
        for (let day = start; day < end; day = nextDate(day)) {
          // Fixed-offset HTTP fixtures only. Actual PostgreSQL DST is tested separately.
          const offset = timezone === 'UTC' ? 0 : 330 * 60000;
          const startAt = new Date(Date.parse(day + 'T00:00:00Z') - offset).toISOString();
          const endAt = new Date(Date.parse(nextDate(day) + 'T00:00:00Z') - offset).toISOString();
          const matching = entries.filter((entry) => entry.user_id === owner &&
            stamp(entry.consumed_at) >= stamp(startAt) && stamp(entry.consumed_at) < stamp(endAt));
          result.push({
            day, timezone, start_at: startAt, end_at: endAt,
            total_ml: matching.reduce((sum, entry) => sum + entry.amount_ml, 0),
            entry_count: matching.length,
          });
        }
        return reply(200, result);
      }

      // Repositories must explicitly filter ownership in addition to database RLS.
      if (req.method !== 'POST') assert.equal(url.searchParams.get('user_id'), 'eq.' + owner);
      if (url.pathname === '/rest/v1/water_goals') {
        if (req.method === 'GET') return representation(goals.has(owner) ? [goals.get(owner)] : []);
        if (req.method === 'PATCH') {
          if (!goals.has(owner)) return representation([]);
          assert.equal('user_id' in body, false);
          goals.set(owner, { ...goals.get(owner), ...body });
          return representation([goals.get(owner)]);
        }
        if (req.method === 'POST') {
          assert.equal(body.user_id, owner);
          if (insertRace) {
            goals.set(owner, { daily_goal_ml: 3500, timezone: 'Asia/Kolkata' });
            insertRace = false;
          }
          if (goals.has(owner)) return reply(409, { code: '23505', message: 'Duplicate goal' });
          goals.set(owner, { daily_goal_ml: 2000, timezone: 'Asia/Kolkata', ...body });
          return representation([goals.get(owner)], 201);
        }
      }
      if (url.pathname === '/rest/v1/water_entries') {
        if (req.method === 'POST') {
          assert.equal(body.user_id, owner);
          const entry = {
            id: randomUUID(), created_at: '2026-10-26T08:00:00Z',
            consumed_at: '2026-10-26T08:00:00Z', ...body,
          };
          entries.push(entry);
          return representation([entry], 201);
        }
        let matching = entries.filter((entry) => entry.user_id === owner);
        const idFilter = url.searchParams.get('id');
        if (idFilter) matching = matching.filter((entry) => entry.id === idFilter.slice(3));
        if (req.method === 'PATCH') {
          matching.forEach((entry) => Object.assign(entry, body));
          return representation(matching);
        }
        if (req.method === 'DELETE') {
          entries = entries.filter((entry) => !matching.includes(entry));
          return representation(matching);
        }
        for (const filter of url.searchParams.getAll('consumed_at')) {
          const operator = filter.slice(0, filter.indexOf('.'));
          const value = filter.slice(filter.indexOf('.') + 1);
          matching = matching.filter((entry) => operator === 'gte'
            ? stamp(entry.consumed_at) >= stamp(value) : stamp(entry.consumed_at) < stamp(value));
        }
        const or = url.searchParams.get('or');
        if (or) {
          const match = /^\(consumed_at\.lt\.(.+),and\(consumed_at\.eq\.(.+),id\.lt\.([a-f0-9-]+)\)\)$/.exec(or);
          assert.ok(match, 'Cursor must use a validated lexicographic filter');
          assert.equal(match[1], match[2]);
          matching = matching.filter((entry) => stamp(entry.consumed_at) < stamp(match[1]) ||
            (stamp(entry.consumed_at) === stamp(match[1]) && entry.id < match[3]));
        }
        assert.equal(url.searchParams.get('order'), 'consumed_at.desc,id.desc');
        matching.sort((left, right) => {
          const a = stamp(left.consumed_at); const b = stamp(right.consumed_at);
          return a === b ? right.id.localeCompare(left.id) : a > b ? -1 : 1;
        });
        return representation(matching.slice(0, Number(url.searchParams.get('limit'))));
      }
      reply(404, { message: 'Unexpected test endpoint' });
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'TEST_FIXTURE_FAILURE', message: error.message }));
    }
  });

  const projectUrl = await listen(project);
  t.after(() => close(project));
  const config = {
    NODE_ENV: 'test', PORT: 3000, TRUST_PROXY: '',
    SUPABASE_URL: projectUrl, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_placeholder',
  };
  for (const [key, value] of Object.entries(config)) process.env[key] = String(value);
  const { default: app } = await import('../src/app.js');
  const server = createServer(app);
  const apiUrl = await listen(server);
  t.after(() => close(server));
  t.beforeEach(() => {
    entries = []; goals = new Map(); requests = []; forceError = null; insertRace = false;
  });

  async function request(path, { method = 'GET', body, token = 'alice-token' } = {}) {
    const response = await fetch(apiUrl + '/api/water' + path, {
      method,
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status, headers: response.headers,
      body: response.status === 204 ? null : await response.json(),
    };
  }
  function seed(id, amount = 250, consumedAt = '2026-10-26T08:00:00.123456+00:00', owner = alice) {
    const entry = { id, user_id: owner, amount_ml: amount, consumed_at: consumedAt, created_at: '2026-10-26T08:00:00Z' };
    entries.push(entry);
    return entry;
  }

  await t.test('every water endpoint requires a verified token', async () => {
    for (const path of ['/entries', '/today', '/history', '/goal']) {
      const result = await request(path, { token: null });
      assert.equal(result.status, 401);
    }
    assert.equal(requests.length, 0);
    const bad = await request('/today', { token: 'invalid-token' });
    assert.equal(bad.status, 401);
    assert.ok(requests.every((req) => req.path === '/auth/v1/user'));
  });

  await t.test('create assigns the verified UUID and leaves automatic time to PostgreSQL', async () => {
    const result = await request('/entries', { method: 'POST', body: { amount_ml: 250 } });
    assert.equal(result.status, 201);
    assert.equal(result.body.data.amount_ml, 250);
    assert.ok(result.body.data.id);
    assert.ok(result.body.data.consumed_at);
    const insert = requests.find((req) => req.path === '/rest/v1/water_entries');
    assert.deepEqual(insert.body, { amount_ml: 250, user_id: alice });
    assert.equal(insert.headers.authorization, 'Bearer alice-token');
    assert.equal(insert.headers.apikey, config.SUPABASE_PUBLISHABLE_KEY);
  });

  await t.test('explicit offset timestamps and microseconds are preserved', async () => {
    const consumedAt = '2026-10-26T13:30:00.123456+05:30';
    const result = await request('/entries', { method: 'POST', body: { amount_ml: 300, consumed_at: consumedAt } });
    assert.equal(result.status, 201);
    assert.equal(result.body.data.consumed_at, consumedAt);
  });

  await t.test('invalid amounts, unknown ownership fields and invalid timestamps are rejected', async () => {
    for (const body of [
      { amount_ml: 0 }, { amount_ml: -1 }, { amount_ml: 1.5 }, { amount_ml: '250' },
      { amount_ml: 2147483648 }, { amount_ml: 250, user_id: bob },
      { amount_ml: 250, consumed_at: '2026-02-30T08:00:00Z' },
      { amount_ml: 250, consumed_at: '2026-10-26T08:00:00' },
      { amount_ml: 250, consumed_at: '2026-10-26T08:00:00.1234567Z' },
      { amount_ml: 250, consumed_at: '2026-10-26T08:00:00+16:00' },
      { amount_ml: 250, consumed_at: '9999-10-26T08:00:00Z' },
      { amount_ml: 250, consumed_at: '2026-02-29T08:00:00Z' },
      { amount_ml: 250, consumed_at: '2026-04-31T08:00:00Z' },
      { amount_ml: 250, consumed_at: '2026-10-26T24:00:00Z' },
      { amount_ml: 250, consumed_at: '2026-10-26T08:60:00Z' },
    ]) {
      const result = await request('/entries', { method: 'POST', body });
      assert.equal(result.status, 400, JSON.stringify(body));
    }
    assert.ok(requests.every((req) => req.path === '/auth/v1/user'));
  });

  await t.test('default goal is available before the first settings write', async () => {
    const result = await request('/goal');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data, { daily_goal_ml: 2000, timezone: 'Asia/Kolkata' });
  });

  await t.test('goal and timezone can be saved and partial updates preserve the other field', async () => {
    const created = await request('/goal', { method: 'PATCH', body: { daily_goal_ml: 2800 } });
    assert.equal(created.status, 200);
    assert.deepEqual(created.body.data, { daily_goal_ml: 2800, timezone: 'Asia/Kolkata' });
    const updated = await request('/goal', { method: 'PATCH', body: { timezone: 'UTC' } });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body.data, { daily_goal_ml: 2800, timezone: 'UTC' });
  });

  await t.test('a concurrent first settings insert is retried without losing its other field', async () => {
    insertRace = true;
    const result = await request('/goal', { method: 'PATCH', body: { timezone: 'UTC' } });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data, { daily_goal_ml: 3500, timezone: 'UTC' });
  });

  await t.test('invalid goals, empty patches, unexpected fields and unknown timezones are rejected', async () => {
    for (const body of [{}, { daily_goal_ml: 0 }, { timezone: 'Unknown/Zone' }, { timezone: '+05:30' }, { user_id: bob }]) {
      assert.equal((await request('/goal', { method: 'PATCH', body })).status, 400);
    }
    assert.ok(requests.every((req) => req.path === '/auth/v1/user'));
  });

  await t.test('a second device logged into the same account sees saved entries and goal', async () => {
    await request('/entries', { method: 'POST', body: { amount_ml: 500 } });
    await request('/goal', { method: 'PATCH', body: { daily_goal_ml: 3000 } });
    const list = await request('/entries?date=' + date, { token: 'alice-second-device' });
    const goal = await request('/goal', { token: 'alice-second-device' });
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.data[0].amount_ml, 500);
    assert.equal(goal.body.data.daily_goal_ml, 3000);
    assert.ok(requests.some((req) => req.path.startsWith('/rest/') && req.headers.authorization === 'Bearer alice-second-device'));
  });

  await t.test('another account sees only its own history and defaults', async () => {
    seed(ids[0], 500);
    goals.set(alice, { daily_goal_ml: 3000, timezone: 'Asia/Kolkata' });
    const list = await request('/entries?date=' + date, { token: 'bob-token' });
    const goal = await request('/goal', { token: 'bob-token' });
    assert.deepEqual(list.body.data, []);
    assert.equal(goal.body.data.daily_goal_ml, 2000);
  });

  await t.test('timestamp ties paginate by UUID with no duplicates and full microsecond precision', async () => {
    ids.forEach((id) => seed(id));
    const first = await request('/entries?date=' + date + '&limit=2');
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.data.map((row) => row.id), [ids[3], ids[2]]);
    assert.ok(first.body.meta.next_cursor);
    const second = await request('/entries?date=' + date + '&limit=2&cursor=' + first.body.meta.next_cursor);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.data.map((row) => row.id), [ids[1], ids[0]]);
    assert.equal(second.body.meta.next_cursor, null);
    const query = requests.filter((req) => req.query.has('or')).at(-1);
    assert.ok(query.query.get('or').includes('2026-10-26T08:00:00.123456+00:00'));
    assert.equal(query.query.get('limit'), '3');
  });

  await t.test('malformed and query-injection cursors are rejected before database queries', async () => {
    for (const cursor of ['%', 'e30', Buffer.from(JSON.stringify({
      id: ids[0], consumed_at: 'x),user_id.eq.' + bob, date, timezone: 'Asia/Kolkata',
    })).toString('base64url')]) {
      const result = await request('/entries?cursor=' + encodeURIComponent(cursor));
      assert.equal(result.status, 400);
    }
    assert.ok(requests.every((req) => req.path === '/auth/v1/user'));
  });

  await t.test('cursors cannot be reused for another date or a changed timezone', async () => {
    ids.forEach((id) => seed(id));
    const first = await request('/entries?date=' + date + '&limit=1');
    const cursor = first.body.meta.next_cursor;
    const wrongDate = await request('/entries?date=2026-10-27&cursor=' + cursor);
    assert.equal(wrongDate.status, 400);
    assert.equal(wrongDate.body.error.code, 'INVALID_CURSOR');
    goals.set(alice, { daily_goal_ml: 2000, timezone: 'UTC' });
    const wrongZone = await request('/entries?date=' + date + '&cursor=' + cursor);
    assert.equal(wrongZone.status, 400);
    assert.equal(wrongZone.body.error.code, 'INVALID_CURSOR');
  });

  await t.test('invalid dates, periods, limits, UUIDs and unexpected query fields are rejected', async () => {
    for (const path of [
      '/entries?date=2026-02-30', '/entries?date=2026-02-29', '/entries?date=2026-04-31',
      '/entries?date=0000-01-01', '/entries?limit=1junk', '/entries?limit=0', '/entries?limit=101',
      '/entries?limit=2&limit=3', '/entries?user_id=' + bob,
      '/history?period=year', '/today?date=' + date,
    ]) {
      assert.equal((await request(path)).status, 400, path);
    }
    assert.equal((await request('/entries/not-a-uuid', { method: 'PATCH', body: { amount_ml: 250 } })).status, 400);
  });

  await t.test('edit moves an entry into its new local date', async () => {
    seed(ids[0], 250);
    const result = await request('/entries/' + ids[0], {
      method: 'PATCH', body: { amount_ml: 400, consumed_at: '2026-10-27T08:00:00Z' },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.amount_ml, 400);
    assert.equal((await request('/entries?date=' + date)).body.data.length, 0);
    assert.equal((await request('/entries?date=2026-10-27')).body.data.length, 1);
  });

  await t.test('missing and foreign entry IDs both return 404 for edit and delete', async () => {
    seed(ids[0], 900, '2026-10-26T08:00:00Z', bob);
    for (const id of [ids[0], ids[1]]) {
      assert.equal((await request('/entries/' + id, { method: 'PATCH', body: { amount_ml: 250 } })).status, 404);
      assert.equal((await request('/entries/' + id, { method: 'DELETE' })).status, 404);
    }
    assert.equal(entries[0].amount_ml, 900);
  });

  await t.test('empty edits, ownership changes and immutable fields are rejected', async () => {
    for (const body of [{}, { user_id: bob }, { created_at: '2026-10-26T08:00:00Z' }, { id: ids[1] }]) {
      assert.equal((await request('/entries/' + ids[0], { method: 'PATCH', body })).status, 400);
    }
  });

  await t.test('delete returns 204 and the entry disappears', async () => {
    seed(ids[0]);
    const deleted = await request('/entries/' + ids[0], { method: 'DELETE' });
    assert.equal(deleted.status, 204);
    assert.equal(deleted.body, null);
    assert.equal((await request('/entries?date=' + date)).body.data.length, 0);
  });

  await t.test('today returns zero progress without entries', async () => {
    const result = await request('/today');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data, {
      date, timezone: 'Asia/Kolkata', total_ml: 0, daily_goal_ml: 2000,
      remaining_ml: 2000, progress_percent: 0, entry_count: 0,
    });
  });

  await t.test('today sums all entries independently of pagination and excludes other users', async () => {
    for (let index = 0; index < 1005; index += 1) seed(randomUUID(), 1);
    seed(ids[0], 99999, '2026-10-26T08:00:00Z', bob);
    const result = await request('/today');
    assert.equal(result.body.data.total_ml, 1005);
    assert.equal(result.body.data.entry_count, 1005);
    assert.equal(result.body.data.remaining_ml, 995);
    assert.equal(result.body.data.progress_percent, 50.25);
    const list = await request('/entries?date=' + date + '&limit=20');
    assert.equal(list.body.data.length, 20);
  });

  await t.test('progress can exceed 100 percent and remaining intake never becomes negative', async () => {
    seed(ids[0], 2500);
    const result = await request('/today');
    assert.equal(result.body.data.remaining_ml, 0);
    assert.equal(result.body.data.progress_percent, 125);
  });

  await t.test('daily history returns totals and period boundaries', async () => {
    seed(ids[0], 250);
    const result = await request('/history?period=day&date=' + date);
    assert.equal(result.status, 200);
    assert.equal(result.body.data.total_ml, 250);
    assert.equal(result.body.data.start_date, date);
    assert.equal(result.body.data.end_date, '2026-10-27');
    assert.equal(result.body.data.days.length, 1);
  });

  await t.test('weekly history uses Monday to Sunday even across a year boundary', async () => {
    const result = await request('/history?period=week&date=2027-01-01');
    assert.equal(result.body.data.start_date, '2026-12-28');
    assert.equal(result.body.data.end_date, '2027-01-04');
    assert.equal(result.body.data.days.length, 7);
    assert.ok(result.body.data.days.every((day) => day.total_ml === 0));
  });

  await t.test('monthly history includes every day in a leap-year February', async () => {
    const result = await request('/history?period=month&date=2024-02-15');
    assert.equal(result.body.data.start_date, '2024-02-01');
    assert.equal(result.body.data.end_date, '2024-03-01');
    assert.equal(result.body.data.days.length, 29);
  });

  await t.test('database outages, throttles and invalid tokens have safe consistent errors', async () => {
    for (const fixture of [
      { status: 503, body: { code: 'XX000', message: 'private details' }, expected: 503, code: 'DATABASE_UNAVAILABLE' },
      { status: 429, body: { message: 'private details' }, expected: 429, code: 'RATE_LIMITED' },
      { status: 401, body: { code: 'PGRST301', message: 'private details' }, expected: 401, code: 'INVALID_TOKEN' },
      { status: 400, body: { code: '23514', message: 'private details' }, expected: 400, code: 'INVALID_INPUT' },
    ]) {
      forceError = fixture;
      const result = await request('/goal');
      assert.equal(result.status, fixture.expected);
      assert.equal(result.body.error.code, fixture.code);
      assert.equal(JSON.stringify(result.body).includes('private details'), false);
    }
  });
});
