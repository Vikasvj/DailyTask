import test from 'node:test';
import assert from 'node:assert/strict';

import { dueTime } from '../src/workers/notification-reminders.js';

test('reminder scheduler tolerates a delayed cron run and keeps the scheduled slot key', () => {
  assert.equal(dueTime(['09:00:00'], '09:03'), '09:00');
  assert.equal(dueTime(['09:00:00'], '09:05'), undefined);
});

test('overlapping water reminder grace windows choose one latest scheduled slot', () => {
  assert.equal(dueTime(['09:00:00', '09:03:00'], '09:04'), '09:03');
  assert.equal(dueTime(['09:00:00', '14:00:00'], '13:59'), undefined);
});
