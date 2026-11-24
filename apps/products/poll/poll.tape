// poll.tape: make a poll, vote once per voter key, read the results as a page with bars or as JSON.
//
//   GET  /                          the latest polls
//   POST /polls                     {"key","question","options":[…]}: 2 to 8 options. 201 {"id",…}; the same key
//                                   again answers the poll it made (200)
//   GET  /polls/<id>                the results as a page, with a form to vote
//   GET  /polls/<id>.json           {"id","question","total","options":[{"option","label","votes"}]}
//   POST /polls/<id>/votes          {"voter","option"} (JSON), or the page's form: 201 counted; 200 when this
//                                   voter has voted already (the vote it gave stands); 404 no such option
//
// A vote claims its (poll, voter) row first; a second run of the same vote, or another vote by the same voter,
// stops at the claim, so a count is moved once per voter. The page's form carries a voter key drawn when the
// page is made: posting that form again (a reload, a double click) is the same vote.

migration 1 "polls" {
  CREATE TABLE polls(
    id INTEGER PRIMARY KEY,
    client TEXT NOT NULL UNIQUE,
    question TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  CREATE TABLE options(
    poll INTEGER NOT NULL REFERENCES polls(id),
    idx INTEGER NOT NULL,
    label TEXT NOT NULL,
    votes INTEGER NOT NULL DEFAULT 0 CHECK (votes >= 0),
    PRIMARY KEY (poll, idx)
  ) WITHOUT ROWID;
  CREATE TABLE votes(
    poll INTEGER NOT NULL,
    voter TEXT NOT NULL,
    idx INTEGER NOT NULL,
    PRIMARY KEY (poll, voter)
  ) WITHOUT ROWID
}

invariant "an option's count is the number of votes for it" {
  SELECT o.poll, o.idx FROM options AS o
    WHERE o.votes <> (SELECT count(*) FROM votes AS v WHERE v.poll = o.poll AND v.idx = o.idx)
}

invariant "every vote is for an option of its poll" {
  SELECT v.poll, v.voter FROM votes AS v
    WHERE NOT EXISTS (SELECT 1 FROM options AS o WHERE o.poll = v.poll AND o.idx = v.idx)
}

type Key = View where len(self) >= 1 and len(self) <= 64 else "1 to 64 bytes"
type Question = View where char_count(v: self) >= 1 and char_count(v: self) <= 200
type Label = View where char_count(v: self) >= 1 and char_count(v: self) <= 80
type NewPoll { NewPoll(key: Key, question: Question, options: List[Label]) }
type Vote { Vote(voter: Key, option: Int) }

type Poll { Poll(id: Int, question: View, created: Int) }
type Tally { Tally(option: Int, label: View, votes: Int) }
type Results { Results(id: Int, question: View, total: Int, options: List[Tally]) }
type Counted { Counted(poll: Int, option: Int, counted: Bool) }
type Problem { Problem(error: View) }
type Choice { Choice(idx: Int) }

type Outcome {
  Made(status: Int, poll: Poll)
  Voted(status: Int, vote: Counted)
  Failed(status: Int, error: View)
}

fn handle(raw: View, db: Sql, clock: Clock, dice: Entropy) -> Buf {
  let r = request(raw)
  match r {
    Request(method: "GET", path: "/") -> home()
    Request(method: "POST", path: "/polls", body) -> made(body) |> rendered
    Request(
      method: "GET",
      path: "/polls/" ++ decimal(id) ++ ".json"
    ) -> json_results(found: results(id))
    Request(method: "GET", path: "/polls/" ++ decimal(id)) -> page(found: results(id), note: "")
    Request(
      method: "POST",
      path: "/polls/" ++ decimal(id) ++ "/votes",
      body
    ) -> voted(id, body, form: is_form(r))
    _ -> rendered(outcome: Failed(status: 404, error: "no such route"))
  }
}

fn is_form(r: Request) -> Bool {
  match header_of(request: r, name: "content-type") {
    Some(value: "application/x-www-form-urlencoded" ++ _) -> True
    _ -> False
  }
}

// a vote from JSON, or from the page's form (voter=…&option=…), checked the same way: the form is written as the
// JSON it stands for, and decoded
fn vote_of(body: View, form: Bool) -> Result[Vote, View] {
  match form {
    True -> decode(json: form_json(form: body), as: Vote)
    False -> decode(json: body, as: Vote)
  }
}

fn form_json(form: View) -> View {
  let voter = match form_field(body: form, name: "voter") {
    Some(value) -> value
    None -> ""
  }
  let option = match form_field(body: form, name: "option") {
    Some(value: decimal(n)) -> n
    _ -> -1
  }
  freeze(buf: buf() |> append(view: "{\"voter\":") |> write_json_string(text: voter) |> append(
    view: ",\"option\":\(option)}"
  ))
}

fn made(body: View) -> Outcome {
  let Ok(value: NewPoll(key, question, options)) = decode(json: body, as: NewPoll) else {
    Err(error) -> Failed(status: 400, error)
  }
  let n = length(list: options)
  let True = n >= 2 and n <= 8 else -> Failed(status: 400, error: "options: 2 to 8, this has \(n)")
  let Some(value: poll) = sql_first(
    row: Poll,
    query: "INSERT INTO polls(client, question, created) VALUES (:key, :question, :at) \
        ON CONFLICT(client) DO NOTHING RETURNING *",
    key,
    question,
    at: now()
  ) else -> again(
    found: sql_first(row: Poll, query: "SELECT * FROM polls WHERE client = :key", key)
  )
  do add_options(poll: poll.id, options, idx: 0)
  Made(status: 201, poll)
}

fn again(found: Option[Poll]) -> Outcome {
  match found {
    Some(value) -> Made(status: 200, poll: value)
    None -> Failed(status: 500, error: "the poll is gone")
  }
}

// each option, numbered from 0; the claim of the poll's key above makes these run once
fn add_options(poll: Int, options: List[Label], idx: Int) -> Int {
  match options {
    Cons(head, tail) -> sql_exec(
      query: "INSERT INTO options(poll, idx, label) VALUES (:poll, :idx, :head)",
      poll,
      idx,
      head
    ) + add_options(
      poll,
      options: tail,
      idx: idx + 1
    )
    Nil -> 0
  }
}

// a vote answers JSON; from the page's form it answers 303 to the page, which shows the count
fn voted(id: Int, body: View, form: Bool) -> Buf {
  let Ok(value: Vote(voter, option)) = vote_of(body, form) else {
    Err(error) -> answer(id, form, outcome: Failed(status: 400, error))
  }
  let 1 = sql_exec(
    query: "INSERT INTO votes(poll, voter, idx) VALUES (:id, :voter, :option) \
        ON CONFLICT(poll, voter) DO NOTHING",
    id,
    voter,
    option
  ) else -> answer(
    id,
    form,
    outcome: already(id, voter)
  )
  let 1 = sql_exec(
    query: "UPDATE options SET votes = votes + 1 WHERE poll = :id AND idx = :option",
    id,
    option
  ) else -> rollback(out: answer(
    id,
    form,
    outcome: Failed(status: 404, error: "poll \(id) has no option \(option)")
  ))
  answer(id, form, outcome: Voted(status: 201, vote: Counted(poll: id, option, counted: True)))
}

fn answer(id: Int, form: Bool, outcome: Outcome) -> Buf {
  match outcome {
    Voted if form -> respond(status: 303) |> header(name: "location", value: "../\(id)")
    _ -> rendered(outcome)
  }
}

fn already(id: Int, voter: View) -> Outcome {
  match sql_first(
    row: Choice,
    query: "SELECT idx FROM votes WHERE poll = :id AND voter = :voter",
    id,
    voter
  ) {
    Some(value: Choice(idx)) -> Voted(
      status: 200,
      vote: Counted(poll: id, option: idx, counted: False)
    )
    None -> Failed(status: 500, error: "the vote is gone")
  }
}

fn results(id: Int) -> Option[Results] {
  let Some(value: Poll(question)) = sql_first(
    row: Poll,
    query: "SELECT * FROM polls WHERE id = :id",
    id
  ) else -> None
  let tallies = listed(rows: sql_all(
    row: Tally,
    query: "SELECT idx AS option, label, votes FROM options WHERE poll = :id ORDER BY idx",
    id
  ))
  let total = fold(list: tallies, from: 0, by: fn(sum: Int, t: Tally) -> Int { sum + t.votes })
  Some(value: Results(id, question, total, options: tallies))
}

fn listed(rows: Rows[Tally]) -> List[Tally] {
  match next(rows) {
    Next(value, rest) -> Cons(head: value, tail: listed(rows: rest))
    End -> Nil
  }
}

fn json_results(found: Option[Results]) -> Buf {
  match found {
    Some(value) -> respond_as(status: 200, content: Json)
      |> header(name: "cache-control", value: "no-store")
      |> write_json(value)
    None -> rendered(outcome: Failed(status: 404, error: "no such poll"))
  }
}

fn rendered(outcome: Outcome) -> Buf {
  match outcome {
    Made(status, poll) -> respond_as(status, content: Json)
      |> header(name: "location", value: "polls/\(poll.id)")
      |> write_json(value: poll)
    Voted(status, vote) -> respond_as(status, content: Json) |> write_json(value: vote)
    Failed(status, error) -> respond_as(status, content: Json) |> write_json(value: Problem(error))
  }
}

fn page(found: Option[Results], note: View) -> Buf {
  match found {
    Some(value: Results(id, question, total, options)) -> {
      let voter = voter_key(n: random())
      let out = shell(status: 200, title: question)
        |> append(view: "<p class=meta>poll \(id) · \(total) ")
        |> append(view: plural(n: total, one: "vote", many: "votes"))
        |> append(view: " · <a href=\"\(id).json\">JSON</a></p><ol class=bars>")
      fold(list: options, from: out, by: fn(o: Buf, t: Tally) -> Buf { bar(out: o, t, total) })
        |> append(
          view: "</ol><form method=post action=\"\(id)/votes\"><fieldset><legend>Vote</legend>"
        )
        |> append(view: "<input type=hidden name=voter value=\"\(voter)\">")
        |> radios(options, at: 0)
        |> append(view: "<button>Vote</button></fieldset></form>")
        |> append(view: "<p class=meta>Or: <code>curl -H 'content-type: application/json' -d ")
        |> append(view: "'{\"voter\":\"you\",\"option\":0}' …/polls/\(id)/votes</code></p>")
        |> foot
    }
    None -> shell(status: 404, title: "no such poll")
      |> append(view: "<p><a href=\"../\">All polls</a></p>")
      |> foot
  }
}

fn radios(out: Buf, options: List[Tally], at: Int) -> Buf {
  match options {
    Cons(head: Tally(option, label), tail) -> out
      |> append(view: "<label><input type=radio name=option value=\"\(option)\"")
      |> append(view: checked(at))
      |> append(view: "> ")
      |> write_html(text: label)
      |> append(view: "</label>")
      |> radios(options: tail, at: at + 1)
    Nil -> out
  }
}

fn checked(at: Int) -> View {
  match at {
    0 -> " checked"
    _ -> ""
  }
}

fn bar(out: Buf, t: Tally, total: Int) -> Buf {
  let share = percent(part: t.votes, whole: total)
  out
    |> append(view: "<li><div class=row><span>")
    |> write_html(text: t.label)
    |> append(view: "</span><span class=n>\(t.votes) · \(share)%</span></div>")
    |> append(view: "<div class=track><div class=fill style=\"width:\(share)%\"></div></div></li>")
}

// a share in percent, to one place, rounded half to even; 0.0 of nothing
//
//   > percent(part: 1, whole: 3)
//   33.3
//   > percent(part: 2, whole: 3)
//   66.7
//   > percent(part: 0, whole: 0)
//   0.0
fn percent(part: Int, whole: Int) -> Dec[1] {
  match whole {
    0 -> 0.0
    _ -> div(a: dec(n: part * 100, scale: 1), by: whole, scale: 1, rounding: HalfEven)
  }
}

fn plural(n: Int, one: View, many: View) -> View {
  match n {
    1 -> one
    _ -> many
  }
}

// a voter key for the page's form: 12 letters drawn from 53 random bits
//
//   > voter_key(n: 0)
//   "v-aaaaaaaaaa"
fn voter_key(n: Int) -> View {
  freeze(buf: letters(out: buf() |> append(view: "v-"), n, left: 10))
}

fn letters(out: Buf, n: Int, left: Int) -> Buf {
  match {
    left <= 0 -> out
    else -> letters(out: out |> push(byte: 97 + n % 26), n: n / 26, left: left - 1)
  }
}

fn home() -> Buf {
  let out = shell(status: 200, title: "polls")
    |> append(view: "<p>Make a poll with a JSON POST; vote once per voter key. A vote claims its \
        voter's row ")
    |> append(view: "first, so a vote sent twice is counted once.</p>")
    |> append(view: "<pre>curl -H 'content-type: application/json' \\\n  -d '{\"key\":\"lunch-1\",")
    |> append(view: "\"question\":\"Lunch?\",\"options\":[\"tacos\",\"pho\"]}' \\\n")
    |> append(view: "  https://tape.ivar.workers.dev/p/demo/poll/polls</pre><h2>Latest</h2><ul>")
  listed_polls(
    out,
    rows: sql_all(row: Poll, query: "SELECT * FROM polls ORDER BY id DESC LIMIT 20")
  )
    |> append(view: "</ul>")
    |> foot
}

fn listed_polls(out: Buf, rows: Rows[Poll]) -> Buf {
  match next(rows) {
    Next(value: Poll(id, question), rest) -> out
      |> append(view: "<li><a href=\"polls/\(id)\">")
      |> write_html(text: question)
      |> append(view: "</a></li>")
      |> listed_polls(rows: rest)
    End -> out
  }
}

fn shell(status: Int, title: View) -> Buf {
  respond_as(status, content: Html)
    |> header(name: "cache-control", value: "no-store")
    |> append(view: "<!doctype html><html lang=en><meta charset=utf-8>")
    |> append(view: "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>")
    |> write_html(text: title)
    |> append(view: "</title><style>")
    |> append(view: ":root{color-scheme:light dark;--fg:#1d1d1f;--bg:#fbfbf8;--mute:#6b6b6b;")
    |> append(
      view: "--box:#ecebe5;--bar:#2f6f5e}@media (prefers-color-scheme:dark){:root{--fg:#e8e6e1;"
    )
    |> append(view: "--bg:#151514;--mute:#9a978f;--box:#2a2a26;--bar:#6fc2a8}}body{margin:0 auto;")
    |> append(view: "max-width:720px;padding:24px 16px;background:var(--bg);color:var(--fg);")
    |> append(view: "font:16px/1.5 system-ui,sans-serif}h1{font-size:22px;margin:0 0 4px}")
    |> append(view: "h2{font-size:16px;margin-top:28px}.meta{color:var(--mute);font-size:14px}")
    |> append(
      view: "a{color:inherit}.bars{list-style:none;padding:0;margin:20px 0}.bars li{margin:12px 0}"
    )
    |> append(
      view: ".row{display:flex;justify-content:space-between;gap:12px}.n{color:var(--mute);"
    )
    |> append(view: "font-variant-numeric:tabular-nums;white-space:nowrap}.track{height:10px;")
    |> append(view: "background:var(--box);border-radius:5px;overflow:hidden;margin-top:4px}")
    |> append(view: ".fill{height:100%;background:var(--bar)}fieldset{border:1px solid var(--box);")
    |> append(view: "border-radius:8px;padding:12px 14px}label{display:block;margin:4px 0}")
    |> append(
      view: "button{margin-top:8px;font:inherit;padding:4px 14px}pre{background:var(--box);"
    )
    |> append(
      view: "padding:12px 14px;border-radius:8px;overflow-x:auto;font:13px/1.45 ui-monospace,"
    )
    |> append(view: "monospace}code{font:13px ui-monospace,monospace;word-break:break-all}")
    |> append(view: "footer{margin-top:32px;color:var(--mute);font-size:13px}</style><h1>")
    |> write_html(text: title)
    |> append(view: "</h1>")
}

fn foot(out: Buf) -> Buf {
  out
    |> append(view: "<footer>A small program written in <a href=\"/\">Tape</a> · <a \
        href=\"https://github.com/ivarvong/tape/blob/main/apps/products/poll/poll.tape\">source</a></footer></html>")
}
