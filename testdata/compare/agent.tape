// agent.tape: an agent's tool loop. A run asks the model for its next step, runs the tool the model names, tells
// the model the result, and goes on until the model answers or five steps have gone by. A run's `state` is a
// machine:
//
//   thinking -> acting -> thinking ...;  thinking -> done (the model answered);  thinking -> gave_up (five steps)
//
// Each model call and each tool call is a command with its own key, AtStep(run, step), so a step sent again (after
// a reply that was lost) is answered from what the callee stored and nothing runs twice: an email is sent once.
// A tool that gave no answer is not a failed tool: the run stays in `acting` and the same call is sent again with
// the same key (POST /runs/<id>/advance, which a timer would send). Only a refusal is told to the model as an error.
//
//   POST /runs                 {"key":"k1","prompt":"mail"}
//   POST /runs/<id>/advance    carry the run on from where it is
//   GET  /runs/<id>

migration 1 "runs" {
  CREATE TABLE runs(
    id INTEGER PRIMARY KEY,
    client TEXT NOT NULL UNIQUE,
    prompt TEXT NOT NULL,
    step INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'thinking' CHECK (state IN ('thinking', 'acting', 'done', 'gave_up')),
    tool TEXT NOT NULL DEFAULT '',
    input TEXT NOT NULL DEFAULT '',
    last TEXT NOT NULL DEFAULT '',
    answer TEXT NOT NULL DEFAULT ''
  )
}

type RunState { Thinking Acting Done GaveUp }

machine runs.state: RunState {
  Thinking -> Acting
  Acting -> Thinking
  Thinking -> Done
  Thinking -> GaveUp
}

type Key = View where len(self) >= 1 and len(self) <= 64
type NewRun { NewRun(key: Key, prompt: View) }
type Run { Run(
  id: Int,
  prompt: View,
  step: Int,
  state: RunState,
  tool: View,
  input: View,
  last: View,
  answer: View
) }
type AtStep { AtStep(run: Int, step: Int) }
type Think { Think(prompt: View, step: Int, last: View) }
type Proposal { Proposed(tool: View, input: View, answer: View) }
type Use { Use(tool: View, input: View) }
type Used { Used(output: View) }

type Outcome {
  Shown(status: Int, run: Run)
  Problem(status: Int, reason: View)
}

fn handle(raw: View, db: Sql, model: Remote, tools: Remote) -> Response {
  routed(raw) |> rendered
}

// db, model and tools are the capabilities handle declares; the functions below use them by name (C72).
fn routed(raw: View) -> Outcome {
  match request(raw) {
    Request(method: Post, path: "/runs", body) -> {
      let Ok(value: NewRun(key, prompt)) = decode(json: body, as: NewRun) else {
        Err(error) -> Problem(status: 400, reason: error)
      }
      // the run this request made, or the one an earlier request with this key made, carried on from where it stands
      let Some(value: run) = sql_first(
        row: Run,
        query: "INSERT INTO runs(client, prompt) VALUES (:key, :prompt) ON CONFLICT(client) \
            DO NOTHING RETURNING *",
        key,
        prompt
      ) else {
        None -> {
          let Some(value: run) = sql_first(
            row: Run,
            query: "SELECT * FROM runs WHERE client = :key AND prompt = :prompt",
            key,
            prompt
          ) else -> Problem(
            status: 422,
            reason: "the key " ++ key ++ " was already used for another run"
          )
          advance(run)
        }
      }
      advance(run)
    }
    Request(method: Post, path: "/runs/" ++ decimal(id) ++ "/advance") -> {
      let Some(value: run) = load(id) else -> missing()
      advance(run)
    }
    Request(method: Get, path: "/runs/" ++ decimal(id)) -> show(status: 200, found: load(id))
    _ -> Problem(status: 404, reason: "no such route")
  }
}

fn load(id: Int) -> Option[Run] {
  sql_first(row: Run, query: "SELECT * FROM runs WHERE id = :id", id)
}

