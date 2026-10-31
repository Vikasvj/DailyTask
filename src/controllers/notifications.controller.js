import * as notificationsService from '../services/notifications.service.js';

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

// GET /api/notifications
export async function listNotifications(req, res) {
  res.json(
    await notificationsService.listNotifications(
      req.user.id,
      req.accessToken,
      req.query,
    ),
  );
}

// GET /api/notifications/unread-count
export async function getUnreadCount(req, res) {
  noQuery(req);

  res.json({
    data: await notificationsService.getUnreadCount(
      req.user.id,
      req.accessToken,
    ),
  });
}

// PATCH /api/notifications/:id/read
export async function markAsRead(req, res) {
  noQuery(req);

  res.json({
    data: await notificationsService.markAsRead(
      req.user.id,
      req.accessToken,
      req.params.id,
    ),
  });
}

// PATCH /api/notifications/read-all
export async function markAllAsRead(req, res) {
  noQuery(req);

  res.json({
    data: await notificationsService.markAllAsRead(
      req.user.id,
      req.accessToken,
    ),
  });
}

export async function registerDevice(req, res) {
  noQuery(req);
  res.json({ data: await notificationsService.registerDevice(
    req.user.id, req.accessToken, req.body,
  ) });
}

export async function unregisterDevice(req, res) {
  noQuery(req);
  res.json({ data: await notificationsService.unregisterDevice(
    req.user.id, req.accessToken, req.body,
  ) });
}

export async function getReminderPreferences(req, res) {
  noQuery(req);
  if (Object.keys(req.body ?? {}).length) {
    throw Object.assign(new Error('Unexpected request body.'), {
      status: 400, code: 'INVALID_INPUT', expose: true,
    });
  }
  res.json({ data: await notificationsService.getReminderPreferences(
    req.user.id, req.accessToken,
  ) });
}

export async function updateReminderPreferences(req, res) {
  noQuery(req);
  res.json({ data: await notificationsService.updateReminderPreferences(
    req.user.id, req.accessToken, req.body,
  ) });
}
