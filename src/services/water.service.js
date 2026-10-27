import { getSupabase } from '../config/supabase.js';

const entryColumns = 'id,amount_ml,consumed_at,created_at';
const goalColumns = 'daily_goal_ml,timezone';
const defaultGoal = { daily_goal_ml: 2000, timezone: 'Asia/Kolkata' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function error(status, code, message) {
  return Object.assign(new Error(message), { status, code, expose: true });
}
function invalid(part = 'body') {
  return error(400, 'INVALID_INPUT', 'Invalid water request ' + part + '.');
}
function unavailable() {
  return error(503, 'DATABASE_UNAVAILABLE', 'Water data is temporarily unavailable. Please try again later.');
}
function onlyFields(value, allowed, part = 'body') {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key))) throw invalid(part);
}
function validAmount(value) {
  return Number.isInteger(value) && value > 0 && value <= 2147483647;
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      value < '0001-01-01' || value > '9998-12-31') return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  // Require seconds, at most six fractional digits and a PostgreSQL-supported offset.
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-5]):[0-5]\d)$/.exec(value);
  return Boolean(match && validDate(match[1]) && Number.isFinite(Date.parse(value)));
}
function validTimezone(value) {
  if (typeof value !== 'string' || !value || value.length > 100 ||
      (value !== 'UTC' && !value.includes('/'))) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
  catch { return false; }
}
function validateEntry(input, partial = false) {
  onlyFields(input, ['amount_ml', 'consumed_at']);
  if (!Object.keys(input).length ||
      ((!partial || Object.hasOwn(input, 'amount_ml')) && !validAmount(input.amount_ml)) ||
      (Object.hasOwn(input, 'consumed_at') && !validTimestamp(input.consumed_at))) throw invalid();
}
function validateId(id) {
  if (typeof id !== 'string' || !uuid.test(id)) throw invalid('params');
}
function readCursor(value) {
  if (value === undefined) return undefined;
  try {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(value)) throw invalid('query');
    const raw = Buffer.from(value, 'base64url');
    if (raw.toString('base64url') !== value) throw invalid('query');
    const cursor = JSON.parse(raw.toString('utf8'));
    onlyFields(cursor, ['id', 'consumed_at', 'date', 'timezone'], 'query');
    if (Object.keys(cursor).length !== 4 || typeof cursor.id !== 'string' || !uuid.test(cursor.id) ||
        !validTimestamp(cursor.consumed_at) || !validDate(cursor.date) || !validTimezone(cursor.timezone)) {
      throw invalid('query');
    }
    return cursor;
  } catch {
    throw invalid('query');
  }
}