// The state names what to do next. The loop is this function calling itself (through `next`) with the row each
// step leaves; each turn is a commit point at its call.
fn advance(run: Run) -> Outcome {
  match run {
    Run(id, step, state: Thinking) if step >= 5 -> show(
      status: 200,
      found: latest(
        id,
        moved: sql_move(
          row: Run,
          query: "UPDATE runs SET state = 'gave_up' WHERE id = :id AND state = 'thinking' \
              RETURNING *",
          id
        )
      )
    )
    Run(id, prompt, step, last, state: Thinking) -> {
      let Ok(value: Proposed(tool, input, answer)) = call(
        to: model,
        method: "think",
        send: Think(prompt, step, last),
        reply: Proposal,
        within: 50,
        once: AtStep(run: id, step)
      ) else {
        Err(error: Rejected(reason)) -> Problem(
          status: 502,
          reason: "the model refused: " ++ reason
        )
        Err(error: Skew(reason)) -> Problem(status: 502, reason)
        Err(error) -> show(status: 202, found: load(id))
      }
      match {
        len(answer) > 0 -> show(
          status: 200,
          found: latest(
            id,
            moved: sql_move(
              row: Run,
              query: "UPDATE runs SET state = 'done', answer = :answer WHERE id = :id \
                  AND state = 'thinking' RETURNING *",
              answer,
              id
            )
          )
        )
        else -> next(found: latest(
          id,
          moved: sql_move(
            row: Run,
            query: "UPDATE runs SET state = 'acting', tool = :tool, input = :input \
                WHERE id = :id AND state = 'thinking' RETURNING *",
            tool,
            input,
            id
          )
        ))
      }
    }
    // The tool's result, or its refusal, is the model's to read at the next step. No answer is not a result: the
    // run stays in `acting`, to send the same call again.
    Run(id, step, tool, input, state: Acting) -> {
      let Ok(value: Used(output)) = call(
        to: tools,
        method: "tool",
        send: Use(tool, input),
        reply: Used,
        within: 50,
        once: AtStep(run: id, step)
      ) else {
        Err(error: Rejected(reason)) -> next(found: told(id, last: "error: " ++ reason))
        Err(error: Skew(reason)) -> Problem(status: 502, reason)
        Err(error) -> show(status: 202, found: load(id))
      }
      next(found: told(id, last: output))
    }
    Run(state: Done) -> Shown(status: 200, run)
    Run(state: GaveUp) -> Shown(status: 200, run)
  }
}

fn next(found: Option[Run]) -> Outcome {
  let Some(value: run) = found else -> missing()
  advance(run)
}

fn told(id: Int, last: View) -> Option[Run] {
  latest(
    id,
    moved: sql_move(
      row: Run,
      query: "UPDATE runs SET state = 'thinking', last = :last, step = step + 1 WHERE id = :id \
          AND state = 'acting' RETURNING *",
      last,
      id
    )
  )
}

fn latest(id: Int, moved: Move[Run]) -> Option[Run] {
  match moved {
    Moved(value) -> Some(value)
    Raced(now) -> Some(now)
    NoRow -> load(id)
  }
}

fn show(status: Int, found: Option[Run]) -> Outcome {
  let Some(value: run) = found else -> missing()
  Shown(status, run)
}

fn missing() -> Outcome {
  Problem(status: 404, reason: "no such run")
}

fn rendered(outcome: Outcome) -> Response {
  match outcome {
    Shown(status, run) -> write_json(out: buf(), value: run) |> respond(status)
    Problem(status, reason) -> buf()
      |> append(view: "{\"error\":")
      |> write_json_string(text: reason)
      |> append(view: "}")
      |> respond(status)
  }
}

// What must hold after every commit (checked by `tape sim` and by app.invariants() in the host).
invariant "a run takes five steps at most" {
  SELECT id, step FROM runs WHERE step > 5 OR step < 0
}

invariant "only a finished run has an answer" {
  SELECT id, state FROM runs WHERE answer <> '' AND state <> 'done'
}
