import { getSupabase } from '../config/supabase.js';

function error(status, code, message) {
  return Object.assign(new Error(message), { status, code, expose: true });
}

function unavailable() {
  return error(503, 'AUTH_UNAVAILABLE', 'Authentication is temporarily unavailable. Please try again later.');
}

function authError(cause, operation) {
  if (cause.status === 429) {
    return error(429, 'RATE_LIMITED', 'Too many authentication requests. Please try again later.');
  }
  if (!Number.isInteger(cause.status) || cause.status === 0 || cause.status >= 500 ||
      cause.name === 'AuthRetryableFetchError') return unavailable();

  if (operation === 'login' &&
      ['invalid_credentials', 'email_not_confirmed', 'user_banned'].includes(cause.code)) {
    return error(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
  }
  if (operation === 'verify' && (
    ['bad_jwt', 'no_authorization', 'user_not_found', 'session_not_found',
      'session_expired', 'user_banned', 'unexpected_audience'].includes(cause.code) ||
    cause.name === 'AuthSessionMissingError'
  )) {
    return error(401, 'INVALID_TOKEN', 'The access token is invalid or expired.');
  }
  if (operation === 'signup' && cause.code === 'weak_password') {
    return error(400, 'WEAK_PASSWORD', 'Password does not meet the project password policy.');
  }
  if (operation === 'signup' && ['email_address_invalid', 'validation_failed'].includes(cause.code)) {
    return error(400, 'INVALID_INPUT', 'Provide a valid email and password.');
  }
  return unavailable();
}

function credentials(input, signup) {
  const validObject = input && typeof input === 'object' && !Array.isArray(input);
  const email = typeof input?.email === 'string' ? input.email.trim() : '';
  const validEmail = email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
    !/[\u0000-\u001f\u007f]/.test(email);
  const validPassword = typeof input?.password === 'string' &&
    input.password.length >= (signup ? 12 : 1) && input.password.length <= 128;
  if (!validObject || Object.keys(input).length !== 2 ||
      !Object.hasOwn(input, 'email') || !Object.hasOwn(input, 'password') ||
      !validEmail || !validPassword) {
    throw error(400, 'INVALID_INPUT', signup
      ? 'Provide only a valid email and a password between 12 and 128 characters.'
      : 'Provide only a valid email and a non-empty password of at most 128 characters.');
  }
  return { email, password: input.password };
}

export function profile(user) {
  return { id: user.id, email: user.email, created_at: user.created_at };
}

export async function signup(input) {
  const payload = credentials(input, true);
  const { error: cause } = await getSupabase().auth.signUp(payload);
  if (cause && !['user_already_exists', 'email_exists'].includes(cause.code)) {
    throw authError(cause, 'signup');
  }
  return { message: 'If registration can proceed, check your email to confirm your account before logging in.' };
}

export async function login(input) {
  const payload = credentials(input, false);
  const { data, error: cause } = await getSupabase().auth.signInWithPassword(payload);
  if (cause) throw authError(cause, 'login');
  if (!data?.session?.access_token || !data.user?.id) throw unavailable();
  const { access_token, token_type, expires_in, expires_at } = data.session;
  return { user: profile(data.user), access_token, token_type, expires_in, expires_at };
}

export async function verifyAccessToken(token) {
  const { data, error: cause } = await getSupabase().auth.getUser(token);
  if (cause) throw authError(cause, 'verify');
  if (!data?.user?.id) throw unavailable();
  return data.user;
}
