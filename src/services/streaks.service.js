
import { getSupabase } from '../config/supabase.js';

const PAGE_SIZE = 1000;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function httpError(status, code, message) {
  return Object.assign(new Error(message), {
    status,
    code,
    expose: true,
  });
}

function badRequest(message = 'Invalid request parameters.') {
  return httpError(400, 'INVALID_INPUT', message);
}

function dbError(error, status) {
  if (status === 429) {
    throw httpError(429, 'RATE_LIMITED', 'Too many requests.');
  }

  if (
    status === 401 ||
    ['PGRST301', 'PGRST303'].includes(error.code)
  ) {
    throw httpError(
      401,
      'INVALID_TOKEN',
      'The access token is invalid or expired.',
    );
  }

  if (error.code === '42501') {
    throw httpError(
      403,
      'FORBIDDEN',
      'This database operation is not permitted.',
    );
  }

  if (
    [
      '22P02',
      '22007',
      '22008',
      '22009',
      '22023',
      '23502',
      '23503',
      '23514',
    ].includes(error.code)
  ) {
    throw badRequest('Invalid data or query parameters.');
  }

  throw httpError(
    503,
    'DATABASE_UNAVAILABLE',
    'The requested data is temporarily unavailable.',
  );
}

async function queryData(query) {
  const { data, error, status } = await query;

  if (error) {
    dbError(error, status);
  }

  return data;
}

// Fetch in pages so Supabase's row limit does not silently
// truncate the historical data needed for longest streaks.
async function queryAllRows(buildQuery) {
  const rows = [];
  let offset = 0;

  while (true) {
    const { data, error, status } = await buildQuery().range(
      offset,
      offset + PAGE_SIZE - 1,
    );

    if (error) {
      dbError(error, status);
    }

    const page = data ?? [];
    rows.push(...page);

    if (page.length < PAGE_SIZE) {
      break;
    }

    offset += PAGE_SIZE;
  }

  return rows;
}

function validDate(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return false;
  }

  const [year, month, day] = value.split('-').map(Number);

  if (year < 1000 || year > 9999) {
    return false;
  }

  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function todayInIndia() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeDate(value, field = 'date') {
  const date = value ?? todayInIndia();

  if (!validDate(date)) {
    throw badRequest(
      `${field} must be a valid date in YYYY-MM-DD format.`,
    );
  }

  return date;
}

function normalizeId(id) {
  if (typeof id !== 'string' || !UUID_REGEX.test(id)) {
    throw badRequest('Habit ID must be a valid UUID.');
  }

  return id;
}

function shiftDate(value, offset) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);

  return date.toISOString().slice(0, 10);
}

function dayDifferenceInclusive(start, end) {
  const startTime = Date.parse(`${start}T00:00:00.000Z`);
  const endTime = Date.parse(`${end}T00:00:00.000Z`);

  return Math.floor((endTime - startTime) / 86400000) + 1;
}

function dateFromTimestamp(value) {
  return typeof value === 'string' ? value.slice(0, 10) : null;
}

function maxDate(a, b) {
  return a > b ? a : b;
}

function minDate(a, b) {
  return a < b ? a : b;
}

function datesBetween(start, end) {
  if (start > end) {
    return [];
  }

  const dates = [];

  for (let date = start; date <= end; date = shiftDate(date, 1)) {
    dates.push(date);
  }

  return dates;
}

function daysInMonth(month) {
  const [year, monthNumber] = month.split('-').map(Number);

  return new Date(
    Date.UTC(year, monthNumber, 0),
  ).getUTCDate();
}

function normalizeMonth(value, asOf) {
  const month = value ?? asOf.slice(0, 7);

  if (
    typeof month !== 'string' ||
    !/^\d{4}-\d{2}$/.test(month)
  ) {
    throw badRequest('month must use YYYY-MM format.');
  }

  const [year, monthNumber] = month.split('-').map(Number);

  if (
    year < 1000 ||
    year > 9999 ||
    monthNumber < 1 ||
    monthNumber > 12
  ) {
    throw badRequest('month must be a valid calendar month.');
  }

  return month;
}

async function getHabitOrThrow(supabase, userId, habitId) {
  const habit = await queryData(
    supabase
      .from('habits')
      .select('id, user_id, name, description, is_active, created_at')
      .eq('id', habitId)
      .eq('user_id', userId)
      .maybeSingle(),
  );

  if (!habit) {
    throw httpError(404, 'NOT_FOUND', 'Habit not found.');
  }

  return habit;
}

async function getActiveHabits(supabase, userId) {
  return queryAllRows(() =>
    supabase
      .from('habits')
      .select('id, user_id, name, description, is_active, created_at')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }),
  );
}

