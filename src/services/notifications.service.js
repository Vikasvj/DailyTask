import { getSupabase } from '../config/supabase.js';

const notificationColumns =
  'id,type,title,body,data,created_at,read_at,expires_at';

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function error(status, code, message) {
  return Object.assign(new Error(message), {
    status,
    code,
    expose: true,
  });
}

function invalid(part = 'request') {
  return error(
    400,
    'INVALID_INPUT',
    `Invalid notification ${part}.`,
  );
}

function unavailable() {
  return error(
    503,
    'DATABASE_UNAVAILABLE',
    'Notification service is temporarily unavailable.',
  );
}

function onlyFields(value, allowed, part = 'body') {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  ) {
    throw invalid(part);
  }
}

function validateId(id) {
  if (typeof id !== 'string' || !uuid.test(id)) {
    throw invalid('id');
  }
}

function databaseError(cause, status) {
  if (['PGRST202', '42883', '42P01', '42703'].includes(cause.code)) {
    return error(
      503,
      'NOTIFICATION_SETUP_REQUIRED',
      'Notification setup is incomplete. Apply the automatic notifications migration.',
    );
  }
  if (status === 429) {
    return error(
      429,
      'RATE_LIMITED',
      'Too many database requests. Please try again later.',
    );
  }

  if (['PGRST301', 'PGRST303'].includes(cause.code)) {
    return error(
      401,
      'INVALID_TOKEN',
      'The access token is invalid or expired.',
    );
  }

  if (['23514', '23502', '22023', '22P02'].includes(cause.code)) {
    return invalid();
  }

  if (cause.code === '42501') {
    return error(
      403,
      'FORBIDDEN',
      'This notification operation is not permitted.',
    );
  }

  return unavailable();
}

async function result(query) {
  const { data, error: cause, status } = await query;

  if (cause) {
    throw databaseError(cause, status);
  }

  return data;
}

// Fixed, server-computed events only. The SQL transaction deduplicates concurrent
// list/count requests; it never receives client-supplied messages or owners.
async function syncHabitNotifications(supabase) {
  const created = await result(supabase.rpc('sync_habit_notifications'));
  if (!Number.isInteger(created) || created < 0 || created > 3) {
    throw unavailable();
  }
}

// GET /api/notifications
export async function listNotifications(userId, token, query) {
  onlyFields(query, ['limit', 'unread_only'], 'query');

  let limit = 20;

  if (query.limit !== undefined) {
    if (
      typeof query.limit !== 'string' ||
      !/^[1-9]\d{0,2}$/.test(query.limit) ||
      Number(query.limit) > 100
    ) {
      throw invalid('query');
    }

    limit = Number(query.limit);
  }

  if (
    query.unread_only !== undefined &&
    !['true', 'false'].includes(query.unread_only)
  ) {
    throw invalid('query');
  }

  const supabase = getSupabase(token);

  await syncHabitNotifications(supabase);

  let request = supabase
    .from('notifications')
    .select(notificationColumns)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (query.unread_only === 'true') {
    request = request.is('read_at', null);
  }

  const notifications = await result(request);

  return {
    data: notifications,
    meta: {
      limit,
      unread_only: query.unread_only === 'true',
    },
  };
}

// GET /api/notifications/unread-count
export async function getUnreadCount(userId, token) {
  const supabase = getSupabase(token);

  await syncHabitNotifications(supabase);

  const { count, error: cause, status } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .is('read_at', null);

  if (cause) {
    throw databaseError(cause, status);
  }

  return {
    unread_count: count ?? 0,
  };
}

// PATCH /api/notifications/:id/read
export async function markAsRead(userId, token, id) {
  validateId(id);

  const supabase = getSupabase(token);

  const updated = await result(
    supabase
      .from('notifications')
      .update({
        read_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('id', id)
      .is('read_at', null)
      .select(notificationColumns)
      .maybeSingle(),
  );

  if (updated) {
    return updated;
  }

  // Marking an already-read notification is idempotent.
  // Verify that the notification belongs to this user.
  const existing = await result(
    supabase
      .from('notifications')
      .select(notificationColumns)
      .eq('user_id', userId)
      .eq('id', id)
      .maybeSingle(),
  );

  if (!existing) {
    throw error(
      404,
      'NOT_FOUND',
      'Notification not found.',
    );
  }

  return existing;
}

// PATCH /api/notifications/read-all
export async function markAllAsRead(userId, token) {
  const supabase = getSupabase(token);

  const updated = await result(
    supabase
      .from('notifications')
      .update({
        read_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .is('read_at', null)
      .select('id'),
  );

  return {
    updated_count: updated.length,
  };
}
