
import { getSupabase } from '../config/supabase.js';

// const habitColumns =
//   'id,name,description,is_active,created_at,updated_at';

const completionColumns =
  'id,habit_id,completion_date,completed_at';
const habitColumns =
  'id,name,description,schedule_type,schedule_days,schedule_dates,is_active,created_at,updated_at';

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function apiError(status, code, message) {
  return Object.assign(new Error(message), {
    status,
    code,
    expose: true,
  });
}

function invalid(part = 'body') {
  return apiError(
    400,
    'INVALID_INPUT',
    `Invalid habits request ${part}.`,
  );
}

function unavailable() {
  return apiError(
    503,
    'DATABASE_UNAVAILABLE',
    'Habit data is temporarily unavailable. Please try again later.',
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
    throw invalid('params');
  }
}

function validDate(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value < '0001-01-01' ||
    value > '9998-12-31'
  ) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}


const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

function validateNumberArray(value, min, max, field) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > max ||
    value.some(
      (item) =>
        !Number.isInteger(item) ||
        item < min ||
        item > max,
    ) ||
    new Set(value).size !== value.length
  ) {
    throw invalid(
      `${field} must contain unique integers from ${min} to ${max}.`,
    );
  }

  return [...value].sort((a, b) => a - b);
}

function normalizeSchedule(input, partial) {
  const keys = [
    'schedule_type',
    'schedule_days',
    'schedule_dates',
  ];

  const hasSchedule = keys.some((key) =>
    Object.hasOwn(input, key),
  );

  // When updating only name/description, preserve the
  // existing database schedule by omitting schedule fields.
  if (partial && !hasSchedule) {
    return {};
  }

  const type = input.schedule_type ?? 'daily';

  if (!['daily', 'weekly', 'monthly'].includes(type)) {
    throw invalid(
      'schedule_type must be daily, weekly, or monthly.',
    );
  }

  if (type === 'daily') {
    if (
      input.schedule_dates !== undefined &&
      (
        !Array.isArray(input.schedule_dates) ||
        input.schedule_dates.length !== 0
      )
    ) {
      throw invalid(
        'Daily schedules must not contain schedule_dates.',
      );
    }

    return {
      schedule_type: 'daily',
      schedule_days: ALL_DAYS,
      schedule_dates: [],
    };
  }

  if (type === 'weekly') {
    if (
      input.schedule_dates !== undefined &&
      (
        !Array.isArray(input.schedule_dates) ||
        input.schedule_dates.length !== 0
      )
    ) {
      throw invalid(
        'Weekly schedules must not contain schedule_dates.',
      );
    }

    if (!Object.hasOwn(input, 'schedule_days')) {
      throw invalid(
        'schedule_days is required for weekly schedules.',
      );
    }

    return {
      schedule_type: 'weekly',
      schedule_days: validateNumberArray(
        input.schedule_days,
        1,
        7,
        'schedule_days',
      ),
      schedule_dates: [],
    };
  }

  if (
    input.schedule_days !== undefined &&
    (
      !Array.isArray(input.schedule_days) ||
      input.schedule_days.some(
        (day) => !Number.isInteger(day) || day < 1 || day > 7,
      ) ||
      new Set(input.schedule_days).size !== input.schedule_days.length
    )
  ) {
    throw invalid('Invalid schedule_days.');
  }

  if (!Object.hasOwn(input, 'schedule_dates')) {
    throw invalid(
      'schedule_dates is required for monthly schedules.',
    );
  }

  return {
    schedule_type: 'monthly',
    // Keep the legacy column valid for the current database
    // constraint. Monthly scheduling uses schedule_dates.
    schedule_days: ALL_DAYS,
    schedule_dates: validateNumberArray(
      input.schedule_dates,
      1,
      31,
      'schedule_dates',
    ),
  };
}

function validateHabit(input, partial = false) {
  onlyFields(input, [
    'name',
    'description',
    'schedule_type',
    'schedule_days',
    'schedule_dates',
  ]);

  if (
    Object.keys(input).length === 0 ||
    (!partial && !Object.hasOwn(input, 'name'))
  ) {
    throw invalid();
  }

  const values = {};

  if (Object.hasOwn(input, 'name')) {
    if (
      typeof input.name !== 'string' ||
      input.name.trim().length < 1 ||
      input.name.trim().length > 80
    ) {
      throw invalid();
    }

    values.name = input.name.trim();
  }

  if (Object.hasOwn(input, 'description')) {
    if (
      input.description !== null &&
      (
        typeof input.description !== 'string' ||
        input.description.length > 500
      )
    ) {
      throw invalid();
    }

    values.description =
      typeof input.description === 'string'
        ? input.description.trim() || null
        : null;
  }

  Object.assign(
    values,
    normalizeSchedule(input, partial),
  );

  return values;
}


