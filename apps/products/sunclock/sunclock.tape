// sunclock.tape: sunrise, sunset and the length of the day anywhere, from NOAA's solar equations (the
// Solar Calculator's spreadsheet: Meeus, "Astronomical Algorithms"), in Float, in the program. GET
// /?lat=51.48&lon=-0.0015 is a page with a bar of the day, night to night; /api?lat=…&lon=… the same as JSON.
// `date=YYYY-MM-DD` picks a day (today, UTC, by default) and `tz=-5` or `tz=5.5` the hours the clock is shown in
// (UTC by default). Each event is computed at its own moment: a first guess at noon, then once more at the
// event, which keeps it within a minute of the ephemeris.

type Problem { Problem(error: View) }

// What the sun does on a day: the times are minutes after 00:00 UTC of that day, and may run below 0 or past
// 1440 where the local day does.
type Sky {
  Rises(
    dawn: Option[Float],
    rise: Float,
    noon: Float,
    set: Float,
    dusk: Option[Float],
    elevation: Float
  )
  AllDay(noon: Float, elevation: Float)
  AllNight(noon: Float, elevation: Float)
}

type Event { Event(utc: View, local: View) }
type Answer {
  Answer(
    lat: Float,
    lon: Float,
    date: View,
    tz: Float,
    sky: View,
    dawn: Option[Event],
    sunrise: Option[Event],
    noon: Event,
    sunset: Option[Event],
    dusk: Option[Event],
    day_minutes: Int,
    noon_elevation: Float
  )
}

type Place { Place(lat: Float, lon: Float, day: Int, tz: Float) }

fn handle(raw: View, clock: Clock) -> Buf {
  match request(raw) {
    Request(method: "GET", path: "/", query: None) -> home()
    Request(method: "GET", path: "/", query: Some(value: q)) -> match place(q) {
      Ok(value: p) -> shown(p)
      Err(error) -> page(status: 400, title: "Not a place")
        |> append(view: "<p>")
        |> write_html(text: error)
        |> append(view: ". Try <a href=\"?lat=51.4769&amp;lon=-0.0005\">Greenwich</a>.</p>")
        |> end
    }
    Request(method: "GET", path: "/api", query: Some(value: q)) -> match place(q) {
      Ok(value: p) -> respond_as(status: 200, content: Json) |> write_json(value: answer(p))
      Err(error) -> respond_as(status: 400, content: Json) |> write_json(value: Problem(error))
    }
    Request(method: "GET", path: "/api") -> respond_as(status: 400, content: Json)
      |> write_json(value: Problem(error: "lat: missing"))
    _ -> respond_as(status: 404, content: Json)
      |> write_json(value: Problem(error: "no such route"))
  }
}

// ---------- the query ----------

fn place(q: View) -> Result[Place, View] {
  let Some(value: lat) = number(
    q,
    name: "lat",
    least: -90f,
    most: 90f
  ) else -> Err(error: "lat: a number from -90 to 90")
  let Some(value: lon) = number(
    q,
    name: "lon",
    least: -180f,
    most: 180f
  ) else -> Err(error: "lon: a number from -180 to 180")
  let tz = match form_field(body: q, name: "tz") {
    None -> Some(value: 0f)
    Some(value: t) -> in_range(found: parse_float(text: t), least: -14f, most: 14f)
  }
  let Some(value: hours) = tz else -> Err(error: "tz: hours from -14 to 14, such as -5 or 5.5")
  match form_field(body: q, name: "date") {
    None -> Ok(value: Place(lat, lon, day: (now() + trunc(hours * 3600000f)) / 86400000, tz: hours))
    Some(value: d) -> match day_of(text: d) {
      Some(value: day) -> Ok(value: Place(lat, lon, day, tz: hours))
      None -> Err(error: "date: YYYY-MM-DD, from 1900 to 2100")
    }
  }
}

fn number(q: View, name: View, least: Float, most: Float) -> Option[Float] {
  let Some(value: t) = form_field(body: q, name) else -> None
  // a sign, digits, a point and an exponent only: the deployed host's parse_float read "" as 0 (fixed in 1f141d4)
  let True = len(t) >= 1 and every_byte(v: t, keep: number_byte) else -> None
  in_range(found: parse_float(text: t), least, most)
}

fn number_byte(b: Int) -> Bool {
  is_digit(b) or b == 46 or b == 45 or b == 43 or b == 101 or b == 69
}

fn in_range(found: Option[Float], least: Float, most: Float) -> Option[Float] {
  match found {
    Some(value: x) if x >= least and x <= most -> found
    _ -> None
  }
}

