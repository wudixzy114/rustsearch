# rustsearch

> **给 OpenCode Agent 用的 Rust 文档查询工具：让 LLM 在断网/不可信模型记忆下，也能拿到最新的 std / docs.rs / Edition Guide 原文。**

## 项目定位 / 背景

`rustsearch`（package name: `opencode-rustdoc-tool`）解决一个非常具体的问题：**当 OpenCode 模型不能直接访问互联网、或训练数据已经过期到危险的程度时，Rust 相关问答（API 签名、trait 约束、Rust 2024 unsafe 规则）极易给出过时的答案**。本项目提供了一个"host 网络 + 本地缓存"的兜底工具——Agent 调一个 `rustdoc` tool，就能拿到**当下、上游、清洗过**的 Rust 官方文档片段。

它提供两个交付物：

1. **OpenCode 全局自定义工具**（`.opencode-global/tools/rustdoc.js`）—— 安装到 `~/.config/opencode/tools/` 后，OpenCode 任何 subagent 都能直接调用。
2. **TypeScript 库 + CLI**（`src/rustdoc.ts` + `src/cli.ts`）—— 同样的查询能力脱离 OpenCode 也能用，本地命令行检索。

上游数据源全部走 host 网络：
- `https://doc.rust-lang.org/std/` — Rust 标准库
- `https://doc.rust-lang.org/book/` — The Book
- `https://doc.rust-lang.org/reference/` — Reference
- `https://doc.rust-lang.org/edition-guide/` — Edition 迁移指南
- `https://doc.rust-lang.org/cargo/` / `https://doc.rust-lang.org/rustdoc/`
- `https://docs.rs` — 第三方 crate 文档
- `https://crates.io` — crate 元数据

抓回的 HTML 会用自研的 `cleanHtml` 工具剥掉侧边栏、script、style、`<nav>` 等 chrome，仅保留正文与代码块，输出 Markdown 风格的纯文本加三引号代码围栏。所有结果按 URL hash 缓存到 `.rustdoc-cache/`，TTL 默认 14 天，`refresh: true` 强制绕过。

## 仓库结构

```
rustsearch/
├── package.json                     # opencode-rustdoc-tool v0.1.0
├── tsconfig.json                     # ES2022 + NodeNext + strict + exactOptionalPropertyTypes
├── README.md
├── src/
│   ├── rustdoc.ts                   # 核心 RustDocClient（~22KB）
│   │                                #   - search/crate/item/migrations/url/sources 6 个 action
│   │                                #   - .rustdoc-cache/ 14天 TTL 文件缓存
│   │                                #   - HTML 清洗 + 文本提取 + Rustdoc item 抽取
│   │                                #   - MIGRATION_SOURCES: 11 个 edition/迁移相关 URL
│   └── cli.ts                       # 简单 CLI: --query/--crate/--item/--url/--limit/--refresh
├── tests/
│   └── rustdoc.test.ts              # node:test：cleanHtml / extractRustdocItems / rankResults
└── .opencode-global/                 # 预生成的全局 OpenCode 资源（直接复制到 ~/.config/opencode/）
    ├── skills/
    │   └── rust-docs/SKILL.md       # 触发条件：Rust API/crate/迁移问题
    └── tools/
        └── rustdoc.js               # OpenCode tool wrapper（调 src/rustdoc.ts）
```

## 技术栈

| 维度 | 选型 | 版本/说明 |
|------|------|-----------|
| 运行时 | Node.js | >= 20 |
| 语言 | TypeScript | ^5.9.3（ESM、NodeNext、strict、noUncheckedIndexedAccess） |
| 测试 | node --test | 内置测试器，通过 tsx 跑 TS |
| OpenCode 集成 | @opencode-ai/plugin | ^1.15.11（`tool()` 工厂 + zod schema） |
| 执行器 | tsx | ^4.20.6（开发与测试均用） |
| 缓存 | node:fs/promises + 哈希 | 基于 URL/查询哈希的 14 天文件缓存 |
| HTTP | node:fetch | 标准库 fetch（无第三方 HTTP 依赖） |

## 核心模块 / 特性

