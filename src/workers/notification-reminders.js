import { getServiceSupabase } from '../config/supabase.js';
import { firebaseReady, sendToSelectedDevices } from '../services/firebase-admin.service.js';
import { isHabitScheduledOn } from '../services/habit-schedule.js';

function localNow(timezone, instant = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

export function dueTime(configuredTimes, currentTime, graceMinutes = 4) {
  const currentMinutes = Number(currentTime.slice(0, 2)) * 60 + Number(currentTime.slice(3, 5));
  return configuredTimes
    .map((value) => value.slice(0, 5))
    .filter((value) => {
      const scheduledMinutes = Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
      return currentMinutes >= scheduledMinutes && currentMinutes - scheduledMinutes <= graceMinutes;
    })
    .sort()
    .at(-1);
}

function dateInTimezone(value, timezone) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function insertReminder(db, userId, type, title, body, eventKey, data) {
  const { error } = await db.from('notifications').upsert({
    user_id: userId, type, title, body, data, event_key: eventKey,
  }, { onConflict: 'user_id,event_key', ignoreDuplicates: true });
  if (error) throw new Error('Could not save a scheduled notification.');
}

async function reminderForUser(db, preferences, now) {
  const { user_id: userId, timezone } = preferences;
  const current = localNow(timezone, now);
  const dayKey = current.date.replaceAll('-', '');
  const habitSlot = preferences.habit_reminders_enabled
    ? dueTime([preferences.habit_reminder_time], current.time) : undefined;
  const waterSlot = preferences.water_reminders_enabled
    ? dueTime(preferences.water_reminder_times ?? [], current.time) : undefined;
  const stepsSlot = preferences.steps_reminders_enabled
    ? dueTime([preferences.steps_reminder_time], current.time) : undefined;

  if (habitSlot) {
    const { data: habits, error: habitError } = await db.from('habits')
      .select('id,name,schedule_type,schedule_days,schedule_dates')
      .eq('user_id', userId).eq('is_active', true).limit(100);
    if (habitError) throw new Error('Could not read scheduled habits.');
    const { data: completions, error: completionError } = await db.from('habit_completions')
      .select('habit_id').eq('user_id', userId).eq('completion_date', current.date).limit(100);
    if (completionError) throw new Error('Could not read habit completions.');
    const done = new Set(completions.map((row) => row.habit_id));
    for (const habit of habits) {
      if (!isHabitScheduledOn(habit, current.date) || done.has(habit.id)) continue;
      await insertReminder(db, userId, 'habit_reminder', `Time for ${habit.name}`,
        'Your scheduled habit is waiting for you.',
        `reminder:habit:${habit.id}:${dayKey}:${habitSlot.replace(':', '')}`,
        { screen: 'habits', habit_id: habit.id });
    }
  }

  if (waterSlot) {
    const { data: goal, error: goalError } = await db.from('water_goals')
      .select('daily_goal_ml').eq('user_id', userId).maybeSingle();
    if (goalError) throw new Error('Could not read the water goal.');
    const since = new Date(now.getTime() - 36 * 60 * 60 * 1000).toISOString();
    const { data: rows, error: waterError } = await db.from('water_entries')
      .select('amount_ml,consumed_at').eq('user_id', userId)
      .gte('consumed_at', since).lte('consumed_at', now.toISOString()).limit(2000);
    if (waterError) throw new Error('Could not read water progress.');
    const total = rows.filter((row) => dateInTimezone(row.consumed_at, timezone) === current.date)
      .reduce((sum, row) => sum + Number(row.amount_ml), 0);
    const target = goal?.daily_goal_ml ?? 2000;
    if (total < target) {
      await insertReminder(db, userId, 'water_reminder', 'A quick hydration check',
        `You have had ${total} of ${target} ml today.`,
        `reminder:water:${dayKey}:${waterSlot.replace(':', '')}`, { screen: 'water' });
    }
  }

  if (stepsSlot) {
    const { data: goal, error: goalError } = await db.from('step_goals')
      .select('daily_goal').eq('user_id', userId).maybeSingle();
    if (goalError) throw new Error('Could not read the steps goal.');
    const { data: row, error: stepsError } = await db.from('daily_steps')
      .select('steps').eq('user_id', userId).eq('step_date', current.date).maybeSingle();
    if (stepsError) throw new Error('Could not read step progress.');
    // A missing synced row is unknown, not zero activity.
    if (row) {
      const target = goal?.daily_goal ?? 10000;
      if (row.steps < target) {
        await insertReminder(db, userId, 'steps_reminder', 'Keep moving',
          `You are at ${row.steps} of ${target} steps today.`,
          `reminder:steps:${dayKey}:${stepsSlot.replace(':', '')}`, { screen: 'steps' });
      }
    }
  }
}

async function sendQueuedPushes(db) {
  const { data: rows, error } = await db.rpc('claim_notification_pushes', { p_limit: 100 });
  if (error) throw new Error('Could not claim queued pushes.');
  let sent = 0;
  for (const row of rows ?? []) {
    try {
      const { data: devices, error: deviceError } = await db.from('notification_devices')
        .select('id').eq('user_id', row.user_id).eq('is_active', true).limit(5000);
      if (deviceError) throw new Error('Could not load registered devices.');
      if (!devices.length) {
        const { error: noDeviceError } = await db.from('notification_push_outbox')
          .update({ status: 'sent', sent_at: new Date().toISOString(), locked_at: null })
          .eq('id', row.outbox_id);
        if (noDeviceError) throw new Error('Could not finish an empty push.');
        continue;
      }
      const { error: enqueueError } = await db.from('notification_push_deliveries')
        .upsert(devices.map((device) => ({ notification_id: row.notification_id, device_id: device.id })),
          { onConflict: 'notification_id,device_id', ignoreDuplicates: true });
      if (enqueueError) throw new Error('Could not enqueue device deliveries.');
      const source = row.data && typeof row.data === 'object' ? row.data : {};
      const routeByType = {
        water_goal: 'water', water_reminder: 'water', step_goal: 'steps',
        steps_reminder: 'steps', habit_reminder: 'habits',
      };
      const screen = typeof source.screen === 'string' ? source.screen : (routeByType[row.type] ?? 'notifications');
      const { data: pending, error: pendingError } = await db.from('notification_push_deliveries')
        .select('device_id,attempts').eq('notification_id', row.notification_id)
        .eq('status', 'queued').lte('available_at', new Date().toISOString()).limit(5000);
      if (pendingError) throw new Error('Could not read pending device deliveries.');
      for (const delivery of pending) {
        const result = await sendToSelectedDevices([delivery.device_id], {
          title: row.title,
          body: row.body,
          data: { ...source, screen, notification_id: row.notification_id },
        });
        if (result.sent > 0 || result.invalid > 0 || result.failed === 0) {
          const terminalStatus = result.sent > 0 ? 'sent' : 'failed';
          const { error: deliveryError } = await db.from('notification_push_deliveries')
            .update({ status: terminalStatus, sent_at: result.sent ? new Date().toISOString() : null,
              attempts: delivery.attempts + 1, last_error: result.invalid ? 'Token is no longer registered.' : null })
            .eq('notification_id', row.notification_id).eq('device_id', delivery.device_id);
          if (deliveryError) throw new Error('Could not save device delivery state.');
          sent += result.sent;
        } else {
          const attempts = delivery.attempts + 1;
          const terminal = attempts >= 8;
          const delay = Math.min(60, 2 ** Math.min(attempts, 6));
          const { error: deliveryError } = await db.from('notification_push_deliveries')
            .update({ status: terminal ? 'failed' : 'queued', attempts,
              available_at: new Date(Date.now() + delay * 60_000).toISOString(),
              last_error: 'Push delivery failed.' })
            .eq('notification_id', row.notification_id).eq('device_id', delivery.device_id);
          if (deliveryError) throw new Error('Could not save device retry state.');
        }
      }
      const { data: stillQueued, error: queueError } = await db.from('notification_push_deliveries')
        .select('available_at').eq('notification_id', row.notification_id).eq('status', 'queued')
        .order('available_at', { ascending: true }).limit(1);
      if (queueError) throw new Error('Could not check device retry state.');
      const update = stillQueued.length
        ? { status: 'queued', available_at: stillQueued[0].available_at, locked_at: null }
        : { status: 'sent', sent_at: new Date().toISOString(), locked_at: null, last_error: null };
      const { error: updateError } = await db.from('notification_push_outbox')
        .update(update).eq('id', row.outbox_id);
      if (updateError) throw new Error('Could not finish push delivery.');
    } catch (_) {
      const retryMinutes = Math.min(60, 2 ** Math.min(row.attempts, 6));
      const failedPermanently = row.attempts >= 8;
      await db.from('notification_push_outbox').update({
        status: failedPermanently ? 'failed' : 'queued',
        available_at: new Date(Date.now() + retryMinutes * 60_000).toISOString(),
        locked_at: null,
        last_error: 'Push delivery failed.',
      }).eq('id', row.outbox_id);
    }
  }
  return sent;
}

export async function runNotificationReminders({ now = new Date() } = {}) {
  const db = getServiceSupabase();
  const { data: preferences, error } = await db.from('notification_preferences')
    .select('*').limit(5000);
  if (error) throw new Error('Could not load reminder preferences.');
  let evaluated = 0;
  for (const preference of preferences ?? []) {
    try {
      await reminderForUser(db, preference, now);
      evaluated += 1;
    } catch (_) {
      // Keep the worker's output free of account data, tokens and SQL errors.
      console.error(JSON.stringify({ event: 'reminder_evaluation_failed' }));
    }
  }
  const pushed = firebaseReady() ? await sendQueuedPushes(db) : 0;
  return { evaluated, pushed };
}
