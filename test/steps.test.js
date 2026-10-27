import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const owners = new Map([['alice-token', alice], ['bob-token', bob]]);
async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}
async function close(server) {
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
}

test('steps HTTP contract through existing Express auth and Supabase SDK', async (t) => {
  let goals = new Map(); let records = new Map(); let calls = []; let forced = null; let goalRace = false;
  const project = createServer(async (req, res) => {
    const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'X-Supabase-Api-Version': '2024-01-01' }); res.end(JSON.stringify(data)); };
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : null;
      const url = new URL(req.url, 'http://localhost');
      const user = owners.get(req.headers.authorization?.replace('Bearer ', ''));
      calls.push({ method: req.method, path: url.pathname, body, query: url.searchParams, user });
      if (url.pathname === '/auth/v1/user') return user
        ? reply(200, { id: user, email: 'fixture@example.com', created_at: '2026-01-01T00:00:00Z' })
        : reply(401, { code: 'bad_jwt', message: 'Invalid fixture token' });
      if (!user) return reply(401, { code: 'PGRST301' });
      if (forced) return reply(forced.status, forced.body);
      if (req.method !== 'POST') assert.equal(url.searchParams.get('user_id'), 'eq.' + user);
      const represent = (rows, status = 200) => {
        const columns = url.searchParams.get('select').split(',');
        const projected = rows.map((row) => Object.fromEntries(columns.map((key) => [key, row[key]])));
        reply(status, req.headers.accept?.includes('vnd.pgrst.object') ? projected[0] : projected);
      };
      if (url.pathname === '/rest/v1/step_goals') {
        if (req.method === 'GET') return represent(goals.has(user) ? [goals.get(user)] : []);
        if (req.method === 'PATCH') {
          assert.equal('user_id' in body, false);
          if (!goals.has(user)) return represent([]);
          goals.set(user, { ...goals.get(user), ...body }); return represent([goals.get(user)]);
        }
        assert.equal(body.user_id, user);
        if (goalRace) { goals.set(user, { daily_goal: 5000, timezone: 'UTC' }); goalRace = false; }
        if (goals.has(user)) return reply(409, { code: '23505' });
        goals.set(user, { daily_goal: 10000, timezone: 'Asia/Kolkata', ...body });
        return represent([goals.get(user)], 201);
      }
      if (url.pathname === '/rest/v1/daily_steps') {
        if (req.method === 'POST') {
          assert.equal(body.user_id, user);
          assert.equal(url.searchParams.get('on_conflict'), 'user_id,step_date');
          assert.match(req.headers.prefer, /resolution=merge-duplicates/);
          assert.equal('updated_at' in body, false, 'timestamps are assigned by PostgreSQL');
          const key = user + ':' + body.step_date;
          const old = records.get(key);
          // HTTP fixture mimics the SQL trigger. Real SQL is tested separately.
          const row = { id: randomUUID(), created_at: new Date().toISOString(), ...old, ...body,
            steps: Math.max(old?.steps ?? 0, body.steps), updated_at: new Date().toISOString() };
          records.set(key, row); return represent([row], 201);
        }
        let rows = [...records.values()].filter((row) => row.user_id === user);
        for (const filter of url.searchParams.getAll('step_date')) {
          const op = filter.slice(0, filter.indexOf('.')); const value = filter.slice(filter.indexOf('.') + 1);
          rows = rows.filter((row) => op === 'eq' ? row.step_date === value : op === 'gte' ? row.step_date >= value : row.step_date < value);
        }
        rows.sort((a, b) => a.step_date.localeCompare(b.step_date)); return represent(rows);
      }
      reply(404, { code: 'FIXTURE_ENDPOINT_MISSING' });
    } catch (error) { reply(500, { code: 'FIXTURE_FAILURE', message: error.message }); }
  });
  const projectUrl = await listen(project); t.after(() => close(project));
  Object.assign(process.env, { NODE_ENV: 'test', PORT: '3000', TRUST_PROXY: '',
    SUPABASE_URL: projectUrl, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_steps_fixture' });
  const { default: app } = await import('../src/app.js');
  const api = createServer(app); const base = await listen(api); t.after(() => close(api));
  t.beforeEach(() => { goals = new Map(); records = new Map(); calls = []; forced = null; goalRace = false; });
  const request = async (path, { method = 'GET', body, token = 'alice-token', type = 'application/json' } = {}) => {
    const res = await fetch(base + '/api/steps' + path, { method,
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'Content-Type': type }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  const put = (body, options = {}) => request('/today', { method: 'PUT', body, ...options });

  await t.test('all five routes reject missing and invalid authentication', async () => {
    for (const [path, method] of [['/today','GET'],['/today','PUT'],['/history','GET'],['/goal','GET'],['/goal','PATCH']]) {
      for (const token of [null, 'expired-token']) {
        const res = await request(path, { method, token, body: ['PUT','PATCH'].includes(method) ? {} : undefined });
        assert.equal(res.status, 401); assert.ok(res.headers.get('www-authenticate'));
      }
    }
  });
  await t.test('empty today uses account defaults and the documented response envelope', async () => {
    const res = await request('/today'); assert.equal(res.status, 200);
    assert.equal(res.body.data.steps, 0); assert.equal(res.body.data.daily_goal, 10000);
    assert.equal(res.body.data.remaining_steps, 10000); assert.equal(res.body.data.updated_at, null);
    assert.equal(res.body.data.timezone, 'Asia/Kolkata'); assert.match(res.body.data.date, /^\d{4}-\d{2}-\d{2}$/);
  });
  await t.test('first PUT returns 200 and a persisted daily summary', async () => {
    const res = await put({ step_date: '2026-01-01', steps: 1250 });
    assert.equal(res.status, 200); assert.equal(res.body.data.date, '2026-01-01');
    assert.equal(res.body.data.steps, 1250); assert.equal(res.body.data.progress_percent, 12.5);
    assert.equal(res.body.data.remaining_steps, 8750); assert.ok(res.body.data.updated_at);
  });
  await t.test('omitted date uses today in the account timezone', async () => {
    goals.set(alice, { daily_goal: 7500, timezone: 'Pacific/Kiritimati' });
    const today = (await request('/today')).body.data;
    const res = await put({ steps: 50 });
    assert.equal(res.body.data.date, today.date); assert.equal(res.body.data.timezone, today.timezone);
  });
  await t.test('replay, higher total, and stale lower total retain one aggregate', async () => {
    for (const steps of [100,100,500,300]) assert.equal((await put({ step_date:'2026-01-01', steps })).status, 200);
    assert.equal(records.size, 1); assert.equal([...records.values()][0].steps, 500);
  });
  await t.test('concurrent HTTP totals converge to the highest aggregate', async () => {
    const responses = await Promise.all([100,500,300].map((steps) => put({ step_date:'2026-01-01', steps })));
    assert.ok(responses.every((res) => res.status === 200)); assert.equal([...records.values()][0].steps, 500);
  });
  await t.test('invalid step bodies never reach the database', async () => {
    for (const body of [{}, {steps:-1}, {steps:1.5}, {steps:'10'}, {steps:null}, {steps:200001},
      {steps:1, user_id:bob}, {steps:1, timezone:'UTC'}, [], null]) {
      calls = []; assert.equal((await put(body)).status, 400);
      assert.ok(calls.every((call) => call.path === '/auth/v1/user'));
    }
    assert.equal((await put({step_date:'2026-01-01', steps:0})).status, 200);
  });
  await t.test('impossible, malformed and future write dates are rejected', async () => {
    for (const step_date of ['2026-02-30','2026-13-01','2026-1-01','2026-01-01T00:00:00Z','9998-12-31','0000-01-01', null]) {
      assert.equal((await put({step_date, steps:1})).status, 400);
    }
  });
  await t.test('PUT media type, malformed JSON, and payload limits use existing error conventions', async () => {
    assert.equal((await put({steps:1}, {type:'text/plain'})).status, 415);
    const broken = await fetch(base + '/api/steps/today', {method:'PUT', headers:{'Content-Type':'application/json'},body:'{'});
    assert.equal(broken.status, 400); assert.equal((await broken.json()).error.code, 'INVALID_JSON');
    assert.equal((await put({steps:1, padding:'a'.repeat(5000)})).status, 413);
  });
  await t.test('ownership cannot be supplied via bodies, queries, or history', async () => {
    await put({step_date:'2026-01-01', steps:1234});
    assert.equal((await request('/history?date=2026-01-01', {token:'bob-token'})).body.data.total_steps, 0);
    assert.equal((await request('/history?user_id=' + alice, {token:'bob-token'})).status, 400);
    assert.equal((await request('/goal?user_id=' + alice)).status, 400);
    assert.equal((await request('/today?date=2026-01-01')).status, 400);
  });
  await t.test('goal defaults, creation and partial updates retain the other setting', async () => {
    assert.deepEqual((await request('/goal')).body.data, {daily_goal:10000, timezone:'Asia/Kolkata'});
    const patch = (body) => request('/goal', {method:'PATCH', body});
    assert.equal((await patch({daily_goal:7500})).body.data.daily_goal, 7500);
    assert.deepEqual((await patch({timezone:'UTC'})).body.data, {daily_goal:7500, timezone:'UTC'});
    assert.equal((await request('/goal', {token:'bob-token'})).body.data.daily_goal, 10000);
  });
  await t.test('invalid goals and timezones are rejected', async () => {
    for (const body of [{}, {daily_goal:0}, {daily_goal:-1}, {daily_goal:1.2}, {daily_goal:200001},
      {timezone:'Unknown/Zone'}, {timezone:'GMT+5'}, {user_id:bob}, {daily_goal:'7500'}]) {
      assert.equal((await request('/goal', {method:'PATCH', body})).status, 400);
    }
  });
  await t.test('simultaneous first goal creation retries the unique-conflict update', async () => {
    goalRace = true;
    assert.deepEqual((await request('/goal', {method:'PATCH', body:{daily_goal:7500}})).body.data, {daily_goal:7500, timezone:'UTC'});
  });
  await t.test('day/week/month history zero fills and uses exclusive end dates', async () => {
    await put({step_date:'2024-02-28', steps:100}); await put({step_date:'2024-02-29', steps:200});
    const day = (await request('/history?period=day&date=2024-02-29')).body.data;
    assert.equal(day.total_steps, 200); assert.equal(day.days.length, 1); assert.equal(day.end_date, '2024-03-01');
    const week = (await request('/history?period=week&date=2024-02-29')).body.data;
    assert.equal(week.total_steps, 300); assert.equal(week.days.length, 7); assert.equal(week.start_date, '2024-02-26');
    const month = (await request('/history?period=month&date=2024-02-29')).body.data;
    assert.equal(month.total_steps, 300); assert.equal(month.days.length, 29); assert.equal(month.end_date, '2024-03-01');
  });
  await t.test('invalid/repeated history parameters fail while empty future reports are harmless', async () => {
    for (const query of ['period=year','period=day&period=week','date=2024-02-30','date=nope','date=2024-01-01&date=2024-01-02']) {
      assert.equal((await request('/history?' + query)).status, 400);
    }
    assert.equal((await request('/history?date=9998-12-31')).body.data.total_steps, 0);
  });
  await t.test('safe database failures and failed sync followed by retry', async () => {
    for (const [status, code, expected] of [[503,'XX000',503],[429,'PGRST000',429],[401,'PGRST301',401],[403,'42501',403],[400,'23514',400]]) {
      forced = {status, body:{code,message:'PRIVATE DATABASE DETAIL'}};
      const res = await put({step_date:'2026-01-01', steps:321});
      assert.equal(res.status, expected); assert.equal(JSON.stringify(res.body).includes('PRIVATE'), false);
    }
    forced = null; assert.equal((await put({step_date:'2026-01-01', steps:321})).status, 200);
    assert.equal(records.size, 1);
  });
  await t.test('malformed persisted goal is a safe service error', async () => {
    goals.set(alice, {daily_goal:0, timezone:'Invalid/Zone'});
    assert.equal((await request('/today')).status, 503);
  });
  await t.test('per-user limiter returns 429 without affecting another account', async () => {
    let response;
    for (let attempt = 0; attempt < 121; attempt++) {
      response = await request('/goal'); if (response.status === 429) break;
    }
    assert.equal(response.status, 429); assert.equal(response.body.error.code, 'RATE_LIMITED');
    assert.equal((await request('/goal', {token:'bob-token'})).status, 200);
  });
});
