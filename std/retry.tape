// std/retry.tape: when to try again, as a library on top of one capability. backoff is pure arithmetic;
// retry_later also sets a timer (wake, which needs Timer), so the host calls the program's `woken` with
// Wake(key) when the time comes. Nothing here is syntax, and a program that never calls it sets no timers.

// How long to wait after each failure in a row: `first` ms after the first, `factor` times longer after each one
// after that, never longer than `most` ms; and how many attempts in all, the first one included.
type Backoff {
  Backoff(first: Int, factor: Int, most: Int, tries: Int)
}

// What to do after a failure: try again in `after` ms (that will be attempt number `attempt`), or stop, because
// all `tries` attempts have failed. GaveUp is final: backoff gives it again for as many failures or more, so a
// row a program gives up on waits for a request (C79).
type Retry {
  RetryIn(after: Int, attempt: Int)
  GaveUp(tries: Int) final
}

// After `failed` failures in a row (1 after the first), what to do. The same answer every time.
//   > backoff(policy: Backoff(first: 1000, factor: 2, most: 30000, tries: 5), failed: 1)
//   RetryIn(after: 1000, attempt: 2)
//   > backoff(policy: Backoff(first: 1000, factor: 2, most: 30000, tries: 5), failed: 3)
//   RetryIn(after: 4000, attempt: 4)
//   > backoff(policy: Backoff(first: 1000, factor: 3, most: 5000, tries: 9), failed: 4)
//   RetryIn(after: 5000, attempt: 5)
//   > backoff(policy: Backoff(first: 1000, factor: 2, most: 30000, tries: 5), failed: 5)
//   GaveUp(tries: 5)
fn backoff(policy: Backoff, failed: Int) -> Retry {
  let Backoff(first, factor, most, tries) = policy
  match {
    failed >= tries -> GaveUp(tries)
    else -> RetryIn(
      after: capped(wait: grown(wait: first, factor, most, times: failed - 1), most),
      attempt: failed + 1
    )
  }
}

// `wait`, `times` times multiplied by `factor`, stopping once it reaches `most`.
//   > grown(wait: 10, factor: 2, most: 1000, times: 3)
//   80
fn grown(wait: Int, factor: Int, most: Int, times: Int) -> Int {
  match {
    times <= 0 or wait >= most -> wait
    else -> grown(wait: wait * factor, factor, most, times: times - 1)
  }
}

// The smaller of the two: a wait never longer than `most`.
//   > capped(wait: 7000, most: 5000)
//   5000
fn capped(wait: Int, most: Int) -> Int {
  match {
    wait > most -> most
    else -> wait
  }
}

// backoff, and when it says to try again, a timer for then: `woken` gets Wake(key) that many ms from now. The
// key names what to retry (an order's id, say); setting it again moves its time, so a key is retried once.
fn retry_later(timer: Timer, key: Int, policy: Backoff, failed: Int) -> Retry {
  retry_at(timer, key, decided: backoff(policy, failed))
}

// retry_later, once backoff has decided.
private fn retry_at(timer: Timer, key: Int, decided: Retry) -> Retry {
  match decided {
    RetryIn(after, attempt) -> RetryIn(after: wake(timer, after, key), attempt)
    GaveUp(tries) -> GaveUp(tries)
  }
}
