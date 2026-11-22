// A tool that sets a timer: refused, because no policy grants Timer (VERIFY check 17).
export fn woken(timer: Timer, message: Wake) -> Result[Wake, View] {
  Ok(value: Wake(key: wake(timer, after: 10, key: message.key)))
}
