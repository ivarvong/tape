# Security

Tape is alpha software. Report a vulnerability privately, not in a public issue.

Email ivar@ivarvong.com.

Please include what you found, how to reproduce it (a program, a request, a command), and what it lets someone do.

## In scope

- The compiler (`compiler.ts`, `compiler/`, `rules/`, `sql/`): a program that compiles to a module doing what its
  source does not allow, such as SQL that was not a literal in the source, or a capability it was not given.
- The host (`host.ts`, `host/`): a program reaching outside its arena, its database or the capabilities it was
  given; a replay or a stored reply that answers another caller's request.
- The service (`service/`): a way past its authentication, a signed link that opens something it was not signed
  for, one account or name reaching another's data or programs, or a way around a limit in
  [`docs/service.md`](docs/service.md#limits).

## The program's Sql

A program's `Sql` capability reaches only the tables that program created. The host keeps keyed replies, timers,
applied migrations and the effect log in the same Durable Object's key-value storage (`ctx.storage.kv`), which the
SQL API cannot read (the hidden `_cf_KV` table). In Node and the browser the same bookkeeping lives in a store the
program's connection never sees. Writes to that store and to the program's SQL commit or roll back together
(`transactionSync` in workerd). `sqlite_*` catalog tables are not in a program's Sql (C68). A program may create a
table named `_calls` or `_wakes`; that table is only its own data, not the host's.

Objects that still have host tables in SQLite copy those rows into the store and drop the tables the first time the
new host opens them.

## Known and not yet fixed

These are listed in [`STATUS.md`](STATUS.md#known-limitations); there is no need to report them again:

- A published page is served from the API's host as `text/html`, `image/svg+xml`, or XML (`application/atom+xml`,
  `application/rss+xml`, `application/xml`). Each response has `X-Content-Type-Options: nosniff` and a
  `Content-Security-Policy` with `sandbox` and no script. Chrome renders the XML types as pages; that policy is
  what stops a script in the document, and nosniff does not. The API's credentials are bearer tokens, not cookies.
  The sandbox gives the document an opaque origin. The isolation is that policy.
