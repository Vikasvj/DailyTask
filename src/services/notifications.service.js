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
      'Notification setup is incomplete. Apply the notifications migrations.',
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

  if (cause.code === '23505') {
    return error(
      409,
      'DEVICE_ALREADY_REGISTERED',
      'This device is active on another account. Sign out there before registering it here.',
    );
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

// Device tokens are scoped to the authenticated account. The database RPC
// refuses to transfer a token that is already registered to another user.
export async function registerDevice(userId, token, input) {
  onlyFields(input, ['installation_id', 'platform']);
  if (typeof input.installation_id !== 'string' ||
      input.installation_id.length < 20 || input.installation_id.length > 4096 ||
      !['android', 'ios', 'web'].includes(input.platform)) {
    throw invalid();
  }
  const rows = await result(getSupabase(token).rpc('register_fcm_device', {
    p_fid: input.installation_id,
    p_platform: input.platform,
  }));
  const device = Array.isArray(rows) ? rows[0] : rows;
  if (!device || device.user_id !== userId || typeof device.id !== 'string') {
    throw unavailable();
  }
  return { registered: true, platform: device.platform, updated_at: device.updated_at };
}

export async function unregisterDevice(userId, token, input) {
  onlyFields(input, ['installation_id']);
  if (typeof input.installation_id !== 'string' ||
      input.installation_id.length < 20 || input.installation_id.length > 4096) {
    throw invalid();
  }
  const deactivated = await result(getSupabase(token).rpc('unregister_fcm_device', {
    p_fid: input.installation_id,
  }));
  if (typeof deactivated !== 'boolean') throw unavailable();
  return { unregistered: true, deactivated };
}

const preferenceFields = [
  'timezone', 'habit_reminders_enabled', 'habit_reminder_time',
  'water_reminders_enabled', 'water_reminder_times',
  'steps_reminders_enabled', 'steps_reminder_time',
];

function validTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validatePreferences(input) {
  onlyFields(input, preferenceFields);
  if (!Object.keys(input).length) throw invalid();
  if (Object.hasOwn(input, 'timezone')) {
    try {
      if (typeof input.timezone !== 'string' || input.timezone.length > 100 ||
          (input.timezone !== 'UTC' && !input.timezone.includes('/'))) throw new Error();
      new Intl.DateTimeFormat('en', { timeZone: input.timezone });
    } catch { throw invalid(); }
  }
  for (const key of ['habit_reminders_enabled', 'water_reminders_enabled', 'steps_reminders_enabled']) {
    if (Object.hasOwn(input, key) && typeof input[key] !== 'boolean') throw invalid();
  }
  for (const key of ['habit_reminder_time', 'steps_reminder_time']) {
    if (Object.hasOwn(input, key) && !validTime(input[key])) throw invalid();
  }
  if (Object.hasOwn(input, 'water_reminder_times')) {
    const times = input.water_reminder_times;
    if (!Array.isArray(times) || times.length > 8 || times.some((time) => !validTime(time)) ||
        new Set(times).size !== times.length) throw invalid();
  }
  return input;
}

export async function getReminderPreferences(userId, token) {
  const supabase = getSupabase(token);
  const existing = await result(supabase.from('notification_preferences')
    .select('*').eq('user_id', userId).maybeSingle());
  if (existing) return normalizePreferences(existing);
  await result(supabase.from('notification_preferences')
    .upsert({ user_id: userId }, { onConflict: 'user_id', ignoreDuplicates: true }));
  const inserted = await result(supabase.from('notification_preferences')
    .select('*').eq('user_id', userId).single());
  return normalizePreferences(inserted);
}

export async function updateReminderPreferences(userId, token, input) {
  const values = validatePreferences(input);
  const updated = await result(getSupabase(token).from('notification_preferences')
    .upsert({ ...values, user_id: userId, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }).select('*').single());
  return normalizePreferences(updated);
}

function normalizePreferences(row) {
  const time = (value) => typeof value === 'string' ? value.slice(0, 5) : value;
  return {
    ...row,
    habit_reminder_time: time(row.habit_reminder_time),
    steps_reminder_time: time(row.steps_reminder_time),
    water_reminder_times: Array.isArray(row.water_reminder_times)
      ? row.water_reminder_times.map(time) : [],
  };
}
