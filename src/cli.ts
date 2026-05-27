import { runRustDoc, type RustDocAction, type RustDocArgs } from "./rustdoc.js"

const [action, ...rest] = process.argv.slice(2)

if (!action || action === "-h" || action === "--help") {
  printHelp()
  process.exit(action ? 0 : 1)
}

const parsed = parseArgs(rest)
const args: RustDocArgs = {
  action: action as RustDocAction,
}
if (parsed.query !== undefined) args.query = parsed.query
if (parsed.crate !== undefined) args.crate = parsed.crate
if (parsed.version !== undefined) args.version = parsed.version
if (parsed.item !== undefined) args.item = parsed.item
if (parsed.url !== undefined) args.url = parsed.url
if (parsed.limit !== undefined) args.limit = Number.parseInt(parsed.limit, 10)
if (parsed.refresh !== undefined) args.refresh = parsed.refresh === "true"

try {
  const output = await runRustDoc(args, { cwd: process.cwd() })
  console.log(output)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

function parseArgs(values: string[]): Record<string, string> {
  const parsed: Record<string, string> = {}

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!value) continue
    if (value === "--refresh") {
      parsed.refresh = "true"
      continue
    }
    if (!value.startsWith("--")) {
      if (!parsed.query) parsed.query = value
      continue
    }

    const key = value.slice(2)
    const next = values[index + 1]
    if (!next || next.startsWith("--")) {
      parsed[key] = "true"
      continue
    }
    parsed[key] = next
    index += 1
  }

  return parsed
}

function printHelp(): void {
  console.log(`Usage:
  npm run rustdoc -- search --query "Vec retain"
  npm run rustdoc -- item --crate serde --item Serialize
  npm run rustdoc -- crate --crate tokio
  npm run rustdoc -- migrations --query "Rust 2024 unsafe"
  npm run rustdoc -- url --url https://doc.rust-lang.org/std/vec/struct.Vec.html

Options:
  --query <text>     Search query.
  --crate <name>     Crate name, or std/core/alloc.
  --version <semver> Crate version, defaults to latest.
  --item <name>      Rust API item name.
  --url <url>        Explicit Rust documentation URL.
  --limit <n>        Result limit, 1-20.
  --refresh          Bypass local cache.
`)
}
