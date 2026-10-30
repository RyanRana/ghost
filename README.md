# ghost

test on your real database. writes run for real, then roll back. your session sees them, nobody else does.

postgres, supabase, mysql, mariadb, sqlite.

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
npx runghost query "update orders set shipped = true where id = 7" --session me
npx runghost query "select * from orders where id = 7" --read --session me
```

```ts
import { connect } from "runghost"

const ghost = await connect(process.env.DATABASE_URL) // or a pg / postgres.js / PGlite / mysql2 / node:sqlite handle
const s = ghost.session("agent-42")
const { rows, changes } = await s.query("update orders set shipped = true where id = $1 returning *", [7])
await s.read("select * from orders where id = 7") // sees the update; the database doesn't have it
```

| | install | capture | replay skips your triggers | can't commit |
|---|---|---|---|---|
| postgres, supabase | `runghost install` | trigger per table | guard in each trigger function | deferred trigger |
| mysql, mariadb | `runghost install` | triggers per table | guard in each trigger | ghost refuses anything that commits, checks every CALL, checks after every run |
| sqlite | nothing | temp triggers on ghost's connection | dropped and put back inside the run | deferred foreign key |

every run:
- refuses COMMIT, ROLLBACK and anything else that would end it early, in plain words, before it reaches the database
- tries again on a deadlock or a lock it won't wait for (safe: nothing is kept)
- puts a long session back in batches, and row by row when a constraint needs the exact order
- says so when a real row now clashes with one the session inserted, instead of showing the wrong one

mysql saves ddl the moment it runs, so ghost refuses it there. sqlite numbers rows without AUTOINCREMENT from the
highest one, so a real insert can reuse a ghost row's id; ghost tells you when it does.

mit
