// std/crypto.tape: SHA-256 (FIPS 180-4), HMAC-SHA-256 (RFC 2104) and the encodings that carry their bytes: hex and
// base64 (RFC 4648). They are written in Tape, so they need no capability, give the same bytes on every host and
// in a replay, and cost steps as any other code does (LANGUAGE.md section 10).
//
// A digest is 32 raw bytes. SHA-256 works on 32-bit words; an Int holds 64 bits, so each word is kept from 0 to
// 2^32 - 1: a sum is taken back to 32 bits with `& 4294967295`, which is 2^32 - 1, and a rotation is two shifts
// of a value that is never negative.

// The SHA-256 digest of `data`: 32 bytes. Its cost is 66 steps for each 64-byte block hashed, and 1 more: the
// data with its padding (a 128 byte, zeros and its length in bits, 9 bytes at least) is a whole number of blocks,
// so 0 to 55 bytes are one block, 56 to 119 two, and n bytes (n + 72) / 64 blocks. It makes no copy of `data`.
//
//   > hex(bytes: sha256(data: ""))
//   "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
//   > hex(bytes: sha256(data: "abc"))
//   "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
//   > len(sha256(data: "abc"))
//   32
fn sha256(data: View) -> View {
  let end = ((len(data) + 72) / 64) * 64
  let hash = sha256_blocks(data, at: 0, end, hash: sha256_initial())
  buf()
    |> push_word(word: hash.h0)
    |> push_word(word: hash.h1)
    |> push_word(word: hash.h2)
    |> push_word(word: hash.h3)
    |> push_word(word: hash.h4)
    |> push_word(word: hash.h5)
    |> push_word(word: hash.h6)
    |> push_word(word: hash.h7)
    |> freeze
}

// The HMAC-SHA-256 of `data` under `key` (RFC 2104): 32 bytes. A key longer than the 64-byte block is hashed
// first, as the RFC says. Its cost is 65 steps for each of the two padded keys and the steps of its two digests,
// of 64 + len(data) bytes and then of 96 (133 steps): 396 steps for up to 55 bytes of data, and 66 more for each
// further 64 bytes; a key longer than 64 bytes adds the steps of its own digest. It copies the data once.
//
//   > hex(bytes: hmac_sha256(key: "Jefe", data: "what do ya want for nothing?"))
//   "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
fn hmac_sha256(key: View, data: View) -> View {
  let block_key = match {
    len(key) > 64 -> sha256(data: key)
    else -> key
  }
  let inner = buf()
    |> keyed(key: block_key, pad: 54, at: 0)
    |> append(view: data)
    |> freeze
    |> sha256
  buf() |> keyed(key: block_key, pad: 92, at: 0) |> append(view: inner) |> freeze |> sha256
}

// Is `mac` the HMAC-SHA-256 of `data` under `key`? Check a signature with this, not with `==`: `==` on two Views
// stops at the first byte that differs, so how long it takes, and how many steps a request takes when the check
// is written as a loop that stops, tells a caller how many leading bytes of a forged mac were right. This walks
// all 32 bytes whatever they hold and takes the OR of their XORs, so its steps and its time are the same wherever
// the bytes differ: hmac_sha256's steps and 33 more. A mac that is not 32 bytes long is False before any byte is
// compared (its length is not a secret).
//
//   > hmac_sha256_verify(key: "k", data: "body", mac: hmac_sha256(key: "k", data: "body"))
//   True
//   > hmac_sha256_verify(key: "k", data: "body", mac: hmac_sha256(key: "K", data: "body"))
//   False
//   > hmac_sha256_verify(key: "k", data: "body", mac: "")
//   False
fn hmac_sha256_verify(key: View, data: View, mac: View) -> Bool {
  let want = hmac_sha256(key, data)
  len(mac) == 32 and differences(a: want, b: mac, at: 0, found: 0) == 0
}

// The bytes in lower-case hex, two digits a byte. One step a byte, and 1.
//
//   > hex(bytes: "Tape")
//   "54617065"
//   > hex(bytes: sha256(data: "")) |> slice(from: 0, to: 8)
//   "e3b0c442"
fn hex(bytes: View) -> View {
  freeze(buf: hex_from(out: buf(), bytes, at: 0))
}

// The bytes in base64 (RFC 4648 section 4): A-Z, a-z, 0-9, + and /, padded with = to a multiple of 4. One step
// for each 3 bytes, and 1.
//
//   > base64(bytes: "hello")
//   "aGVsbG8="
//   > base64(bytes: ">>?")
//   "Pj4/"
//   > base64(bytes: "")
//   ""
fn base64(bytes: View) -> View {
  freeze(buf: base64_from(out: buf(), bytes, at: 0, url: False))
}

