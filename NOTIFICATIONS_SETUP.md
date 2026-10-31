# Automatic in-app notifications

Creation runs when the authenticated notification list or unread-count API loads.
Flutter also refreshes the badge after a successful water save and after returning
from Step Tracker. Water, Steps, Profile and Auth API contracts are unchanged.

Files changed for automatic creation:

- `E:\DailyTask\src\services\notifications.service.js` — evaluate before list/count.
- `E:\DailyTask\supabase\migrations\20261027021227_automatic_habit_notifications.sql` — storage, RLS, deduplication and trusted evaluator.
- `E:\DailyTask\test\notifications.test.js` — authenticated API integration tests.
- `E:\DailyTask\test\notifications-database.test.js` — PostgreSQL generation/security tests.
- `E:\DailyTask\NOTIFICATIONS_SETUP.md` — activation and verification guide.
- `E:\Daily Task frontend\lib\screens\home_screen.dart` — refresh badge after saves/Step Tracker.
- `E:\Daily Task frontend\test\notification_screen_test.dart` — badge refresh regression tests.

## Events

- **Welcome:** once per account on its first notification evaluation, including
  existing accounts. This works with Flutter's direct Supabase authentication.
- **Water goal:** once per account/calendar date when the saved total for today
  reaches the water goal. Uses the water account timezone and existing dashboard
  midnight-to-midnight totals, including any same-day future-dated water entries.
- **Step goal:** once per account/calendar date when today's backend aggregate
  reaches the step goal. Device-only or pending offline totals must sync first.

Defaults match the tracker: 2,000 ml, 10,000 steps and Asia/Kolkata. Date keys do
not include timezone, so changing timezone does not duplicate the same dated
event. Changing a goal can create an eligible achievement once; increasing it
later or deleting water entries does not revoke an existing achievement. Stored
data keeps the original goal, total, date and timezone snapshot.

Only the current date is evaluated. Previous-day offline uploads do not generate
historical achievement notifications. There is no scheduled/background worker,
push notification or phone notification-tray delivery. If no notification API is
called that day, an achievement may never be generated for that date.

## Activate in your Supabase project

The connected Supabase account currently lists no projects, so this migration has
**not been applied to the live database**.

1. Confirm the existing Water and Steps migrations were already applied. Do not
   rerun those migrations on existing tables.
2. Inspect an existing notifications table before applying this migration:

   ```sql
   select column_name, udt_name, is_nullable, column_default
   from information_schema.columns
   where table_schema = 'public' and table_name = 'notifications'
   order by ordinal_position;

   select conname, pg_get_constraintdef(oid)
   from pg_constraint where conrelid = to_regclass('public.notifications');
   ```

3. Open and run the complete file in Supabase SQL Editor **once**:
   `E:\DailyTask\supabase\migrations\20261027021227_automatic_habit_notifications.sql`.
   It creates a missing table or adopts compatible columns. Existing rows and
   policies remain; incompatible types, duplicate keys or invalid rows abort the
   transaction. Additional existing CHECK constraints must allow `welcome`,
   `water_goal` and `step_goal`. Inspect incompatible constraints rather than
   dropping existing data or policies. If SQL Editor retains a failed transaction,
   run `ROLLBACK` before retrying a corrected migration.
4. Keep `habit_notifications_private` out of exposed Data API schemas. The public
   invoker RPC calls a private, authenticated, fixed-purpose definer function.
   Clients can select their own rows and update `read_at`; arbitrary notification
   creation, content edits, ownership changes and deletion are not granted.
5. Restart the backend yourself, then fully restart the configured Flutter app.

That migration only enables the existing in-app event creation. The FCM migration
and backend-only credentials below are also required for device registration and
push delivery.

## Manual verification

Login and open the bell: welcome should appear once. Refresh repeatedly and mark
it read: it must stay read and never duplicate. Reach today's water goal, then
check the badge and notification. Sync today's step goal and return home: check
the step achievement. More saves or stale/repeated step syncs must not duplicate
the same dated achievement. Repeat using a second account to confirm isolation.

```powershell
Set-Location E:\DailyTask
node --test --test-concurrency=1
curl.exe -H "Authorization: Bearer <ACCESS_TOKEN>" "http://localhost:3000/api/notifications?limit=20"
curl.exe -H "Authorization: Bearer <ACCESS_TOKEN>" "http://localhost:3000/api/notifications/unread-count"
```

Tests use local Auth/PostgREST fixtures and real PostgreSQL via existing PGlite.
Live schema constraints, Supabase advisors and real Android sensor-to-cloud flow
still require verification in your own project/device.

## FCM devices, push delivery, and reminders

The Flutter app uses the Firebase Installation ID (FID) registration API from the
installed Firebase Messaging SDK. The backend stores that identifier as a private
device record and sends to it with Firebase Admin. Firebase's current guidance
uses FIDs with `register()` / `onRegistered`; the old registration-token methods
are deprecated. Foreground pushes use a local Android notification channel.

### Database and API

Apply `supabase/migrations/20261031120000_fcm_devices_and_reminders.sql` after
the automatic notifications migration above. It adds:

- `notification_devices` with globally unique FIDs and owner-bound registration
  and unregister RPCs.
- `notification_preferences` with a timezone and configurable habit, water, and
  steps reminder times. Preferences are private to their Supabase user.
- `notification_push_outbox` and per-device delivery rows, populated by a
  trigger whenever an in-app notification is inserted.

Authenticated API routes:

- `POST /api/notifications/devices` — `{ "installation_id": "...", "platform": "android" }`
- `DELETE /api/notifications/devices/current` — `{ "installation_id": "..." }`
- `GET /api/notifications/reminders`
- `PATCH /api/notifications/reminders` — partial updates to timezone and reminder settings.

The existing list, unread-count, mark-one-read, and mark-all-read routes remain
unchanged. Notification taps route from the saved notification data and mark the
notification read when an ID is present.

### Backend secrets and worker

Set these in the backend host's secret environment only. `.env.example` contains
placeholders; do not put credentials in Flutter config, Git, or this document.

- `SUPABASE_SERVICE_ROLE_KEY` — required only by trusted worker/Admin SDK access.
- `FIREBASE_PROJECT_ID=dailytask-cc261`
- `FIREBASE_CLIENT_EMAIL` — service account email from Firebase project settings.
- `FIREBASE_PRIVATE_KEY` — service account private key; store as a secret. Escaped
  `\n` line breaks are expanded by the backend.

Create the Firebase service account in Firebase Console → Project settings →
Service accounts, then add its email/private key to the backend host. Never add
the downloaded service-account JSON to the repository. The Firebase Android
app remains `com.example.daily_habit_tracker`; its existing `google-services.json`
and `lib/firebase_options.dart` are reused.

Run the worker as a **one-shot scheduled job every minute**, not as a loop in the
Express web service:

```sh
npm run reminders:run
```

The worker checks scheduled active habits, skips already-completed habits,
checks water totals and synced step rows, writes deduplicated notifications to
the existing history, then drains the per-device push outbox. A missing daily
step row is treated as unknown and does not generate a step reminder. Cron retries
are keyed by user/activity/date/scheduled time and per device.

### Android verification and remaining platform setup

On Android 13 and later, approve the notification prompt when DailyTask asks.
If denied, enable notifications in Android App info; the app does not repeatedly
prompt. Ensure Firebase Cloud Messaging is enabled for the project. A connected
Android device and the backend migration/secrets/worker are required for a real
end-to-end delivery test. iOS additionally requires APNs credentials in Firebase;
web push is not wired in this Android-first integration.
