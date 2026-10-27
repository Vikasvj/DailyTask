import { createClient } from '@supabase/supabase-js';
import { isIP } from 'node:net';

export function readEnv(source = process.env) {
  const config = {
    NODE_ENV: source.NODE_ENV ?? 'development',
    PORT: Number(source.PORT ?? 3000),
    SUPABASE_URL: source.SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: typeof source.SUPABASE_PUBLISHABLE_KEY === 'string'
      ? source.SUPABASE_PUBLISHABLE_KEY.trim() : '',
    TRUST_PROXY: typeof source.TRUST_PROXY === 'string' ? source.TRUST_PROXY.trim() : '',
  };
  const invalid = [];
  if (!['development', 'test', 'production'].includes(config.NODE_ENV)) invalid.push('NODE_ENV');
  if (!Number.isInteger(config.PORT) || config.PORT < 1 || config.PORT > 65535) invalid.push('PORT');

  try {
    if (typeof config.SUPABASE_URL !== 'string') throw new Error();
    const url = new URL(config.SUPABASE_URL);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local && config.NODE_ENV !== 'production')) ||
        url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
  } catch {
    invalid.push('SUPABASE_URL');
  }
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.SUPABASE_PUBLISHABLE_KEY)) {
    invalid.push('SUPABASE_PUBLISHABLE_KEY');
  }

  if (source.TRUST_PROXY !== undefined && typeof source.TRUST_PROXY !== 'string') invalid.push('TRUST_PROXY');
  if (config.TRUST_PROXY) {
    for (const proxy of config.TRUST_PROXY.split(',').map((value) => value.trim())) {
      if (['loopback', 'linklocal', 'uniquelocal'].includes(proxy)) continue;
      const [address, prefix, extra] = proxy.split('/');
      const family = isIP(address);
      if (!family || extra !== undefined ||
          (prefix !== undefined && (!/^\d+$/.test(prefix) ||
            Number(prefix) < 1 || Number(prefix) > (family === 4 ? 32 : 128)))) {
        invalid.push('TRUST_PROXY');
        break;
      }
    }
  }
  if (invalid.length) {
    // Never include environment values in configuration errors.
    throw new Error('Invalid environment configuration: ' + [...new Set(invalid)].join(', ') + '. See .env.example.');
  }
  return config;
}

export function getSupabase(accessToken) {
  const config = readEnv();
  // signInWithPassword changes client state: never share an auth client across users.
  return createClient(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: accessToken ? { Authorization: 'Bearer ' + accessToken } : {},
      fetch: (input, options = {}) => fetch(input, {
        ...options,
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      }),
    },
  });
}