// The bytes in base64url (RFC 4648 section 5): - and _ where base64 has + and /, and no padding, as JWT and
// Standard Webhooks' signatures write it (so it can stand in a URL or a header unescaped). One step for each 3
// bytes, and 1.
//
//   > base64url(bytes: "hello")
//   "aGVsbG8"
//   > base64url(bytes: ">>?")
//   "Pj4_"
fn base64url(bytes: View) -> View {
  freeze(buf: base64_from(out: buf(), bytes, at: 0, url: True))
}

// The bytes that base64 text stands for, or None. It takes exactly what `base64` writes and nothing else: None
// for a byte outside A-Z, a-z, 0-9, + and / (a space, a line break, base64url's - or _, an = that is not
// padding), for a length that is not a multiple of 4, and for a last character whose bits past the data are not
// zero ("aGVsbG9=" is not canonical: base64 of "hello" is "aGVsbG8="), so each value has one encoding. One step a
// character and one for each 4 characters, and 2.
//
//   > from_base64(text: "aGVsbG8=")
//   Some(value: "hello")
//   > from_base64(text: "aGVsbG8")
//   None
//   > from_base64(text: "aGVsbG9=")
//   None
//   > from_base64(text: "aGVs bG8=")
//   None
fn from_base64(text: View) -> Option[View] {
  let n = len(text)
  let padding = match {
    n >= 2 and text[n - 1] == '=' and text[n - 2] == '=' -> 2
    n >= 1 and text[n - 1] == '=' -> 1
    else -> 0
  }
  match {
    n % 4 != 0 -> None
    else -> base64_decoded(text: slice(v: text, from: 0, to: n - padding), url: False)
  }
}

// The bytes that base64url text stands for, or None. It takes exactly what `base64url` writes: None for a byte
// outside A-Z, a-z, 0-9, - and _ (base64's + or /, and = too: base64url here has no padding), for a length that
// leaves 1 character over a multiple of 4 (no bytes give that), and for a last character whose bits past the data
// are not zero. One step a character and one for each 4 characters, and 2.
//
//   > from_base64url(text: "aGVsbG8")
//   Some(value: "hello")
//   > from_base64url(text: "Pj4_")
//   Some(value: ">>?")
//   > from_base64url(text: "aGVsbG8=")
//   None
//   > from_base64url(text: "Pj4/")
//   None
fn from_base64url(text: View) -> Option[View] {
  base64_decoded(text, url: True)
}

// Internal: the eight words of SHA-256's hash value, H0 to H7.
type Sha256_Hash {
  Sha256_Hash(h0: Int, h1: Int, h2: Int, h3: Int, h4: Int, h5: Int, h6: Int, h7: Int)
}

// The initial hash value: the first 32 bits of the fractional parts of the square roots of the first 8 primes.
private fn sha256_initial() -> Sha256_Hash {
  Sha256_Hash(
    h0: 1779033703,
    h1: 3144134277,
    h2: 1013904242,
    h3: 2773480762,
    h4: 1359893119,
    h5: 2600822924,
    h6: 528734635,
    h7: 1541459225
  )
}

// The hash after each block from `at` to `end`, the padded length.
private fn sha256_blocks(data: View, at: Int, end: Int, hash: Sha256_Hash) -> Sha256_Hash {
  match {
    at >= end -> hash
    else -> sha256_blocks(
      data,
      at: at + 64,
      end,
      hash: sha256_rounds(
        data,
        at,
        end,
        t: 0,
        hash,
        a: hash.h0,
        b: hash.h1,
        c: hash.h2,
        d: hash.h3,
        e: hash.h4,
        f: hash.h5,
        g: hash.h6,
        h: hash.h7,
        w0: 0,
        w1: 0,
        w2: 0,
        w3: 0,
        w4: 0,
        w5: 0,
        w6: 0,
        w7: 0,
        w8: 0,
        w9: 0,
        w10: 0,
        w11: 0,
        w12: 0,
        w13: 0,
        w14: 0,
        w15: 0
      )
    )
  }
}

