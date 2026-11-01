import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';

import * as controller from '../controllers/shared-lists.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = Router();
router.use(authenticate);
router.use(rateLimit({
  windowMs: 60_000,
  limit: 120,
  keyGenerator: (req) => req.user.id,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: { code: 'RATE_LIMITED', message: 'Too many list requests. Please try again later.' },
  },
}));

// Keep fixed routes before /:id.
router.get('/invitations', controller.listInvitations);
router.post('/invitations/:id/accept', controller.acceptInvitation);
router.post('/:id/items', controller.createItem);
router.patch('/:id/items/:itemId', controller.updateItem);
router.delete('/:id/items/:itemId', controller.deleteItem);
router.post('/:id/shares', controller.shareList);
router.delete('/:id/shares/:inviteId', controller.revokeInvitation);
router.delete('/:id/members/:memberId', controller.removeMember);
router.delete('/:id/membership', controller.leaveList);
router.get('/', controller.listLists);
router.post('/', controller.createList);
router.get('/:id', controller.getList);
router.patch('/:id', controller.updateList);
router.delete('/:id', controller.deleteList);

export default router;
