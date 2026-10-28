import { getSupabase } from '../config/supabase.js';

const PAGE_SIZE = 1000;

const DEFAULT_WATER_GOAL = {
  daily_goal_ml: 2000,
  timezone: 'Asia/Kolkata',
};

const DEFAULT_STEP_GOAL = {
  daily_goal: 10000,
  timezone: 'Asia/Kolkata',
};

function apiError(status, code, message) {
  return Object.assign(new Error(message), {
    status,
    code,
    expose: true,
  });
}

function invalid(message = 'Invalid calendar request.') {
  return apiError(400, 'INVALID_INPUT', message);
}

function unavailable() {
  return apiError(
    503,
    'DATABASE_UNAVAILABLE',
    'Calendar data is temporarily unavailable.',
  );
}

async function result(query) {
  const { data, error, status } = await query;

  if (!error) return data;

  if (status === 429) {
    throw apiError(429, 'RATE_LIMITED', 'Too many requests.');
  }

  if (['PGRST301', 'PGRST303'].includes(error.code)) {
    throw apiError(401, 'INVALID_TOKEN', 'The access token is invalid or expired.');
  }

  if (error.code === '42501') {
    throw apiError(403, 'FORBIDDEN', 'This operation is not permitted.');
  }

  if (['22P02', '22007', '22008', '22009', '22023'].includes(error.code)) {
    throw invalid();
  }

  throw unavailable();
}

