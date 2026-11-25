// webhook.tape: receive a signed webhook, verify it, and tell another service. Cryptography and outbound HTTP are
// not special: each is a Remote the host provides (WebCrypto, fetch), so both get a time budget, both are in
// the effect log, and a replay needs neither. POST /hook?sig=<hex> with a JSON body.

type Check { Check(body: View, signature: View) }
type Verdict { Verdict(valid: Bool) }
type Event { Event(id: Int, kind: View) }
type Note { Note(event: Int, text: View) }
type Sent { Sent(status: Int) }

// what the signer and the api refuse with: a reason they give
type Refusal { Refused(reason: View) }

fn handle(raw: View, signer: Remote, api: Remote) -> Response {
  match request(raw) {
    Request(
      method: Post,
      path: "/hook",
      query: Some(value: "sig=" ++ signature),
      body
    ) -> hook(body, signature)
    Request(method: Post, path: "/hook") -> problem(status: 401, detail: "missing signature")
    _ -> problem(status: 404, detail: "no such route")
  }
}

fn hook(body: View, signature: View) -> Response uses api, signer {
  let Ok(value: Verdict(valid: True)) = ask(
    to: signer,
    method: "verify",
    send: Check(body, signature),
    reply: Verdict,
    error: Refusal,
    within: 100
  ) else {
    Ok(value: Verdict(valid: False)) -> problem(status: 401, detail: "bad signature")
    Err(error: Timeout) -> problem(status: 504, detail: "the signature check timed out")
    _ -> problem(status: 503, detail: "the signature check is unavailable")
  }
  let Ok(value: Event(id, kind)) = decode(json: body, as: Event) else {
    Err(error) -> problem(status: 400, detail: error)
  }
  // The event's id is the key: a webhook delivered twice notifies once.
  let Ok(value: Sent(status)) = call(
    to: api,
    method: "notify",
    send: Note(event: id, text: kind),
    reply: Sent,
    error: Refusal,
    within: 500,
    once: Note(event: id, text: kind)
  ) else {
    Err(error: Timeout) -> problem(
      status: 504,
      detail: "the notification timed out; send the webhook again"
    )
    Err(error: Rejected(reason: Refused(reason))) -> problem(status: 502, detail: reason)
    _ -> problem(status: 502, detail: "the notification service is unavailable")
  }
  buf() |> append(view: "{\"delivered\":\(status)}") |> respond(status: 200)
}
