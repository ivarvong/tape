# Change request

The service in this directory implements SPEC.md. Change it as follows. Everything not mentioned stays as SPEC.md says.

1. **Accounts can be frozen.** Every account gains a fourth key, `frozen`: `{"id":1,"name":"ann","balance":0,"frozen":false}`. This is the shape everywhere an account appears. New accounts are not frozen.
2. **`POST /accounts/<id>/freeze`** → `200` and the account, now frozen. **`POST /accounts/<id>/unfreeze`** → `200` and the account, no longer frozen. The body is ignored. Freezing a frozen account (or unfreezing one that is not) changes nothing and is still `200`. Unknown account → `404 not_found`.
3. **`POST /accounts/<id>/withdraw`** with body `{"amount":25}` (a whole number from 1 to 1000000) → `200` and the updated account. Unknown account → `404 not_found`. Balance smaller than the amount → `409 insufficient_funds`.
4. **A frozen account refuses money movement.** A deposit to or a withdrawal from a frozen account, and a transfer where either account is frozen → `409` with `{"error":"frozen"}`, and nothing changes.
5. **Order of checks** for a request with a body: the body (`400`), then whether accounts exist (`404`), then frozen (`409 frozen`), then funds (`409 insufficient_funds`).
6. **`GET /accounts?frozen=true`** and **`GET /accounts?frozen=false`** → only the accounts that are, or are not, frozen. `?min=<n>` still works. Only these three forms of query are accepted; anything else, including an empty query (`GET /accounts?`) and combinations, → `400 bad_request`.
7. The new paths `/accounts/<id>/freeze`, `/accounts/<id>/unfreeze` and `/accounts/<id>/withdraw` accept `POST` only; other methods → `405 method_not_allowed`.
