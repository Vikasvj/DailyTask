import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';

const user = {
  id: '4ef53093-8567-4f4f-bb6e-f065d6088650',
  email: 'person@example.com',
  aud: 'authenticated',
  role: 'authenticated',
  created_at: '2026-01-01T00:00:00.000Z',
  app_metadata: { provider: 'email' },
  user_metadata: { private_fixture: 'must-not-leak' },
  identities: [],
};
const credentials = { email: user.email, password: 'Example-password-2026!' };
const expectedProfile = { id: user.id, email: user.email, created_at: user.created_at };

function session(forUser = user, token = 'fixture-access-token') {
  return {
    access_token: token,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: 'fixture-refresh-token-must-not-leak',
    user: forUser,
  };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('authentication HTTP contract using the real Supabase SDK against a local Auth stub', async (t) => {
  const requests = [];
  let handleUpstream = () => ({ status: 500, body: { message: 'Unexpected upstream request' } });
  const upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const outgoing = { url: req.url, method: req.method, headers: req.headers, body: raw ? JSON.parse(raw) : null };
    requests.push(outgoing);
    const reply = await handleUpstream(outgoing);
    res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', 'X-Supabase-Api-Version': '2024-01-01' });
    res.end(JSON.stringify(reply.body));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => close(upstream));

  const config = {
    NODE_ENV: 'test',
    PORT: 3000,
    SUPABASE_URL: upstreamUrl,
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_placeholder',
    TRUST_PROXY: '',
  };
  for (const [key, value] of Object.entries(config)) process.env[key] = String(value);
  const { default: app } = await import('../src/app.js');
  const server = createServer(app);
  const baseUrl = await listen(server);
  t.after(() => close(server));

  async function request(path, { method = 'POST', body, headers = {} } = {}) {
    const response = await fetch(baseUrl + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }

  let signupBody;
  await t.test('signup forwards validated credentials and returns a generic 202', async () => {
    handleUpstream = () => ({ body: user });
    const result = await request('/api/auth/signup', { body: credentials });
    assert.equal(result.status, 202);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.get('x-powered-by'), null);
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Object.keys(result.body.data), ['message']);
    signupBody = result.body;
    assert.equal(requests.at(-1).url, '/auth/v1/signup');
    assert.equal(requests.at(-1).method, 'POST');
    assert.equal(requests.at(-1).body.email, credentials.email);
    assert.equal(requests.at(-1).body.password, credentials.password);
    assert.equal(requests.at(-1).headers.apikey, config.SUPABASE_PUBLISHABLE_KEY);
  });

  await t.test('explicit existing-account errors have the same signup response', async () => {
    handleUpstream = () => ({ status: 422, body: { code: 'user_already_exists', message: 'Already registered' } });
    const result = await request('/api/auth/signup', { body: credentials });
    assert.equal(result.status, 202);
    assert.deepEqual(result.body, signupBody);
  });

  await t.test('obfuscated existing accounts have the same signup response', async () => {
    handleUpstream = () => ({ body: { ...user, identities: [] } });
    const result = await request('/api/auth/signup', { body: credentials });
    assert.equal(result.status, 202);
    assert.deepEqual(result.body, signupBody);
  });

  await t.test('invalid signup inputs never reach Supabase', async () => {
    const before = requests.length;
    for (const body of [
      { email: 'invalid', password: credentials.password },
      { email: user.email, password: 'short' },
      { ...credentials, role: 'admin' },
      { email: user.email, password: 123456789012 },
      { email: 'bad\u0000@example.com', password: credentials.password },
      { email: user.email, password: [credentials.password] },
      { email: null, password: credentials.password },
      { email: 'person@example.com\r\nInjected: true', password: credentials.password },
    ]) {
      const result = await request('/api/auth/signup', { body });
      assert.equal(result.status, 400);
      assert.equal(result.body.error.code, 'INVALID_INPUT');
    }
    assert.equal(requests.length, before);
  });

  await t.test('login returns the allowed profile fields and access token without refresh tokens', async () => {
    handleUpstream = () => ({ body: session() });
    const result = await request('/api/auth/login', { body: credentials });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data.user, expectedProfile);
    assert.equal(result.body.data.access_token, 'fixture-access-token');
    assert.equal(result.body.data.token_type, 'bearer');
    assert.equal(result.body.data.expires_in, 3600);
    assert.equal(typeof result.body.data.expires_at, 'number');
    assert.equal('refresh_token' in result.body.data, false);
    assert.equal(JSON.stringify(result.body).includes('must-not-leak'), false);
    assert.equal(requests.at(-1).url, '/auth/v1/token?grant_type=password');
  });

  let invalidCredentialsBody;
  await t.test('incorrect credentials return a generic 401', async () => {
    handleUpstream = () => ({ status: 400, body: { code: 'invalid_credentials', message: 'Internal auth detail' } });
    const result = await request('/api/auth/login', { body: credentials });
    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, 'INVALID_CREDENTIALS');
    assert.equal(result.headers.get('www-authenticate'), 'Bearer realm="api"');
    invalidCredentialsBody = result.body;
    assert.equal(JSON.stringify(result.body).includes('Internal auth detail'), false);
  });

  await t.test('unconfirmed email does not disclose account existence', async () => {
    handleUpstream = () => ({ status: 400, body: { code: 'email_not_confirmed', message: 'Email not confirmed' } });
    const result = await request('/api/auth/login', { body: credentials });
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, invalidCredentialsBody);
  });

  await t.test('login accepts an existing password shorter than the new-signup minimum', async () => {
    handleUpstream = () => ({ body: session() });
    const result = await request('/api/auth/login', { body: { email: user.email, password: 'oldpass' } });
    assert.equal(result.status, 200);
    assert.equal(requests.at(-1).body.password, 'oldpass');
  });

  await t.test('missing and malformed Bearer headers are rejected locally, even after login', async () => {
    const before = requests.length;
    for (const headers of [
      {},
      { Authorization: 'Basic fixture' },
      { Authorization: 'Bearer' },
      { Authorization: 'Bearer token another-token' },
    ]) {
      const result = await request('/api/auth/me', { method: 'GET', headers });
      assert.equal(result.status, 401);
      assert.equal(result.body.error.code, 'UNAUTHORIZED');
    }
    assert.equal(requests.length, before);
  });

  await t.test('me verifies the supplied token with Supabase and returns only the profile', async () => {
    handleUpstream = () => ({ body: user });
    const result = await request('/api/auth/me', {
      method: 'GET', headers: { Authorization: 'Bearer fixture-access-token' },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { data: { user: expectedProfile } });
    assert.equal(requests.at(-1).url, '/auth/v1/user');
    assert.equal(requests.at(-1).headers.authorization, 'Bearer fixture-access-token');
  });

  await t.test('invalid and expired tokens are rejected by upstream verification', async () => {
    handleUpstream = () => ({ status: 401, body: { code: 'bad_jwt', message: 'JWT expired or invalid' } });
    const result = await request('/api/auth/me', {
      method: 'GET', headers: { Authorization: 'Bearer tampered.token.signature' },
    });
    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, 'INVALID_TOKEN');
    assert.equal(requests.at(-1).headers.authorization, 'Bearer tampered.token.signature');
  });

  await t.test('invalid project credentials are a service configuration error, not a bad user token', async () => {
    handleUpstream = () => ({ status: 401, body: { message: 'Invalid API key' } });
    const result = await request('/api/auth/me', {
      method: 'GET', headers: { Authorization: 'Bearer fixture-access-token' },
    });
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'AUTH_UNAVAILABLE');
    assert.equal(JSON.stringify(result.body).includes('Invalid API key'), false);
  });

  await t.test('concurrent users have isolated authenticated requests', async () => {
    const otherUser = { ...user, id: '5a90571e-ef89-438b-9c55-92c9b1e47f31', email: 'other@example.com' };
    handleUpstream = (req) => ({
      body: req.headers.authorization === 'Bearer token-one' ? user : otherUser,
    });
    const [first, second] = await Promise.all([
      request('/api/auth/me', { method: 'GET', headers: { Authorization: 'Bearer token-one' } }),
      request('/api/auth/me', { method: 'GET', headers: { Authorization: 'Bearer token-two' } }),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.body.data.user.id, user.id);
    assert.equal(second.body.data.user.id, otherUser.id);
    assert.notEqual(first.body.data.user.id, second.body.data.user.id);
  });

  await t.test('Supabase outages return 503 instead of invalid-credential errors', async () => {
    handleUpstream = () => ({ status: 503, body: { code: 'unexpected_failure', message: 'Database unavailable' } });
    const result = await request('/api/auth/login', { body: credentials });
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'AUTH_UNAVAILABLE');
    assert.equal(JSON.stringify(result.body).includes('Database unavailable'), false);
    const me = await request('/api/auth/me', {
      method: 'GET', headers: { Authorization: 'Bearer fixture-access-token' },
    });
    assert.equal(me.status, 503);
    assert.equal(me.body.error.code, 'AUTH_UNAVAILABLE');
  });

  await t.test('Supabase throttling returns 429', async () => {
    handleUpstream = () => ({ status: 429, body: { code: 'over_request_rate_limit', message: 'Rate limited' } });
    const result = await request('/api/auth/login', { body: credentials });
    assert.equal(result.status, 429);
    assert.equal(result.body.error.code, 'RATE_LIMITED');
  });

  await t.test('provider password policy errors remain safe and useful', async () => {
    handleUpstream = () => ({ status: 422, body: { code: 'weak_password', message: 'Secret policy details' } });
    const result = await request('/api/auth/signup', { body: credentials });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'WEAK_PASSWORD');
    assert.equal(JSON.stringify(result.body).includes('Secret policy details'), false);
  });

  await t.test('malformed JSON receives the standard error envelope', async () => {
    const response = await fetch(baseUrl + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"PRIVATE-INVALID-JSON","email":',
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'INVALID_JSON');
    assert.equal(body.error.message, 'Request body must contain valid JSON.');
    assert.equal(JSON.stringify(body).includes('PRIVATE-INVALID-JSON'), false);
  });

  await t.test('non-JSON requests are rejected', async () => {
    const response = await fetch(baseUrl + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'email=person@example.com',
    });
    assert.equal(response.status, 415);
    assert.equal((await response.json()).error.code, 'UNSUPPORTED_MEDIA_TYPE');
  });

  await t.test('oversized JSON is rejected before contacting Supabase', async () => {
    const before = requests.length;
    const result = await request('/api/auth/login', {
      body: { email: user.email, password: 'a'.repeat(5000) },
    });
    assert.equal(result.status, 413);
    assert.equal(result.body.error.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(requests.length, before);
  });

  await t.test('unknown endpoints return JSON 404', async () => {
    const result = await request('/missing', { method: 'GET' });
    assert.equal(result.status, 404);
    assert.equal(result.body.error.code, 'NOT_FOUND');
  });


});