// YYYY-MM-DD as days since 1970-01-01, by Howard Hinnant's days-from-civil.
//
//   > day_of(text: "1970-01-01")
//   Some(value: 0)
//   > day_of(text: "2026-11-23")
//   Some(value: 20780)
//   > day_of(text: "2000-02-29")
//   Some(value: 11016)
//   > day_of(text: "2026-13-01")
//   None
//   > day_of(text: "2026-02-30")
//   None
fn day_of(text: View) -> Option[Int] {
  let decimal(y) ++ "-" ++ m2 ++ "-" ++ d2 = text else -> None
  let Some(value: m) = two_digits(text: m2) else -> None
  let Some(value: d) = two_digits(text: d2) else -> None
  let True = y >= 1900 and y <= 2100 and m >= 1 and m <= 12 and d >= 1 and d <= 31 else -> None
  let yy = match {
    m <= 2 -> y - 1
    else -> y
  }
  let era = yy / 400
  let yoe = yy - era * 400
  let mp = match {
    m > 2 -> m - 3
    else -> m + 9
  }
  let doy = (153 * mp + 2) / 5 + d - 1
  let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
  let day = era * 146097 + doe - 719468
  match {
    date_of(day) == text -> Some(value: day)
    else -> None
  }
}

fn two_digits(text: View) -> Option[Int] {
  match {
    len(text) == 2
      and is_digit(text[0])
      and is_digit(text[1]) -> Some(value: (text[0] - 48) * 10 + text[1] - 48)
    else -> None
  }
}

// ---------- the sun ----------

fn pi() -> Float {
  3.141592653589793f
}

fn rad(deg: Float) -> Float {
  deg * pi() / 180f
}

fn deg(rad: Float) -> Float {
  rad * 180f / pi()
}

fn asin(x: Float) -> Float {
  atan2(y: x, x: sqrt(max(a: 0f, b: 1f - x * x)))
}

fn turn(deg: Float) -> Float {
  deg - 360f * floor(deg / 360f)
}

// The sun's declination (degrees) and the equation of time (minutes) at `minutes` after 00:00 UTC of `day`.
type Sun { Sun(decl: Float, eot: Float) }

fn sun(day: Int, minutes: Float) -> Sun {
  let jc = (float(day) + 2440587.5f + minutes / 1440f - 2451545f) / 36525f
  let l0 = turn(deg: 280.46646f + jc * (36000.76983f + jc * 0.0003032f))
  let m = 357.52911f + jc * (35999.05029f - 0.0001537f * jc)
  let e = 0.016708634f - jc * (0.000042037f + 0.0000001267f * jc)
  let c = sin(rad(deg: m)) * (
    1.914602f - jc * (0.004817f + 0.000014f * jc)
  ) + sin(rad(deg: 2f * m)) * (0.019993f - 0.000101f * jc) + sin(rad(deg: 3f * m)) * 0.000289f
  let omega = rad(deg: 125.04f - 1934.136f * jc)
  let lambda = rad(deg: l0 + c - 0.00569f - 0.00478f * sin(omega))
  let eps0 = 23f + (26f + (21.448f - jc * (46.815f + jc * (0.00059f - jc * 0.001813f))) / 60f) / 60f
  let eps = rad(deg: eps0 + 0.00256f * cos(omega))
  let t = sin(eps / 2f) / cos(eps / 2f)
  let y = t * t
  let l = rad(deg: l0)
  let mr = rad(deg: m)
  let eot = 4f * deg(rad: y * sin(2f * l) - 2f * e * sin(mr) + 4f * e * y * sin(mr) * cos(
    2f * l
  ) - 0.5f * y * y * sin(
      4f * l
    ) - 1.25f * e * e * sin(
      2f * mr
  ))
  Sun(decl: deg(rad: asin(sin(eps) * sin(lambda))), eot)
}

// Solar noon in minutes UTC, east longitude positive.
fn noon_at(p: Place, minutes: Float) -> Float {
  720f - 4f * p.lon - sun(day: p.day, minutes).eot
}

// cos of the hour angle at which the sun's centre is `zenith` degrees from the zenith, at `minutes`.
fn cos_hour(p: Place, zenith: Float, minutes: Float) -> Float {
  let s = sun(day: p.day, minutes)
  let phi = rad(deg: p.lat)
  let d = rad(deg: s.decl)
  cos(rad(deg: zenith)) / (cos(phi) * cos(d)) - sin(phi) / cos(phi) * sin(d) / cos(d)
}

