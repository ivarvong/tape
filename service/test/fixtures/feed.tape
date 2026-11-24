// A feed and two other XML documents. The host serves Atom, RSS and XML as those types, with charset=utf-8, and
// not as a page (test/v04.ts, service/test/public.test.ts, service/test/headers.test.ts).
fn atom_feed() -> View {
  "<?xml version=\"1.0\" encoding=\"utf-8\"?><feed xmlns=\"http://www.w3.org/2005/Atom\"/>"
}

fn rss_feed() -> View {
  "<?xml version=\"1.0\" encoding=\"utf-8\"?><rss version=\"2.0\"/>"
}

fn xml_doc() -> View {
  "<?xml version=\"1.0\" encoding=\"utf-8\"?><doc/>"
}

fn handle(raw: View) -> Buf {
  match request(raw) {
    Request(path: "/feed.xml") -> respond_as(status: 200, content: Atom)
      |> append(view: atom_feed())
    Request(path: "/rss.xml") -> respond_as(status: 200, content: Rss) |> append(view: rss_feed())
    Request(path: "/doc.xml") -> respond_as(status: 200, content: Xml) |> append(view: xml_doc())
    _ -> respond(status: 404)
  }
}
