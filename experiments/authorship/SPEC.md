# Service: accounts and transfers

Implement one function, `handle`, backed by a SQLite database.

## Wire format

- Request bytes: `METHOD`, a space, `TARGET`, a line feed, then `BODY` (possibly empty). `TARGET` is `PATH` or `PATH?QUERY`.
- Response bytes: `STATUS`, a line feed, then a JSON body. JSON is written with no spaces and keys in the order shown.
- An account is `{"id":1,"name":"ann","balance":0}`.
- An error is `{"error":"CODE"}` where CODE is one of `bad_request`, `not_found`, `conflict`, `insufficient_funds`, `method_not_allowed`.

## Routes

1. `POST /accounts` with body `{"name":"ann"}`. The name is 1 to 40 bytes. Creates an account with balance 0. Ids are 1, 2, 3, … in creation order. → `201` and the account. A name already in use → `409 conflict`.
2. `GET /accounts/<id>` → `200` and the account, or `404 not_found`.
3. `POST /accounts/<id>/deposit` with body `{"amount":25}`. The amount is a whole number from 1 to 1000000. → `200` and the updated account. Unknown account → `404 not_found`.
4. `POST /transfers` with body `{"from":1,"to":2,"amount":25}`. `from` and `to` are account ids; the amount is a whole number from 1 to 1000000. Moves the amount. → `200` and `{"from":ACCOUNT,"to":ACCOUNT}` showing both accounts after the transfer. Either account unknown → `404 not_found`. Balance of `from` smaller than the amount → `409 insufficient_funds`, and nothing changes.
5. `GET /accounts` → `200` and `{"accounts":[ACCOUNT,…]}`, all accounts ordered by id. `GET /accounts?min=<n>` (n is one or more digits) → only accounts whose balance is at least n. Any other query → `400 bad_request`.

## Rules

- A body must be a JSON object with exactly the keys shown, each of the type shown. Anything else (not JSON, not an object, a missing key, an extra key, a wrong type, a value out of range, `from` equal to `to`) → `400 bad_request`.
- Order of checks for a request with a body: the body first (`400`), then whether accounts exist (`404`), then funds (`409`).
- `<id>` is one or more digits. `/accounts/<anything else>` → `404 not_found`.
- The paths are `/accounts`, `/accounts/<id>`, `/accounts/<id>/deposit` and `/transfers`. A known path with a method it does not support → `405 method_not_allowed`. Any other path → `404 not_found`.
- Tests do not use ids with leading zeros, numbers above 9007199254740991, numbers written with a decimal point or exponent, or text that is not valid UTF-8.

## Three example exchanges (one fresh database, in order)

```
POST /accounts
{"name":"ann"}
→ 201
{"id":1,"name":"ann","balance":0}

POST /accounts/1/deposit
{"amount":40}
→ 200
{"id":1,"name":"ann","balance":40}

GET /accounts?min=50
→ 200
{"accounts":[]}
```