async function getCompletions(
  supabase,
  userId,
  {
    habitId,
    habitIds,
    from,
    to,
  } = {},
) {
  if (habitIds && habitIds.length === 0) {
    return [];
  }

  return queryAllRows(() => {
    let query = supabase
      .from('habit_completions')
      .select('habit_id, user_id, completion_date, completed_at')
      .eq('user_id', userId);

    if (habitId) {
      query = query.eq('habit_id', habitId);
    }

    if (habitIds) {
      query = query.in('habit_id', habitIds);
    }

    if (from) {
      query = query.gte('completion_date', from);
    }

    if (to) {
      query = query.lte('completion_date', to);
    }

    return query
      .order('completion_date', { ascending: true })
      .order('habit_id', { ascending: true });
  });
}

function groupCompletions(rows) {
  const map = new Map();

  for (const row of rows) {
    if (!map.has(row.habit_id)) {
      map.set(row.habit_id, []);
    }

    map.get(row.habit_id).push(row);
  }

  return map;
}

function uniqueDates(rows, asOf) {
  return [
    ...new Set(
      rows
        .map((row) => row.completion_date)
        .filter((date) => date <= asOf),
    ),
  ].sort();
}

function longestStreak(dates) {
  let longest = 0;
  let current = 0;
  let previous = null;

  for (const date of dates) {
    if (
      previous !== null &&
      shiftDate(previous, 1) === date
    ) {
      current += 1;
    } else {
      current = 1;
    }

    longest = Math.max(longest, current);
    previous = date;
  }

  return longest;
}

function currentStreak(dates, asOf) {
  const completed = new Set(dates);

  // A streak remains current during today if yesterday
  // was completed and today's completion is still pending.
  let date = completed.has(asOf)
    ? asOf
    : shiftDate(asOf, -1);

  let streak = 0;

  while (completed.has(date)) {
    streak += 1;
    date = shiftDate(date, -1);
  }

  return streak;
}

function eligibleDays(habit, start, end) {
  if (start > end) {
    return 0;
  }

  const createdDate = dateFromTimestamp(habit.created_at);
  const firstEligibleDate = createdDate
    ? maxDate(start, createdDate)
    : start;

  if (firstEligibleDate > end) {
    return 0;
  }

  return dayDifferenceInclusive(firstEligibleDate, end);
}

function rateForDates(dates, habit, start, end) {
  const eligible = eligibleDays(habit, start, end);

  if (eligible === 0) {
    return 0;
  }

  const count = dates.filter(
    (date) => date >= start && date <= end,
  ).length;

  return Math.round((count / eligible) * 100);
}

function habitMetrics(habit, rows, asOf) {
  const dates = uniqueDates(rows, asOf);
  const createdDate = dateFromTimestamp(habit.created_at);
  const lastCompletedDate = dates.at(-1) ?? null;

  return {
    id: habit.id,
    name: habit.name,
    description: habit.description,
    is_active: habit.is_active,
    created_at: habit.created_at,
    current_streak: currentStreak(dates, asOf),
    longest_streak: longestStreak(dates),
    total_completions: dates.length,
    last_completed_date: lastCompletedDate,
    completion_rate_7d: rateForDates(
      dates,
      habit,
      shiftDate(asOf, -6),
      asOf,
    ),
    completion_rate_30d: rateForDates(
      dates,
      habit,
      shiftDate(asOf, -29),
      asOf,
    ),
    eligible_since: createdDate,
  };
}

function overallRate(habits, rows, start, end) {
  const denominator = habits.reduce(
    (total, habit) => total + eligibleDays(habit, start, end),
    0,
  );

  if (denominator === 0) {
    return 0;
  }

  const count = rows.filter(
    (row) => row.completion_date >= start &&
      row.completion_date <= end,
  ).length;

  return Math.round((count / denominator) * 100);
}

function periodWindow(period, asOf) {
  if (period === 'week') {
    const weekday = new Date(
      `${asOf}T00:00:00.000Z`,
    ).getUTCDay();

    const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
    const start = shiftDate(asOf, -daysSinceMonday);

    return {
      start,
      end: shiftDate(start, 6),
      effectiveEnd: asOf,
    };
  }

  if (period === 'month') {
    const month = asOf.slice(0, 7);
    const start = `${month}-01`;
    const lastDay = daysInMonth(month);

    return {
      start,
      end: `${month}-${String(lastDay).padStart(2, '0')}`,
      effectiveEnd: asOf,
    };
  }

  if (period === 'year') {
    const year = asOf.slice(0, 4);

    return {
      start: `${year}-01-01`,
      end: `${year}-12-31`,
      effectiveEnd: asOf,
    };
  }

  throw badRequest('period must be week, month, or year.');
}

