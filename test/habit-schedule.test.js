import test from 'node:test';
import assert from 'node:assert/strict';
import { metricStatus, overallCalendarStatus } from '../src/services/activity-status.js';

import {
  countScheduledOccurrences,
  currentScheduledStreak,
  isHabitScheduledOn,
  longestScheduledStreak,
  scheduledDatesBetween,
  scheduledHabitStatus,
} from '../src/services/habit-schedule.js';

test('habits with no schedule fields default to daily', () => {
  const legacyHabit = { created_at: '2026-10-01T08:00:00.000Z' };
  assert.equal(isHabitScheduledOn(legacyHabit, '2026-10-28'), true);
  assert.equal(
    countScheduledOccurrences(legacyHabit, '2026-10-26', '2026-11-01'),
    7,
  );
});

test('weekly schedules use Monday=1 through Sunday=7', () => {
  const habit = {
    schedule_type: 'weekly',
    schedule_days: [1, 3, 5],
    created_at: '2026-10-01T08:00:00.000Z',
  };

  assert.deepEqual(
    scheduledDatesBetween(habit, '2026-10-26', '2026-11-01'),
    ['2026-10-26', '2026-10-28', '2026-10-30'],
  );
  assert.equal(isHabitScheduledOn(habit, '2026-10-31'), false);
});

test('monthly day 31 skips months that do not contain the date', () => {
  const habit = {
    schedule_type: 'monthly',
    schedule_dates: [31],
    created_at: '2026-01-01T08:00:00.000Z',
  };

  assert.deepEqual(
    scheduledDatesBetween(habit, '2026-01-01', '2026-04-30'),
    ['2026-01-31', '2026-03-31'],
  );
  assert.equal(
    countScheduledOccurrences(habit, '2026-02-01', '2026-02-28'),
    0,
  );
});

test('weekly rest days do not break current or longest streaks', () => {
  const habit = {
    schedule_type: 'weekly',
    schedule_days: [1, 3, 5],
    created_at: '2026-10-01T08:00:00.000Z',
  };
  const completed = ['2026-10-26', '2026-10-28'];

  assert.equal(currentScheduledStreak(habit, completed, '2026-10-29'), 2);
  assert.equal(longestScheduledStreak(habit, completed), 2);
});

test('a missed scheduled occurrence breaks the current streak', () => {
  const habit = {
    schedule_type: 'weekly',
    schedule_days: [1, 3, 5],
    created_at: '2026-10-01T08:00:00.000Z',
  };
  const completed = ['2026-10-26', '2026-10-28'];

  assert.equal(currentScheduledStreak(habit, completed, '2026-11-01'), 0);
  assert.equal(longestScheduledStreak(habit, completed), 2);
});

test('today pending preserves yesterday’s daily streak', () => {
  const habit = { schedule_type: 'daily', created_at: '2026-10-01T08:00:00.000Z' };

  assert.equal(
    currentScheduledStreak(
      habit,
      ['2026-10-26', '2026-10-27'],
      '2026-10-28',
    ),
    2,
  );
});

test('completions on unscheduled dates do not add to streaks', () => {
  const habit = {
    schedule_type: 'weekly',
    schedule_days: [3],
    created_at: '2026-10-01T08:00:00.000Z',
  };
  const completed = ['2026-10-26', '2026-10-28'];

  assert.equal(longestScheduledStreak(habit, completed), 1);
  assert.equal(currentScheduledStreak(habit, completed, '2026-10-29'), 1);
});

test('scheduled habit calendar distinguishes pending, missed, rest, future, and not started', () => {
  const habit = {
    schedule_type: 'weekly',
    schedule_days: [1, 3, 5],
    created_at: '2026-10-27T08:00:00.000Z',
  };

  assert.equal(scheduledHabitStatus(habit, '2026-10-26', '2026-10-29', false), 'not_started');
  assert.equal(scheduledHabitStatus(habit, '2026-10-28', '2026-10-29', true), 'completed');
  assert.equal(scheduledHabitStatus(habit, '2026-10-29', '2026-10-29', false), 'rest_day');
  assert.equal(scheduledHabitStatus(habit, '2026-10-30', '2026-10-30', false), 'pending');
  assert.equal(scheduledHabitStatus(habit, '2026-10-30', '2026-10-31', false), 'missed');
  assert.equal(scheduledHabitStatus(habit, '2026-11-01', '2026-10-31', false), 'future');
});

test('habit creation instant uses the habit calendar timezone for its first eligible day', () => {
  const habit = {
    schedule_type: 'daily',
    created_at: '2026-10-28T20:00:00.000Z',
  };

  assert.deepEqual(
    scheduledDatesBetween(habit, '2026-10-28', '2026-10-30'),
    ['2026-10-29', '2026-10-30'],
  );
  assert.equal(scheduledHabitStatus(habit, '2026-10-28', '2026-10-30', false), 'not_started');
  assert.equal(scheduledHabitStatus(habit, '2026-10-29', '2026-10-30', false), 'missed');
});

test('metric status does not invent historical water or step data', () => {
  const goal = 100;
  assert.equal(metricStatus(0, goal, '2026-10-30', '2026-10-30'), 'pending');
  assert.equal(metricStatus(0, goal, '2026-10-30', '2026-10-31', { hasData: false }), 'no_data');
  assert.equal(metricStatus(0, goal, '2026-10-31', '2026-10-31', { hasData: false, todayPendingWithoutData: false }), 'no_data');
  assert.equal(metricStatus(0, goal, '2026-10-30', '2026-10-31', { knownFrom: '2026-10-31' }), 'no_data');
  assert.equal(metricStatus(0, goal, '2026-10-30', '2026-10-31'), 'missed');
  assert.equal(metricStatus(35, goal, '2026-10-30', '2026-10-31'), 'partial');
  assert.equal(metricStatus(goal, goal, '2026-10-30', '2026-10-31'), 'completed');
  assert.equal(metricStatus(0, goal, '2026-11-01', '2026-10-31'), 'future');
});

test('overall status excludes unknown metrics and not-scheduled rest days', () => {
  assert.equal(overallCalendarStatus('2026-10-30', '2026-10-30', ['no_data', 'rest_day']), 'no_data');
  assert.equal(overallCalendarStatus('2026-10-30', '2026-10-30', ['completed', 'no_data', 'rest_day']), 'completed');
  assert.equal(overallCalendarStatus('2026-10-30', '2026-10-30', ['missed', 'pending']), 'pending');
});
