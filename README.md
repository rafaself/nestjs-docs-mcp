# nestjs-docs-mcp

A standalone NestJS application using the official [`@nestjs/mcp`](https://docs.nestjs.com/mcp/overview) package.

The server runs locally over [stdio](https://docs.nestjs.com/mcp/transports) and exposes two read-only tools: `search_docs` finds relevant sections, and `fetch_docs` retrieves a document by its deterministic ID. Documentation ingestion and search indexing run as separate commands. Tool arguments do not select a documentation version.

## Requirements

- Node.js 24 LTS (24.15.0 or newer); `.nvmrc` selects the 24 release line.
- npm (included with Node.js).

## Setup and run

```sh
nvm use
npm ci
npm run build
```

## Connect an MCP client

Configure your MCP client to launch the compiled entry point directly, replacing the path with this repository's absolute path:

```json
{
  "mcpServers": {
    "nestjs-docs-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/nestjs-docs-mcp/dist/main.js"]
    }
  }
}
```

Use Node.js 24 from the client's environment, or set `command` to the absolute path of its Node.js executable. The client starts the process and communicates through stdin/stdout; there is no HTTP listener or port configuration.

Stdout is reserved for MCP protocol messages. Nest startup logs and errors go to stderr through the official `McpStdioLogger`. Closing stdin ends the MCP connection and closes the application context. SIGINT and SIGTERM also trigger Nest shutdown hooks.

For a manual launch, use `node dist/main.js` or `npm run --silent start:prod`. Use the direct Node.js command in MCP client configurations to avoid npm banners on stdout. `npm run start:dev` rebuilds and restarts on changes for development; its compiler output makes it unsuitable as an MCP client command.

## Ingest documentation

```sh
npm run docs:ingest
# Optional output path and soft chunk size, measured in characters:
npm run docs:ingest -- --output /tmp/nestjs-documentation.json --max-chars 4000
```

The command builds the project, resolves the current `master` commit of the [official documentation repository](https://github.com/nestjs/docs.nestjs.com), and downloads original Markdown from `content/`. The [tracked navigation](https://github.com/nestjs/docs.nestjs.com/blob/master/src/app/shared/nav/nav-items.ts) selects published chapters; the upstream [content aliases](https://github.com/nestjs/docs.nestjs.com/blob/master/tools/generate-llms-txt.ts) map renamed source files to canonical URLs, such as `components.md` to `/providers`. Every source and metadata download uses the same immutable commit. Static navigation data is parsed with JSON5; upstream code and examples are never executed. No HTML scraping is used.

The default output is `data/documentation.json` (ignored by Git). It contains a source manifest and sorted documents, each with:

- A stable document ID derived from the repository URL and source path, plus the title and canonical URL.
- The source commit, path, immutable raw URL, and SHA-256 hash of the original source bytes.
- Normalized Markdown, its SHA-256 hash, and ordered headings with levels, titles, and the site's anchor slugs.
- Ordered chunks with heading ancestry, section URLs, source revisions, content hashes, and code examples with languages and optional filenames.

Normalization removes the UTF-8 BOM, standardizes line endings, removes presentation banners, and decodes the docs' literal-brace template escapes in prose. Marked parses Markdown structure, including nested and indented code. The `@@filename` and `@@switch` directives supply example filenames and TypeScript/JavaScript variants; both variants are preserved. Other embedded HTML remains literal source content.

Chunks stay within sections and pack whole Markdown blocks up to a soft size target. Large code blocks, tables, lists, and paragraphs remain intact even when they exceed that target. Chunk IDs derive from the document ID, heading ancestry, and part number; content edits change hashes, while document IDs stay stable. Identical snapshots and settings produce identical output without timestamps.

Downloads have a 30-second timeout and a 4 MiB limit per file, with at most four chapter downloads in flight. Invalid metadata or failed downloads stop ingestion. Output is replaced atomically only after the complete snapshot is processed, preserving a previous corpus on failure. Only the latest source is ingested; each run replaces the previous corpus. Ingestion runs separately from the MCP runtime, which does not download source documentation.

## Build and use the local search index

After ingestion, create or replace the SQLite FTS5 index from the generated corpus:

```sh
npm run search:index
# Optional corpus and SQLite paths:
npm run search:index -- --input /tmp/nestjs-documentation.json --database /tmp/nestjs-documentation.sqlite
```

The default index is `data/documentation.sqlite` (ignored by Git). It indexes each ingested section chunk, including document titles, heading paths, normalized Markdown, and code examples. Search uses SQLite FTS5 ranking and snippets, with title and heading matches weighted above body text. Queries are converted to quoted terms so caller text cannot inject FTS operators; punctuation around identifiers such as `@Injectable()` is handled. Empty queries return no results. Queries are limited to 256 characters and 32 terms, and result limits default to 10 and cap at 50.

The injectable `DocumentationSearchService` is exported by `DocumentationSearchModule` and can be used independently of the MCP server. It returns chunk and document identifiers, title, section canonical URL, source revision, excerpt, and relevance score. The MCP tools delegate to this service. SQLite comes from Node's built-in `node:sqlite` module, so no database service or production database package is required.

The stdio MCP server reads this local index when it starts. `search_docs` accepts a natural-language query or technical identifier and an optional result limit from 1 to 10. `fetch_docs` accepts only a deterministic document ID from `search_docs`; it returns section Markdown with canonical NestJS documentation URLs and truncates output at 12,000 section characters. Both tools use strict input schemas, so unsupported arguments such as `version` are rejected. Set `NESTJS_DOCS_SEARCH_DB` to use a different index path.

## Checks

```sh
npm run check
```

This runs formatting verification, ESLint, strict TypeScript checking (including tests), the production build, and tests. MCP tool integration tests use Nest's in-memory MCP client to discover and invoke both tools and validate rejected arguments. Stdio lifecycle tests verify shutdown on stdin EOF, SIGINT, and SIGTERM, with protocol messages on stdout and diagnostics on stderr. Ingestion tests use local synthetic documentation fixtures and a stubbed downloader to verify normalization, source metadata, code preservation, chunking, deterministic IDs/hashes, failure handling, and output replacement. Search tests build an index from local fixtures through the ingestion pipeline, then verify relevance, empty input, exact identifiers, and result bounds through both the service and its standalone Nest module. Tests use no external services or network listeners. Jest rebuilds the application before each run, including watch mode.

Individual commands are `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`. Use `npm run format` or `npm run lint:fix` to apply formatting or lint fixes; `npm run test:watch` and `npm run test:cov` are also available.

TypeScript is pinned to the latest compatible 6.0 patch line because the current TypeScript ESLint tooling and Jest transformer do not support TypeScript 7. Dependency versions are recorded in `package-lock.json` for reproducible installs.

## Structure

- `src/main.ts`: standalone application context, stdio transport, and shutdown handling.
- `src/app.module.ts`: root module and MCP server registration.
- `src/documentation.tools.ts`: read-only search and fetch MCP tools.
- `src/ingestion/`: independent downloader, Markdown parser/chunker, corpus writer, and CLI.
- `src/search/`: independent SQLite FTS5 index, Nest search module/service, and index CLI.
- `test/ingestion.spec.ts` and `test/fixtures/documentation/`: offline ingestion coverage.
- `test/search*.spec.ts` and search fixtures: offline search unit and integration coverage.
- `test/mcp-tools.integration.spec.ts`: MCP client discovery, invocation, and input validation.
- `test/stdio.spec.ts`: stdio process lifecycle integration tests.

## License

[MIT](LICENSE)
