import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';

import * as controller from '../controllers/steps.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = Router();

router.use(authenticate);

router.use(
  rateLimit({
    windowMs: 60_000,
    limit: 120,
    keyGenerator: (req) => req.user.id,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many step requests. Please try again later.',
      },
    },
  }),
);

router.get('/today', controller.getToday);
router.put('/today', controller.saveToday);

router.get('/history', controller.history);

router.get('/goal', controller.getGoal);
router.patch('/goal', controller.updateGoal);

export default router;