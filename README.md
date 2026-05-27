# OpenCode Rustdoc Tool

This project adds a Rust documentation lookup path for OpenCode models that do not have direct internet access.

It provides:

- `.opencode/tools/rustdoc.ts`: an OpenCode custom tool backed by host-network fetches and local cache.
- `.opencode/skills/rust-docs/SKILL.md`: instructions that tell the agent when and how to call the tool.
- `src/`: a TypeScript library and CLI for the same lookup behavior outside OpenCode.

## Install

```sh
npm install
```

OpenCode discovers project-local custom tools from `.opencode/tools/` and skills from `.opencode/skills/`.

## CLI

```sh
npm run rustdoc -- search --query "Vec retain"
npm run rustdoc -- item --crate serde --item Serialize
npm run rustdoc -- crate --crate tokio
npm run rustdoc -- migrations --query "Rust 2024 unsafe"
npm run rustdoc -- url --url https://doc.rust-lang.org/std/vec/struct.Vec.html
```

## Tool Actions

- `search`: searches Rust std docs first, then crates.io when no crate is specified.
- `crate`: returns crate metadata plus cleaned crate root documentation.
- `item`: searches a crate's rustdoc `all.html`, fetches the best matching item, and returns cleaned documentation.
- `migrations`: searches Rust release notes and edition-guide pages for migration-related changes.
- `url`: fetches and cleans an explicit Rust documentation URL.
- `sources`: lists the upstream documentation sources used by the tool.

Fetched pages are cached under `.rustdoc-cache/`. Use `refresh: true` in the OpenCode tool, or `--refresh` in the CLI, to bypass cache.
