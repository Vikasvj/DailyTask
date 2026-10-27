import * as stepsService from '../services/steps.service.js';

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

export async function getToday(req, res) {
  noQuery(req);

  res.json({
    data: await stepsService.today(
      req.user.id,
      req.accessToken,
    ),
  });
}

export async function saveToday(req, res) {
  noQuery(req);

  res.json({
    data: await stepsService.saveToday(
      req.user.id,
      req.accessToken,
      req.body,
    ),
  });
}

export async function history(req, res) {
  res.json({
    data: await stepsService.history(
      req.user.id,
      req.accessToken,
      req.query,
    ),
  });
}

export async function getGoal(req, res) {
  noQuery(req);

  res.json({
    data: await stepsService.getGoal(
      req.user.id,
      req.accessToken,
    ),
  });
}

export async function updateGoal(req, res) {
  noQuery(req);

  res.json({
    data: await stepsService.updateGoal(
      req.user.id,
      req.accessToken,
      req.body,
    ),
  });
}