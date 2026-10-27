import { verifyAccessToken } from '../services/auth.service.js';

export async function authenticate(req, res, next) {
  const match = /^Bearer ([^\s,]+)$/i.exec(req.get('authorization') ?? '');
  if (!match || match[1].length > 8192) {
    throw Object.assign(new Error('Provide a Bearer access token.'), {
      status: 401, code: 'UNAUTHORIZED', expose: true,
    });
  }
  // getUser(token) verifies with Supabase Auth; decoded claims are never trusted.
  req.user = await verifyAccessToken(match[1]);
  req.accessToken = match[1];
  next();
}
