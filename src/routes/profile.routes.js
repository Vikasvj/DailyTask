import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';

import * as controller from '../controllers/profile.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 2 * 1024 * 1024, // 2 MB
    files: 1,
  },

  fileFilter(req, file, callback) {
    const allowedTypes = [
      'image/jpeg',
      'image/png',
      'image/webp',
    ];

    if (!allowedTypes.includes(file.mimetype)) {
      const error = Object.assign(
        new Error('Only JPG, PNG, and WebP images are allowed.'),
        {
          status: 400,
          code: 'INVALID_INPUT',
          expose: true,
        },
      );

      return callback(error);
    }

    callback(null, true);
  },
});

router.use(authenticate);
// Upload profile photo
router.post(
  '/avatar',
  upload.single('avatar'),
  controller.uploadAvatar,
);

router.use(
  rateLimit({
    windowMs: 60_000,
    limit: 60,
    keyGenerator: (req) => req.user.id,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many profile requests. Please try again later.',
      },
    },
  }),
);

router.get('/', controller.getProfile);
router.patch('/', controller.updateProfile);



export default router;