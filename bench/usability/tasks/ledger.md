# Bank ledger

Build the ledger behind a small payments product: accounts with balances in integer cents, and transfers between
them. Clients are mobile apps on bad networks: **they retry every write** when they do not see an answer, so a
retried request must never apply twice.

## Endpoints

- `POST /accounts` with `{"id": "alice", "balance": 10000}` opens an account and answers **201** with
  `{"id": "alice", "balance": 10000}`. `id` is 1 to 32 characters of `a-z`, `0-9`, `-`; `balance` is an integer
  from 0 to 1000000000. Sending the same request again (a retry) answers **200** with the account as it is now and
  changes nothing. Opening an id that already exists with a different balance: **409**.
- `GET /accounts/{id}` answers **200** with `{"id": "alice", "balance": 7000}`, or **404**.
- `POST /transfers` with `{"transfer_id": "t-1", "from": "alice", "to": "bob", "amount": 3000}` moves `amount`
  cents from one account to the other, atomically, and answers **201** with
  `{"transfer_id": "t-1", "from": "alice", "to": "bob", "amount": 3000, "status": "completed"}`.
  - `transfer_id` is chosen by the client (1 to 64 characters). A retry with the same `transfer_id` and the same
    body answers **200** with the same transfer and moves no money.
  - The same `transfer_id` with a different body: **409**.
  - `amount` must be an integer from 1 to 1000000000, and `from` and `to` must differ: otherwise **400**.
  - An account that does not exist: **404**.
  - Not enough money in `from` (balances never go below 0): **409** with `{"error": "insufficient funds"}`, and
    nothing moves.
- `GET /transfers/{transfer_id}` answers **200** with the transfer as above, or **404**.

Every 4xx has a JSON body `{"error": "<a short reason>"}`. A body that is not valid JSON, or is missing a field: **400**.
