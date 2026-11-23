# Using the public service

These are the rules for the hosted service at https://tape.ivar.workers.dev. They do not apply to the code in this
repository, which is under the [MIT license](LICENSE), or to a copy of the service you run yourself.

The hosted MCP server and API are live at https://tape.ivar.workers.dev/mcp (and `/v1/compile`, `/v1/run`,
`/v1/feedback` beside it).

## Alpha software

Tape is alpha-quality software. Anything can change at any time, without notice: the language, the API, the
service, its limits and its accounts. Do not keep anything on it you cannot lose, and do not depend on it for
anything that matters.

## What is logged

We log metadata about each call: the tool called, sizes, counts, error and diagnostic codes, response statuses,
timings, step counts, a hash of your IP address salted with a secret and the day, and your user agent. We do not
log your program's source, your requests' bodies or the responses. We use this to improve Tape and the service.
What each call logs is listed in [`docs/mcp.md`](docs/mcp.md#what-is-logged).

A program deployed on the service is different: recording every request it serves is what the service does (a run
is replayed and traced from its effect log). Its effect log keeps each request's method, target and body, and these
request headers, which the program can also read: `accept`, `accept-language`, `content-type`, `if-match`,
`if-none-match`, `if-modified-since`, `idempotency-key`, and any `x-` header except `x-forwarded-*` and
`x-real-ip`; each value cut at 1 KB, 32 headers at most. Never `cookie`, `authorization`, the client's address or
the headers Cloudflare adds. That log is the program's own data, readable by its account's operator (and through the
signed trace links the operator hands out), and is kept as the program's retention says; it is not the call metadata above. Compile and run calls keep nothing of the
programs and requests they are sent.

Logs are kept for 7 days, the retention of Workers Logs (Workers Observability) on this account's Workers Paid plan,
and then deleted by Cloudflare. Nothing copies them elsewhere (no Logpush job, no tail consumer).

## Feedback

The `feedback` tool sends a report to the maintainers. What you send in it is stored (in a private bucket, not
public, never served back) and read by us to improve Tape: the text and any code, requests and expected and actual
results you choose to include, with the time, the service version, your user agent, the daily salted hash of your
IP address and what the compiler says of the code you sent. Do not send secrets or personal data. Reports are kept
until we delete them. [`docs/mcp.md`](docs/mcp.md#feedback) lists every field.

## Acceptable use

Do not use the service for:

- phishing, or pages that imitate someone else;
- malware, or distributing it;
- illegal content;
- abuse of other services, such as flooding or scanning them;
- attempts to break the isolation between programs or to get around the service's limits;
- spam;
- cryptomining.

We delete content that breaks these rules, at our discretion.

## Contact

To report abuse or ask about these rules: ivar@ivarvong.com. To report a security vulnerability, see [`SECURITY.md`](SECURITY.md).
