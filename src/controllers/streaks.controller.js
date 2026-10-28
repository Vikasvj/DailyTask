
import * as streaksService from '../services/streaks.service.js';

function validateQueryKeys(req, allowedKeys) {
  const unknownKeys = Object.keys(req.query).filter(
    (key) => !allowedKeys.includes(key),
  );

  if (unknownKeys.length > 0) {
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

export async function overview(req, res) {
  validateQueryKeys(req, ['as_of']);

  const data = await streaksService.getOverview(
    req.user.id,
    req.accessToken,
    req.query.as_of,
  );

  res.json({ data });
}

export async function insights(req, res) {
  validateQueryKeys(req, ['period', 'as_of']);

  const data = await streaksService.getInsights(
    req.user.id,
    req.accessToken,
    req.query.period ?? 'week',
    req.query.as_of,
  );

  res.json({ data });
}

export async function habitStats(req, res) {
  validateQueryKeys(req, ['as_of']);

  const data = await streaksService.getHabitStats(
    req.user.id,
    req.accessToken,
    req.params.id,
    req.query.as_of,
  );

  res.json({ data });
}

export async function habitCalendar(req, res) {
  validateQueryKeys(req, ['month', 'as_of']);

  const data = await streaksService.getHabitCalendar(
    req.user.id,
    req.accessToken,
    req.params.id,
    req.query.month,
    req.query.as_of,
  );

  res.json({ data });
}

export async function habitHistory(req, res) {
  validateQueryKeys(req, ['from', 'to', 'as_of']);

  const data = await streaksService.getHabitHistory(
    req.user.id,
    req.accessToken,
    req.params.id,
    {
      from: req.query.from,
      to: req.query.to,
      as_of: req.query.as_of,
    },
  );

  res.json({ data });
}
