# Daily Habit Tracker API

Node.js 24, Express 5, JavaScript ES modules, Supabase Auth and PostgreSQL.
Includes email/password authentication and per-account water tracking.

## Run

Dependencies are installed in this folder. For a fresh checkout, run `npm ci`.

```powershell
Set-Location E:\DailyTask
Copy-Item .env.example .env
```

Fill `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in `.env`. Use your
project's `sb_publishable_...` key, never a secret or service-role key.

In your intended Supabase project:

1. Enable email/password authentication and public signup.
2. Keep **Confirm email** enabled. Set the minimum password length to 12 to
   match this API. The provider policy also protects direct Supabase signups.
3. Configure **Site URL** to a reachable page you control. Supabase handles
   email confirmation before redirecting; this API needs no callback endpoint.
4. Configure [custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
   for public registration. Supabase's built-in sender is restricted to
   authorized test addresses.
5. Run the complete contents of
   [the SQL migration](supabase/migrations/20261026051059_create_water_tracking.sql)
   once in that project's SQL Editor. Both tables must be exposed through
   the project's Data API. The migration includes explicit grants and RLS.

User records and password management stay in Supabase Auth. Do not expose the
`auth` schema through the Data API.

```powershell
npm start
```

Development: `npm run dev`. Tests: `npm test`.

Local Flutter web development is supported: CORS allows HTTP/HTTPS origins on
localhost, 127.0.0.1 and ::1 while NODE_ENV is development or test. Browser OPTIONS
preflight is answered before authentication; actual API requests still require
a valid bearer token. Non-local origins are not granted CORS access. Production
does not inherit this development policy. No cookies or credential sharing are enabled.

No live Supabase project has been configured or modified by this implementation.

## Structure

```text
src/
  config/
    supabase.js
  routes/
    auth.routes.js
    water.routes.js
  controllers/
    auth.controller.js
    water.controller.js
  services/
    auth.service.js
    water.service.js
  middleware/
    auth.middleware.js
  app.js
  server.js
