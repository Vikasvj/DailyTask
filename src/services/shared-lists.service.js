import { getSupabase } from '../config/supabase.js';

const listColumns = 'id,owner_id,name,created_at,updated_at';
const itemColumns =
  'id,list_id,text,is_completed,created_by,completed_by,completed_at,created_at,updated_at';
const memberColumns = 'list_id,user_id,invited_by,created_at';
const inviteColumns = 'id,list_id,email,list_name,invited_by,status,created_at,updated_at';
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function apiError(status, code, message) {
  return Object.assign(new Error(message), { status, code, expose: true });
}

function invalid(part = 'request') {
  return apiError(400, 'INVALID_INPUT', `Invalid shared-list ${part}.`);
}

function unavailable() {
  return apiError(503, 'DATABASE_UNAVAILABLE', 'Shared Lists are temporarily unavailable.');
}

function setupRequired() {
  return apiError(
    503,
    'SHARED_LISTS_SETUP_REQUIRED',
    'Shared Lists setup is incomplete. Apply the shared-lists database migration.',
  );
}

function validateId(id, part = 'id') {
  if (typeof id !== 'string' || !uuid.test(id)) throw invalid(part);
  return id;
}

function validateName(value) {
  if (typeof value !== 'string') throw invalid('name');
  const name = value.trim();
  if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) {
    throw invalid('name');
  }
  return name;
}

function validateItemText(value) {
  if (typeof value !== 'string') throw invalid('item');
  const text = value.trim();
  if (!text || text.length > 160 || /[\x00-\x1f\x7f]/.test(text)) {
    throw invalid('item');
  }
  return text;
}

function validateEmail(value) {
  if (typeof value !== 'string') throw invalid('email');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !emailPattern.test(email) || /[\x00-\x1f\x7f]/.test(email)) {
    throw invalid('email');
  }
  return email;
}

function onlyFields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key))) {
    throw invalid('body');
  }
}

function databaseError(cause, status) {
  if (['PGRST202', '42883', '42P01', '42703'].includes(cause.code)) {
    return setupRequired();
  }
  if (status === 429) return apiError(429, 'RATE_LIMITED', 'Too many requests. Please try again later.');
  if (['PGRST301', 'PGRST303'].includes(cause.code)) {
    return apiError(401, 'INVALID_TOKEN', 'The access token is invalid or expired.');
  }
  if (cause.code === '42501') return apiError(403, 'FORBIDDEN', 'You do not have access to this list.');
  if (cause.code === 'P0002') return apiError(404, 'NOT_FOUND', 'The list or invitation could not be found.');
  if (cause.code === '23505') return apiError(409, 'CONFLICT', 'This item or invitation already exists.');
  if (['23514', '23502', '22023', '22P02'].includes(cause.code)) return invalid();
  return unavailable();
}

async function result(query) {
  try {
    const { data, error: cause, status } = await query;
    if (cause) throw databaseError(cause, status);
    return data;
  } catch (cause) {
    if (cause?.expose === true) throw cause;
    throw unavailable();
  }
}

function requireData(data, part) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw apiError(404, 'NOT_FOUND', `The shared-list ${part} could not be found.`);
  }
  return data;
}

export async function listLists(userId, token) {
  const rows = await result(getSupabase(token).from('shared_lists')
    .select(listColumns).order('updated_at', { ascending: false }).limit(100));
  return rows.map((row) => ({ ...row, access: row.owner_id === userId ? 'owner' : 'shared' }));
}

export async function createList(userId, token, input) {
  onlyFields(input, ['name']);
  if (!Object.hasOwn(input, 'name')) throw invalid('name');
  const data = await result(getSupabase(token).from('shared_lists')
    .insert({ owner_id: userId, name: validateName(input.name) })
    .select(listColumns).single());
  return { ...requireData(data, 'list'), access: 'owner' };
}

export async function getList(userId, token, id) {
  validateId(id);
  const supabase = getSupabase(token);
  const list = await result(supabase.from('shared_lists')
    .select(listColumns).eq('id', id).maybeSingle());
  if (!list) throw apiError(404, 'NOT_FOUND', 'This list could not be found.');
  const isOwner = list.owner_id === userId;
  const [items, members, invitations] = await Promise.all([
    result(supabase.from('shared_list_items').select(itemColumns)
      .eq('list_id', id).order('created_at').order('id').limit(500)),
    result(supabase.from('shared_list_members').select(memberColumns)
      .eq('list_id', id).order('created_at').limit(200)),
    isOwner
      ? result(supabase.from('shared_list_invites').select(inviteColumns)
          .eq('list_id', id).eq('status', 'pending').order('created_at').limit(200))
      : Promise.resolve([]),
  ]);
  return {
    list: { ...list, access: isOwner ? 'owner' : 'shared' },
    items,
    members,
    invitations,
  };
}