async function result(query) {
  const { data, error: cause, status } = await query;
  if (!cause) return data;
  if (status === 429) throw error(429, 'RATE_LIMITED', 'Too many database requests. Please try again later.');
  if (['PGRST301', 'PGRST303'].includes(cause.code)) {
    throw error(401, 'INVALID_TOKEN', 'The access token is invalid or expired.');
  }
  if (cause.code === '23505') throw error(409, 'CONFLICT', 'The record already exists.');
  if (['23514', '23502', '22023', '22007', '22008', '22009', '22003', '22P02'].includes(cause.code)) {
    throw error(400, 'INVALID_INPUT', 'Water data violates a database constraint.');
  }
  if (cause.code === '42501') throw error(403, 'FORBIDDEN', 'This database operation is not permitted.');
  throw unavailable();
}
function safeInteger(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw unavailable();
  return number;
}
function shiftDate(value, days) {
  const date = new Date(value + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function dailyTotals(supabase, startDate, endDate) {
  const args = startDate === undefined ? {} : { p_start_date: startDate, p_end_date: endDate };
  return result(supabase.rpc('water_daily_totals', args));
}
async function selectedDay(supabase, date) {
  const rows = await dailyTotals(supabase, date, date === undefined ? undefined : shiftDate(date, 1));
  if (!Array.isArray(rows) || rows.length !== 1) throw unavailable();
  return rows[0];
}
async function readGoal(supabase, userId) {
  return await result(supabase.from('water_goals').select(goalColumns)
    .eq('user_id', userId).maybeSingle()) ?? { ...defaultGoal };
}

export async function createEntry(userId, token, input) {
  validateEntry(input);
  return result(getSupabase(token).from('water_entries')
    .insert({ ...input, user_id: userId }).select(entryColumns).single());
}

export async function listEntries(userId, token, query) {
  onlyFields(query, ['date', 'limit', 'cursor'], 'query');
  if (query.date !== undefined && !validDate(query.date)) throw invalid('query');
  let limit = 20;
  if (query.limit !== undefined) {
    if (typeof query.limit !== 'string' || !/^[1-9]\d{0,2}$/.test(query.limit) ||
        Number(query.limit) > 100) throw invalid('query');
    limit = Number(query.limit);
  }
  const cursor = readCursor(query.cursor);
  const supabase = getSupabase(token);
  const day = await selectedDay(supabase, query.date);
  if (cursor && (cursor.date !== day.day || cursor.timezone !== day.timezone)) {
    throw error(400, 'INVALID_CURSOR', 'Cursor does not match the selected date and account timezone.');
  }
  let request = supabase.from('water_entries').select(entryColumns).eq('user_id', userId)
    .gte('consumed_at', day.start_at).lt('consumed_at', day.end_at)
    .order('consumed_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1);
  if (cursor) {
    // Strict timestamp/UUID validation above prevents injection into this filter.
    request = request.or('consumed_at.lt.' + cursor.consumed_at +
      ',and(consumed_at.eq.' + cursor.consumed_at + ',id.lt.' + cursor.id + ')');
  }
  const rows = await result(request);
  const entries = rows.slice(0, limit);
  const last = entries.at(-1);
  const nextCursor = rows.length > limit ? Buffer.from(JSON.stringify({
    id: last.id, consumed_at: last.consumed_at, date: day.day, timezone: day.timezone,
  })).toString('base64url') : null;
  return { data: entries, meta: { date: day.day, timezone: day.timezone, limit, next_cursor: nextCursor } };
}

export async function updateEntry(userId, token, id, input) {
  validateId(id);
  validateEntry(input, true);
  const entry = await result(getSupabase(token).from('water_entries').update(input)
    .eq('user_id', userId).eq('id', id).select(entryColumns).maybeSingle());
  if (!entry) throw error(404, 'NOT_FOUND', 'Water entry not found.');
  return entry;
}

export async function deleteEntry(userId, token, id) {
  validateId(id);
  const entry = await result(getSupabase(token).from('water_entries').delete()
    .eq('user_id', userId).eq('id', id).select('id').maybeSingle());
  if (!entry) throw error(404, 'NOT_FOUND', 'Water entry not found.');
}

export async function getGoal(userId, token) {
  return readGoal(getSupabase(token), userId);
}

export async function updateGoal(userId, token, input) {
  onlyFields(input, ['daily_goal_ml', 'timezone']);
  if (!Object.keys(input).length ||
      (Object.hasOwn(input, 'daily_goal_ml') && !validAmount(input.daily_goal_ml))) throw invalid();
  const patch = { ...input };
  if (Object.hasOwn(input, 'timezone')) {
    if (typeof input.timezone !== 'string') throw invalid();
    patch.timezone = input.timezone.trim();
    if (!validTimezone(patch.timezone)) throw invalid();
  }
  const supabase = getSupabase(token);
  // PATCH only supplied fields; preserve the other setting during concurrent updates.
  const updated = await result(supabase.from('water_goals').update(patch)
    .eq('user_id', userId).select(goalColumns).maybeSingle());
  if (updated) return updated;
  try {
    return await result(supabase.from('water_goals').insert({ ...patch, user_id: userId })
      .select(goalColumns).single());
  } catch (cause) {
    if (cause.code !== 'CONFLICT' || cause.status !== 409) throw cause;
    // Another request may have created the row after our initial update.
    const retried = await result(supabase.from('water_goals').update(patch)
      .eq('user_id', userId).select(goalColumns).maybeSingle());
    if (!retried) throw unavailable();
    return retried;
  }
}

export async function today(userId, token) {
  const supabase = getSupabase(token);
  const [day, goal] = await Promise.all([selectedDay(supabase), readGoal(supabase, userId)]);
  const total = safeInteger(day.total_ml);
  return {
    date: day.day, timezone: day.timezone, total_ml: total, daily_goal_ml: goal.daily_goal_ml,
    remaining_ml: Math.max(0, goal.daily_goal_ml - total),
    progress_percent: Math.round((total / goal.daily_goal_ml) * 10000) / 100,
    entry_count: safeInteger(day.entry_count),
  };
}

export async function history(userId, token, query) {
  onlyFields(query, ['period', 'date'], 'query');
  const period = query.period ?? 'day';
  if (!['day', 'week', 'month'].includes(period) ||
      (query.date !== undefined && !validDate(query.date))) throw invalid('query');
  const supabase = getSupabase(token);
  const selected = await selectedDay(supabase, query.date);
  let start = selected.day;
  let end = shiftDate(start, 1);
  if (period === 'week') {
    const weekday = new Date(start + 'T00:00:00Z').getUTCDay();
    start = shiftDate(start, -((weekday + 6) % 7));
    end = shiftDate(start, 7);
  } else if (period === 'month') {
    start = start.slice(0, 7) + '-01';
    const next = new Date(start + 'T00:00:00Z');
    next.setUTCMonth(next.getUTCMonth() + 1);
    end = next.toISOString().slice(0, 10);
  }
  const rows = period === 'day' ? [selected] : await dailyTotals(supabase, start, end);
  const days = rows.map((row) => ({
    date: row.day, total_ml: safeInteger(row.total_ml), entry_count: safeInteger(row.entry_count),
  }));
  return {
    period, start_date: start, end_date: end,
    timezone: rows[0]?.timezone ?? selected.timezone,
    total_ml: safeInteger(days.reduce((sum, row) => sum + row.total_ml, 0)), days,
  };
}
