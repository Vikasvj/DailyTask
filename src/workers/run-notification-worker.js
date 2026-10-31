import { pathToFileURL } from 'node:url';

import { runNotificationReminders } from './notification-reminders.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runNotificationReminders();
    console.log(JSON.stringify({ event: 'notification_worker_complete', ...result }));
  } catch (_) {
    console.error(JSON.stringify({ event: 'notification_worker_failed' }));
    process.exitCode = 1;
  }
}
