// fx.tape: a program (not a tool) that knows exchange rates, from US dollars, in hundredths. The convert tool may
// ask it, because the account's policy allows Remote fx; no tool may ask anything else.

schema "CREATE TABLE IF NOT EXISTS rates(currency TEXT PRIMARY KEY, per_hundred INTEGER NOT NULL)"
schema "INSERT OR IGNORE INTO rates VALUES ('EUR', 92), ('GBP', 79), ('JPY', 15300), ('USD', 100)"

type Pair { Pair(to: View) }
type Rate { Rate(per_hundred: Int) }

export fn rate(db: Sql, message: Pair) -> Result[Rate, View] {
  known(found: sql_first(
    row: Rate,
    query: "SELECT per_hundred FROM rates WHERE currency = :to",
    to: message.to
  ))
}

fn known(found: Option[Rate]) -> Result[Rate, View] {
  match found {
    Some(value) -> Ok(value)
    None -> Err(error: "no rate for that currency")
  }
}

invariant "a rate is more than nothing" {
  SELECT currency, per_hundred FROM rates WHERE per_hundred < 1
}
