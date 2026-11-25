// A feed and two other XML documents. The Atom body holds an XHTML script. Chrome runs that script when the
// response is application/atom+xml, application/rss+xml or application/xml, and nosniff does not stop it. The
// service's content-security-policy (sandbox, default-src 'none') does (service/src/headers.ts, headers.test.ts).
fn atom_feed() -> View {
  "<?xml version=\"1.0\" encoding=\"utf-8\"?><feed xmlns=\"http://www.w3.org/2005/Atom\"><script \
      xmlns=\"http://www.w3.org/1999/xhtml\">ran=1</script></feed>"
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
