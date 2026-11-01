import * as sharedListsService from '../services/shared-lists.service.js';

function noQuery(req) {
  if (Object.keys(req.query).length) {
    throw Object.assign(new Error('Unexpected query parameters.'), {
      status: 400, code: 'INVALID_INPUT', expose: true,
    });
  }
}

export async function listLists(req, res) {
  noQuery(req);
  res.json({ data: await sharedListsService.listLists(req.user.id, req.accessToken) });
}

export async function createList(req, res) {
  noQuery(req);
  res.status(201).json({
    data: await sharedListsService.createList(req.user.id, req.accessToken, req.body),
  });
}

export async function getList(req, res) {
  noQuery(req);
  res.json({ data: await sharedListsService.getList(req.user.id, req.accessToken, req.params.id) });
}

export async function updateList(req, res) {
  noQuery(req);
  res.json({ data: await sharedListsService.updateList(req.accessToken, req.params.id, req.body) });
}

export async function deleteList(req, res) {
  noQuery(req);
  await sharedListsService.deleteList(req.accessToken, req.params.id);
  res.status(204).end();
}

export async function listInvitations(req, res) {
  noQuery(req);
  if (Object.keys(req.body ?? {}).length) {
    throw Object.assign(new Error('Unexpected request body.'), {
      status: 400, code: 'INVALID_INPUT', expose: true,
    });
  }
  res.json({ data: await sharedListsService.listInvitations(req.accessToken, req.user.email) });
}

export async function shareList(req, res) {
  noQuery(req);
  res.status(201).json({
    data: await sharedListsService.shareList(req.accessToken, req.params.id, req.body),
  });
}

export async function acceptInvitation(req, res) {
  noQuery(req);
  res.json({ data: await sharedListsService.acceptInvitation(req.accessToken, req.params.id) });
}

export async function revokeInvitation(req, res) {
  noQuery(req);
  await sharedListsService.revokeInvitation(req.accessToken, req.params.id, req.params.inviteId);
  res.status(204).end();
}

export async function removeMember(req, res) {
  noQuery(req);
  await sharedListsService.removeMember(req.accessToken, req.params.id, req.params.memberId);
  res.status(204).end();
}

export async function leaveList(req, res) {
  noQuery(req);
  await sharedListsService.leaveList(req.accessToken, req.params.id);
  res.status(204).end();
}

export async function createItem(req, res) {
  noQuery(req);
  res.status(201).json({
    data: await sharedListsService.createItem(
      req.user.id, req.accessToken, req.params.id, req.body,
    ),
  });
}

export async function updateItem(req, res) {
  noQuery(req);
  res.json({
    data: await sharedListsService.updateItem(
      req.accessToken, req.params.id, req.params.itemId, req.body,
    ),
  });
}

export async function deleteItem(req, res) {
  noQuery(req);
  await sharedListsService.deleteItem(req.accessToken, req.params.id, req.params.itemId);
  res.status(204).end();
}