// Round t of the block at `at`, with the working variables a to h, and w0 to w15 the last 16 words of the message
// schedule, W[t - 16] to W[t - 1]. Round t makes W[t] (the block's word t for the first 16, then from four of
// the words before) and shifts it into the window, so the schedule is never stored. After round 63 the working
// variables are added to the block's hash; at t = 64 the values worked out before the match are not used.
private fn sha256_rounds(
  data: View,
  at: Int,
  end: Int,
  t: Int,
  hash: Sha256_Hash,
  a: Int,
  b: Int,
  c: Int,
  d: Int,
  e: Int,
  f: Int,
  g: Int,
  h: Int,
  w0: Int,
  w1: Int,
  w2: Int,
  w3: Int,
  w4: Int,
  w5: Int,
  w6: Int,
  w7: Int,
  w8: Int,
  w9: Int,
  w10: Int,
  w11: Int,
  w12: Int,
  w13: Int,
  w14: Int,
  w15: Int
) -> Sha256_Hash {
  let w = match {
    t < 16 -> word_at(data, at: at + 4 * t, end)
    else -> add32(a: add32(a: small_sigma1(x: w14), b: w9), b: add32(a: small_sigma0(x: w1), b: w0))
  }
  let t1 = add32(
    a: add32(a: add32(a: h, b: big_sigma1(x: e)), b: choose(x: e, y: f, z: g)),
    b: add32(a: k(t), b: w)
  )
  let t2 = add32(a: big_sigma0(x: a), b: majority(x: a, y: b, z: c))
  match {
    t == 64 -> Sha256_Hash(
      h0: add32(a: hash.h0, b: a),
      h1: add32(a: hash.h1, b: b),
      h2: add32(a: hash.h2, b: c),
      h3: add32(a: hash.h3, b: d),
      h4: add32(a: hash.h4, b: e),
      h5: add32(a: hash.h5, b: f),
      h6: add32(a: hash.h6, b: g),
      h7: add32(a: hash.h7, b: h)
    )
    else -> sha256_rounds(
      data,
      at,
      end,
      t: t + 1,
      hash,
      a: add32(a: t1, b: t2),
      b: a,
      c: b,
      d: c,
      e: add32(a: d, b: t1),
      f: e,
      g: f,
      h: g,
      w0: w1,
      w1: w2,
      w2: w3,
      w3: w4,
      w4: w5,
      w5: w6,
      w6: w7,
      w7: w8,
      w8: w9,
      w9: w10,
      w10: w11,
      w11: w12,
      w12: w13,
      w13: w14,
      w14: w15,
      w15: w
    )
  }
}

// The big-endian word at `at` of the padded data.
private fn word_at(data: View, at: Int, end: Int) -> Int {
  let b0 = padded_byte(data, at, end)
  let b1 = padded_byte(data, at: at + 1, end)
  let b2 = padded_byte(data, at: at + 2, end)
  let b3 = padded_byte(data, at: at + 3, end)
  (b0 << 24) | (b1 << 16) | (b2 << 8) | b3
}

// The byte at `at` of the data padded to `end`: the data, a 128 byte, zeros, and the data's length in bits as
// the last 8 bytes, big-endian. The padding is read where it would be, never written.
private fn padded_byte(data: View, at: Int, end: Int) -> Int {
  let n = len(data)
  match {
    at < n -> data[at]
    at == n -> 128
    at < end - 8 -> 0
    else -> ((n * 8) >> (8 * (end - 1 - at))) & 255
  }
}

// The four bytes of a word, big-endian.
private fn push_word(out: Buf, word: Int) -> Buf {
  out
    |> push(byte: (word >> 24) & 255)
    |> push(byte: (word >> 16) & 255)
    |> push(byte: (word >> 8) & 255)
    |> push(byte: word & 255)
}

// a + b, as 32 bits.
private fn add32(a: Int, b: Int) -> Int {
  (a + b) & 4294967295
}

// x rotated right by n bits, as 32 bits.
private fn rotr(x: Int, n: Int) -> Int {
  ((x >> n) | (x << (32 - n))) & 4294967295
}

// FIPS 180-4's Ch: each bit of y where x has a 1, of z where it has a 0.
private fn choose(x: Int, y: Int, z: Int) -> Int {
  (x & y) ^ ((x ^ 4294967295) & z)
}

// FIPS 180-4's Maj: each bit as most of x, y and z have it.
private fn majority(x: Int, y: Int, z: Int) -> Int {
  (x & y) ^ (x & z) ^ (y & z)
}

// FIPS 180-4's Σ0, of a round's a.
private fn big_sigma0(x: Int) -> Int {
  rotr(x, n: 2) ^ rotr(x, n: 13) ^ rotr(x, n: 22)
}

