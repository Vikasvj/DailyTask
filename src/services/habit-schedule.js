const ALL_WEEKDAYS = Object.freeze([1, 2, 3, 4, 5, 6, 7]);

function shiftDate(value, amount) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function dateParts(value) {
  const [year, month, day] = value.split('-').map(Number);
  return { year, month, day };
}

function formatDate(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function weekdayNumber(value) {
  const weekday = new Date(`${value}T00:00:00.000Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function normalizeNumberSet(value, min, max) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(
    (item) => Number.isInteger(item) && item >= min && item <= max,
  ))].sort((a, b) => a - b);
}

function habitCreationDate(habit) {
  if (typeof habit.created_at !== 'string') return null;
  const createdAt = new Date(habit.created_at);
  if (!Number.isFinite(createdAt.getTime())) return habit.created_at.slice(0, 10);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(createdAt);
  const fields = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

/** Missing/null schedules are legacy daily habits. */
export function normalizeHabitSchedule(habit = {}) {
  if (habit.schedule_type === 'weekly') {
    const weekdays = normalizeNumberSet(habit.schedule_days, 1, 7);
    if (weekdays.length > 0) {
      return { type: 'weekly', weekdays, dates: [] };
    }
  } else if (habit.schedule_type === 'monthly') {
    const dates = normalizeNumberSet(habit.schedule_dates, 1, 31);
    if (dates.length > 0) {
      return { type: 'monthly', weekdays: [], dates };
    }
  } else if (habit.schedule_type === 'daily') {
    return { type: 'daily', weekdays: ALL_WEEKDAYS, dates: [] };
  }

  return { type: 'daily', weekdays: ALL_WEEKDAYS, dates: [] };
}

export function isHabitScheduledOn(habit, date) {
  const schedule = normalizeHabitSchedule(habit);
  if (schedule.type === 'daily') return true;
  if (schedule.type === 'weekly') {
    return schedule.weekdays.includes(weekdayNumber(date));
  }
  return schedule.dates.includes(dateParts(date).day);
}

export function scheduledHabitStatus(habit, date, asOf, isCompleted) {
  if (date > asOf) return 'future';
  const createdDate = habitCreationDate(habit);
  if (createdDate && date < createdDate) return 'not_started';
  if (!isHabitScheduledOn(habit, date)) return 'rest_day';
  if (isCompleted) return 'completed';
  return date === asOf ? 'pending' : 'missed';
}

/** Return the next scheduled date on or after `date`. */
export function nextScheduledDateOnOrAfter(habit, date) {
  const schedule = normalizeHabitSchedule(habit);
  if (schedule.type === 'daily') return date;

  if (schedule.type === 'weekly') {
    for (let offset = 0; offset < 7; offset += 1) {
      const candidate = shiftDate(date, offset);
      if (schedule.weekdays.includes(weekdayNumber(candidate))) {
        return candidate;
      }
    }
    return null;
  }

  const start = dateParts(date);
  let year = start.year;
  let month = start.month;

  while (year <= 9998) {
    const lastDay = daysInMonth(year, month);
    const minimumDay = year === start.year && month === start.month
      ? start.day
      : 1;
    const day = schedule.dates.find(
      (value) => value >= minimumDay && value <= lastDay,
    );
    if (day !== undefined) return formatDate(year, month, day);

    if (month === 12) {
      year += 1;
      month = 1;
    } else {
      month += 1;
    }
  }

  return null;
}

/** Return the previous scheduled date strictly before `date`. */
export function previousScheduledDate(habit, date) {
  const schedule = normalizeHabitSchedule(habit);
  if (schedule.type === 'daily') return shiftDate(date, -1);
  if (schedule.type === 'weekly') {
    for (let offset = 1; offset <= 7; offset += 1) {
      const candidate = shiftDate(date, -offset);
      if (schedule.weekdays.includes(weekdayNumber(candidate))) {
        return candidate;
      }
    }
    return null;
  }

  const start = dateParts(shiftDate(date, -1));
  let year = start.year;
  let month = start.month;

  while (year >= 1) {
    const maximumDay = year === start.year && month === start.month
      ? start.day
      : daysInMonth(year, month);
    const day = [...schedule.dates].reverse().find(
      (value) => value <= maximumDay && value <= daysInMonth(year, month),
    );
    if (day !== undefined) return formatDate(year, month, day);

    if (month === 1) {
      year -= 1;
      month = 12;
    } else {
      month -= 1;
    }
  }

  return null;
}

export function scheduledDatesBetween(habit, start, end) {
  if (start > end) return [];
  const createdDate = habitCreationDate(habit);
  let cursor = createdDate && createdDate > start ? createdDate : start;
  const dates = [];

  while (cursor <= end) {
    const next = nextScheduledDateOnOrAfter(habit, cursor);
    if (next === null || next > end) break;
    dates.push(next);
    cursor = shiftDate(next, 1);
  }

  return dates;
}

export function scheduledCompletionDates(habit, completionDates, asOf) {
  const createdDate = habitCreationDate(habit);
  return [...new Set(completionDates)].filter(
    (date) => date <= asOf && (!createdDate || date >= createdDate) &&
      isHabitScheduledOn(habit, date),
  ).sort();
}

export function currentScheduledStreak(habit, completionDates, asOf) {
  const completed = completionDates instanceof Set
    ? completionDates
    : new Set(completionDates);
  const createdDate = habitCreationDate(habit);

  let cursor = isHabitScheduledOn(habit, asOf) && completed.has(asOf)
    ? asOf
    : previousScheduledDate(habit, asOf);
  let streak = 0;

  while (cursor && (!createdDate || cursor >= createdDate)) {
    if (!completed.has(cursor)) break;
    streak += 1;
    cursor = previousScheduledDate(habit, cursor);
  }

  return streak;
}

export function streakEndingOnScheduledDate(habit, completionDates, date) {
  const completed = completionDates instanceof Set
    ? completionDates
    : new Set(completionDates);
  const createdDate = habitCreationDate(habit);
  if (!completed.has(date) || !isHabitScheduledOn(habit, date)) return 0;

  let streak = 0;
  let cursor = date;
  while (cursor && (!createdDate || cursor >= createdDate) && completed.has(cursor)) {
    streak += 1;
    cursor = previousScheduledDate(habit, cursor);
  }
  return streak;
}

export function longestScheduledStreak(habit, completionDates, asOf = '9998-12-31') {
  const dates = scheduledCompletionDates(habit, completionDates, asOf);
  let longest = 0;
  let current = 0;
  let previous = null;

  for (const date of dates) {
    current = previous && nextScheduledDateOnOrAfter(
      habit,
      shiftDate(previous, 1),
    ) === date
      ? current + 1
      : 1;
    longest = Math.max(longest, current);
    previous = date;
  }

  return longest;
}

export function countScheduledOccurrences(habit, start, end) {
  return scheduledDatesBetween(habit, start, end).length;
}
