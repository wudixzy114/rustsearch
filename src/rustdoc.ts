import { createHash } from "node:crypto"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"

export type RustDocAction = "search" | "crate" | "item" | "migrations" | "url" | "sources"

export interface RustDocArgs {
  action: RustDocAction
  query?: string
  crate?: string
  version?: string
  item?: string
  url?: string
  limit?: number
  refresh?: boolean
}

export interface RustDocOptions {
  cwd?: string
  cacheTtlMs?: number
}

interface FetchOptions {
  refresh?: boolean
}

interface SearchResult {
  name: string
  kind: string
  url: string
  score: number
  snippet?: string
}

interface CrateSummary {
  crate: {
    name: string
    max_version?: string
    description?: string
    documentation?: string
    repository?: string
    homepage?: string
  }
  versions?: Array<{ num: string; yanked: boolean }>
}

const DEFAULT_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 14
const USER_AGENT = "opencode-rustdoc-tool/0.1 (+https://opencode.ai)"
const MAX_TEXT_CHARS = 9_000

const MIGRATION_SOURCES = [
  "https://doc.rust-lang.org/edition-guide/",
  "https://doc.rust-lang.org/edition-guide/rust-2024/index.html",
  "https://doc.rust-lang.org/edition-guide/rust-2024/summary.html",
  "https://doc.rust-lang.org/edition-guide/rust-2024/unsafe-attributes.html",
  "https://doc.rust-lang.org/edition-guide/rust-2024/unsafe-op-in-unsafe-fn.html",
  "https://doc.rust-lang.org/edition-guide/rust-2021/index.html",
  "https://doc.rust-lang.org/edition-guide/rust-2021/intoiterator-for-arrays.html",
  "https://doc.rust-lang.org/edition-guide/rust-2021/disjoint-capture-in-closures.html",
  "https://doc.rust-lang.org/edition-guide/rust-2018/index.html",
  "https://doc.rust-lang.org/releases.html",
  "https://doc.rust-lang.org/cargo/reference/resolver.html",
]

export async function runRustDoc(args: RustDocArgs, options: RustDocOptions = {}): Promise<string> {
  const client = new RustDocClient(options.cwd ?? process.cwd(), options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS)
  const limit = clampLimit(args.limit)

  switch (args.action) {
    case "sources":
      return formatSources()
    case "url":
      return await client.fetchExplicitUrl(required(args.url, "url"), args)
    case "crate":
      return await client.fetchCrate(required(args.crate, "crate"), args.version, args)
    case "item":
      return await client.fetchItem(required(args.crate, "crate"), required(args.item, "item"), {
        ...args,
        limit,
      })
    case "migrations":
      return await client.searchMigrations(required(args.query, "query"), { ...args, limit })
    case "search":
      return await client.search(required(args.query, "query"), { ...args, limit })
    default:
      return assertNever(args.action)
  }
}

export function cleanHtml(html: string): { title: string; text: string } {
  const title = decodeEntities(matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ?? "Untitled")
    .replace(/\s+-\s+Rust$/i, "")
    .trim()

  let body = matchFirst(html, /<main\b[^>]*>([\s\S]*?)<\/main>/i)
    ?? matchFirst(html, /<body\b[^>]*>([\s\S]*?)<\/body>/i)
    ?? html

  body = body
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
    .replace(/<rustdoc-topbar\b[\s\S]*?<\/rustdoc-topbar>/gi, " ")
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form\b[\s\S]*?<\/form>/gi, " ")
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, "\n\n$2\n")
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, code: string) => {
      return `\n\n\`\`\`rust\n${stripTags(code)}\n\`\`\`\n`
    })
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, code: string) => `\`${stripTags(code)}\``)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")

  const text = normalizeText(decodeEntities(body))
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  return { title, text: trimChars(text, MAX_TEXT_CHARS) }
}

export function extractRustdocItems(html: string, baseUrl: string): SearchResult[] {
  const rows = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
  const results: SearchResult[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    const href = decodeEntities(row[1] ?? "").trim()
    const rawLabel = decodeEntities(stripTags(row[2] ?? "")).trim()
    if (!href || !rawLabel || !isRustdocItemHref(href)) continue

    const name = rawLabel.replace(/\s+/g, " ")
    const url = new URL(href, baseUrl).toString()
    if (seen.has(url)) continue
    seen.add(url)

    results.push({
      name,
      kind: inferKindFromHref(href),
      url,
      score: 0,
    })
  }

  return results
}