// The minute of an event `side` (-1 before noon, 1 after) at `zenith`, guessed at `guess` and computed again
// there; None where the sun does not reach it that day.
fn event(p: Place, zenith: Float, side: Float, guess: Float) -> Option[Float] {
  let first = at_event(p, zenith, side, minutes: guess)
  match first {
    Some(value: m) -> at_event(p, zenith, side, minutes: m)
    None -> None
  }
}

fn at_event(p: Place, zenith: Float, side: Float, minutes: Float) -> Option[Float] {
  let h = cos_hour(p, zenith, minutes)
  match {
    h < -1f or h > 1f -> None
    else -> Some(
      value: noon_at(p, minutes) + side * 4f * deg(rad: atan2(y: sqrt(1f - h * h), x: h))
    )
  }
}

fn sky(p: Place) -> Sky {
  let noon = noon_at(p, minutes: noon_at(p, minutes: 720f))
  let elevation = 90f - abs(p.lat - sun(day: p.day, minutes: noon).decl)
  match event(p, zenith: 90.833f, side: -1f, guess: noon) {
    Some(value: rise) -> match event(p, zenith: 90.833f, side: 1f, guess: noon) {
      Some(value: set) -> Rises(
        dawn: event(p, zenith: 96f, side: -1f, guess: rise),
        rise,
        noon,
        set,
        dusk: event(p, zenith: 96f, side: 1f, guess: set),
        elevation
      )
      None -> AllDay(noon, elevation)
    }
    None -> match {
      elevation > 0f -> AllDay(noon, elevation)
      else -> AllNight(noon, elevation)
    }
  }
}

// ---------- the answer ----------

fn answer(p: Place) -> Answer {
  let s = sky(p)
  match s {
    Rises(dawn, rise, noon, set, dusk, elevation) -> Answer(
      lat: p.lat,
      lon: p.lon,
      date: date_of(day: p.day),
      tz: p.tz,
      sky: "rises and sets",
      dawn: stamp(p, found: dawn),
      sunrise: Some(value: at(p, minutes: rise)),
      noon: at(p, minutes: noon),
      sunset: Some(value: at(p, minutes: set)),
      dusk: stamp(p, found: dusk),
      day_minutes: trunc(set - rise + 0.5f),
      noon_elevation: tenths(x: elevation)
    )
    AllDay(noon, elevation) -> Answer(
      lat: p.lat,
      lon: p.lon,
      date: date_of(day: p.day),
      tz: p.tz,
      sky: "up all day",
      dawn: None,
      sunrise: None,
      noon: at(p, minutes: noon),
      sunset: None,
      dusk: None,
      day_minutes: 1440,
      noon_elevation: tenths(x: elevation)
    )
    AllNight(noon, elevation) -> Answer(
      lat: p.lat,
      lon: p.lon,
      date: date_of(day: p.day),
      tz: p.tz,
      sky: "down all day",
      dawn: None,
      sunrise: None,
      noon: at(p, minutes: noon),
      sunset: None,
      dusk: None,
      day_minutes: 0,
      noon_elevation: tenths(x: elevation)
    )
  }
}

fn tenths(x: Float) -> Float {
  floor(x * 10f + 0.5f) / 10f
}

fn stamp(p: Place, found: Option[Float]) -> Option[Event] {
  match found {
    Some(value: m) -> Some(value: at(p, minutes: m))
    None -> None
  }
}

// An event as an ISO time in UTC and as a clock time where the page is set.
fn at(p: Place, minutes: Float) -> Event {
  let utc = trunc(floor(minutes + 0.5f))
  let local = utc + trunc(floor(p.tz * 60f + 0.5f))
  Event(utc: iso(day: p.day, minutes: utc), local: clock_text(minutes: local))
}

fn iso(day: Int, minutes: Int) -> View {
  let d = day + floor_div(a: minutes, b: 1440)
  let m = minutes - floor_div(a: minutes, b: 1440) * 1440
  "\(date_of(day: d))T\(two(n: m / 60)):\(two(n: m % 60))Z"
}

// HH:MM on a 24-hour clock, with the day it falls on when that is not the day asked for.
//
//   > clock_text(minutes: 75)
//   "01:15"
//   > clock_text(minutes: -30)
//   "23:30 (the day before)"
//   > clock_text(minutes: 1500)
//   "01:00 (the next day)"
fn clock_text(minutes: Int) -> View {
  let m = minutes - floor_div(a: minutes, b: 1440) * 1440
  let hm = "\(two(n: m / 60)):\(two(n: m % 60))"
  match {
    minutes < 0 -> hm ++ " (the day before)"
    minutes >= 1440 -> hm ++ " (the next day)"
    else -> hm
  }
}

