import assert from "node:assert/strict"
import test from "node:test"
import { cleanHtml, extractRustdocItems, rankResults } from "../src/rustdoc.js"

test("cleanHtml strips chrome and preserves useful text", () => {
  const cleaned = cleanHtml(`
    <html>
      <head><title>Vec - Rust</title><style>.x{}</style></head>
      <body>
        <nav>Search navigation</nav>
        <main>
          <h1>Struct Vec</h1>
          <p>A contiguous growable array type.</p>
          <pre>let mut v = Vec::new();</pre>
        </main>
        <script>alert(1)</script>
      </body>
    </html>
  `)

  assert.equal(cleaned.title, "Vec")
  assert.match(cleaned.text, /Struct Vec/)
  assert.match(cleaned.text, /contiguous growable array/)
  assert.match(cleaned.text, /```rust\nlet mut v = Vec::new\(\);/)
  assert.doesNotMatch(cleaned.text, /Search navigation/)
  assert.doesNotMatch(cleaned.text, /alert/)
})

test("extractRustdocItems finds item links from all.html", () => {
  const items = extractRustdocItems(`
    <a href="struct.Vec.html">Vec</a>
    <a href="trait.Iterator.html#method.map">Iterator::map</a>
    <a href="sidebar-items.js">ignore</a>
  `, "https://doc.rust-lang.org/std/vec/all.html")

  assert.equal(items.length, 2)
  assert.equal(items[0]?.kind, "struct")
  assert.equal(items[0]?.url, "https://doc.rust-lang.org/std/vec/struct.Vec.html")
  assert.equal(items[1]?.kind, "trait")
})

test("rankResults prefers exact API name matches", () => {
  const ranked = rankResults([
    { name: "VecDeque", kind: "struct" },
    { name: "Vec", kind: "struct" },
    { name: "Vec::retain", kind: "method" },
  ], "Vec")

  assert.equal(ranked[0]?.name, "Vec")
})
