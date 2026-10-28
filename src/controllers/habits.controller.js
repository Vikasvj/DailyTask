
import * as habitsService from '../services/habits.service.js';

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

export async function createHabit(req, res) {
  noQuery(req);

  res.status(201).json({
    data: await habitsService.createHabit(
      req.user.id,
      req.accessToken,
      req.body,
    ),
  });
}

export async function listHabits(req, res) {
  noQuery(req);

  res.json({
    data: await habitsService.listHabits(
      req.user.id,
      req.accessToken,
    ),
  });
}

export async function getHabit(req, res) {
  noQuery(req);

  res.json({
    data: await habitsService.getHabit(
      req.user.id,
      req.accessToken,
      req.params.id,
    ),
  });
}

export async function updateHabit(req, res) {
  noQuery(req);

  res.json({
    data: await habitsService.updateHabit(
      req.user.id,
      req.accessToken,
      req.params.id,
      req.body,
    ),
  });
}

export async function deleteHabit(req, res) {
  noQuery(req);

  await habitsService.archiveHabit(
    req.user.id,
    req.accessToken,
    req.params.id,
  );

  res.status(204).end();
}

export async function completeHabit(req, res) {
  noQuery(req);

  res.status(201).json({
    data: await habitsService.completeHabit(
      req.user.id,
      req.accessToken,
      req.params.id,
      req.body,
    ),
  });
}

export async function undoCompletion(req, res) {
  noQuery(req);

  await habitsService.undoCompletion(
    req.user.id,
    req.accessToken,
    req.params.id,
    req.params.date,
  );

  res.status(204).end();
}

export async function history(req, res) {
  noQuery(req);

  res.json({
    data: await habitsService.habitHistory(
      req.user.id,
      req.accessToken,
      req.params.id,
    ),
  });
}
