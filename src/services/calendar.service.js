import { getSupabase } from '../config/supabase.js';
import {
  isEligibleActivityStatus,
  metricStatus,
  overallCalendarStatus,
} from './activity-status.js';
import {
  currentScheduledStreak,
  isHabitScheduledOn,
  longestScheduledStreak,
  scheduledCompletionDates,
  scheduledHabitStatus,
  streakEndingOnScheduledDate,
} from './habit-schedule.js';

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
      .select('id,name,description,schedule_type,schedule_days,schedule_dates,is_active,created_at')
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

async function readWaterTrackingStart(supabase, userId, timezone) {
  const row = await result(
    supabase
      .from('water_entries')
      .select('consumed_at')
      .eq('user_id', userId)
      .order('consumed_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
  );

  return row ? localDateFromTimestamp(row.consumed_at, timezone) : null;
}

function localDateFromTimestamp(value, timezone) {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw unavailable();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(timestamp);
  const fields = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${fields.year}-${fields.month}-${fields.day}`;
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
    const dateSet = dateSets.get(habit.id) ?? new Set();
    const dates = scheduledCompletionDates(habit, dateSet, asOf);

    stats.set(habit.id, {
      id: habit.id,
      name: habit.name,
      schedule_type: habit.schedule_type ?? 'daily',
      schedule_days: habit.schedule_days ?? [1, 2, 3, 4, 5, 6, 7],
      schedule_dates: habit.schedule_dates ?? [],
      current_streak: currentScheduledStreak(habit, dateSet, asOf),
      longest_streak: longestScheduledStreak(habit, dateSet, asOf),
      total_completions: dates.length,
      last_completed_date: dates.at(-1) ?? null,
      dates: dateSet,
    });
  }

  return { stats, rowsByHabit };
}

function habitDayStatus(habit, date, asOf, completedDates) {
  return scheduledHabitStatus(
    habit,
    date,
    asOf,
    completedDates.has(date),
  );
}

function habitModuleStatus(date, asOf, completed, eligible, pending, restDay) {
  if (date > asOf) return 'future';
  if (eligible === 0) return restDay > 0 ? 'rest_day' : 'not_started';
  if (completed === eligible) return 'completed';
  if (completed > 0) return 'partial';
  if (pending > 0 || date === asOf) return 'pending';
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

  const waterAsOf = query.as_of ?? todayInTimezone(waterGoal.timezone);
  const stepsAsOf = query.as_of ?? todayInTimezone(stepGoal.timezone);
  const habitsAsOf = query.as_of ?? todayInTimezone('Asia/Kolkata');
  const asOf = [waterAsOf, stepsAsOf, habitsAsOf].sort().at(-1);

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

  const [waterRows, stepRows, completionRows, waterTrackingStart] = await Promise.all([
    readWaterTotals(supabase, start, end, waterAsOf),
    readStepRows(supabase, userId, start, end, stepsAsOf),
    readCompletions(supabase, userId, habits, habitsAsOf),
    readWaterTrackingStart(supabase, userId, waterGoal.timezone),
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
    habitsAsOf,
  );
  const completionByDate = new Map(completionRows.map((row) => [
    `${row.habit_id}:${row.completion_date}`,
    row.completed_at,
  ]));

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
      waterAsOf,
      {
        hasData: waterTrackingStart !== null,
        knownFrom: waterTrackingStart,
        todayPendingWithoutData: true,
      },
    );

    const stepsStatus = metricStatus(
      steps,
      stepGoal.daily_goal,
      date,
      stepsAsOf,
      {
        hasData: stepsByDate.has(date),
        todayPendingWithoutData: false,
      },
    );

    const habitItems = habits.map((habit) => {
      const stats = streakStats.get(habit.id);
      const status = habitDayStatus(
        habit,
        date,
        habitsAsOf,
        stats?.dates ?? new Set(),
      );

      return {
        id: habit.id,
        name: habit.name,
        schedule_type: habit.schedule_type ?? 'daily',
        schedule_days: habit.schedule_days ?? [1, 2, 3, 4, 5, 6, 7],
        schedule_dates: habit.schedule_dates ?? [],
        status,
        completed_at: completionByDate.get(`${habit.id}:${date}`) ?? null,
        streak_on_date:
          status === 'completed'
            ? streakEndingOnScheduledDate(habit, stats?.dates ?? new Set(), date)
              : date === habitsAsOf
              ? stats?.current_streak ?? 0
              : 0,
        current_streak: stats?.current_streak ?? 0,
        longest_streak: stats?.longest_streak ?? 0,
      };
    });

    const completedHabits = habitItems.filter(
      (habit) => habit.status === 'completed',
    ).length;
    const missedHabits = habitItems.filter(
      (habit) => habit.status === 'missed',
    ).length;
    const pendingHabits = habitItems.filter(
      (habit) => habit.status === 'pending',
    ).length;
    const restDayHabits = habitItems.filter(
      (habit) => habit.status === 'rest_day',
    ).length;
    const notStartedHabits = habitItems.filter(
      (habit) => habit.status === 'not_started',
    ).length;
    const futureHabits = habitItems.filter(
      (habit) => habit.status === 'future',
    ).length;
    const eligibleHabits = completedHabits + missedHabits + pendingHabits;

    const habitStatus = habitModuleStatus(
      date,
      habitsAsOf,
      completedHabits,
      eligibleHabits,
      pendingHabits,
      restDayHabits,
    );

    const activities = [];
    if (isEligibleActivityStatus(waterStatus)) {
      activities.push({
        status: waterStatus,
        progress: statusProgress(waterStatus, water.total_ml / waterGoal.daily_goal_ml),
      });
    }
    if (isEligibleActivityStatus(stepsStatus)) {
      activities.push({
        status: stepsStatus,
        progress: statusProgress(stepsStatus, steps / stepGoal.daily_goal),
      });
    }

    if (eligibleHabits > 0) {
      activities.push({
        status: habitStatus,
        progress: completedHabits / eligibleHabits,
      });
    }

    const progressPercent = activities.length === 0
      ? 0
      : Math.round(
          (activities.reduce((sum, activity) => sum + activity.progress, 0) /
            activities.length) * 100,
        );
    const overallStatus = overallCalendarStatus(date, asOf, [
      waterStatus,
      stepsStatus,
      habitStatus,
    ]);

    return {
      date,
      water: {
        total_ml: water.total_ml,
        daily_goal_ml: waterGoal.daily_goal_ml,
        entry_count: water.entry_count,
        progress_percent: Math.round(
          (water.total_ml / waterGoal.daily_goal_ml) * 1000,
        ) / 10,
        goal_achieved: waterStatus === 'completed',
        status: waterStatus,
      },
      steps: {
        steps,
        daily_goal: stepGoal.daily_goal,
        progress_percent: Math.round(
          (steps / stepGoal.daily_goal) * 1000,
        ) / 10,
        goal_achieved: stepsStatus === 'completed',
        status: stepsStatus,
      },
      habits: {
        completed: completedHabits,
        eligible: eligibleHabits,
        missed: missedHabits,
        pending: pendingHabits,
        rest_day: restDayHabits,
        not_started: notStartedHabits,
        future: futureHabits,
        total_habits: habits.length,
        status: habitStatus,
        items: habitItems,
      },
      overall: {
        progress_percent: progressPercent,
        completed_activities: activities.filter(
          (activity) => activity.status === 'completed',
        ).length,
        eligible_activities: activities.length,
        status: overallStatus,
      },
    };
  });

  const streaks = habits.map((habit) => {
    const stats = streakStats.get(habit.id);

    return {
      id: habit.id,
      name: habit.name,
      schedule_type: stats?.schedule_type ?? 'daily',
      schedule_days: stats?.schedule_days ?? [1, 2, 3, 4, 5, 6, 7],
      schedule_dates: stats?.schedule_dates ?? [],
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
  const waterDaysUpToAsOf = days.filter((day) => day.date <= waterAsOf);
  const stepsDaysUpToAsOf = days.filter((day) => day.date <= stepsAsOf);
  const habitDaysUpToAsOf = days.filter((day) => day.date <= habitsAsOf);
  const habitsById = new Map(habits.map((habit) => [habit.id, habit]));
  const monthCompletions = completionRows.filter(
    (row) => {
      const habit = habitsById.get(row.habit_id);
      return row.completion_date >= start && row.completion_date <= end &&
        habit && isHabitScheduledOn(habit, row.completion_date);
    },
  );
  const eligibleActivityCount = daysUpToAsOf.reduce(
    (sum, day) => sum + day.overall.eligible_activities,
    0,
  );
  const completedActivityCount = daysUpToAsOf.reduce(
    (sum, day) => sum + day.overall.completed_activities,
    0,
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
      water_total_ml: waterDaysUpToAsOf.reduce(
        (sum, day) => sum + day.water.total_ml,
        0,
      ),
      water_goal_achieved_days: waterDaysUpToAsOf.filter(
        (day) => day.water.goal_achieved,
      ).length,
      water_known_days: waterDaysUpToAsOf.filter(
        (day) => ['completed', 'partial', 'missed', 'pending'].includes(day.water.status),
      ).length,
      total_steps: stepsDaysUpToAsOf.reduce(
        (sum, day) => sum + day.steps.steps,
        0,
      ),
      steps_recorded_days: stepsDaysUpToAsOf.filter(
        (day) => day.steps.status !== 'no_data',
      ).length,
      steps_goal_achieved_days: stepsDaysUpToAsOf.filter(
        (day) => day.steps.goal_achieved,
      ).length,
      habit_completions_in_month: monthCompletions.length,
      days_with_all_habits_completed: habitDaysUpToAsOf.filter(
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
      habit_eligible_occurrences: habitDaysUpToAsOf.reduce(
        (sum, day) => sum + day.habits.eligible,
        0,
      ),
      habit_missed_occurrences: habitDaysUpToAsOf.reduce(
        (sum, day) => sum + day.habits.missed,
        0,
      ),
      habit_pending_occurrences: habitDaysUpToAsOf.reduce(
        (sum, day) => sum + day.habits.pending,
        0,
      ),
      habit_rest_days: habitDaysUpToAsOf.reduce(
        (sum, day) => sum + day.habits.rest_day,
        0,
      ),
      eligible_activities: eligibleActivityCount,
      completed_activities: completedActivityCount,
      activity_completion_rate_percent: eligibleActivityCount === 0
        ? 0
        : Math.round((completedActivityCount / eligibleActivityCount) * 100),
    },
    available_habits: habits.map((habit) => ({
      id: habit.id,
      name: habit.name,
      schedule_type: habit.schedule_type ?? 'daily',
      schedule_days: habit.schedule_days ?? [1, 2, 3, 4, 5, 6, 7],
      schedule_dates: habit.schedule_dates ?? [],
    })),
    streaks,
    days,
  };
}