function buildChart(period, window, rows, asOf) {
  const countByDate = new Map();

  for (const row of rows) {
    const date = row.completion_date;

    countByDate.set(date, (countByDate.get(date) ?? 0) + 1);
  }

  if (period === 'year') {
    const year = asOf.slice(0, 4);
    const chart = [];

    for (let month = 1; month <= 12; month += 1) {
      const monthString = String(month).padStart(2, '0');
      const start = `${year}-${monthString}-01`;
      const end = `${year}-${monthString}-${String(
        daysInMonth(`${year}-${monthString}`),
      ).padStart(2, '0')}`;

      let count = 0;

      for (const [date, value] of countByDate.entries()) {
        if (date >= start && date <= end) {
          count += value;
        }
      }

      chart.push({
        date: start,
        label: new Date(`${start}T00:00:00.000Z`)
          .toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }),
        completions: count,
        is_future: start > asOf,
      });
    }

    return chart;
  }

  return datesBetween(window.start, window.end).map((date) => ({
    date,
    label: period === 'week'
      ? new Date(`${date}T00:00:00.000Z`)
        .toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
      : String(Number(date.slice(8, 10))),
    completions: countByDate.get(date) ?? 0,
    is_future: date > asOf,
  }));
}

// GET /api/streaks
export async function getOverview(userId, token, requestedAsOf) {
  const asOf = normalizeDate(requestedAsOf, 'as_of');
  const supabase = getSupabase(token);
  const habits = await getActiveHabits(supabase, userId);

  const rows = await getCompletions(supabase, userId, {
    habitIds: habits.map((habit) => habit.id),
    to: asOf,
  });

  const grouped = groupCompletions(rows);
  const items = habits.map((habit) =>
    habitMetrics(habit, grouped.get(habit.id) ?? [], asOf),
  );

  return {
    as_of: asOf,
    summary: {
      total_active_habits: items.length,
      active_streaks_count: items.filter(
        (habit) => habit.current_streak > 0,
      ).length,
      longest_streak: Math.max(
        0,
        ...items.map((habit) => habit.longest_streak),
      ),
      best_current_streak: Math.max(
        0,
        ...items.map((habit) => habit.current_streak),
      ),
      total_completions: items.reduce(
        (sum, habit) => sum + habit.total_completions,
        0,
      ),
      completion_rate_7d: overallRate(
        habits,
        rows,
        shiftDate(asOf, -6),
        asOf,
      ),
      completion_rate_30d: overallRate(
        habits,
        rows,
        shiftDate(asOf, -29),
        asOf,
      ),
    },
    habits: items.sort(
      (a, b) =>
        b.current_streak - a.current_streak ||
        b.longest_streak - a.longest_streak,
    ),
  };
}

// GET /api/streaks/habits/:id/stats
export async function getHabitStats(
  userId,
  token,
  id,
  requestedAsOf,
) {
  const habitId = normalizeId(id);
  const asOf = normalizeDate(requestedAsOf, 'as_of');
  const supabase = getSupabase(token);

  const habit = await getHabitOrThrow(supabase, userId, habitId);
  const rows = await getCompletions(supabase, userId, {
    habitId,
    to: asOf,
  });

  return {
    as_of: asOf,
    ...habitMetrics(habit, rows, asOf),
  };
}

// GET /api/streaks/habits/:id/calendar?month=YYYY-MM
export async function getHabitCalendar(
  userId,
  token,
  id,
  requestedMonth,
  requestedAsOf,
) {
  const habitId = normalizeId(id);
  const asOf = normalizeDate(requestedAsOf, 'as_of');
  const month = normalizeMonth(requestedMonth, asOf);
  const supabase = getSupabase(token);

  const habit = await getHabitOrThrow(supabase, userId, habitId);
  const rows = await getCompletions(supabase, userId, {
    habitId,
    to: asOf,
  });

  const stats = habitMetrics(habit, rows, asOf);
  const completionByDate = new Map(
    rows.map((row) => [row.completion_date, row.completed_at]),
  );

  const firstDate = `${month}-01`;
  const lastDate = `${month}-${String(
    daysInMonth(month),
  ).padStart(2, '0')}`;

  const createdDate = dateFromTimestamp(habit.created_at);

  const days = datesBetween(firstDate, lastDate).map((date) => {
    let status;

    if (date > asOf) {
      status = 'future';
    } else if (createdDate && date < createdDate) {
      status = 'not_started';
    } else if (completionByDate.has(date)) {
      status = 'completed';
    } else {
      status = 'missed';
    }

    return {
      date,
      day: Number(date.slice(8, 10)),
      status,
      completed_at: completionByDate.get(date) ?? null,
    };
  });

  return {
    habit: {
      id: habit.id,
      name: habit.name,
      description: habit.description,
      is_active: habit.is_active,
    },
    month,
    as_of: asOf,
    stats,
    days,
  };
}

