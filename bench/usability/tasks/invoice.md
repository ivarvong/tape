# Invoices with tax

Build the invoicing endpoint of a billing system. Money must be exact: totals are what an accountant gets by hand.

## Money

- Amounts are **decimal strings**, never JSON numbers: `"19.99"`, `"0.05"`, `"1500"`.
- Currencies: `USD` and `EUR` have 2 decimal places (an amount may have 0, 1 or 2 decimals: `"3"`, `"1.5"`, `"1.50"`);
  `JPY` has 0 (no decimal point at all). More decimals than the currency has, a negative amount, or anything that is
  not a plain decimal number: **400**. A unit price is at most 100000000 in the currency's main unit.
- Every amount the service answers is written with exactly the currency's decimal places: `"60.02"`, `"3.00"`,
  `"0.13"`, `"1084"` (no thousands separators, no currency sign).

## Endpoints

- `POST /invoices` with

  ```json
  {"invoice_id": "inv-1", "currency": "USD", "tax_rate": "8.875",
   "lines": [{"description": "Widget", "quantity": 3, "unit_price": "19.99"},
             {"description": "Sticker", "quantity": 1, "unit_price": "0.05"}]}
  ```

  computes the invoice and stores it: **201**

  ```json
  {"invoice_id": "inv-1", "currency": "USD",
   "lines": [{"description": "Widget", "quantity": 3, "unit_price": "19.99", "line_total": "59.97"},
             {"description": "Sticker", "quantity": 1, "unit_price": "0.05", "line_total": "0.05"}],
   "subtotal": "60.02", "tax": "5.33", "total": "65.35"}
  ```

  - `line_total` = `quantity × unit_price`, exactly. `subtotal` = the sum of the line totals.
  - `tax_rate` is a percentage as a decimal string with at most 3 decimals, from `"0"` to `"100"`.
    `tax` = `subtotal × tax_rate / 100`, rounded once, to the currency's decimal places, **half away from zero**
    (60.02 × 8.875% = 5.326775 → `"5.33"`; 10.00 × 1.25% = 0.125 → `"0.13"`).
  - `total` = `subtotal + tax`.
  - `invoice_id` is 1 to 64 characters; `lines` has 1 to 100 lines; `description` 1 to 200 bytes; `quantity` an
    integer from 1 to 1000000. Anything else, an unknown currency, or a bad body: **400** `{"error": "..."}`.
  - The billing client retries: the same `invoice_id` again answers **200** with the invoice as first stored.
- `GET /invoices/{invoice_id}` answers **200** with the stored invoice, or **404** `{"error": "..."}`.

Any other route: **404**.