// FIPS 180-4's Σ1, of a round's e.
private fn big_sigma1(x: Int) -> Int {
  rotr(x, n: 6) ^ rotr(x, n: 11) ^ rotr(x, n: 25)
}

// FIPS 180-4's σ0, of the schedule's W[t - 15].
private fn small_sigma0(x: Int) -> Int {
  rotr(x, n: 7) ^ rotr(x, n: 18) ^ (x >> 3)
}

// FIPS 180-4's σ1, of the schedule's W[t - 2].
private fn small_sigma1(x: Int) -> Int {
  rotr(x, n: 17) ^ rotr(x, n: 19) ^ (x >> 10)
}

// The round constant K[t]: the first 32 bits of the fractional parts of the cube roots of the first 64 primes.
// 0 at t = 64, the round that is not one.
private fn k(t: Int) -> Int {
  match t {
    0 -> 1116352408
    1 -> 1899447441
    2 -> 3049323471
    3 -> 3921009573
    4 -> 961987163
    5 -> 1508970993
    6 -> 2453635748
    7 -> 2870763221
    8 -> 3624381080
    9 -> 310598401
    10 -> 607225278
    11 -> 1426881987
    12 -> 1925078388
    13 -> 2162078206
    14 -> 2614888103
    15 -> 3248222580
    16 -> 3835390401
    17 -> 4022224774
    18 -> 264347078
    19 -> 604807628
    20 -> 770255983
    21 -> 1249150122
    22 -> 1555081692
    23 -> 1996064986
    24 -> 2554220882
    25 -> 2821834349
    26 -> 2952996808
    27 -> 3210313671
    28 -> 3336571891
    29 -> 3584528711
    30 -> 113926993
    31 -> 338241895
    32 -> 666307205
    33 -> 773529912
    34 -> 1294757372
    35 -> 1396182291
    36 -> 1695183700
    37 -> 1986661051
    38 -> 2177026350
    39 -> 2456956037
    40 -> 2730485921
    41 -> 2820302411
    42 -> 3259730800
    43 -> 3345764771
    44 -> 3516065817
    45 -> 3600352804
    46 -> 4094571909
    47 -> 275423344
    48 -> 430227734
    49 -> 506948616
    50 -> 659060556
    51 -> 883997877
    52 -> 958139571
    53 -> 1322822218
    54 -> 1537002063
    55 -> 1747873779
    56 -> 1955562222
    57 -> 2024104815
    58 -> 2227730452
    59 -> 2361852424
    60 -> 2428436474
    61 -> 2756734187
    62 -> 3204031479
    63 -> 3329325298
    _ -> 0
  }
}

// The 64-byte block key of HMAC, each byte XORed with `pad` (0x36 is 54, ipad; 0x5c is 92, opad): the key's bytes,
// then zeros.
private fn keyed(out: Buf, key: View, pad: Int, at: Int) -> Buf {
  match {
    at >= 64 -> out
    at < len(key) -> keyed(out: push(buf: out, byte: key[at] ^ pad), key, pad, at: at + 1)
    else -> keyed(out: push(buf: out, byte: pad), key, pad, at: at + 1)
  }
}

// The OR of a[i] XOR b[i] over every i from `at` (b at least as long as a): 0 only when they are the same. It has
// no branch on the bytes, so it reads all of them whatever they are.
private fn differences(a: View, b: View, at: Int, found: Int) -> Int {
  match {
    at >= len(a) -> found
    else -> differences(a, b, at: at + 1, found: found | (a[at] ^ b[at]))
  }
}

// The loop of hex.
private fn hex_from(out: Buf, bytes: View, at: Int) -> Buf {
  match {
    at >= len(bytes) -> out
    else -> hex_from(
      out: out
        |> push(byte: hex_digit(n: bytes[at] >> 4))
        |> push(byte: hex_digit(n: bytes[at] & 15)),
      bytes,
      at: at + 1
    )
  }
}

// The lower-case hex digit of 0 to 15.
private fn hex_digit(n: Int) -> Int {
  match {
    n < 10 -> '0' + n
    else -> 'a' + n - 10
  }
}

