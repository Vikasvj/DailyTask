import { getSupabase } from '../config/supabase.js';

const stepColumns =
  'id,step_date,steps,created_at,updated_at';

const goalColumns = 'daily_goal,timezone';

const defaultGoal = {
  daily_goal: 10000,
  timezone: 'Asia/Kolkata',
};

function error(status, code, message) {
  return Object.assign(new Error(message), {
    status,
    code,
    expose: true,
  });
}

function invalid(part = 'body') {
  return error(
    400,
    'INVALID_INPUT',
    `Invalid steps request ${part}.`,
  );
}

function unavailable() {
  return error(
    503,
    'DATABASE_UNAVAILABLE',
    'Step data is temporarily unavailable. Please try again later.',
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

function validDate(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value &&
    value >= '0001-01-01' &&
    value <= '9998-12-31'
  );
}

function validSteps(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 200000
  );
}

function validGoal(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 200000
  );
}

function validTimezone(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 100 ||
    (value !== 'UTC' && !value.includes('/'))
  ) {
    return false;
  }

  try {
    new Intl.DateTimeFormat('en', {
      timeZone: value,
    });

    return true;
  } catch {
    return false;
  }
}

async function result(query) {
  const { data, error: cause, status } = await query;

  if (!cause) return data;

  if (status === 429) {
    throw error(
      429,
      'RATE_LIMITED',
      'Too many database requests. Please try again later.',
    );
  }

  if (['PGRST301', 'PGRST303'].includes(cause.code)) {
    throw error(
      401,
      'INVALID_TOKEN',
      'The access token is invalid or expired.',
    );
  }

  if (cause.code === '23505') {
    throw error(
      409,
      'CONFLICT',
      'The record already exists.',
    );
  }

  if (
    [
      '23514',
      '23502',
      '22023',
      '22007',
      '22008',
      '22009',
      '22003',
      '22P02',
    ].includes(cause.code)
  ) {
    throw error(
      400,
      'INVALID_INPUT',
      'Step data violates a database constraint.',
    );
  }

  if (cause.code === '42501') {
    throw error(
      403,
      'FORBIDDEN',
      'This database operation is not permitted.',
    );
  }

  throw unavailable();
}

function dateInTimezone(timezone) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(date, amount) {
  const value = new Date(`${date}T00:00:00.000Z`);

  value.setUTCDate(value.getUTCDate() + amount);

  return value.toISOString().slice(0, 10);
}

function safeInteger(value) {
  const number = Number(value);

  if (!Number.isSafeInteger(number) || number < 0) {
    throw unavailable();
  }

  return number;
}

async function readGoal(supabase, userId) {
  const goal = await result(
    supabase
      .from('step_goals')
      .select(goalColumns)
      .eq('user_id', userId)
      .maybeSingle(),
  );

  if (goal && (!validGoal(goal.daily_goal) || !validTimezone(goal.timezone))) {
    throw unavailable();
  }

  return goal ?? { ...defaultGoal };
}

function dailySummary(date, steps, goal, updatedAt = null) {
  const dailySteps = safeInteger(steps);
  const dailyGoal = goal.daily_goal;

  return {
    date,
    timezone: goal.timezone,
    steps: dailySteps,
    daily_goal: dailyGoal,
    remaining_steps: Math.max(0, dailyGoal - dailySteps),
    progress_percent: Math.round(
      (dailySteps / dailyGoal) * 1000,
    ) / 10,
    updated_at: updatedAt,
  };
}

export async function today(userId, token) {
  const supabase = getSupabase(token);
  const goal = await readGoal(supabase, userId);
  const date = dateInTimezone(goal.timezone);

  const row = await result(
    supabase
      .from('daily_steps')
      .select(stepColumns)
      .eq('user_id', userId)
      .eq('step_date', date)
      .maybeSingle(),
  );

  return dailySummary(
    date,
    row?.steps ?? 0,
    goal,
    row?.updated_at ?? null,
  );
}

