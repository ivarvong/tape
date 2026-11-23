# URL shortener

Build a link shortener.

## Endpoints

- `POST /links` with `{"url": "https://example.com/some/page"}` and optionally `"slug": "my-page"`.
  - `url` must start with `http://` or `https://` and be at most 2048 bytes: otherwise **400**.
  - `slug`, when given, is 3 to 32 characters of `a-z`, `A-Z`, `0-9`, `-`: otherwise **400**.
  - With no slug, the service makes one: 6 characters of `a-z`, `A-Z`, `0-9`. Shortening a URL that already has a
    generated slug answers that same slug (so a retried request makes no second link): **200**. A new link: **201**.
  - With a slug: a new slug answers **201**; the same slug with the same URL again (a retry) answers **200**; a slug
    already taken by a different URL is **409**.
  - The answer is `{"slug": "my-page", "url": "https://example.com/some/page"}`.
- `GET /{slug}` redirects: **302** with the URL in a `Location` header and as JSON in the body, `{"url": "..."}`.
  Each redirect counts one hit. Unknown slug: **404**.
- `GET /links/{slug}` answers **200** `{"slug": "...", "url": "...", "hits": 3}`, or **404**. It counts no hit.

Every 4xx has a JSON body `{"error": "<a short reason>"}`.
