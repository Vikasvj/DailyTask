# Backend mein kya implemented hai

Daily Habit Tracker ka backend **Node.js + Express** API hai. Data aur authentication ke liye **Supabase** use hota hai.

## Features aur endpoints

- **Auth:** signup, login, aur current user (`/api/auth/signup`, `/login`, `/me`). Protected requests Supabase Bearer token verify karti hain.
- **Water tracking:** drink add/list/edit/delete, aaj ka total aur daily goal (`/api/water`). Daily, weekly, aur monthly history bhi milti hai.
- **Step tracking:** aaj ke steps read/save, daily goal, aur daily/weekly/monthly history (`/api/steps`).
- **Profile:** profile read/update aur JPG/PNG/WebP avatar upload, 2 MB tak (`/api/profile`).
- **Notifications:** list, unread count, ek/all notifications ko read mark karna (`/api/notifications`); habit notifications database migration se sync hote hain.

## Request ka flow

`Route → auth middleware → controller → service → Supabase`

Routes endpoints aur middleware jodte hain; middleware token verify karta hai; controller request/response sambhalta hai; service validation aur database logic chalati hai. Errors ek consistent JSON format mein aate hain. Rate limits aur request-size limits bhi configured hain.

## Local run

`.env` configure karke backend folder mein `npm run dev` chalao. Supabase schema updates `supabase/migrations/` mein hain.
