import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';

import * as controller from '../controllers/notifications.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = Router();

// All notification routes require authentication.
router.use(authenticate);

// Apply rate limiting per authenticated user.
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
        message: 'Too many notification requests. Please try again later.',
      },
    },
  }),
);

// GET /api/notifications
router.get('/', controller.listNotifications);

// Device registration and user-owned reminder preferences.
router.post('/devices', controller.registerDevice);
router.delete('/devices/current', controller.unregisterDevice);
router.get('/reminders', controller.getReminderPreferences);
router.patch('/reminders', controller.updateReminderPreferences);

// GET /api/notifications/unread-count
router.get('/unread-count', controller.getUnreadCount);

// PATCH /api/notifications/read-all
router.patch('/read-all', controller.markAllAsRead);

// PATCH /api/notifications/:id/read
router.patch('/:id/read', controller.markAsRead);

export default router;
