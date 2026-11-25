// std/time.tape: an instant, milliseconds since 1970-01-01T00:00:00Z as `now()` gives it, as a date and a time of
// day in UTC. Each function takes the instant as an argument and needs no capability: the clock is read once,
// with `now()`, and what is shown of it is computed. The calendar is the proleptic Gregorian one, with no leap
// seconds (a day is 86,400,000 ms), as JavaScript's Date and Unix time count. Every Int is an instant, before 1970
// too: the days are counted by Howard Hinnant's civil_from_days, a few operations and no loop over the years.

// An instant in UTC, by its parts: `month` 1 to 12, `day` 1 to 31, `hour` 0 to 23, `minute` and `second` 0 to 59,
// `millisecond` 0 to 999. `year` is astronomical: the year before 1 is 0, and before that -1.
type Civil {
  Civil(year: Int, month: Int, day: Int, hour: Int, minute: Int, second: Int, millisecond: Int)
}

// The date and time of day in UTC of an instant, milliseconds since 1970. For every Int: an instant before 1970
// is negative, and its parts count forward from the start of its day as any other's (-1 is 1969-12-31 at
// 23:59:59.999); the least Int is in the year -292275055 and the largest in 292278994. It loops over nothing,
// so it costs no steps.
//
//   > civil(ms: 0)
//   Civil(year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0)
//   > civil(ms: 1795615387123)
//   Civil(year: 2026, month: 11, day: 25, hour: 14, minute: 3, second: 7, millisecond: 123)
//   > civil(ms: 951782400000)
//   Civil(year: 2000, month: 2, day: 29, hour: 0)
//   > civil(ms: -1)
//   Civil(year: 1969, month: 12, day: 31, hour: 23, minute: 59, second: 59, millisecond: 999)
//   > civil(ms: -62198755200000).year
//   -1
fn civil(ms: Int) -> Civil {
  let rest = ms % 86400000
  let in_day = match {
    rest < 0 -> rest + 86400000
    else -> rest
  }
  let days = ms / 86400000 - match {
    rest < 0 -> 1
    else -> 0
  }
  // civil_from_days: eras of 400 years (146,097 days) from 0000-03-01, so a leap day ends its year
  let z = days + 719468
  let era = (z - match {
    z < 0 -> 146096
    else -> 0
  }) / 146097
  let doe = z - era * 146097
  let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
  let mp = (5 * doy + 2) / 153
  let month = match {
    mp < 10 -> mp + 3
    else -> mp - 9
  }
  let year = yoe + era * 400 + match {
    month <= 2 -> 1
    else -> 0
  }
  let day = doy - (153 * mp + 2) / 5 + 1
  let hour = in_day / 3600000
  let minute = in_day / 60000 % 60
  let second = in_day / 1000 % 60
  Civil(year, month, day, hour, minute, second, millisecond: in_day % 1000)
}

// An instant as RFC 3339 text in UTC, `2026-11-25T14:03:07.123Z`: always the three digits of its milliseconds and
// `Z`, so every one is 24 bytes from 0000 to 9999 and they sort as text in the order of time. For JSON, Atom feeds
// and logs. RFC 3339 has years 0000 to 9999 only, from -62167219200000 to 253402300799999; outside them the year is
// ISO 8601's expanded one, a sign and at least six digits (`+010000-01-01T00:00:00.000Z`), as JavaScript's
// toISOString writes it. Its steps are its numbers' digits, one each as a hole writes them: 20 for 2026.
//
//   > rfc3339(ms: 1795615387123)
//   "2026-11-25T14:03:07.123Z"
//   > rfc3339(ms: 0)
//   "1970-01-01T00:00:00.000Z"
//   > rfc3339(ms: -1)
//   "1969-12-31T23:59:59.999Z"
//   > rfc3339(ms: 253402300800000)
//   "+010000-01-01T00:00:00.000Z"
//   > rfc3339(ms: -62198755200000)
//   "-000001-01-01T00:00:00.000Z"
fn rfc3339(ms: Int) -> View {
  let Civil(year, month, day, hour, minute, second, millisecond) = civil(ms)
  let y = iso_year(year)
  let mo = two_digit(n: month)
  let d = two_digit(n: day)
  let h = two_digit(n: hour)
  let mi = two_digit(n: minute)
  let s = two_digit(n: second)
  let f = three_digit(n: millisecond)
  "\(y)-\(mo)-\(d)T\(h):\(mi):\(s).\(f)Z"
}