fn floor_div(a: Int, b: Int) -> Int {
  match {
    a < 0 and a % b != 0 -> a / b - 1
    else -> a / b
  }
}

// Days since 1970 as YYYY-MM-DD.
//
//   > date_of(day: 20780)
//   "2026-11-23"
fn date_of(day: Int) -> View {
  let z = day + 719468
  let era = z / 146097
  let doe = z - era * 146097
  let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
  let mp = (5 * doy + 2) / 153
  let d = doy - (153 * mp + 2) / 5 + 1
  let m = match {
    mp < 10 -> mp + 3
    else -> mp - 9
  }
  let y = yoe + era * 400 + match {
    m <= 2 -> 1
    else -> 0
  }
  "\(y)-\(two(n: m))-\(two(n: d))"
}

fn two(n: Int) -> View {
  match {
    n < 10 -> "0\(n)"
    else -> "\(n)"
  }
}

// ---------- pages ----------

fn page(status: Int, title: View) -> Buf {
  respond_as(status, content: Html)
    |> header(name: "cache-control", value: "no-store")
    |> append(view: "<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport \
        content=\"width=device-width,initial-scale=1\"><meta name=robots \
        content=\"noindex\"><title>")
    |> write_html(text: title)
    |> append(view: " · sunclock</title><style>")
    |> append(
    view: ":root{color-scheme:light dark;--fg:#1d1f23;--mute:#626873;--bg:#fbfbfa;--card:#fff;"
  )
    |> append(view: "--line:#e3e4e6;--acc:#2856c7;--night:#1f2a44;--twi:#6b7fb5;--day:#f4c542}")
    |> append(
    view: "@media(prefers-color-scheme:dark){:root{--fg:#e8e9eb;--mute:#9aa0aa;--bg:#15171a;"
  )
    |> append(view: "--card:#1d2024;--line:#30343a;--acc:#86a8ff;--night:#0b1120;--twi:#3c4f86;--day:#e9b82f}}")
    |> append(view: "body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 \
        system-ui,sans-serif}")
    |> append(
    view: "main{max-width:44rem;margin:0 auto;padding:2rem 1rem}h1{font-size:1.5rem;margin:0}"
  )
    |> append(view: "a{color:var(--acc)}.mute{color:var(--mute)}.grid{display:grid;")
    |> append(
    view: "grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.75rem;margin:1rem 0}"
  )
    |> append(
    view: ".grid div{background:var(--card);border:1px solid var(--line);border-radius:10px;"
  )
    |> append(
    view: "padding:.6rem .8rem}.grid b{display:block;font-size:1.35rem;font-variant-numeric:"
  )
    |> append(
    view: "tabular-nums}svg{width:100%;height:auto;display:block}.night{fill:var(--night)}"
  )
    |> append(
    view: ".twi{fill:var(--twi)}.day{fill:var(--day)}.tick{stroke:var(--mute);stroke-width:1}"
  )
    |> append(view: ".lbl{fill:var(--mute);font:11px system-ui,sans-serif}</style><main>")
    |> append(view: "<p class=mute><a href=\"/p/demo/sunclock/\">sunclock</a></p><h1>")
    |> write_html(text: title)
    |> append(view: "</h1>")
}

fn end(out: Buf) -> Buf {
  out
    |> append(view: "<p class=mute>Computed in Tape from NOAA's solar equations: sunrise and \
        sunset when the top of the sun meets the horizon (refraction 34′), dawn and dusk at 6° \
        below it (civil twilight). Within a minute or two of an ephemeris away from the \
        poles.</p></main></html>")
}

fn home() -> Buf {
  page(status: 200, title: "Sunrise and sunset, anywhere")
    |> append(view: "<p>Give a latitude and a longitude in the address: \
        <code>?lat=51.4769&amp;lon=-0.0005</code>, and optionally \
        <code>&amp;date=2026-12-21</code> and <code>&amp;tz=-5</code> (hours from \
        UTC). <code>api?…</code> answers JSON.</p><ul><li><a \
        href=\"?lat=51.4769&amp;lon=-0.0005\">Greenwich</a></li><li><a \
        href=\"?lat=40.7128&amp;lon=-74.006&amp;tz=-5\">New York</a></li><li><a \
        href=\"?lat=-33.8688&amp;lon=151.2093&amp;tz=11\">Sydney</a></li><li><a \
        href=\"?lat=1.3521&amp;lon=103.8198&amp;tz=8\">Singapore</a></li><li><a \
        href=\"?lat=69.6492&amp;lon=18.9553&amp;tz=1\">Tromsø</a> (no sunrise in \
        December)</li><li><a \
        href=\"?lat=78.2232&amp;lon=15.6267&amp;tz=1&amp;date=2026-06-21\">Longyearbyen at \
        midsummer</a></li></ul>")
    |> end
}

