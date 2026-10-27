import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import * as controller from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = Router();
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: { code: 'RATE_LIMITED', message: 'Too many authentication requests. Please try again later.' },
  },
});

router.post('/signup', authLimiter, controller.signup);
router.post('/login', authLimiter, controller.login);
router.get('/me', authenticate, controller.me);

export default router;
