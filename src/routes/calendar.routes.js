import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';

import { authenticate } from '../middleware/auth.middleware.js';
import { monthlyCalendar } from '../controllers/calendar.controller.js';

const router = Router();

router.use(authenticate);

router.use(rateLimit({
  windowMs: 60_000,
  limit: 120,
  keyGenerator: (req) => req.user.id,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many calendar requests. Please try again later.',
    },
  },
}));

router.get('/', (req, res, next) => {
  Promise.resolve(monthlyCalendar(req, res)).catch(next);
});

export default router;