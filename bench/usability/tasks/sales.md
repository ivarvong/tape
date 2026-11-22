# Sales report

Build a service that records sales and answers a summary report as JSON or CSV (the CSV is opened in spreadsheets
by the finance team).

## Endpoints

- `POST /sales` with
  `{"sale_id": "s-1001", "region": "emea", "product": "widget", "quantity": 3, "unit_price_cents": 250}`
  records a sale: **201** `{"sale_id": "s-1001"}`. The point-of-sale clients retry: the same `sale_id` again
  records nothing and answers **200** `{"sale_id": "s-1001"}`.
  - `sale_id` 1 to 64 characters; `region` and `product` 1 to 32 characters of `a-z`, `0-9`, `-`; `quantity` an
    integer from 1 to 10000; `unit_price_cents` an integer from 0 to 10000000. Anything else, or a bad body:
    **400** `{"error": "..."}`.
- `GET /report` answers **200** with one row per region that has sales, sorted by region name (byte order):
  `orders` is the number of sales, `units` the sum of quantities, `revenue_cents` the sum of
  `quantity × unit_price_cents`.
  - `format=json` (the default when `format` is not given): a JSON array,
    `[{"region": "amer", "orders": 2, "units": 5, "revenue_cents": 1250}, ...]` (`[]` when there are no sales).
  - `format=csv`: text, a header line then one line per region, every line ending in `\n`:

    ```
    region,orders,units,revenue_cents
    amer,2,5,1250
    emea,1,3,750
    ```

  - `region=<name>` limits the report to that region (an empty report if it has no sales).
  - `group=product` makes one row per (region, product) pair instead, sorted by region then product, with a
    `product` field (JSON) or column (CSV, `region,product,orders,units,revenue_cents`).
  - Any other `format` or `group` value: **400** `{"error": "..."}`. Parameters can come in any order.

Any other route: **404**.
