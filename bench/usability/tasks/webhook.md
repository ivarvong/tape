# Webhook receiver

Our payment provider sends us webhooks. It delivers **at least once**: the same delivery can arrive two, three or
more times, sometimes minutes apart, and every copy carries the same `delivery_id`. Build the receiver, and keep a
running balance per merchant account from the events.

## Endpoint: `POST /webhooks`

Body:

```json
{"delivery_id": "evt_123", "type": "payment.succeeded", "account": "acme", "amount": 2500}
```

- `delivery_id`: 1 to 64 characters. `account`: 1 to 64 characters. `amount`: integer cents, 1 to 100000000.
- `type` is one of `payment.succeeded` (adds `amount` to the account's balance) and `payment.refunded` (subtracts it;
  a balance may go negative).
- The first time a `delivery_id` is seen, the event is applied: **200** `{"status": "processed"}`.
- Any later delivery with that `delivery_id` (whatever its body) changes nothing: **200** `{"status": "duplicate"}`.
- A well-formed event whose `type` is anything else is recorded but changes no balance: **200**
  `{"status": "ignored"}` (a later copy of it is a `duplicate`).
- A body that is not JSON, or misses a field, or has a field out of range: **400** `{"error": "<a short reason>"}`.
  The provider will not resend a 400.

## Endpoint: `GET /accounts/{account}`

**200** `{"account": "acme", "balance": 2500, "events": 1}` where `events` is how many succeeded or refunded events
were applied to it. An account no applied event has named: **404** `{"error": "..."}`.

Any other route: **404**.
