import assert from 'node:assert/strict';
import test from 'node:test';
import { readEnv } from '../src/config/supabase.js';

const valid = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_placeholder',
};

test('configuration has safe defaults', () => {
  assert.deepEqual(readEnv(valid), {
    NODE_ENV: 'development',
    PORT: 3000,
    ...valid,
    TRUST_PROXY: '',
  });
});

test('missing configuration reports names without printing supplied credentials', () => {
  assert.throws(() => readEnv({ SUPABASE_PUBLISHABLE_KEY: 'private-credential-value' }), (error) => {
    assert.match(error.message, /SUPABASE_URL/);
    assert.match(error.message, /SUPABASE_PUBLISHABLE_KEY/);
    assert.equal(error.message.includes('private-credential-value'), false);
    return true;
  });
});

test('configuration rejects privileged credentials, invalid ports, unsafe URLs and open proxy trust', () => {
  for (const overrides of [
    { SUPABASE_PUBLISHABLE_KEY: 'sb_secret_not-a-real-key' },
    { PORT: 'invalid' },
    { PORT: '65536' },
    { SUPABASE_URL: 'http://example.supabase.co' },
    { SUPABASE_URL: 'https://user:password@example.supabase.co' },
    { SUPABASE_URL: 'https://example.supabase.co/auth/v1' },
    { TRUST_PROXY: 'true' },
    { TRUST_PROXY: '0.0.0.0/0' },
    { TRUST_PROXY: '::/0' },
    { TRUST_PROXY: 'untrusted-proxy' },
    { TRUST_PROXY: '127.0.0.1/33' },
    { TRUST_PROXY: '::1/129' },
    { TRUST_PROXY: false },
  ]) {
    assert.throws(() => readEnv({ ...valid, ...overrides }), /Invalid environment configuration/);
  }
});

test('local HTTP is available for development but cannot be configured in production', () => {
  assert.equal(readEnv({ ...valid, SUPABASE_URL: 'http://127.0.0.1:54321' }).SUPABASE_URL,
    'http://127.0.0.1:54321');
  assert.throws(() => readEnv({
    ...valid, NODE_ENV: 'production', SUPABASE_URL: 'http://127.0.0.1:54321',
  }), /SUPABASE_URL/);
});
