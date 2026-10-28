import * as calendarService from '../services/calendar.service.js';

const ALLOWED_QUERY = ['month', 'as_of', 'habit_id'];

export async function monthlyCalendar(req, res) {
  const unknownKeys = Object.keys(req.query).filter(
    (key) => !ALLOWED_QUERY.includes(key),
  );

  if (unknownKeys.length > 0) {
    throw Object.assign(
      new Error('Unexpected calendar query parameters.'),
      {
        status: 400,
        code: 'INVALID_INPUT',
        expose: true,
      },
    );
  }

  const data = await calendarService.getMonthlyCalendar(
    req.user.id,
    req.accessToken,
    req.query,
  );

  res.json({ data });
}