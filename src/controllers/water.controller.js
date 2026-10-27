import * as waterService from '../services/water.service.js';

function noQuery(req) {
  if (Object.keys(req.query).length) {
    throw Object.assign(new Error('Unexpected query parameters.'), {
      status: 400, code: 'INVALID_INPUT', expose: true,
    });
  }
}

export async function createEntry(req, res) {
  noQuery(req);
  res.status(201).json({
    data: await waterService.createEntry(req.user.id, req.accessToken, req.body),
  });
}

export async function listEntries(req, res) {
  res.json(await waterService.listEntries(req.user.id, req.accessToken, req.query));
}

export async function updateEntry(req, res) {
  noQuery(req);
  res.json({
    data: await waterService.updateEntry(req.user.id, req.accessToken, req.params.id, req.body),
  });
}

export async function deleteEntry(req, res) {
  noQuery(req);
  await waterService.deleteEntry(req.user.id, req.accessToken, req.params.id);
  res.status(204).end();
}

export async function today(req, res) {
  noQuery(req);
  res.json({ data: await waterService.today(req.user.id, req.accessToken) });
}

export async function history(req, res) {
  res.json({ data: await waterService.history(req.user.id, req.accessToken, req.query) });
}

export async function getGoal(req, res) {
  noQuery(req);
  res.json({ data: await waterService.getGoal(req.user.id, req.accessToken) });
}

export async function updateGoal(req, res) {
  noQuery(req);
  res.json({ data: await waterService.updateGoal(req.user.id, req.accessToken, req.body) });
}
