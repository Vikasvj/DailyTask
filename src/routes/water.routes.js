import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import * as controller from '../controllers/water.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = Router();
router.use(authenticate);
router.use(rateLimit({
  windowMs: 60_000,
  limit: 120,
  keyGenerator: (req) => req.user.id,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many water requests. Please try again later.' } },
}));

router.post('/entries', controller.createEntry);
router.get('/entries', controller.listEntries);
router.patch('/entries/:id', controller.updateEntry);
router.delete('/entries/:id', controller.deleteEntry);
router.get('/today', controller.today);
router.get('/history', controller.history);
router.get('/goal', controller.getGoal);
router.patch('/goal', controller.updateGoal);

export default router;