// The loop of base64 and base64url: each 3 bytes from `at` as 4 characters; then 2 left as 3, 1 as 2, padded
// with = unless `url`.
private fn base64_from(out: Buf, bytes: View, at: Int, url: Bool) -> Buf {
  let left = len(bytes) - at
  match {
    left >= 3 -> base64_from(
      out: out
        |> sextets(bits: (bytes[at] << 16) | (bytes[at + 1] << 8) | bytes[at + 2], count: 4, url),
      bytes,
      at: at + 3,
      url
    )
    left == 2 -> out
      |> sextets(bits: (bytes[at] << 16) | (bytes[at + 1] << 8), count: 3, url)
      |> padded(n: 1, url)
    left == 1 -> out |> sextets(bits: bytes[at] << 16, count: 2, url) |> padded(n: 2, url)
    else -> out
  }
}

// The first `count` of the four 6-bit values in 24 bits, as characters.
private fn sextets(out: Buf, bits: Int, count: Int, url: Bool) -> Buf {
  let two = out
    |> push(byte: base64_char(n: (bits >> 18) & 63, url))
    |> push(byte: base64_char(n: (bits >> 12) & 63, url))
  match count {
    2 -> two
    3 -> two |> push(byte: base64_char(n: (bits >> 6) & 63, url))
    _ -> two
      |> push(byte: base64_char(n: (bits >> 6) & 63, url))
      |> push(byte: base64_char(n: bits & 63, url))
  }
}

// n = signs, unless `url` (base64url has no padding).
private fn padded(out: Buf, n: Int, url: Bool) -> Buf {
  match {
    url -> out
    n == 2 -> out |> push(byte: '=') |> push(byte: '=')
    else -> out |> push(byte: '=')
  }
}

// The character for a 6-bit value.
private fn base64_char(n: Int, url: Bool) -> Int {
  match {
    n < 26 -> 'A' + n
    n < 52 -> 'a' + n - 26
    n < 62 -> '0' + n - 52
    n == 62 and url -> '-'
    n == 62 -> '+'
    url -> '_'
    else -> '/'
  }
}

// The 6-bit value of a character, or -1 for one that is not in the alphabet.
private fn base64_value(c: Int, url: Bool) -> Int {
  match {
    c >= 'A' and c <= 'Z' -> c - 'A'
    c >= 'a' and c <= 'z' -> c - 'a' + 26
    c >= '0' and c <= '9' -> c - '0' + 52
    c == '+' and not url -> 62
    c == '/' and not url -> 63
    c == '-' and url -> 62
    c == '_' and url -> 63
    else -> -1
  }
}

// Base64 characters without their padding, decoded, or None: when one is not in the alphabet, when 1 is left
// over a multiple of 4, and when the bits of the last character past the data are not zero (4 of them when 2
// are left over, 2 when 3 are).
private fn base64_decoded(text: View, url: Bool) -> Option[View] {
  let n = len(text)
  let last = match {
    n > 0 -> base64_value(c: text[n - 1], url)
    else -> 0
  }
  match {
    n % 4 == 1 -> None
    not base64_valid(text, url, at: 0) -> None
    n % 4 == 2 and last & 15 != 0 -> None
    n % 4 == 3 and last & 3 != 0 -> None
    else -> Some(value: freeze(buf: base64_bytes(out: buf(), text, at: 0, url)))
  }
}

// Is every character of text from `at` in the alphabet?
private fn base64_valid(text: View, url: Bool, at: Int) -> Bool {
  match {
    at >= len(text) -> True
    base64_value(c: text[at], url) < 0 -> False
    else -> base64_valid(text, url, at: at + 1)
  }
}

// The loop of base64_decoded, on characters already checked: each 4 from `at` as 3 bytes, then 3 left as 2 and
// 2 as 1.
private fn base64_bytes(out: Buf, text: View, at: Int, url: Bool) -> Buf {
  let left = len(text) - at
  let s0 = sextet(text, at, url)
  let s1 = sextet(text, at: at + 1, url)
  let s2 = sextet(text, at: at + 2, url)
  let s3 = sextet(text, at: at + 3, url)
  let bits = (s0 << 18) | (s1 << 12) | (s2 << 6) | s3
  match {
    left >= 4 -> base64_bytes(
      out: out
        |> push(byte: (bits >> 16) & 255)
        |> push(byte: (bits >> 8) & 255)
        |> push(byte: bits & 255),
      text,
      at: at + 4,
      url
    )
    left == 3 -> out |> push(byte: (bits >> 16) & 255) |> push(byte: (bits >> 8) & 255)
    left == 2 -> out |> push(byte: (bits >> 16) & 255)
    else -> out
  }
}

// The 6-bit value of the character at `at`, or 0 past the end.
private fn sextet(text: View, at: Int, url: Bool) -> Int {
  match {
    at < len(text) -> base64_value(c: text[at], url)
    else -> 0
  }
}
