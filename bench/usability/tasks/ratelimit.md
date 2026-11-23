# Per-key rate limiter

Build a rate-limiting service that other backends ask before doing expensive work.

## Rules

- Each key gets a **limit** of requests per **window of 60 seconds**. The default limit is 5.
- A key's window starts at the first check it gets and lasts 60 s; the first check after it ends starts a new window
  with the full limit.
- Every check counts, including a retried one.
- Keys are 1 to 64 characters of `A-Z`, `a-z`, `0-9`, `_`, `-`, `.`, `:`. Keys are independent of each other.

## Endpoints

- `POST /check/{key}` counts one request for the key.
  - Allowed: **200** `{"allowed": true, "remaining": 4}` where `remaining` is how many more checks this window
    allows (so the 5th allowed check answers `"remaining": 0`).
  - Over the limit: **429** `{"allowed": false, "remaining": 0, "retry_after_ms": 59000}` where `retry_after_ms` is
    the milliseconds until the window ends (an integer, from 1 to 60000). A refused check does not extend the window.
- `PUT /limits/{key}` with `{"limit": 3}` sets that key's limit (an integer from 1 to 10000) and answers **200**
  `{"key": "...", "limit": 3}`. It applies from the next check, in the current window too.
- `GET /limits/{key}` answers **200** `{"key": "...", "limit": 5, "used": 2}`: the key's limit and how many checks
  the current window has counted (0 when it has none or it has ended).

A key that breaks the rules above, or a bad body: **400** with `{"error": "<a short reason>"}`. Any other route: **404**.