// GET /api/streaks/habits/:id/history
export async function getHabitHistory(
  userId,
  token,
  id,
  options = {},
) {
  const habitId = normalizeId(id);
  const asOf = normalizeDate(options.as_of, 'as_of');
  const end = normalizeDate(options.to ?? asOf, 'to');
  const start = normalizeDate(
    options.from ?? shiftDate(end, -29),
    'from',
  );

  if (start > end) {
    throw badRequest('from must be earlier than or equal to to.');
  }

  if (dayDifferenceInclusive(start, end) > 366) {
    throw badRequest('History range cannot exceed 366 days.');
  }

  const supabase = getSupabase(token);
  const habit = await getHabitOrThrow(supabase, userId, habitId);

  const rows = end < asOf
    ? await getCompletions(supabase, userId, {
      habitId,
      from: start,
      to: end,
    })
    : start <= asOf
      ? await getCompletions(supabase, userId, {
        habitId,
        from: start,
        to: asOf,
      })
      : [];

  const completionByDate = new Map(
    rows.map((row) => [row.completion_date, row.completed_at]),
  );

  const createdDate = dateFromTimestamp(habit.created_at);

  const entries = datesBetween(start, end)
    .map((date) => {
      let status;

      if (date > asOf) {
        status = 'future';
      } else if (createdDate && date < createdDate) {
        status = 'not_started';
      } else if (completionByDate.has(date)) {
        status = 'completed';
      } else {
        status = 'missed';
      }

      return {
        date,
        status,
        completed_at: completionByDate.get(date) ?? null,
      };
    })
    .reverse();

  return {
    habit: {
      id: habit.id,
      name: habit.name,
    },
    from: start,
    to: end,
    as_of: asOf,
    entries,
  };
}

// GET /api/streaks/insights?period=week|month|year
export async function getInsights(
  userId,
  token,
  requestedPeriod = 'week',
  requestedAsOf,
) {
  const period = requestedPeriod ?? 'week';

  if (!['week', 'month', 'year'].includes(period)) {
    throw badRequest('period must be week, month, or year.');
  }

  const asOf = normalizeDate(requestedAsOf, 'as_of');
  const window = periodWindow(period, asOf);
  const supabase = getSupabase(token);

  const habits = await getActiveHabits(supabase, userId);

  const allRows = await getCompletions(supabase, userId, {
    habitIds: habits.map((habit) => habit.id),
    to: asOf,
  });

  const grouped = groupCompletions(allRows);
  const activeMetrics = habits.map((habit) =>
    habitMetrics(habit, grouped.get(habit.id) ?? [], asOf),
  );

  const periodRows = allRows.filter(
    (row) =>
      row.completion_date >= window.start &&
      row.completion_date <= window.effectiveEnd,
  );

  const denominator = habits.reduce(
    (sum, habit) =>
      sum + eligibleDays(habit, window.start, window.effectiveEnd),
    0,
  );

  const completionRate = denominator === 0
    ? 0
    : Math.round((periodRows.length / denominator) * 100);

  const topPerformingHabits = habits
    .map((habit) => {
      const rows = grouped.get(habit.id) ?? [];
      const dates = uniqueDates(rows, asOf);
      const completionCount = dates.filter(
        (date) =>
          date >= window.start &&
          date <= window.effectiveEnd,
      ).length;

      const eligible = eligibleDays(
        habit,
        window.start,
        window.effectiveEnd,
      );

      return {
        id: habit.id,
        name: habit.name,
        current_streak: currentStreak(dates, asOf),
        longest_streak: longestStreak(dates),
        completion_count: completionCount,
        eligible_days: eligible,
        completion_rate: eligible === 0
          ? 0
          : Math.round((completionCount / eligible) * 100),
      };
    })
    .sort(
      (a, b) =>
        b.completion_rate - a.completion_rate ||
        b.completion_count - a.completion_count ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 5);

  return {
    period,
    as_of: asOf,
    period_start: window.start,
    period_end: window.end,
    summary: {
      total_active_habits: habits.length,
      active_streaks_count: activeMetrics.filter(
        (habit) => habit.current_streak > 0,
      ).length,
      longest_streak: Math.max(
        0,
        ...activeMetrics.map((habit) => habit.longest_streak),
      ),
      best_current_streak: Math.max(
        0,
        ...activeMetrics.map((habit) => habit.current_streak),
      ),
      total_completions: periodRows.length,
      all_time_completions: allRows.length,
      completion_rate: completionRate,
      eligible_habit_days: denominator,
    },
    chart: buildChart(period, window, periodRows, asOf),
    top_performing_habits: topPerformingHabits,
  };
}
