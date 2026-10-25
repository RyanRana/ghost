# ghost

test on your real postgres or supabase. writes run for real, then roll back. your session sees them, nobody else does.

```
 app / agent ──▶ runghost ──▶ postgres
                   │            begin
                   │            replay your changes
                   │            run the write
                   │            capture rows
                   ◀────────── rollback
```

```
npx runghost init
npx runghost query "update orders set shipped = true returning *"
```

mit
