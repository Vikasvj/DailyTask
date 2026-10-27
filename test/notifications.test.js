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

test('notification HTTP contract through existing Express auth and Supabase SDK', async (t) => {
  let records = []; let candidates = []; let calls = []; let forced = null;
  let rpcValue;
  const project = createServer(async (req, res) => {
    const reply = (status, data, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'X-Supabase-Api-Version': '2024-01-01', ...headers });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(data));
    };
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : null;
      const url = new URL(req.url, 'http://localhost');
      const user = owners.get(req.headers.authorization?.replace('Bearer ', ''));
      calls.push({ method: req.method, path: url.pathname, query: url.searchParams, body, user });
      if (url.pathname === '/auth/v1/user') return user
        ? reply(200, { id: user, email: 'fixture@example.com', created_at: '2026-01-01T00:00:00Z' })
        : reply(401, { code: 'bad_jwt', message: 'Invalid fixture token' });
      if (!user) return reply(401, { code: 'PGRST301' });
      if (forced && (!forced.path || forced.path === url.pathname)) return reply(forced.status, forced.body);
      if (url.pathname === '/rest/v1/rpc/sync_habit_notifications') {
        assert.equal(req.method, 'POST');
        assert.deepEqual(body, {}, 'the invoker RPC derives ownership from auth.uid(), not request fields');
        if (rpcValue !== undefined) return reply(200, rpcValue);
        let created = 0;
        // Mimics the migration's unique deduplication key. SQL behavior has separate tests.
        for (const candidate of candidates.filter((entry) => entry.user_id === user)) {
          if (!records.some((entry) => entry.user_id === user && entry.key === candidate.key)) {
            records.push({ id: randomUUID(), type: 'habit', title: 'Goal reached', body: 'Your daily goal is complete.',
              data: {}, created_at: new Date().toISOString(), read_at: null, expires_at: null, ...candidate });
            created++;
          }
        }
        return reply(200, created);
      }
      if (url.pathname !== '/rest/v1/notifications') return reply(404, { code: 'FIXTURE_ENDPOINT_MISSING' });
      assert.equal(url.searchParams.get('user_id'), 'eq.' + user);
      let rows = records.filter((row) => row.user_id === user);
      const id = url.searchParams.get('id');
      if (id) rows = rows.filter((row) => 'eq.' + row.id === id);
      if (url.searchParams.get('read_at') === 'is.null') rows = rows.filter((row) => row.read_at === null);
      if (req.method === 'HEAD') {
        assert.match(req.headers.prefer, /count=exact/);
        return reply(200, null, { 'Content-Range': '0-0/' + rows.length });
      }
      if (req.method === 'PATCH') {
        assert.deepEqual(Object.keys(body), ['read_at']);
        assert.ok(Number.isFinite(Date.parse(body.read_at)));
        rows.forEach((row) => { row.read_at = body.read_at; });
      } else {
        assert.equal(req.method, 'GET');
        if (url.searchParams.get('order')) {
          assert.equal(url.searchParams.get('order'), 'created_at.desc');
          rows = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));
        }
        if (url.searchParams.get('limit')) rows = rows.slice(0, Number(url.searchParams.get('limit')));
      }
      const columns = url.searchParams.get('select').split(',');
      const projected = rows.map((row) => Object.fromEntries(columns.map((key) => [key, row[key]])));
      return reply(200, req.headers.accept?.includes('vnd.pgrst.object') ? projected[0] ?? null : projected);
    } catch (error) { reply(500, { code: 'FIXTURE_FAILURE', message: error.message }); }
  });
  const projectUrl = await listen(project); t.after(() => close(project));
  Object.assign(process.env, { NODE_ENV: 'test', PORT: '3000', TRUST_PROXY: '',
    SUPABASE_URL: projectUrl, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_notifications_fixture' });
  const { default: app } = await import('../src/app.js');
  const api = createServer(app); const base = await listen(api); t.after(() => close(api));
  t.beforeEach(() => { records = []; candidates = []; calls = []; forced = null; rpcValue = undefined; });
  const request = async (path = '', { method = 'GET', token = 'alice-token', body } = {}) => {
    const res = await fetch(base + '/api/notifications' + path, {
      method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(method === 'PATCH' ? { 'Content-Type': 'application/json' } : {}) },
      body: method === 'PATCH' ? JSON.stringify(body ?? {}) : undefined,
    });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  const patch = (path, options = {}) => request(path, { method: 'PATCH', ...options });
  const rpcCalls = () => calls.filter((call) => call.path.endsWith('/rpc/sync_habit_notifications'));
  const seed = (user = alice, extra = {}) => {
    const row = { id: randomUUID(), user_id: user, type: 'welcome', title: 'Welcome', body: 'Start your daily habits.',
      data: {}, created_at: '2026-01-01T00:00:00Z', read_at: null, expires_at: null, ...extra };
    records.push(row); return row;
  };

  await t.test('all existing routes require valid authentication before generation or database reads', async () => {
    for (const [path, method] of [['', 'GET'], ['/unread-count', 'GET'], ['/read-all', 'PATCH'], ['/' + randomUUID() + '/read', 'PATCH']]) {
      for (const token of [null, 'expired-token']) {
        const res = await request(path, { method, token });
        assert.equal(res.status, 401); assert.ok(res.headers.get('www-authenticate'));
      }
    }
    assert.equal(rpcCalls().length, 0); assert.ok(calls.every((call) => call.path === '/auth/v1/user'));
  });
  await t.test('list synchronizes before reading and keeps the existing response fields and metadata', async () => {
    candidates.push({ user_id: alice, key: 'welcome', title: 'Welcome' });
    const res = await request('?limit=20');
    assert.equal(res.status, 200); assert.deepEqual(res.body.meta, { limit: 20, unread_only: false });
    assert.equal(res.body.data.length, 1); assert.equal(res.body.data[0].title, 'Welcome');
    assert.deepEqual(Object.keys(res.body.data[0]).sort(), ['body','created_at','data','expires_at','id','read_at','title','type']);
    assert.deepEqual(calls.filter((call) => call.path.startsWith('/rest/')).map((call) => call.path),
      ['/rest/v1/rpc/sync_habit_notifications', '/rest/v1/notifications']);
  });
  await t.test('unread count synchronizes before its exact owner-scoped HEAD query', async () => {
    candidates.push({ user_id: alice, key: 'water:today' }, { user_id: bob, key: 'water:today' });
    const res = await request('/unread-count');
    assert.equal(res.status, 200); assert.deepEqual(res.body, { data: { unread_count: 1 } });
    assert.equal(records.length, 1); assert.equal(records[0].user_id, alice);
    assert.equal(calls.at(-1).method, 'HEAD'); assert.equal(rpcCalls()[0].user, alice);
  });
  await t.test('list uses newest-first ordering, limit and unread-only filter', async () => {
    seed(alice, { title: 'Old' }); seed(alice, { title: 'Read', created_at: '2026-01-02T00:00:00Z', read_at: '2026-01-02T01:00:00Z' });
    seed(alice, { title: 'New', created_at: '2026-01-03T00:00:00Z' }); seed(bob);
    assert.deepEqual((await request('?limit=2')).body.data.map((row) => row.title), ['New', 'Read']);
    const unread = (await request('?limit=20&unread_only=true')).body;
    assert.deepEqual(unread.data.map((row) => row.title), ['New', 'Old']);
    assert.deepEqual(unread.meta, { limit: 20, unread_only: true });
    assert.equal((await request('?unread_only=false')).body.data.length, 3);
  });
  await t.test('repeated and concurrent reads do not duplicate generated notifications', async () => {
    candidates.push(...['welcome', 'water:today', 'steps:today'].map((key) => ({ user_id: alice, key })));
    const responses = await Promise.all([request(), request('/unread-count'), request('?unread_only=true')]);
    assert.ok(responses.every((res) => res.status === 200)); assert.equal(records.length, 3);
    assert.equal((await request('/unread-count')).body.data.unread_count, 3);
    assert.equal(records.length, 3);
  });
  await t.test('mark-one and mark-all update counts, are idempotent and never invoke generation', async () => {
    const first = seed(); seed(); seed(bob);
    const one = await patch('/' + first.id + '/read');
    assert.equal(one.status, 200); assert.ok(one.body.data.read_at);
    assert.equal((await patch('/' + first.id + '/read')).body.data.read_at, one.body.data.read_at);
    assert.deepEqual((await patch('/read-all')).body, { data: { updated_count: 1 } });
    assert.deepEqual((await patch('/read-all')).body, { data: { updated_count: 0 } });
    assert.equal(rpcCalls().length, 0);
    assert.equal(records.find((row) => row.user_id === bob).read_at, null);
    assert.equal((await request('/unread-count')).body.data.unread_count, 0);
    assert.equal((await request('?unread_only=true')).body.data.length, 0);
  });
  await t.test('another account cannot read or mark a notification by id', async () => {
    const own = seed(); seed(bob);
    const res = await patch('/' + own.id + '/read', { token: 'bob-token' });
    assert.equal(res.status, 404); assert.equal(res.body.error.code, 'NOT_FOUND'); assert.equal(own.read_at, null);
    const list = await request('', { token: 'bob-token' });
    assert.equal(list.body.data.length, 1); assert.notEqual(list.body.data[0].id, own.id);
  });
  await t.test('invalid or repeated query parameters fail before the sync RPC', async () => {
    for (const query of ['limit=0','limit=-1','limit=101','limit=1.5','limit=abc','limit=','limit=20&limit=10',
      'unread_only=1','unread_only=TRUE','unread_only=true&unread_only=false','user_id=' + bob]) {
      assert.equal((await request('?' + query)).status, 400, query);
    }
    assert.equal((await request('/unread-count?limit=20')).status, 400);
    assert.equal((await patch('/read-all?user_id=' + bob)).status, 400);
    assert.equal((await patch('/not-a-uuid/read')).status, 400);
    assert.equal(rpcCalls().length, 0); assert.ok(calls.every((call) => call.path === '/auth/v1/user'));
  });
  await t.test('missing migration produces an actionable setup error without leaking SQL details', async () => {
    for (const code of ['PGRST202', '42883']) {
      forced = { status: 404, body: { code, message: 'PRIVATE SQL DETAIL' }, path: '/rest/v1/rpc/sync_habit_notifications' };
      for (const path of ['', '/unread-count']) {
        const res = await request(path); assert.equal(res.status, 503);
        assert.deepEqual(res.body.error, { code: 'NOTIFICATION_SETUP_REQUIRED',
          message: 'Notification setup is incomplete. Apply the automatic notifications migration.' });
      }
    }
  });
  await t.test('RPC failures preserve existing safe database and authorization mappings', async () => {
    for (const [status, code, expected] of [[503,'XX000',503],[429,'PGRST000',429],[401,'PGRST301',401],[403,'42501',403],[400,'23514',400]]) {
      forced = { status, body: { code, message: 'PRIVATE DATABASE DETAIL' }, path: '/rest/v1/rpc/sync_habit_notifications' };
      const res = await request(); assert.equal(res.status, expected); assert.ok(!JSON.stringify(res.body).includes('PRIVATE'));
      if (expected === 401) assert.ok(res.headers.get('www-authenticate'));
    }
    assert.ok(calls.every((call) => call.path !== '/rest/v1/notifications'), 'failed generation stops the subsequent read');
  });
  await t.test('malformed RPC counts are rejected and a failed read can safely retry', async () => {
    for (const value of [null, '1', -1, 1.5, 4, {}, []]) {
      rpcValue = value; assert.equal((await request()).status, 503);
    }
    rpcValue = undefined; candidates.push({ user_id: alice, key: 'welcome' });
    forced = { status: 503, body: { code: 'XX000' }, path: '/rest/v1/notifications' };
    assert.equal((await request()).status, 503); assert.equal(records.length, 1);
    forced = null; assert.equal((await request()).body.data.length, 1); assert.equal(records.length, 1);
  });
  await t.test('per-user rate limit returns 429 without generating again or blocking another account', async () => {
    let res;
    for (let attempt = 0; attempt < 121; attempt++) {
      const before = rpcCalls().length; res = await request('/unread-count');
      if (res.status === 429) { assert.equal(rpcCalls().length, before); break; }
    }
    assert.equal(res.status, 429); assert.equal(res.body.error.code, 'RATE_LIMITED');
    assert.equal((await request('/unread-count', { token: 'bob-token' })).status, 200);
  });
});
