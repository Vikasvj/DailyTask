
import { Router } from 'express';

import { authenticate } from '../middleware/auth.middleware.js';
import * as controller from '../controllers/streaks.controller.js';

const router = Router();

// Every endpoint requires an authenticated user.
router.use(authenticate);

// Express 4 compatible async error forwarding.
const asyncHandler = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

// Streaks overview and overall insights.
router.get('/', asyncHandler(controller.overview));
router.get('/insights', asyncHandler(controller.insights));

// Per-habit details.
router.get(
  '/habits/:id/stats',
  asyncHandler(controller.habitStats),
);

router.get(
  '/habits/:id/calendar',
  asyncHandler(controller.habitCalendar),
);

router.get(
  '/habits/:id/history',
  asyncHandler(controller.habitHistory),
);

export default router;