export async function updateList(token, id, input) {
  validateId(id);
  onlyFields(input, ['name']);
  if (!Object.hasOwn(input, 'name')) throw invalid('name');
  const data = await result(getSupabase(token).from('shared_lists')
    .update({ name: validateName(input.name), updated_at: new Date().toISOString() })
    .eq('id', id).select(listColumns).maybeSingle());
  if (!data) throw apiError(404, 'NOT_FOUND', 'This list could not be found.');
  return { ...data, access: 'owner' };
}

export async function deleteList(token, id) {
  validateId(id);
  const data = await result(getSupabase(token).from('shared_lists')
    .delete().eq('id', id).select('id').maybeSingle());
  if (!data) throw apiError(404, 'NOT_FOUND', 'This list could not be found.');
}

export async function listInvitations(token, email) {
  const normalized = validateEmail(email ?? '');
  return result(getSupabase(token).from('shared_list_invites')
    .select('id,list_id,list_name,invited_by,created_at')
    .eq('email', normalized).eq('status', 'pending')
    .order('created_at', { ascending: false }).limit(100));
}

export async function shareList(token, listId, input) {
  validateId(listId);
  onlyFields(input, ['email']);
  if (!Object.hasOwn(input, 'email')) throw invalid('email');
  const data = await result(getSupabase(token).rpc('share_shared_list', {
    p_list_id: listId,
    p_email: validateEmail(input.email),
  }));
  return requireData(data, 'invitation');
}

export async function acceptInvitation(token, inviteId) {
  validateId(inviteId, 'invitation id');
  const data = await result(getSupabase(token).rpc('accept_shared_list_invite', {
    p_invite_id: inviteId,
  }));
  return requireData(data, 'list');
}

export async function revokeInvitation(token, listId, inviteId) {
  validateId(listId);
  validateId(inviteId, 'invitation id');
  await result(getSupabase(token).rpc('revoke_shared_list_invite', {
    p_list_id: listId,
    p_invite_id: inviteId,
  }));
}

export async function removeMember(token, listId, memberId) {
  validateId(listId);
  validateId(memberId, 'member id');
  await result(getSupabase(token).rpc('remove_shared_list_member', {
    p_list_id: listId,
    p_user_id: memberId,
  }));
}

export async function leaveList(token, listId) {
  validateId(listId);
  await result(getSupabase(token).rpc('leave_shared_list', { p_list_id: listId }));
}

export async function createItem(userId, token, listId, input) {
  validateId(listId);
  onlyFields(input, ['text']);
  if (!Object.hasOwn(input, 'text')) throw invalid('item');
  const data = await result(getSupabase(token).from('shared_list_items')
    .insert({ list_id: listId, text: validateItemText(input.text), created_by: userId })
    .select(itemColumns).single());
  return requireData(data, 'item');
}

export async function updateItem(token, listId, itemId, input) {
  validateId(listId);
  validateId(itemId, 'item id');
  onlyFields(input, ['text', 'is_completed']);
  const patch = {};
  if (Object.hasOwn(input, 'text')) patch.text = validateItemText(input.text);
  if (Object.hasOwn(input, 'is_completed')) {
    if (typeof input.is_completed !== 'boolean') throw invalid('completion');
    patch.is_completed = input.is_completed;
  }
  if (!Object.keys(patch).length) throw invalid('body');
  const data = await result(getSupabase(token).from('shared_list_items')
    .update(patch).eq('list_id', listId).eq('id', itemId)
    .select(itemColumns).maybeSingle());
  if (!data) throw apiError(404, 'NOT_FOUND', 'This list item could not be found.');
  return data;
}

export async function deleteItem(token, listId, itemId) {
  validateId(listId);
  validateId(itemId, 'item id');
  const data = await result(getSupabase(token).from('shared_list_items')
    .delete().eq('list_id', listId).eq('id', itemId).select('id').maybeSingle());
  if (!data) throw apiError(404, 'NOT_FOUND', 'This list item could not be found.');
}
