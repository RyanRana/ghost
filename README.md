# ghost

Test on your real database without saving anything.

ghost runs every write through your real Postgres logic (triggers, functions, constraints, rollups), gives your app the real answer, and rolls it all back. Your later reads see your earlier writes, as if they had happened. Close the session and it's all gone. Works with Supabase today, and with plain Postgres connections.

```
npx runghost init
```

## What you get

- **Real answers.** A write runs for real inside a transaction that always rolls back. If your trigger refuses it, you see that refusal. If a rollup changes a total, you see the new total.
- **Your writes stick for you.** ghost remembers the rows each write changed. Later reads in your session are replayed or patched with them, so pages and views look like the writes happened.
- **Nothing is saved.** The database itself refuses to commit a ghost run. It doesn't depend on your app being careful.
- **No numbers used up.** Sequences draw from ghost twins (9000001 and up), so order numbers and invoice numbers are never burned.
- **Your branch's migrations run.** Point ghost at your migrations folder and anything the database doesn't have yet runs first inside each rolled-back run. Heavy ones wait their turn and never lock up real traffic.
- **Outside sends are held.** Email, Slack, Stripe, webhooks: logged and answered OK, never sent.
- **Uploads work.** They really land, under `ghost/<session>/` in the same bucket. Your app keeps using the original path. They're deleted when the session ends.
- **Everyone gets their own session.** Sessions never see each other.

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
       │  session log: memory · a SQLite file · the database (ghost.sessions)
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

## Set up

```
npm i runghost
npx runghost init
```

`init` asks for three things, saves them to `.env.local` (and keeps that file out of git):

| | where to find it (Supabase) | used for |
|---|---|---|
| `SUPABASE_URL` | Project Settings → API | every ghost call |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API | ghost's runners are granted to service_role only |
| `DATABASE_URL` | Project Settings → Database → connection string | installing ghost; leave blank to use the SQL editor |

Then it installs ghost into the database and runs `runghost doctor`.

No connection string? Run `npx runghost sql`, paste the output into the Supabase SQL editor, and run it.

Installing adds:
- a `ghost` schema;
- an `zz_ghost_capture` trigger on every public table with a primary key, which does nothing unless a ghost run turns it on;
- a two-line guard at the top of every plpgsql trigger function, so replayed rows skip triggers;
- ghost twins of your sequences.

Run `npx runghost install` again after a migration adds tables, trigger functions or sequences. `runghost doctor` tells you when it's needed.

## Use it

### Supabase (server side)

```ts
import { createClient } from "@supabase/supabase-js"
import { createGhost, sqliteLog } from "runghost"

export const ghost = createGhost({
  url: process.env.SUPABASE_URL!,
  serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  log: sqliteLog(".ghost/ghost.sqlite"),          // sessions survive a dev-server restart
  migrations: { dir: "supabase/migrations" },     // optional: run your branch's migrations too
})

const session = ghost.session("alice")
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  global: { fetch: session.fetch },
})

await supabase.from("orders").insert({ customer_id: 1 })   // runs for real, kept for alice only
await supabase.from("orders").select("*")                  // alice sees her order; nobody else does
await session.summary()                                     // what alice did
await session.end()                                         // gone, uploads included
```

### Every fetch in the process

Some code makes its own clients or calls outside services directly. Install the guard once, then run each request inside its session:

```ts
ghost.installGuard()

await ghost.session(id).run(async () => {
  // every fetch in here is ghosted: database writes run and roll back, Slack/email/Stripe are held
})
```

Code inside `ghost.real(() => ...)` sends for real even inside a session.

### Next.js

```ts
// lib/ghost.ts
export const ghost = createGhost({
  url: process.env.SUPABASE_URL!,
  serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  log: process.env.NODE_ENV === "development" ? sqliteLog(".ghost/ghost.sqlite") : databaseLog(),
  migrations: process.env.NODE_ENV === "development" ? { dir: "supabase/migrations" } : undefined,
})
ghost.installGuard()

// a route handler or server action
const id = (await cookies()).get("ghost")?.value
const run = () => doTheWork()
return id ? ghost.session(id).run(run) : run()
```

