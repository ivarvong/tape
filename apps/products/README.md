# Small products

Five small programs written to use Tape as a user would, each served from the hosted service's public route. Each
file's header lists its routes; `node tape.ts test` runs its examples and `node tape.ts sim` simulates it.

- [`pastebin/`](pastebin/pastebin.tape): post text, get a short id and an escaped HTML page; a timer set in the
  same commit deletes it after 24 hours (or `?minutes=N`). https://tape.ivar.workers.dev/p/demo/pastebin/
- [`poll/`](poll/poll.tape): JSON-made polls, one vote per voter key (claimed first), results as bars or JSON, and a
  vote form that posts and redirects. https://tape.ivar.workers.dev/p/demo/poll/
- [`countdown/`](countdown/countdown.tape): a countdown page computed from `now()` at each load, with a Float ring of
  how much of the wait has gone and a Dec of days left in JSON. https://tape.ivar.workers.dev/p/demo/countdown/
- [`ledger/`](ledger/ledger.tape): double-entry play money in Dec[2]: transfers keyed by client id, balances with a
  floor, and CSV exports. https://tape.ivar.workers.dev/p/demo/ledger/
- [`status/`](status/status.tape): components and incidents as machines moved by `sql_move`, a maintenance window
  ended by a timer, an HTML page, `status.json` and a JSON Feed; only the operator writes.
  https://tape.ivar.workers.dev/p/demo/status/
