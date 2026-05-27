import { tool } from "@opencode-ai/plugin"
import { runRustDoc, type RustDocArgs } from "../../src/rustdoc.js"

export default tool({
  description:
    "Search and clean Rust std, docs.rs crate docs, crates.io metadata, and Rust edition/release migration notes using host networking and local cache.",
  args: {
    action: tool.schema
      .enum(["search", "crate", "item", "migrations", "url", "sources"])
      .describe("Lookup mode to run."),
    query: tool.schema
      .string()
      .optional()
      .describe("Search query for broad search or migration lookups."),
    crate: tool.schema
      .string()
      .optional()
      .describe("Crate name, or std/core/alloc for Rust standard library docs."),
    version: tool.schema
      .string()
      .optional()
      .describe("Crate version. Defaults to latest on docs.rs."),
    item: tool.schema
      .string()
      .optional()
      .describe("API item name for item lookup, such as Vec, Iterator::map, Serialize, or tokio::spawn."),
    url: tool.schema
      .string()
      .url()
      .optional()
      .describe("Explicit Rust documentation URL to fetch and clean."),
    limit: tool.schema
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("Maximum number of results to return."),
    refresh: tool.schema
      .boolean()
      .optional()
      .describe("Bypass local cache and fetch fresh upstream content."),
  },
  async execute(args, context) {
    const cwd = context.worktree || context.directory || process.cwd()
    const rustdocArgs: RustDocArgs = { action: args.action }
    if (args.query !== undefined) rustdocArgs.query = args.query
    if (args.crate !== undefined) rustdocArgs.crate = args.crate
    if (args.version !== undefined) rustdocArgs.version = args.version
    if (args.item !== undefined) rustdocArgs.item = args.item
    if (args.url !== undefined) rustdocArgs.url = args.url
    if (args.limit !== undefined) rustdocArgs.limit = args.limit
    if (args.refresh !== undefined) rustdocArgs.refresh = args.refresh
    return await runRustDoc(rustdocArgs, { cwd })
  },
})