async function fetchAll(buildQuery) {
  const rows = [];
  let offset = 0;

  while (true) {
    const { data, error, status } = await buildQuery().range(
      offset,
      offset + PAGE_SIZE - 1,
    );

    if (error) {
      if (status === 429) {
        throw apiError(429, 'RATE_LIMITED', 'Too many requests.');
      }

      if (error.code === '42501') {
        throw apiError(403, 'FORBIDDEN', 'This operation is not permitted.');
      }

      throw unavailable();
    }

    const page = data ?? [];
    rows.push(...page);

    if (page.length < PAGE_SIZE) break;
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
  if (year < 1000 || year > 9998) return false;

  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function todayInTimezone(timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
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

function shiftDate(value, amount) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function dateRange(start, end) {
  const dates = [];

  for (let date = start; date <= end; date = shiftDate(date, 1)) {
    dates.push(date);
  }

  return dates;
}

function getMonthRange(month) {
  if (
    typeof month !== 'string' ||
    !/^\d{4}-\d{2}$/.test(month)
  ) {
    throw invalid('month must use YYYY-MM format.');
  }

  const [year, monthNumber] = month.split('-').map(Number);

  if (year < 1000 || year > 9998 || monthNumber < 1 || monthNumber > 12) {
    throw invalid('Invalid calendar month.');
  }

  const start = `${month}-01`;
  const nextMonth = new Date(`${start}T00:00:00.000Z`);

  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);

  return {
    start,
    end: shiftDate(nextMonth.toISOString().slice(0, 10), -1),
    endExclusive: nextMonth.toISOString().slice(0, 10),
  };
}

function readPositiveInteger(value, fallback) {
  const number = Number(value ?? fallback);

  if (!Number.isSafeInteger(number) || number < 1) {
    throw unavailable();
  }

  return number;
}

function readNonNegativeInteger(value) {
  const number = Number(value ?? 0);

  if (!Number.isSafeInteger(number) || number < 0) {
    throw unavailable();
  }

  return number;
}

function validUUID(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function metricStatus(value, goal, date, asOf) {
  if (date > asOf) return 'future';
  if (value >= goal) return 'completed';
  if (value > 0) return 'partial';
  if (date === asOf) return 'not_started';
  return 'missed';
}

function completionDates(rows) {
  return [...new Set(rows.map((row) => row.completion_date))].sort();
}

function longestStreak(dates) {
  let longest = 0;
  let current = 0;
  let previous = null;

  for (const date of dates) {
    current = previous && shiftDate(previous, 1) === date
      ? current + 1
      : 1;

    longest = Math.max(longest, current);
    previous = date;
  }

  return longest;
}

function streakEndingOnDate(dateSet, date) {
  if (!dateSet.has(date)) return 0;

  let streak = 0;
  let cursor = date;

  while (dateSet.has(cursor)) {
    streak += 1;
    cursor = shiftDate(cursor, -1);
  }

  return streak;
}

function currentStreak(dateSet, asOf) {
  if (dateSet.has(asOf)) {
    return streakEndingOnDate(dateSet, asOf);
  }

  // Keep yesterday's streak alive until the current day ends.
  return streakEndingOnDate(dateSet, shiftDate(asOf, -1));
}

async function readWaterGoal(supabase, userId) {
  const row = await result(
    supabase
      .from('water_goals')
      .select('daily_goal_ml,timezone')
      .eq('user_id', userId)
      .maybeSingle(),
  );

  const goal = row ?? DEFAULT_WATER_GOAL;

  if (!goal.timezone || typeof goal.timezone !== 'string') {
    throw unavailable();
  }

  return {
    daily_goal_ml: readPositiveInteger(goal.daily_goal_ml, 2000),
    timezone: goal.timezone,
  };
}

async function readStepGoal(supabase, userId) {
  const row = await result(
    supabase
      .from('step_goals')
      .select('daily_goal,timezone')
      .eq('user_id', userId)
      .maybeSingle(),
  );

  const goal = row ?? DEFAULT_STEP_GOAL;

  if (!goal.timezone || typeof goal.timezone !== 'string') {
    throw unavailable();
  }

  return {
    daily_goal: readPositiveInteger(goal.daily_goal, 10000),
    timezone: goal.timezone,
  };
}

async function readHabits(supabase, userId, habitId) {
  if (habitId && !validUUID(habitId)) {
    throw invalid('habit_id must be a valid UUID.');
  }

  const habits = await fetchAll(() => {
    let query = supabase
      .from('habits')
      .select('id,name,description,is_active,created_at')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });

    if (habitId) query = query.eq('id', habitId);

    return query;
  });

  if (habitId && habits.length === 0) {
    throw apiError(404, 'NOT_FOUND', 'Active habit not found.');
  }

  return habits;
}

async function readWaterTotals(supabase, start, end, asOf) {
  const effectiveEnd = end < asOf ? end : asOf;
  if (start > effectiveEnd) return [];

  // This is the same RPC and exclusive end-date convention
  // used by the existing water service.
  const rows = await result(
    supabase.rpc('water_daily_totals', {
      p_start_date: start,
      p_end_date: shiftDate(effectiveEnd, 1),
    }),
  );

  if (!Array.isArray(rows)) throw unavailable();

  return rows;
}

async function readStepRows(supabase, userId, start, end, asOf) {
  const effectiveEnd = end < asOf ? end : asOf;
  if (start > effectiveEnd) return [];

  return fetchAll(() =>
    supabase
      .from('daily_steps')
      .select('step_date,steps')
      .eq('user_id', userId)
      .gte('step_date', start)
      .lte('step_date', effectiveEnd)
      .order('step_date', { ascending: true }),
  );
}

async function readCompletions(supabase, userId, habits, asOf) {
  const ids = habits.map((habit) => habit.id);
  if (ids.length === 0) return [];

  // Read all history up to asOf to calculate longest streak correctly.
  return fetchAll(() =>
    supabase
      .from('habit_completions')
      .select('habit_id,completion_date,completed_at')
      .eq('user_id', userId)
      .in('habit_id', ids)
      .lte('completion_date', asOf)
      .order('completion_date', { ascending: true })
      .order('habit_id', { ascending: true }),
  );
}

function buildHabitStats(habits, completions, asOf) {
  const rowsByHabit = new Map();
  const dateSets = new Map();

  for (const habit of habits) {
    rowsByHabit.set(habit.id, []);
    dateSets.set(habit.id, new Set());
  }

  for (const row of completions) {
    rowsByHabit.get(row.habit_id)?.push(row);
    dateSets.get(row.habit_id)?.add(row.completion_date);
  }

  const stats = new Map();

  for (const habit of habits) {
    const rows = rowsByHabit.get(habit.id) ?? [];
    const dates = completionDates(rows);
    const dateSet = dateSets.get(habit.id) ?? new Set();

    stats.set(habit.id, {
      id: habit.id,
      name: habit.name,
      current_streak: currentStreak(dateSet, asOf),
      longest_streak: longestStreak(dates),
      total_completions: dates.length,
      last_completed_date: dates.at(-1) ?? null,
      dates: dateSet,
    });
  }

  return { stats, rowsByHabit };
}

function habitDayStatus(habit, date, asOf, completedDates) {
  if (date > asOf) return 'future';

  const createdDate = habit.created_at?.slice(0, 10);
  if (createdDate && date < createdDate) return 'not_started';

  if (completedDates.has(date)) return 'completed';
  if (date === asOf) return 'not_started';

  return 'missed';
}

function habitModuleStatus(date, asOf, completed, eligible) {
  if (date > asOf) return 'future';
  if (eligible === 0) return 'not_started';
  if (completed === eligible) return 'completed';
  if (completed > 0) return 'partial';
  if (date === asOf) return 'not_started';
  return 'missed';
}

function statusProgress(status, progress) {
  if (status === 'completed') return 1;
  return Math.min(1, Math.max(0, progress));
}

export async function getMonthlyCalendar(userId, token, query = {}) {
  const supabase = getSupabase(token);

  const [waterGoal, stepGoal] = await Promise.all([
    readWaterGoal(supabase, userId),
    readStepGoal(supabase, userId),
  ]);

  const defaultAsOf = todayInTimezone(waterGoal.timezone);
  const asOf = query.as_of ?? defaultAsOf;

  if (!validDate(asOf)) {
    throw invalid('as_of must use a valid YYYY-MM-DD date.');
  }

  const month = query.month ?? asOf.slice(0, 7);
  const { start, end } = getMonthRange(month);

  const habits = await readHabits(
    supabase,
    userId,
    query.habit_id,
  );

  const [waterRows, stepRows, completionRows] = await Promise.all([
    readWaterTotals(supabase, start, end, asOf),
    readStepRows(supabase, userId, start, end, asOf),
    readCompletions(supabase, userId, habits, asOf),
  ]);

  const waterByDate = new Map();

  for (const row of waterRows) {
    waterByDate.set(row.day, {
      total_ml: readNonNegativeInteger(row.total_ml),
      entry_count: readNonNegativeInteger(row.entry_count),
    });
  }

  const stepsByDate = new Map();

  for (const row of stepRows) {
    stepsByDate.set(
      row.step_date,
      readNonNegativeInteger(row.steps),
    );
  }

  const { stats: streakStats } = buildHabitStats(
    habits,
    completionRows,
    asOf,
  );

  const days = dateRange(start, end).map((date) => {
    const water = waterByDate.get(date) ?? {
      total_ml: 0,
      entry_count: 0,
    };

    const steps = stepsByDate.get(date) ?? 0;

    const waterStatus = metricStatus(
      water.total_ml,
      waterGoal.daily_goal_ml,
      date,
      asOf,
    );

    const stepsStatus = metricStatus(
      steps,
      stepGoal.daily_goal,
      date,
      asOf,
    );

    const habitItems = habits.map((habit) => {
      const stats = streakStats.get(habit.id);
      const status = habitDayStatus(
        habit,
        date,
        asOf,
        stats?.dates ?? new Set(),
      );

      return {
        id: habit.id,
        name: habit.name,
        status,
        completed_at:
          completionRows.find(
            (row) =>
              row.habit_id === habit.id &&
              row.completion_date === date,
          )?.completed_at ?? null,
        streak_on_date:
          status === 'completed'
            ? streakEndingOnDate(stats?.dates ?? new Set(), date)
            : date === asOf
              ? stats?.current_streak ?? 0
              : 0,
      };
    });

    const eligibleHabits = date > asOf
      ? 0
      : habits.filter((habit) => {
          const created = habit.created_at?.slice(0, 10);
          return !created || created <= date;
        }).length;

    const completedHabits = habitItems.filter(
      (habit) => habit.status === 'completed',
    ).length;

    const missedHabits = habitItems.filter(
      (habit) => habit.status === 'missed',
    ).length;

    const habitStatus = habitModuleStatus(
      date,
      asOf,
      completedHabits,
      eligibleHabits,
    );

    const activeRatios = [
      statusProgress(
        waterStatus,
        water.total_ml / waterGoal.daily_goal_ml,
      ),
      statusProgress(
        stepsStatus,
        steps / stepGoal.daily_goal,
      ),
    ];

    if (eligibleHabits > 0) {
      activeRatios.push(completedHabits / eligibleHabits);
    }

    const progressPercent = date > asOf
      ? 0
      : Math.round(
          (activeRatios.reduce((sum, value) => sum + value, 0) /
            activeRatios.length) *
            100,
        );

    const overallStatus = date > asOf
      ? 'future'
      : progressPercent >= 100
        ? 'completed'
        : progressPercent > 0
          ? 'partial'
          : date === asOf
            ? 'not_started'
            : 'missed';

    return {
      date,
      water: {
        total_ml: water.total_ml,
        daily_goal_ml: waterGoal.daily_goal_ml,
        entry_count: water.entry_count,
        progress_percent: Math.round(
          (water.total_ml / waterGoal.daily_goal_ml) * 1000,
        ) / 10,
        goal_achieved: water.total_ml >= waterGoal.daily_goal_ml &&
          date <= asOf,
        status: waterStatus,
      },
      steps: {
        steps,
        daily_goal: stepGoal.daily_goal,
        progress_percent: Math.round(
          (steps / stepGoal.daily_goal) * 1000,
        ) / 10,
        goal_achieved: steps >= stepGoal.daily_goal && date <= asOf,
        status: stepsStatus,
      },
      habits: {
        completed: completedHabits,
        eligible: eligibleHabits,
        missed: missedHabits,
        not_started: habitItems.filter(
          (habit) => habit.status === 'not_started',
        ).length,
        total_habits: habits.length,
        status: habitStatus,
        items: habitItems,
      },
      overall: {
        progress_percent: progressPercent,
        completed_activities: activeRatios.filter(
          (value) => value >= 1,
        ).length,
        eligible_activities: activeRatios.length,
        status: overallStatus,
      },
    };
  });

  const streaks = habits.map((habit) => {
    const stats = streakStats.get(habit.id);

    return {
      id: habit.id,
      name: habit.name,
      current_streak: stats?.current_streak ?? 0,
      longest_streak: stats?.longest_streak ?? 0,
      total_completions: stats?.total_completions ?? 0,
      last_completed_date: stats?.last_completed_date ?? null,
    };
  }).sort(
    (a, b) =>
      b.current_streak - a.current_streak ||
      b.longest_streak - a.longest_streak,
  );

  const daysUpToAsOf = days.filter((day) => day.date <= asOf);
  const monthCompletions = completionRows.filter(
    (row) => row.completion_date >= start && row.completion_date <= end,
  );

  return {
    month,
    as_of: asOf,
    filter: {
      habit_id: query.habit_id ?? null,
      mode: query.habit_id ? 'single_habit' : 'all_habits',
    },
    timezones: {
      water: waterGoal.timezone,
      steps: stepGoal.timezone,
    },
    goals: {
      water_daily_goal_ml: waterGoal.daily_goal_ml,
      steps_daily_goal: stepGoal.daily_goal,
    },
    summary: {
      active_habits: habits.length,
      water_total_ml: daysUpToAsOf.reduce(
        (sum, day) => sum + day.water.total_ml,
        0,
      ),
      water_goal_achieved_days: daysUpToAsOf.filter(
        (day) => day.water.goal_achieved,
      ).length,
      total_steps: daysUpToAsOf.reduce(
        (sum, day) => sum + day.steps.steps,
        0,
      ),
      steps_goal_achieved_days: daysUpToAsOf.filter(
        (day) => day.steps.goal_achieved,
      ).length,
      habit_completions_in_month: monthCompletions.length,
      days_with_all_habits_completed: daysUpToAsOf.filter(
        (day) =>
          day.habits.eligible > 0 &&
          day.habits.completed === day.habits.eligible,
      ).length,
      best_current_streak: Math.max(
        0,
        ...streaks.map((habit) => habit.current_streak),
      ),
      longest_streak: Math.max(
        0,
        ...streaks.map((habit) => habit.longest_streak),
      ),
    },
    available_habits: habits.map(({ id, name }) => ({ id, name })),
    streaks,
    days,
  };
}