export async function saveToday(userId, token, input) {
  onlyFields(input, ['step_date', 'steps']);

  if (
    !Object.hasOwn(input, 'steps') ||
    !validSteps(input.steps) ||
    (
      Object.hasOwn(input, 'step_date') &&
      !validDate(input.step_date)
    )
  ) {
    throw invalid();
  }

  const supabase = getSupabase(token);
  const goal = await readGoal(supabase, userId);

  // Frontend may provide the date of a pending local sync.
  const date =
    input.step_date ?? dateInTimezone(goal.timezone);

  if (date > dateInTimezone(goal.timezone)) {
    throw invalid();
  }

  const row = await result(
    supabase
      .from('daily_steps')
      .upsert(
        {
          user_id: userId,
          step_date: date,
          steps: input.steps,
        },
        {
          onConflict: 'user_id,step_date',
        },
      )
      .select(stepColumns)
      .single(),
  );

  return dailySummary(
    date,
    row.steps,
    goal,
    row.updated_at,
  );
}

function getRange(date, period) {
  if (period === 'day') {
    return {
      startDate: date,
      endDate: addDays(date, 1),
    };
  }

  if (period === 'week') {
    const weekday = new Date(
      `${date}T00:00:00.000Z`,
    ).getUTCDay();

    const startDate = addDays(
      date,
      -((weekday + 6) % 7),
    );

    return {
      startDate,
      endDate: addDays(startDate, 7),
    };
  }

  if (period === 'month') {
    const startDate = `${date.slice(0, 7)}-01`;
    const nextMonth = new Date(
      `${startDate}T00:00:00.000Z`,
    );

    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);

    return {
      startDate,
      endDate: nextMonth.toISOString().slice(0, 10),
    };
  }

  throw invalid('query');
}

export async function history(userId, token, query) {
  onlyFields(query, ['period', 'date'], 'query');

  const period = query.period ?? 'day';

  if (
    !['day', 'week', 'month'].includes(period) ||
    (
      query.date !== undefined &&
      !validDate(query.date)
    )
  ) {
    throw invalid('query');
  }

  const supabase = getSupabase(token);
  const goal = await readGoal(supabase, userId);

  const selectedDate =
    query.date ?? dateInTimezone(goal.timezone);

  const { startDate, endDate } = getRange(
    selectedDate,
    period,
  );

  const rows = await result(
    supabase
      .from('daily_steps')
      .select('step_date,steps')
      .eq('user_id', userId)
      .gte('step_date', startDate)
      .lt('step_date', endDate)
      .order('step_date', { ascending: true }),
  );

  // Include days with zero steps, even when no record exists.
  const savedSteps = new Map(
    rows.map((row) => [
      row.step_date,
      safeInteger(row.steps),
    ]),
  );

  const days = [];

  for (
    let date = startDate;
    date < endDate;
    date = addDays(date, 1)
  ) {
    days.push({
      date,
      steps: savedSteps.get(date) ?? 0,
    });
  }

  const totalSteps = days.reduce(
    (total, day) => total + day.steps,
    0,
  );

  return {
    period,
    start_date: startDate,
    end_date: endDate,
    timezone: goal.timezone,
    total_steps: totalSteps,
    days,
  };
}

export async function getGoal(userId, token) {
  return readGoal(getSupabase(token), userId);
}

export async function updateGoal(userId, token, input) {
  onlyFields(input, ['daily_goal', 'timezone']);

  if (
    Object.keys(input).length === 0 ||
    (
      Object.hasOwn(input, 'daily_goal') &&
      !validGoal(input.daily_goal)
    ) ||
    (
      Object.hasOwn(input, 'timezone') &&
      !validTimezone(input.timezone)
    )
  ) {
    throw invalid();
  }

  const supabase = getSupabase(token);

  const patch = { ...input };

  // Update the existing user's goal first.
  const updated = await result(
    supabase
      .from('step_goals')
      .update(patch)
      .eq('user_id', userId)
      .select(goalColumns)
      .maybeSingle(),
  );

  if (updated) return updated;

  // No goal exists yet; create it.
  try {
    return await result(
      supabase
        .from('step_goals')
        .insert({
          ...input,
          user_id: userId,
        })
        .select(goalColumns)
        .single(),
    );
  } catch (cause) {
    // Handle simultaneous first-time requests.
    if (
      cause.code !== 'CONFLICT' ||
      cause.status !== 409
    ) {
      throw cause;
    }

    const retried = await result(
      supabase
        .from('step_goals')
        .update(patch)
        .eq('user_id', userId)
        .select(goalColumns)
        .maybeSingle(),
    );

    if (!retried) throw unavailable();

    return retried;
  }
}
