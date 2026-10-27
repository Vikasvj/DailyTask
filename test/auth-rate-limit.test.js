import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('local rate limiting blocks the twenty-first authentication attempt', async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', PORT: '3000', TRUST_PROXY: '',
      SUPABASE_URL: 'http://127.0.0.1:1',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_placeholder',
    });
    const { default: app } = await import('../src/app.js');
    const limitedServer = createServer(app);
    const limitedUrl = await listen(limitedServer);
    try {
      for (let index = 0; index < 20; index += 1) {
        const response = await fetch(limitedUrl + '/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        assert.equal(response.status, 400);
        await response.json();
      }
      const response = await fetch(limitedUrl + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(response.status, 429);
      assert.equal((await response.json()).error.code, 'RATE_LIMITED');
      assert.ok(response.headers.get('retry-after'));
      assert.ok(response.headers.get('ratelimit'));
    } finally {
      await close(limitedServer);
    }
  });