### 1. 6 个查询 action
```sh
# 综合搜索（先 std，缺 crate 则走 crates.io）
npm run rustdoc -- search --query "Vec retain"

# 查具体 crate 根文档 + crates.io 元数据
npm run rustdoc -- crate --crate tokio

# 查具体 API 条目（自动从 all.html 选最高相关项）
npm run rustdoc -- item --crate serde --item Serialize

# 查标准库条目
npm run rustdoc -- std --item HashMap

# Rust edition / 迁移资料
npm run rustdoc -- migrations --query "Rust 2024 unsafe"

# 显式 URL 抓取并清洗
npm run rustdoc -- url --url https://doc.rust-lang.org/std/vec/struct.Vec.html

# 列出所有可信来源
npm run rustdoc -- sources
```

### 2. OpenCode Tool 适配层
`.opencode-global/tools/rustdoc.js` 用 `@opencode-ai/plugin` 的 `tool({ description, args, execute })` 工厂把 6 个 action 暴露成 OpenCode 内部工具，参数 schema 走 zod（query/crate/version/item/url 全部 `.optional()`，refresh 是 boolean，limit 限制 1-20）。`execute` 内调用编译后的 `runRustDoc(args, { cwd })`。

### 3. Skill 触发器
`.opencode-global/skills/rust-docs/SKILL.md` 教 Agent **何时**调：
- Rust std API、trait、宏、模块、示例
- 第三方 crate API 或 crate-level guide
- Edition 改动、release note、兼容性变化、deprecation、新稳定 API
- 任何"模型记忆可能已过期"的 Rust 文档细节

并教 Agent 选用 `item` 优于 `crate` 优于 `search` 优于 `migrations` 优于 `url` 的优先级。

### 4. HTML 清洗 + 排序
- `cleanHtml(html)` —— 剥 `<script>`/`<style>`/`<nav>`，保留 `<main>`、`<pre>`、标题；输出 `{ title, text }`
- `extractRustdocItems(html, baseUrl)` —— 从 `all.html` 抽 `<a href="struct.Vec.html">Vec</a>`，推导出 kind（struct/trait/fn/macro/method）
- `rankResults(items, query)` —— 精确匹配 `Vec` 优先于 `VecDeque` / `Vec::retain`

### 5. 缓存与刷新
默认 14 天 TTL，cache key 是 URL hash；OpenCode 端传 `refresh: true` / CLI 端传 `--refresh` 立即重抓。

## 已完成 / 进行中

- ✅ 6 个 query action 全部实现（search / crate / item / migrations / url / sources）
- ✅ `.rustdoc-cache/` 14 天文件缓存
- ✅ `cleanHtml` / `extractRustdocItems` / `rankResults` 核心工具函数
- ✅ MIGRATION_SOURCES 11 个 edition/迁移 URL 预置
- ✅ OpenCode global 适配层（tool.js + SKILL.md）开箱即用
- ✅ node:test 单元测试 3 个（cleanHtml / extractRustdocItems / rankResults）
- ✅ CLI 入口 + `--help`
- ⏳ OpenCode global 部署脚本（需手动复制到 `~/.config/opencode/tools/` 与 `skills/`）
- ⏳ 网络异常 / 404 / 重定向 / 大文件截断的容错单元测试

## 本地开发

```bash
# 安装
npm install

# 类型检查
npm run check

# 跑测试
npm test

# CLI 试用
npm run rustdoc -- search --query "Vec retain"
npm run rustdoc -- item --crate serde --item Serialize
npm run rustdoc -- migrations --query "Rust 2024 unsafe"

# 全局部署到 OpenCode（手动）
mkdir -p ~/.config/opencode/tools
cp .opencode-global/tools/rustdoc.js ~/.config/opencode/tools/
mkdir -p ~/.config/opencode/skills/rust-docs
cp .opencode-global/skills/rust-docs/SKILL.md ~/.config/opencode/skills/rust-docs/
```

`.rustdoc-cache/` 默认落在 cwd 下，可用 `cwd` 参数显式控制。

## 状态

**v0.1.0** —— 6 个 action、缓存、CLI、OpenCode 适配、单测齐全，可作为本地 Rust 文档助手直接用。

## License

MIT