export function rankResults<T extends { name: string; kind?: string; snippet?: string; score?: number }>(
  results: T[],
  query: string,
): T[] {
  const queryTokens = tokenize(query)
  const normalizedQuery = normalizeToken(query)

  return results
    .map((result) => {
      const haystack = normalizeToken(`${result.name} ${result.kind ?? ""} ${result.snippet ?? ""}`)
      let score = 0
      if (normalizeToken(result.name) === normalizedQuery) score += 100
      if (normalizeToken(result.name).endsWith(normalizedQuery)) score += 60
      if (haystack.includes(normalizedQuery)) score += 30
      for (const token of queryTokens) {
        const normalizedName = normalizeToken(result.name)
        if (/[A-Z]/.test(query) && result.name.includes(tokenToCaseHint(query, token))) score += 45
        if (normalizedName === token) score += queryTokens.length > 1 ? 20 : 80
        if (normalizedName.endsWith(` ${token}`) || normalizedName.endsWith(token)) score += queryTokens.length > 1 ? 20 : 35
        if (normalizedName.includes(token)) score += 15
        if (haystack.includes(token)) score += token.length >= 4 ? 8 : 3
      }
      return { ...result, score }
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.name.localeCompare(b.name))
}

class RustDocClient {
  private cache: Cache

  constructor(cwd: string, ttlMs: number) {
    this.cache = new Cache(path.join(cwd, ".rustdoc-cache"), ttlMs)
  }

  async search(query: string, args: RustDocArgs & { limit: number }): Promise<string> {
    if (args.crate) {
      return await this.fetchItem(args.crate, query, { ...args, item: query })
    }

    const stdResults = await this.searchRustdocItems("std", undefined, query, args)
    const crates = await this.searchCrates(query, args)

    const lines = [
      `Rust documentation search for "${query}"`,
      "",
      "Standard library matches:",
      ...formatResultList(stdResults.slice(0, args.limit)),
      "",
      "Crates.io matches:",
      ...crates.slice(0, args.limit).map((crateResult, index) => {
        const suffix = crateResult.snippet ? ` - ${crateResult.snippet}` : ""
        return `${index + 1}. ${crateResult.name} (${crateResult.kind})${suffix}\n   ${crateResult.url}`
      }),
    ]

    return lines.join("\n").trim()
  }

  async fetchCrate(crateName: string, version: string | undefined, args: RustDocArgs): Promise<string> {
    const crateId = normalizeCrateName(crateName)

    if (isStdCrate(crateId)) {
      const url = stdCrateUrl(crateId)
      return await this.fetchCleanPage(url, `Rust ${crateId} documentation`, args)
    }

    const metadataUrl = `https://crates.io/api/v1/crates/${encodeURIComponent(crateId)}`
    const metadata = await this.fetchJson<CrateSummary>(metadataUrl, args)
    const docsUrl = docsRsCrateRoot(crateId, version)
    const cleaned = await this.tryFetchCleanPage(docsUrl, args)

    const latest = metadata.crate.max_version ?? version ?? "latest"
    const sourceLines = [
      `Crate: ${metadata.crate.name}`,
      `Latest version: ${latest}`,
      metadata.crate.description ? `Description: ${metadata.crate.description}` : undefined,
      metadata.crate.documentation ? `Documentation: ${metadata.crate.documentation}` : undefined,
      metadata.crate.repository ? `Repository: ${metadata.crate.repository}` : undefined,
      metadata.crate.homepage ? `Homepage: ${metadata.crate.homepage}` : undefined,
      `Crates.io: https://crates.io/crates/${crateId}`,
      `Docs.rs: ${docsUrl}`,
    ].filter(Boolean)

    if (!cleaned) {
      return `${sourceLines.join("\n")}\n\nCould not fetch cleaned docs.rs crate root.`
    }

    return `${sourceLines.join("\n")}\n\n${cleaned}`
  }

  async fetchItem(
    crateName: string,
    item: string,
    args: RustDocArgs & { limit: number },
  ): Promise<string> {
    const member = extractMemberLookup(item)
    const results = await this.searchRustdocItems(crateName, args.version, member?.container ?? item, args)
    if (results.length === 0) {
      return `No rustdoc item matches found for "${item}" in ${crateName}.`
    }

    let best = results[0]
    if (!best) return `No rustdoc item matches found for "${item}" in ${crateName}.`

    let sourceUrl = best.url
    let cleaned: string | undefined

    if (member) {
      for (const candidate of results.slice(0, Math.max(args.limit, 10))) {
        const rawHtml = await this.tryFetchText(candidate.url, args)
        const section = rawHtml ? extractRustdocSection(rawHtml, candidateSectionIds(member.member)) : undefined
        if (!section) continue

        best = candidate
        sourceUrl = `${candidate.url}#${section.id}`
        cleaned = [`# ${candidate.name}::${member.member}`, `Source: ${sourceUrl}`, "", section.text].join("\n").trim()
        break
      }
    }

    cleaned ??= await this.tryFetchCleanPage(best.url, args)
    const otherMatches = results.slice(1, args.limit)

    return [
      `Best match: ${best.name} (${best.kind})`,
      `Source: ${sourceUrl}`,
      "",
      cleaned ?? "Could not fetch cleaned item page.",
      "",
      otherMatches.length > 0 ? "Other matches:" : "",
      ...formatResultList(otherMatches),
    ].filter((line) => line !== "").join("\n")
  }

  async fetchExplicitUrl(url: string, args: RustDocArgs): Promise<string> {
    const parsed = new URL(url)
    if (!isAllowedRustDocHost(parsed.hostname)) {
      throw new Error(`Refusing URL outside known Rust documentation hosts: ${url}`)
    }
    return await this.fetchCleanPage(parsed.toString(), "Rust documentation URL", args)
  }

  async searchMigrations(query: string, args: RustDocArgs & { limit: number }): Promise<string> {
    const queryTokens = tokenize(query)
    const matches: SearchResult[] = []

    for (const url of MIGRATION_SOURCES) {
      const cleaned = await this.tryFetchCleanPage(url, args)
      if (!cleaned) continue

      const [titleLine = "Rust migration source", ...rest] = cleaned.split("\n")
      const body = rest.join("\n")
      const paragraphs = body
        .split(/\n{2,}/)
        .map((part) => part.trim())
        .filter((part) => part && part !== "Source" && !part.startsWith("Source:"))
      for (const paragraph of paragraphs) {
        const normalized = normalizeToken(paragraph)
        let score = 0
        for (const token of queryTokens) {
          if (normalized.includes(token)) score += token.length >= 4 ? 10 : 4
        }
        if (score === 0) continue
        matches.push({
          name: titleLine.replace(/^#\s*/, ""),
          kind: "migration/release-note",
          url,
          score,
          snippet: trimChars(paragraph, 700),
        })
      }
    }

    const ranked = matches.sort((a, b) => b.score - a.score).slice(0, args.limit)
    if (ranked.length === 0) {
      return `No migration or release-note matches found for "${query}". Sources searched:\n${MIGRATION_SOURCES.join("\n")}`
    }

    return [
      `Rust migration/release-note search for "${query}"`,
      "",
      ...ranked.map((match, index) => {
        return `${index + 1}. ${match.name}\n   Source: ${match.url}\n   ${match.snippet}`
      }),
    ].join("\n")
  }

  private async searchRustdocItems(
    crateName: string,
    version: string | undefined,
    query: string,
    args: RustDocArgs,
  ): Promise<SearchResult[]> {
    const crateId = normalizeCrateName(crateName)
    const allUrl = isStdCrate(crateId)
      ? `${stdCrateUrl(crateId).replace(/\/$/, "")}/all.html`
      : docsRsAllItems(crateId, version)

    const html = await this.fetchText(allUrl, args)
    const results = extractRustdocItems(html, allUrl)
    return rankResults(results, query).filter((result) => result.score > 0)
  }

  private async searchCrates(query: string, args: RustDocArgs): Promise<SearchResult[]> {
    const url = `https://crates.io/api/v1/crates?q=${encodeURIComponent(query)}&per_page=${args.limit}`
    const payload = await this.fetchJson<{ crates: Array<{
      id: string
      name: string
      max_version: string
      description?: string
      documentation?: string
      repository?: string
    }> }>(url, args)

    return payload.crates.map((crateItem) => {
      const result: SearchResult = {
        name: crateItem.name,
        kind: `crate ${crateItem.max_version}`,
        url: crateItem.documentation || `https://docs.rs/${crateItem.name}/latest/${crateItem.name.replace(/-/g, "_")}/`,
        score: 0,
      }
      if (crateItem.description !== undefined) result.snippet = crateItem.description
      return result
    })
  }

  private async fetchCleanPage(url: string, heading: string, args: RustDocArgs): Promise<string> {
    const html = await this.fetchText(url, args)
    const cleaned = cleanHtml(html)
    return [`# ${cleaned.title || heading}`, `Source: ${url}`, "", cleaned.text].join("\n").trim()
  }

  private async tryFetchCleanPage(url: string, args: RustDocArgs): Promise<string | undefined> {
    try {
      return await this.fetchCleanPage(url, "Rust documentation", args)
    } catch {
      return undefined
    }
  }

  private async tryFetchText(url: string, args: RustDocArgs): Promise<string | undefined> {
    try {
      return await this.fetchText(url, args)
    } catch {
      return undefined
    }
  }

  private async fetchJson<T>(url: string, args: FetchOptions): Promise<T> {
    const text = await this.fetchText(url, args)
    return JSON.parse(text) as T
  }

  private async fetchText(url: string, args: FetchOptions): Promise<string> {
    return await this.cache.get(url, async () => {
      const response = await fetch(url, {
        headers: {
          "accept": "text/html,application/json,text/plain;q=0.9,*/*;q=0.8",
          "user-agent": USER_AGENT,
        },
      })
      if (!response.ok) {
        throw new Error(`Fetch failed for ${url}: ${response.status} ${response.statusText}`)
      }
      return await response.text()
    }, args.refresh)
  }
}

class Cache {
  constructor(private readonly dir: string, private readonly ttlMs: number) {}

  async get(url: string, fetcher: () => Promise<string>, refresh = false): Promise<string> {
    await mkdir(this.dir, { recursive: true })
    const file = path.join(this.dir, `${createHash("sha256").update(url).digest("hex")}.txt`)

    if (!refresh) {
      const cached = await this.readFresh(file)
      if (cached !== undefined) return cached
    }

    try {
      const text = await fetcher()
      await writeFile(file, text, "utf8")
      return text
    } catch (error) {
      const stale = await this.readAny(file)
      if (stale !== undefined) return stale
      throw error
    }
  }

  private async readFresh(file: string): Promise<string | undefined> {
    try {
      const info = await stat(file)
      if (Date.now() - info.mtimeMs > this.ttlMs) return undefined
      return await readFile(file, "utf8")
    } catch {
      return undefined
    }
  }

  private async readAny(file: string): Promise<string | undefined> {
    try {
      return await readFile(file, "utf8")
    } catch {
      return undefined
    }
  }
}

function docsRsCrateRoot(crateName: string, version: string | undefined): string {
  const docsCrate = crateName.replace(/-/g, "_")
  return `https://docs.rs/${crateName}/${version ?? "latest"}/${docsCrate}/`
}

function docsRsAllItems(crateName: string, version: string | undefined): string {
  const docsCrate = crateName.replace(/-/g, "_")
  return `https://docs.rs/${crateName}/${version ?? "latest"}/${docsCrate}/all.html`
}

function stdCrateUrl(crateName: string): string {
  return `https://doc.rust-lang.org/${crateName}/`
}

function normalizeCrateName(crateName: string): string {
  return crateName.trim().replace(/^crate:/, "").replace(/^std::/, "std").replace(/^core::/, "core")
}

function isStdCrate(crateName: string): boolean {
  return ["std", "core", "alloc", "proc_macro", "test"].includes(crateName)
}

function isAllowedRustDocHost(hostname: string): boolean {
  return hostname === "doc.rust-lang.org"
    || hostname === "docs.rs"
    || hostname.endsWith(".docs.rs")
    || hostname === "crates.io"
}

function isRustdocItemHref(href: string): boolean {
  return /(?:^|\/)(?:struct|enum|trait|fn|type|mod|macro|constant|static|union|primitive|attr)\.[^/?#]+\.html(?:#.*)?$/i.test(href)
    || /(?:^|\/)[^/?#]+\/index\.html$/i.test(href)
}

function inferKindFromHref(href: string): string {
  const match = href.match(/(?:^|\/)(struct|enum|trait|fn|type|mod|macro|constant|static|union|primitive|attr)\./i)
  if (match?.[1]) return match[1].toLowerCase()
  if (href.endsWith("/index.html")) return "module"
  return "item"
}

function extractMemberLookup(query: string): { container: string; member: string } | undefined {
  const explicit = query.match(/^\s*([A-Za-z_][\w]*(?:::[A-Za-z_][\w]*)*)::([A-Za-z_][\w]*)\s*$/)
  if (explicit?.[1] && explicit[2]) {
    const container = explicit[1].split("::").at(-1)
    if (container) return { container, member: explicit[2] }
  }

  const words = query.trim().split(/\s+/).filter(Boolean)
  if (words.length === 2 && /^[A-Za-z_]\w*$/.test(words[0] ?? "") && /^[A-Za-z_]\w*$/.test(words[1] ?? "")) {
    return { container: words[0] ?? "", member: words[1] ?? "" }
  }

  return undefined
}

function candidateSectionIds(member: string): string[] {
  return [
    `method.${member}`,
    `tymethod.${member}`,
    `associatedconstant.${member}`,
    `associatedtype.${member}`,
    `impl-${member}`,
  ]
}

function extractRustdocSection(html: string, ids: string[]): { id: string; text: string } | undefined {
  for (const id of ids) {
    const index = html.indexOf(`id="${id}"`)
    if (index < 0) continue

    const detailsStart = html.lastIndexOf("<details", index)
    const sectionStart = html.lastIndexOf("<section", index)
    const start = detailsStart >= 0 && index - detailsStart < 1_500 ? detailsStart : Math.max(0, sectionStart)
    const detailsEnd = html.indexOf("</details>", index)
    const nextSection = html.indexOf("<section", index + id.length)
    const end = detailsEnd >= 0 ? detailsEnd + "</details>".length : nextSection > index ? nextSection : index + 8_000
    const slice = html.slice(start, end)
    const cleaned = cleanHtml(`<main>${slice}</main>`)
    return { id, text: cleaned.text }
  }

  return undefined
}

function formatResultList(results: SearchResult[]): string[] {
  if (results.length === 0) return ["No matches."]
  return results.map((result, index) => {
    const snippet = result.snippet ? `\n   ${trimChars(result.snippet, 220)}` : ""
    return `${index + 1}. ${result.name} (${result.kind})\n   ${result.url}${snippet}`
  })
}

function formatSources(): string {
  return [
    "Rust documentation sources used by this tool:",
    "- Standard library rustdoc: https://doc.rust-lang.org/std/",
    "- Core/alloc rustdoc: https://doc.rust-lang.org/core/ and https://doc.rust-lang.org/alloc/",
    "- Crate API docs: https://docs.rs/",
    "- Crate metadata/search: https://crates.io/api/v1/crates",
    "- Edition Guide: https://doc.rust-lang.org/edition-guide/",
    "- Release notes: https://doc.rust-lang.org/releases.html",
    "- Cargo resolver migration notes: https://doc.rust-lang.org/cargo/reference/resolver.html",
  ].join("\n")
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`Missing required argument: ${name}`)
  return value.trim()
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit ?? 0) || limit === undefined) return 5
  return Math.max(1, Math.min(20, Math.trunc(limit)))
}

function matchFirst(value: string, regex: RegExp): string | undefined {
  return regex.exec(value)?.[1]
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ")
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " ",
    rsquo: "'",
    lsquo: "'",
    rdquo: "\"",
    ldquo: "\"",
    hellip: "...",
    mdash: "-",
    ndash: "-",
  }

  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    return named[entity.toLowerCase()] ?? match
  })
}

function normalizeText(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
}

function trimChars(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max).trimEnd()}\n\n[truncated]`
}

function tokenize(value: string): string[] {
  return normalizeToken(value)
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length > 1)
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/::/g, " ").replace(/[^a-z0-9_]+/g, " ").trim()
}

function tokenToCaseHint(query: string, normalizedToken: string): string {
  return query.split(/[^A-Za-z0-9_]+/).find((part) => part.toLowerCase() === normalizedToken) ?? normalizedToken
}

function assertNever(value: never): never {
  throw new Error(`Unhandled action: ${value}`)
}
