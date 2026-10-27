import express from 'express';
import helmet from 'helmet';
import { readEnv } from './config/supabase.js';
import authRoutes from './routes/auth.routes.js';
import waterRoutes from './routes/water.routes.js';
import stepsRoutes from './routes/steps.routes.js';
import profileRoutes from './routes/profile.routes.js';
import notificationsRoutes from './routes/notifications.routes.js';


const app = express();
const config = readEnv();
app.disable('x-powered-by');
app.set('trust proxy', config.TRUST_PROXY
  ? config.TRUST_PROXY.split(',').map((address) => address.trim()) : false);
app.use(helmet());
// Flutter web development uses a separate localhost origin from this API.
app.use((req, res, next) => {
  res.vary('Origin');
  const origin = req.get('Origin');
  const localOrigin = typeof origin === 'string' &&
    /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(origin);
  if (config.NODE_ENV !== 'production' && localOrigin) {
    res.set('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      return res.status(204).end();
    }
  }
  next();
});
// app.use((req, res, next) => {
//   res.set('Cache-Control', 'no-store');
//   if (['POST', 'PATCH'].includes(req.method) && !req.is('application/json')) {
//     return res.status(415).json({
//       error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Use Content-Type: application/json.' },
//     });
//   }
//   next();
// });

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');

  const isAvatarUpload =
    req.method === 'POST' &&
    req.path.replace(/\/+$/, '') === '/api/profile/avatar';

  if (isAvatarUpload) {
    if (!req.is('multipart/form-data')) {
      return res.status(415).json({
        error: {
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: 'Use multipart/form-data for avatar uploads.',
        },
      });
    }

    return next();
  }

  if (
    ['POST', 'PUT', 'PATCH'].includes(req.method) &&
    !req.is('application/json')
  ) {
    return res.status(415).json({
      error: {
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'Use Content-Type: application/json.',
      },
    });
  }

  next();
});

app.use(express.json({ limit: '4kb', inflate: false }));
app.use('/api/auth', authRoutes);
app.use('/api/water', waterRoutes);
app.use('/api/steps', stepsRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use((req, res) => res.status(404).json({
  error: { code: 'NOT_FOUND', message: 'Endpoint not found.' },
}));

const bodyErrors = new Map([
  ['entity.parse.failed', [400, 'INVALID_JSON', 'Request body must contain valid JSON.']],
  ['entity.too.large', [413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds the 4 KB limit.']],
  ['charset.unsupported', [415, 'UNSUPPORTED_MEDIA_TYPE', 'Use UTF-8 encoded JSON.']],
  ['encoding.unsupported', [415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported request body encoding.']],
  ['request.aborted', [400, 'INVALID_REQUEST', 'The request body was incomplete.']],
  ['request.size.invalid', [400, 'INVALID_REQUEST', 'Invalid request body size.']],
]);

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'An unexpected error occurred.';
  if (bodyErrors.has(err.type)) {
    [status, code, message] = bodyErrors.get(err.type);
  } else if (err.expose === true && typeof err.code === 'string' && /^[A-Z_]+$/.test(err.code) &&
      Number.isInteger(err.status) && err.status >= 400 && err.status <= 599) {
    ({ status, code, message } = err);
  } else {
    // Never log request bodies, headers, tokens or raw upstream errors.
    console.error(JSON.stringify({ event: 'request_error', name: err.name ?? 'Error' }));
  }
  if (status === 401) res.set('WWW-Authenticate', 'Bearer realm="api"');
  res.status(status).json({ error: { code, message } });
});

export default app;
