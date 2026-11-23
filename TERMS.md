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
