import * as authService from '../services/auth.service.js';

function noQuery(req) {
  if (Object.keys(req.query).length) {
    throw Object.assign(new Error('Unexpected query parameters.'), {
      status: 400, code: 'INVALID_INPUT', expose: true,
    });
  }
}

export async function signup(req, res) {
  noQuery(req);
  res.status(202).json({ data: await authService.signup(req.body) });
}

export async function login(req, res) {
  noQuery(req);
  res.json({ data: await authService.login(req.body) });
}

export function me(req, res) {
  res.json({ data: { user: authService.profile(req.user) } });
}