fn shown(p: Place) -> Buf {
  let a = answer(p)
  page(status: 200, title: "The sun on \(a.date)")
    |> append(view: "<p class=mute>at \(p.lat)°, \(p.lon)° · times at UTC\(offset(tz: p.tz)) · ")
    |> append(view: "<a href=\"/p/demo/sunclock/api?lat=\(p.lat)&amp;lon=\(p.lon)&amp;date=\(a.date)&amp;tz=\(p.tz)\">JSON</a></p>")
    |> bar(s: sky(p), tz: p.tz)
    |> append(view: "<div class=grid>")
    |> tile(name: "Dawn", found: a.dawn)
    |> tile(name: "Sunrise", found: a.sunrise)
    |> tile(name: "Solar noon", found: Some(value: a.noon))
    |> tile(name: "Sunset", found: a.sunset)
    |> tile(name: "Dusk", found: a.dusk)
    |> append(
    view: "<div>Day length<b>\(a.day_minutes / 60) h \(two(n: a.day_minutes % 60)) m</b></div>"
  )
    |> append(view: "<div>Sun at noon<b>\(a.noon_elevation)°</b></div></div>")
    |> append(view: match a.sky {
    "up all day" -> "<p>The sun does not set today.</p>"
    "down all day" -> "<p>The sun does not rise today.</p>"
    _ -> ""
  }) |> end
}

fn offset(tz: Float) -> View {
  match {
    tz > 0f -> "+\(tz)"
    tz < 0f -> "\(tz)"
    else -> ""
  }
}

fn tile(out: Buf, name: View, found: Option[Event]) -> Buf {
  match found {
    Some(value: Event(local)) -> out |> append(view: "<div>\(name)<b>\(local)</b></div>")
    None -> out |> append(view: "<div>\(name)<b>—</b></div>")
  }
}

// ---------- the bar ----------

// The day from local midnight to midnight, 720 wide: night, then twilight, day, twilight and night, with an
// hour tick every three hours. Every number in it is computed; nothing in it comes from the request but numbers.
fn bar(out: Buf, s: Sky, tz: Float) -> Buf {
  let shift = tz * 60f
  out
    |> append(view: "<svg viewBox=\"0 0 720 64\" role=img aria-label=\"daylight over the day\">")
    |> append(view: "<rect class=night x=0 y=0 width=720 height=40 rx=6/>")
    |> spans(s, shift)
    |> ticks(hour: 0)
    |> append(view: "</svg>")
}

fn spans(out: Buf, s: Sky, shift: Float) -> Buf {
  match s {
    Rises(dawn, rise, set, dusk) -> out
      |> band(
      class: "twi",
      from: or_else(found: dawn, other: rise) + shift,
      to: or_else(found: dusk, other: set) + shift
    )
      |> band(class: "day", from: rise + shift, to: set + shift)
    AllDay -> out |> band(class: "day", from: 0f, to: 1440f)
    AllNight -> out
  }
}

fn or_else(found: Option[Float], other: Float) -> Float {
  match found {
    Some(value) -> value
    None -> other
  }
}

// A band from one minute to another of the local day, drawn on both sides of midnight when it wraps.
fn band(out: Buf, class: View, from: Float, to: Float) -> Buf {
  let a = from - 1440f * floor(from / 1440f)
  let b = a + (to - from)
  match {
    b <= 1440f -> out |> rect(class, from: a, to: b)
    else -> out |> rect(class, from: a, to: 1440f) |> rect(class, from: 0f, to: b - 1440f)
  }
}

fn rect(out: Buf, class: View, from: Float, to: Float) -> Buf {
  let x = tenths(x: from / 2f)
  let w = tenths(x: (to - from) / 2f)
  out |> append(view: "<rect class=\(class) x=\(x) y=0 width=\(w) height=40/>")
}

fn ticks(out: Buf, hour: Int) -> Buf {
  match {
    hour > 24 -> out
    else -> out
      |> append(view: "<line class=tick x1=\(hour * 30) x2=\(hour * 30) y1=40 y2=46/>")
      |> append(view: "<text class=lbl x=\(min(a: max(a: hour * 30, b: 8), b: 712)) y=60 \
          text-anchor=middle>")
      |> append(view: "\(two(n: hour % 24)):00</text>")
      |> ticks(hour: hour + 3)
  }
}