```

Routes map endpoints to middleware and controllers. Controllers handle HTTP.
Services validate inputs, implement business rules and run Supabase queries.
Authentication middleware verifies access tokens. A small error handler in
app.js returns safe, consistent responses. Environment checks and request-scoped
Supabase clients live in config/supabase.js. Input validation uses plain JavaScript.

## API

All water endpoints and `/api/auth/me` require
`Authorization: Bearer <access_token>`. JSON write requests require
`Content-Type: application/json`.

| Method | Path | Input | Success |
| --- | --- | --- | --- |
| POST | `/api/auth/signup` | `email, password` | 202 |
| POST | `/api/auth/login` | `email, password` | 200 |
| GET | `/api/auth/me` | — | 200 |
| POST | `/api/water/entries` | `amount_ml, consumed_at?` | 201 |
| GET | `/api/water/entries` | Query: `date?, limit?, cursor?` | 200 |
| PATCH | `/api/water/entries/:id` | `amount_ml?` and/or `consumed_at?` | 200 |
| DELETE | `/api/water/entries/:id` | — | 204 |
| GET | `/api/water/today` | — | 200 |
| GET | `/api/water/history` | Query: `period=day\|week\|month, date?` | 200 |
| GET | `/api/water/goal` | — | 200 |
| PATCH | `/api/water/goal` | `daily_goal_ml?` and/or `timezone?` | 200 |

Amounts and goals must be positive integers up to PostgreSQL's integer limit.
New passwords must contain 12–128 characters; existing passwords can still be
used for login. Passwords are never trimmed.

A create request can be as small as:

```json
{ "amount_ml": 250 }
```

PostgreSQL supplies the timestamp. To backdate or edit an entry, provide an
ISO timestamp with seconds and an explicit UTC offset, for example
`2026-10-26T13:30:00+05:30`. Up to six fractional second digits are supported.
Dates use `YYYY-MM-DD`; supported calendar dates are 0001-01-01 to 9998-12-31.
User IDs, entry IDs and creation timestamps cannot be supplied as editable fields.

Goal updates are partial. For example:

```json
{ "daily_goal_ml": 2500, "timezone": "Asia/Kolkata" }
```

Defaults are **2000 ml** and **Asia/Kolkata**. These are application defaults,
and users can change them. Settings persist with the account across devices.
A settings row is created on the first update.

Date boundaries follow the saved account timezone. Weeks run Monday–Sunday;
months follow calendar boundaries. Every reported period includes zero-intake
days. Changing timezone regroups stored instants into the new local days.
Goal changes apply immediately; historical summaries report intake totals
without tracking old goals.

Today returns:

```json
{
  "data": {
    "date": "2026-10-26",
    "timezone": "Asia/Kolkata",
    "total_ml": 500,
    "daily_goal_ml": 2000,
    "remaining_ml": 1500,
    "progress_percent": 25,
    "entry_count": 2
  }
}
```

Remaining intake floors at zero; progress can exceed 100 percent.
History returns `period`, `start_date`, exclusive `end_date`, `timezone`,
`total_ml` and `days` with daily totals and entry counts.

Entry lists return `data: [...]` and
`meta: { date, timezone, limit, next_cursor }`.
Default page size is 20, maximum 100. Send the same date and
`cursor=<next_cursor>` for the next page; null means there are no more pages.
Cursors preserve microseconds and order by intake time then UUID descending.
Restart pagination after changing timezone. Concurrent edits can change lists;
pagination does not provide a database snapshot.

## Postman

Import [the collection](postman/Daily-Habit-Tracker.postman_collection.json).
Open its **Variables** and set `baseUrl`, `email` and `password`.
Use a real mailbox for confirmation. Do not share exported tokens/passwords.

1. **Signup**: send once and expect 202. Confirm the email before login.
   The generic signup response does not reveal whether an account exists.
2. **Login**: expect 200. The post-response script saves `accessToken`.
   Supabase supplies token expiry; log in again when it expires.
3. **Current user**: expect 200 with `id, email, created_at`.
4. **Read goal / Update goal**: expect 200; update saves the goal and timezone.
5. **Add intake**: expect 201. The script saves `entryId`.
6. **List entries**: expect 200. `date` defaults to today's date in the
   collection's timezone when initially blank. Set it explicitly for history.
   The script saves `nextCursor`; enable the disabled `cursor` query
   parameter to retrieve the next page when it is nonempty.
7. **Today / Daily history / Weekly history / Monthly history**: expect 200.
   Today uses the account's current local date regardless of the collection's
   selected `date`.
8. **Edit intake**: expect 200. Changing the timestamp moves the entry between
   local dates. **Delete intake**: expect 204; deleting it again returns 404.

Negative checks:

- Remove the token or change it: protected routes return 401.
- Use an invalid email, zero/decimal amount, invalid date, empty PATCH,
  unknown timezone, or a request-supplied `user_id`: expect 400.
- Send malformed JSON: 400; non-JSON writes: 415; bodies over 4 KB: 413.
- Sign up and log in as another user. Their lists must not include your
  entries; editing/deleting your `entryId` must return 404.
- Log in with the original account on a different device: history and settings
  remain available. The server stores no per-device session state.

Errors always have this envelope:

```json
{ "error": { "code": "INVALID_INPUT", "message": "Invalid water request body." } }
```

Other statuses: 403 for a denied database operation, 404 for unknown/inaccessible
entries, 409 for an unexpected conflict, 429 for throttling, 500 for an
unexpected application error, and 503 for unavailable/misconfigured upstream
services. Raw database errors, passwords and tokens are never returned or logged.

## Security and verification

- Access tokens are verified through
  [`auth.getUser(token)`](https://supabase.com/docs/reference/javascript/auth-getuser).
  Decoded JWT claims are never trusted without verification.
- Each request uses its own Supabase client carrying the verified access token.
  Services also filter by that user's UUID; database RLS enforces ownership
  even if an application query omits its filter.
- Updates have RLS `USING` and `WITH CHECK` ownership predicates. Column
  grants prevent changing entry ownership, UUID or creation time.
- Summary aggregation runs in PostgreSQL through a `SECURITY INVOKER` RPC,
  independent of entry pagination and the Data API's row limit.
- Goal PATCH operations update only supplied fields and handle a concurrent
  first insert without overwriting the other setting.
- Refresh-token handling, reminders and other habit types are outside this scope.

Run `npm test` to reproduce the checks. HTTP tests use the real Supabase SDK
against local Auth/Data API fixtures. SQL tests run the actual migration in
PGlite PostgreSQL with local Supabase role/`auth.uid()` fixtures.
Coverage includes ownership, constraints, token forwarding, cross-device
account access, microsecond cursor pagination, large totals, concurrent goal
creation, leap months, and 23/25-hour daylight-saving days.

These checks do not verify live Supabase configuration, email delivery or a
deployed host.

## Deployment and free-tier considerations

Use a Node.js 24 host that supports a Node process, HTTPS and environment variables.
Deploy this backend and the Supabase database as separate services.

1. Install production dependencies with `npm ci --omit=dev`; start with `npm start`.
2. Set `NODE_ENV=production`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`
   and the host's `PORT`. Set these in the host's environment settings;
   never upload or commit `.env`.
3. Apply the SQL migration to the intended project before serving water APIs.
4. Configure custom SMTP and verify signup email delivery.
5. Behind a proxy, configure `TRUST_PROXY` with its documented IP addresses
   or CIDR ranges only, comma-separated. The proxy must sanitize forwarded
   headers. Leave this empty for direct connections.
6. Use one Node process initially. Signup/login share a limit of 20 requests
   per IP per 15 minutes; water routes allow 120 requests per authenticated
   user per minute. In-memory limits reset on restart. Add a shared store or
   ingress limiter before running replicas.
7. Supabase's provider-side policies still apply; direct Supabase requests
   bypass Express rate limits. This backend needs no privileged Supabase key.
8. No browser frontend is included. Add an explicit CORS origin allowlist when
   integrating a frontend from another origin.

PGlite is a development-only test dependency and is omitted by production installs.
Free hosting, database and SMTP plans can change. Check current quotas, sleep
behavior, backups and terms before choosing a provider. A free tier does not
guarantee uptime or permanent availability.
