---
name: rust-docs
description: Use the project rustdoc tool to answer Rust API, crate documentation, and Rust version or edition migration questions with fetched source-backed information.
allowed-tools:
  - rustdoc
---

# Rust Docs Lookup

Use this skill when the task needs current or precise Rust documentation and the model may not have internet access.

Call the `rustdoc` tool before answering when the user asks about:

- Rust standard library APIs, traits, functions, macros, modules, or examples.
- Crate APIs or crate-level guides from docs.rs or crates.io.
- Rust edition changes, version migration notes, release notes, compatibility changes, deprecations, or newly stabilized APIs.
- Any Rust documentation detail where stale model memory could produce an incorrect answer.

Prefer actions this way:

- Use `item` when both a crate/std library area and an API name are known.
- Use `crate` for crate overview docs, latest version, README-like guidance, and feature metadata.
- Use `search` for broad API discovery.
- Use `migrations` for edition migration and release-note questions.
- Use `url` when the user gives a Rust documentation URL.

Answer from the tool output, and cite the returned source URLs. If tool results are partial, state that clearly instead of filling gaps from memory.
