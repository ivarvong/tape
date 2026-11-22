# Orders with payments

Build the order service of a shop. Charging the card is done by a separate Tape program, **payments**, which your
program reaches as another program (a capability named `payments`). Its method `charge`:

- takes `{"order_id": <int>, "amount_cents": <int>}`
- answers `{"payment_id": <int>}` when the card was charged,
- or refuses with a reason (for example `"card declined"`),
- or does not answer: it can be slow, down, or the network can drop the reply. Wait at most **2 seconds**.

payments charges at most once per command it is sent with the same idempotency key, so sending the same charge again
for the same order is safe and is the way to find out what happened.

## Endpoints

- `POST /orders` with `{"order_key": "cart-81f2", "amount_cents": 1999}` places an order and charges it.
  - `order_key` is chosen by the client (1 to 64 characters) and the client **retries** this request when it sees no
    answer: the same `order_key` must never make a second order or a second charge. A retry answers with the order as
    it is now (**200**).
  - `amount_cents` is an integer from 1 to 1000000; anything else, or a bad body: **400** `{"error": "..."}`.
  - Charged: **201** `{"id": 1, "order_key": "cart-81f2", "amount_cents": 1999, "state": "paid"}`.
  - Refused: **402** with the order, `"state": "failed"` and the reason in `"reason"`.
  - No answer in time: **202** with the order, `"state": "pending"`. The service keeps trying in the background
    (with the same idempotency key) until payments answers, and then the order becomes `paid` or `failed`.
    An order must never stay `pending` for ever.
- `GET /orders/{id}` answers **200** with the order (with `"reason"` when it failed), or **404**.
- Ids are integers given in order, starting at 1.

Every 4xx has a JSON body `{"error": "<a short reason>"}`. Any other route: **404**.

Note for testing: in the hosted `run` tool only one program runs, so every call to payments answers that it was
unreachable. Your program must still be written for all three outcomes.
