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

fn handle(raw: View) -> Response {
  match request(raw) {
    Request(path: "/feed.xml") -> buf()
      |> append(view: atom_feed())
      |> respond_as(status: 200, content: Atom)
    Request(path: "/rss.xml") -> buf()
      |> append(view: rss_feed())
      |> respond_as(status: 200, content: Rss)
    Request(path: "/doc.xml") -> buf()
      |> append(view: xml_doc())
      |> respond_as(status: 200, content: Xml)
    _ -> empty(status: 404)
  }
}
