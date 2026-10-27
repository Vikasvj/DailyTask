import * as profileService from '../services/profile.service.js';

function noQuery(req) {
  if (Object.keys(req.query).length) {
    throw Object.assign(
      new Error('Unexpected query parameters.'),
      {
        status: 400,
        code: 'INVALID_INPUT',
        expose: true,
      },
    );
  }
}

export async function getProfile(req, res) {
  noQuery(req);

  res.json({
    data: await profileService.getProfile(
      req.user.id,
      req.accessToken,
    ),
  });
}

export async function updateProfile(req, res) {
  noQuery(req);

  res.json({
    data: await profileService.updateProfile(
      req.user.id,
      req.accessToken,
      req.body,
    ),
  });
}

export async function uploadAvatar(req, res) {
  noQuery(req);

  res.json({
    data: await profileService.uploadAvatar(
      req.user.id,
      req.accessToken,
      req.file,
    ),
  });
}
