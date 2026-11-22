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

## Known and not yet fixed

These are listed in [`STATUS.md`](STATUS.md#known-limitations); there is no need to report them again:

- Two overlapping sends of one `once` key, to a method that itself makes a call, can both run.
- A woken run that fails on a storage error removes its timer.
- A published page is served from the API's origin as `text/html` or `image/svg+xml`, with no
  `Content-Security-Policy` and no `X-Content-Type-Options: nosniff`.
