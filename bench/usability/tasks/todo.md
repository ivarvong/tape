# Todo API

Build the backend for a small todo list. One list for the whole service (no users).

## Endpoints

- `POST /todos` with `{"title": "Buy milk"}` creates a todo and answers **201** with the todo:
  `{"id": 1, "title": "Buy milk", "done": false}`. Ids are integers given in creation order, starting at 1.
  Two POSTs with the same title make two todos: clients do not retry this call.
- `GET /todos` answers **200** with a JSON array of every todo, in id order (`[]` when there are none).
- `GET /todos?done=true` / `GET /todos?done=false` answers only the todos with that `done` value, in id order.
  Any other value of `done` is a **400**.
- `GET /todos/{id}` answers **200** with the todo, or **404** if there is no such todo (a non-numeric id is a 404 too).
- `PATCH /todos/{id}` with any of `{"title": "...", "done": true}` changes the fields given and answers **200** with
  the whole todo. A body with neither field is a **400**. No such todo: **404**.
- `DELETE /todos/{id}` answers **204** with an empty body. No such todo: **404**.

## Validation

- `title` is a string of 1 to 100 bytes. Missing, empty, too long, or not a string: **400**.
- `done` is a boolean.
- A body that is not JSON, or a JSON value that is not an object: **400**.
- Every 400 and 404 has a JSON body `{"error": "<a short reason>"}`.
- Any route not listed: **404**.
