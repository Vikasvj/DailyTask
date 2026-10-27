import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';

test('local browser CORS preserves protected water API authentication', async (t) => {
  process.env.SUPABASE_URL = 'https://cors-fixture.invalid';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_cors_fixture';
  process.env.PORT = '3000';
  process.env.TRUST_PROXY = '';

  async function start(mode) {
    process.env.NODE_ENV = mode;
    const { default: app } = await import('../src/app.js?cors=' + mode);
    const server = createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });
    return 'http://127.0.0.1:' + server.address().port;
  }

  const developmentUrl = await start('development');
  const preflight = (baseUrl, origin) => fetch(baseUrl + '/api/water/today', {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization, content-type',
    },
  });

  await t.test('localhost browser preflight succeeds before authentication', async () => {
    for (const origin of [
      'http://localhost:8080', 'http://localhost:54321',
      'http://127.0.0.1:8080', 'http://[::1]:8080',
    ]) {
      const response = await preflight(developmentUrl, origin);
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
      assert.match(response.headers.get('vary'), /Origin/i);
      assert.match(response.headers.get('access-control-allow-methods'), /GET/);
      assert.match(response.headers.get('access-control-allow-headers'), /Authorization/i);
      assert.match(response.headers.get('access-control-allow-headers'), /Content-Type/i);
      assert.equal(response.headers.get('access-control-allow-credentials'), null);
      assert.equal(await response.text(), '');
    }
  });

  await t.test('browser can read the actual 401 instead of a generic network failure', async () => {
    const response = await fetch(developmentUrl + '/api/water/today', {
      headers: { Origin: 'http://localhost:8080' },
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:8080');
    assert.equal((await response.json()).error.code, 'UNAUTHORIZED');
  });

  await t.test('step PUT preflight permits JSON and Bearer authentication', async () => {
    const response = await fetch(developmentUrl + '/api/steps/today', {
      method: 'OPTIONS', headers: { Origin: 'http://localhost:8080',
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'authorization, content-type' },
    });
    assert.equal(response.status, 204);
    assert.ok(response.headers.get('access-control-allow-methods').split(/,\s*/).includes('PUT'));
  });

  await t.test('real create, update and delete requests still require a valid token', async () => {
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const path = method === 'POST' ? '/api/water/entries'
        : '/api/water/entries/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const response = await fetch(developmentUrl + path, {
        method,
        headers: { Origin: 'http://localhost:8080', 'Content-Type': 'application/json' },
        body: method === 'DELETE' ? undefined : JSON.stringify({ amount_ml: 250 }),
      });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:8080');
      assert.equal((await response.json()).error.code, 'UNAUTHORIZED');
    }
  });

  await t.test('external, opaque and spoofed localhost origins are not granted CORS access', async () => {
    for (const origin of [
      'https://example.com', 'null', 'http://localhost.evil.test:8080',
      'http://127.0.0.1.evil.test:8080', 'http://user@localhost:8080',
    ]) {
      const response = await preflight(developmentUrl, origin);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
  });

  await t.test('native Android requests without an Origin remain protected', async () => {
    const response = await fetch(developmentUrl + '/api/water/today');
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });

  await t.test('production does not inherit development localhost permissions', async () => {
    const productionUrl = await start('production');
    const response = await preflight(productionUrl, 'http://localhost:8080');
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });
});