// An instant as an HTTP date (RFC 9110 section 5.6.7, IMF-fixdate), `Wed, 25 Nov 2026 14:03:07 GMT`: for the
// date, last-modified, expires and retry-after headers. The milliseconds are dropped: the second it falls in. The
// same text as JavaScript's toUTCString. An HTTP date has years 0000 to 9999 only; outside them the year is written
// as toUTCString writes it, its digits after a `-` for a year before 0 (`-0001`), and a header should not be sent
// with one. Its steps are its numbers' digits, one each as a hole writes them: 16 for 2026.
//
//   > http_date(ms: 1795615387123)
//   "Wed, 25 Nov 2026 14:03:07 GMT"
//   > http_date(ms: 784111777000)
//   "Sun, 06 Nov 1994 08:49:37 GMT"
//   > http_date(ms: -1)
//   "Wed, 31 Dec 1969 23:59:59 GMT"
fn http_date(ms: Int) -> View {
  let Civil(year, month, day, hour, minute, second) = civil(ms)
  let w = weekday_name(day: weekday(ms))
  let d = two_digit(n: day)
  let mo = month_name(month)
  let y = http_year(year)
  let h = two_digit(n: hour)
  let mi = two_digit(n: minute)
  let s = two_digit(n: second)
  "\(w), \(d) \(mo) \(y) \(h):\(mi):\(s) GMT"
}

// Internal: the day of the week of an instant, 0 for Sunday to 6 for Saturday (1970-01-01 was a Thursday).
fn weekday(ms: Int) -> Int {
  let days = ms / 86400000 - match {
    ms % 86400000 < 0 -> 1
    else -> 0
  }
  let w = (days + 4) % 7
  match {
    w < 0 -> w + 7
    else -> w
  }
}

// Internal: a day of the week as IMF-fixdate names it, 0 for Sunday.
fn weekday_name(day: Int) -> View {
  match day {
    0 -> "Sun"
    1 -> "Mon"
    2 -> "Tue"
    3 -> "Wed"
    4 -> "Thu"
    5 -> "Fri"
    _ -> "Sat"
  }
}

// Internal: a month as IMF-fixdate names it, 1 for January.
fn month_name(month: Int) -> View {
  match month {
    1 -> "Jan"
    2 -> "Feb"
    3 -> "Mar"
    4 -> "Apr"
    5 -> "May"
    6 -> "Jun"
    7 -> "Jul"
    8 -> "Aug"
    9 -> "Sep"
    10 -> "Oct"
    11 -> "Nov"
    _ -> "Dec"
  }
}

// Internal: a year as rfc3339 writes it: four digits from 0 to 9999, else a sign and at least six.
fn iso_year(year: Int) -> View {
  match {
    year >= 0 and year <= 9999 -> four_digit(n: year)
    year > 9999 -> "+" ++ six_digit(n: year)
    else -> "-" ++ six_digit(n: 0 - year)
  }
}

// Internal: a year as http_date writes it: at least four digits, after a `-` before the year 0.
fn http_year(year: Int) -> View {
  match {
    year >= 0 -> four_digit(n: year)
    else -> "-" ++ four_digit(n: 0 - year)
  }
}

// Internal: n, 0 or more, in at least two digits.
fn two_digit(n: Int) -> View {
  match {
    n < 10 -> "0\(n)"
    else -> "\(n)"
  }
}

// Internal: n, 0 or more, in at least three digits.
fn three_digit(n: Int) -> View {
  match {
    n < 10 -> "00\(n)"
    n < 100 -> "0\(n)"
    else -> "\(n)"
  }
}

// Internal: n, 0 or more, in at least four digits.
fn four_digit(n: Int) -> View {
  match {
    n < 10 -> "000\(n)"
    n < 100 -> "00\(n)"
    n < 1000 -> "0\(n)"
    else -> "\(n)"
  }
}

// Internal: n, 0 or more, in at least six digits.
fn six_digit(n: Int) -> View {
  match {
    n < 10000 -> "00" ++ four_digit(n)
    n < 100000 -> "0\(n)"
    else -> "\(n)"
  }
}
