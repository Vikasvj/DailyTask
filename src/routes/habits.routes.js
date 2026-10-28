
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';

import * as controller from '../controllers/habits.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = Router();

// All habit endpoints require authentication.
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
        message: 'Too many habit requests. Please try again later.',
      },
    },
  }),
);

router.post('/', controller.createHabit);
router.get('/', controller.listHabits);

router.get('/:id/history', controller.history);
router.post('/:id/completions', controller.completeHabit);
router.delete('/:id/completions/:date', controller.undoCompletion);

router.get('/:id', controller.getHabit);
router.patch('/:id', controller.updateHabit);
router.delete('/:id', controller.deleteHabit);

export default router;
