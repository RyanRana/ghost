# ghost

test on your real postgres or supabase. writes run for real, then roll back. your session sees them, nobody else does.

```
 your app / an agent
       │  session id (a cookie, a header, a script argument)
       ▼
 runghost, in your server process
  ├─ writes ─────────── public.ghost_run  ──┐
  ├─ reads ──────────── patched with your session's rows,
  │                     or replayed in public.ghost_read (views, rpcs, branch migrations)
  ├─ uploads ────────── real, under <bucket>/ghost/<session>/
  ├─ edge functions ─── your handler, run in-process (or held as "simulated")
  └─ outside sends ──── held + logged, answered ok
       │
       │  session log: memory · a sqlite file · the database (ghost.sessions)
       ▼
 postgres, one transaction per request that always rolls back
  1. your branch's migrations
  2. replay your earlier changes as exact rows, triggers skipped
     (a deferred check makes the transaction impossible to commit)
  3. run the request: real triggers, functions, constraints
     (sequences draw from ghost twins)
  4. capture every row it changed
  5. return the answer + the changes → roll back
```

```
npx runghost init
npx runghost query "update orders set shipped = true returning *"
```

mit