async function result(query, conflictMessage) {
  const { data, error: cause, status } = await query;

  if (!cause) return data;

  if (status === 429) {
    throw apiError(
      429,
      'RATE_LIMITED',
      'Too many database requests. Please try again later.',
    );
  }

  if (['PGRST301', 'PGRST303'].includes(cause.code)) {
    throw apiError(
      401,
      'INVALID_TOKEN',
      'The access token is invalid or expired.',
    );
  }

  if (cause.code === '23505') {
    throw apiError(
      409,
      'CONFLICT',
      conflictMessage ?? 'The record already exists.',
    );
  }

  if (
    [
      '23514',
      '23502',
      '23503',
      '22023',
      '22007',
      '22008',
      '22009',
      '22003',
      '22P02',
    ].includes(cause.code)
  ) {
    throw apiError(
      400,
      'INVALID_INPUT',
      'Habit data violates a database constraint.',
    );
  }

  if (cause.code === '42501') {
    throw apiError(
      403,
      'FORBIDDEN',
      'This database operation is not permitted.',
    );
  }

  throw unavailable();
}

// Create a new habit
export async function createHabit(userId, token, input) {
  const values = validateHabit(input);

  return result(
    getSupabase(token)
      .from('habits')
      .insert({
        ...values,
        description: values.description ?? null,
        user_id: userId,
      })
      .select(habitColumns)
      .single(),
  );
}

// List the current user's active habits
export async function listHabits(userId, token) {
  return result(
    getSupabase(token)
      .from('habits')
      .select(habitColumns)
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(100),
  );
}

// Get one active habit
export async function getHabit(userId, token, id) {
  validateId(id);

  const habit = await result(
    getSupabase(token)
      .from('habits')
      .select(habitColumns)
      .eq('user_id', userId)
      .eq('id', id)
      .eq('is_active', true)
      .maybeSingle(),
  );

  if (!habit) {
    throw apiError(404, 'NOT_FOUND', 'Habit not found.');
  }

  return habit;
}

// Update name and/or description
export async function updateHabit(userId, token, id, input) {
  validateId(id);
  const values = validateHabit(input, true);

  const habit = await result(
    getSupabase(token)
      .from('habits')
      .update({
        ...values,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('id', id)
      .eq('is_active', true)
      .select(habitColumns)
      .maybeSingle(),
  );

  if (!habit) {
    throw apiError(404, 'NOT_FOUND', 'Habit not found.');
  }

  return habit;
}

// Archive instead of permanently deleting the habit
export async function archiveHabit(userId, token, id) {
  validateId(id);

  const habit = await result(
    getSupabase(token)
      .from('habits')
      .update({
        is_active: false,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('id', id)
      .eq('is_active', true)
      .select('id')
      .maybeSingle(),
  );

  if (!habit) {
    throw apiError(404, 'NOT_FOUND', 'Habit not found.');
  }
}

// Mark a habit complete for a specific date
export async function completeHabit(userId, token, id, input) {
  validateId(id);
  onlyFields(input, ['completion_date']);

  if (
    !Object.hasOwn(input, 'completion_date') ||
    !validDate(input.completion_date)
  ) {
    throw invalid();
  }

  const supabase = getSupabase(token);

  const habit = await result(
    supabase
      .from('habits')
      .select('id')
      .eq('user_id', userId)
      .eq('id', id)
      .eq('is_active', true)
      .maybeSingle(),
  );

  if (!habit) {
    throw apiError(404, 'NOT_FOUND', 'Habit not found.');
  }

  return result(
    supabase
      .from('habit_completions')
      .insert({
        habit_id: id,
        user_id: userId,
        completion_date: input.completion_date,
      })
      .select(completionColumns)
      .single(),
    'Habit is already completed for this date.',
  );
}

// Undo a completion
export async function undoCompletion(
  userId,
  token,
  id,
  date,
) {
  validateId(id);

  if (!validDate(date)) {
    throw invalid('params');
  }

  const completion = await result(
    getSupabase(token)
      .from('habit_completions')
      .delete()
      .eq('user_id', userId)
      .eq('habit_id', id)
      .eq('completion_date', date)
      .select('id')
      .maybeSingle(),
  );

  if (!completion) {
    throw apiError(
      404,
      'NOT_FOUND',
      'Habit completion not found.',
    );
  }
}

// Read the latest 100 completion records for one habit
export async function habitHistory(userId, token, id) {
  validateId(id);

  const supabase = getSupabase(token);

  const habit = await result(
    supabase
      .from('habits')
      .select('id')
      .eq('user_id', userId)
      .eq('id', id)
      .maybeSingle(),
  );

  if (!habit) {
    throw apiError(404, 'NOT_FOUND', 'Habit not found.');
  }

  return result(
    supabase
      .from('habit_completions')
      .select(completionColumns)
      .eq('user_id', userId)
      .eq('habit_id', id)
      .order('completion_date', { ascending: false })
      .limit(100),
  );
}