Turn ghost on by setting the `ghost` cookie to a new id (`crypto.randomUUID()`), and off by deleting it and calling `ghost.session(id).end()`. For local development you can give every browser a session automatically.

Deployed with more than one server? Use `databaseLog()`: sessions live in the database (`ghost.sessions`), the same on every server, and are ignored after 12 hours idle.

### Edge functions

A deployed edge function would write for real, so ghost runs your function's code in-process instead:

```ts
createGhost({ ..., functions: { "send-receipt": (request) => sendReceipt(request) } })
```

Its own fetches go through the guard like everything else. A function you don't register is answered `{ ghost: "simulated" }` and listed with the held sends.

### Browser uploads

A signed upload URL made in a ghost session points at `ghost/<session>/…`. Give the browser client `followGhostUploads` as its fetch so storage-js uploads there:

```ts
createClient(url, anonKey, { global: { fetch: followGhostUploads } })
```

### Plain Postgres

Hold one connection (a pool client, not the pool) and run statements through ghost:

```ts
import pg from "pg"
import { ghostPg, MemoryGhostLog } from "runghost"

const client = await pool.connect()
const ghost = ghostPg(client, new MemoryGhostLog("alice"))

const { rows, changes } = await ghost.query("insert into orders (customer_id) values ($1) returning *", [1])
await ghost.read("select * from orders")      // sees the order
await ghost.transaction(async (q) => { await q("update ..."); await q("delete ...") })
```

Each call is `begin; select ghost.open_run(...); <your sql>; select ghost.close_run(); rollback;`. The marker ghost inserts first means that transaction can never commit, even if something tries.

## For agents

One line in the terminal:

```
npx runghost query "update orders set shipped = true where id = 1 returning *" --session agent-ship
```

prints the rows and every row the statement changed (triggers included), and keeps nothing.

One line in code:

```ts
const { db } = await ghostClient("agent-ship")   // a Supabase client: writes roll back, reads see them
```

`ghostClient` reads the keys `init` saved, keeps sessions in `.ghost/ghost.sqlite`, runs `supabase/migrations` as branch migrations, and holds outside sends. `runghost init` offers to add a short note to your project's AGENTS.md so coding agents know ghost is there. `npx runghost doctor --json` tells an agent whether everything is connected.

## Commands

```
runghost init         ask for your keys, save them, install ghost, check it works
runghost install      install or update ghost in the database
runghost doctor       check every piece is connected (--json)
runghost sql          print the install SQL
runghost query "<sql>"  run one statement in ghost, print { rows, changes } (--read, --session <id>)
runghost sessions     list local sessions (--json)
runghost reset <id>   forget one local session's changes
```

`init`, `install` and `doctor` take `--url`, `--key`, `--db` and `--yes` for running without prompts.

## Limits

- **Server side only.** ghost's runners need the service role key, so it runs where that key lives. A browser client that writes straight to Supabase with the anon key isn't ghosted; send those writes through your server.
- **Row level security doesn't apply inside a run.** The runners act as the database owner, like the service role does.
- **The `public` schema only**, for now.
- **Reads ghost can't patch exactly are refused, not faked.** Filtered embeds, counts and full-text filters on tables your session changed come back with a clear "ghost can't show this yet" instead of a wrong answer.
- **Identity columns still count.** Postgres takes an identity number before any trigger runs. `serial` and `nextval` defaults are fine. `install` lists the identity columns it can't twin.
- **A heavy branch migration** (rewriting or backfilling a live table) runs with a 200 ms lock limit and retries in the background, so it may take a while to show up.
- **Effects that outlive a rollback are refused** in branch migrations: advisory locks, `dblink`, `alter system`, `copy … program`.
- **A session closed without ending** keeps its ghost uploads until it's reset or ended.

## Develop

```
pnpm install
pnpm test        # SQL runs on PGlite (real Postgres in wasm), plus supabase-js end to end
pnpm typecheck
pnpm build
```

MIT license.
