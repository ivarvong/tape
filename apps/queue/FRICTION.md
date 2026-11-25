# Friction log: writing a job queue in Tape

Written while building `apps/queue/queue.tape` on 19 November 2026, with `LANGUAGE.md` as the only reference
(written the same day). The writer also works on the compiler, so this is not a cold read: it measures the
language and the definition, not how a newcomer fares. Entries are in the order they happened. Each says what
happened, its class, and what was done.

The program is 250 lines. It compiled on the fifth try; the four refusals are entries 1 to 4. Entries 5 and 6
were found after it compiled, by the test and by the simulator.

| # | What | Class | Resolution |
|---|---|---|---|
| 1 | `fn or_int(given: Option[Int], otherwise: Int)` called with an `Option[Delay]`: C14, "should be Option[Int] but is Option[Delay]". A refined type is its base type everywhere except inside another type's brackets. | missing feature | **fixed 25 November 2026** (issue #20): `Option[Delay]` stands where `Option[Int]` is asked, and std has `value_or(given:, otherwise:)`; `delay_of` and `most_of` are gone |
| 2 | The lease as one statement, `UPDATE … WHERE id = (SELECT id … ORDER BY run_at LIMIT 1) AND state = 'ready'`: C63, sql_move names its row by `column = value` only. | true positive | choose the job with a SELECT, then `sql_move` it by id. The refusal is right: with a subquery, "nothing was due" and "another run took it" cannot be told apart |
| 3 | `Raced(now: Job(state: "done", attempts)) if … -> Shown(status: 200, job: now)`: C16, unknown name `now`. A field given a pattern binds what the pattern binds, not the field. | compile error (mine) | `Raced(now: job = Job(…))`. The same mistake is in the tickets log twice; LANGUAGE.md section 5 has the form (`name = P`) but not the mistake |
| 4 | Extending a lease with `sql_first(… UPDATE jobs SET lease_until = ?3 WHERE id = ?1 AND state = 'leased' AND attempts = ?2 RETURNING *)`: C62, a compare-and-set through sql_first answers None both for a lost race and for no row. | true positive | `sql_move`, which made me write the two answers (409 and 404) |
| 5 | **A bug in `sql_move`.** With `WHERE id = ?1 AND state = 'leased' AND attempts = ?2`, an ack from an attempt that had lost the lease was answered `NoRow` (404, "no such job") for a job that was there. The planner read every `column = value` that is not the state as part of the row's key, so the re-read looked for a job with that id *and* that attempt. | bug (compiler) | **fixed** (`rules.ts`, movePlan): only the columns of the primary key or a UNIQUE set name the row; any other condition failing is `Raced(now)`. Found by `test/queue.ts`, which expected 409 |
| 6 | **A bug in my design.** `POST /jobs/<id>/retry` set `attempts` back to 0. Attempt numbers are what ack and nack name a lease by, so after a redrive an old ack for "attempt 1" would have finished the new attempt 1. No rule or invariant of mine said so. | bug (mine) | `tape sim` printed it under "sent again": a nack sent a second time changed a row. Attempts now only count up; a redrive gives five more tries. The invariants could not have caught it: nothing in one state of the rows is wrong, only in what an old message means |
| 7 | Nothing refuses a lease that is not idempotent. Before I added the lease key, a `POST /lease` sent twice took two jobs. C55 asks an INSERT for a key; an UPDATE that claims *a different row each time it runs* passes every rule (its compare-and-set is on the row it found). | missing rule | **open**. I added the key because I knew to. The simulator's "sent again" note would show it, as a note, not a failure |
| 8 | The simulator did not find a planted off-by-one (`attempt > most` for `>=`) in 200 runs: it needs a job leased, failed and leased again after its wait, and requests rarely line up that way. The invariant that would catch it is declared; the run that breaks it was not made. | weak check | **open**, recorded in `proof/sim-invariants.ts` |
| 9 | `invariant` cannot say "at most one": I wanted "no lease key holds two jobs" and wrote `GROUP BY lease HAVING count(*) > 1`, which the checker took. A UNIQUE partial index (`WHERE lease <> ''`) would make the database hold it; it compiles, and I left it out because I have not checked that the rules read a partial index as partial (C55 and sql_move count UNIQUE sets as keys). | not settled | **open**: say in LANGUAGE.md what SQL the checker reads, and test a partial index against the rules |

## What went well

- The definition's worked program was enough to write from. Decode, `let … else`, `sql_move`, `do wake` and
  `woken` went down as written there, and none of the four refusals was about those forms.
- C62 and C63 (entries 2 and 4) made the program better: both forced the "lost race" answer to be written.
- C77 refused the queue with its lease timer taken out, naming the write and why nothing comes back for it.
- The settled invariant "no job is left leased" took one line and is the property the whole design is for.
- The simulator reached all nine paths and all four states with nothing written for it.

## What this says about the language

Two of the nine entries are bugs the *language's own tools* had or missed (5 and 7), and one more is a real
mistake only a note caught (6). The rules are strongest on a single statement and weakest on what a message
means over time: which lease an attempt number names, whether a request claims the same row twice. That is where
the next rule or the next simulator check belongs.
