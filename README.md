# nestjs-docs-mcp

A standalone, community-maintained NestJS documentation MCP server using the official [`@nestjs/mcp`](https://docs.nestjs.com/mcp/overview) package. This project is independent and is not affiliated with, endorsed by, or an official product of NestJS or its maintainers.

The server supports local [stdio and Streamable HTTP](https://docs.nestjs.com/mcp/transports) entry points and exposes two read-only tools: `search_docs` finds relevant sections, and `fetch_docs` retrieves a document by its deterministic ID. The `nestjs-docs-mcp` executable uses stdio; the HTTP entry point listens on loopback at `http://127.0.0.1:3000/mcp` by default. Documentation ingestion and search indexing run as separate commands. Tool arguments do not select a documentation version.

## Requirements

- Node.js 24 LTS (24.15.0 or newer); `.nvmrc` selects the 24 release line.
- npm (included with Node.js).

## Install from npm

```sh
npm install --global nestjs-docs-mcp
nestjs-docs-mcp
```

`nestjs-docs-mcp` starts the stdio server for MCP clients. The package also provides `nestjs-docs-mcp-http` to start the loopback HTTP server. This installation will be usable after the package is manually published to npm. Set `NESTJS_VERSION=11` to select v11; the default is v12. Each npm package version is a fixed snapshot of the server and both SQLite indexes. The npm version identifies the package release; `data/manifest.json` records the upstream source ref and commit for each documentation major. A later GitHub index release does not change an already installed package, and the server never downloads updates at startup. This repository does not publish the package automatically.

## Local development

```sh
nvm use
npm ci
npm run build
npm run start:stdio
# Or start the HTTP endpoint:
npm run start:prod
```

The server reads its index files beside the installed package, regardless of the working directory. A fresh checkout needs indexes before the server or `npm pack` can run. After the index-update workflow has published its first bundle, download `documentation-indexes.tar.gz` from the latest [`docs-index-*` GitHub prerelease](https://github.com/rafaself/nestjs-docs-mcp/releases), then extract it into the repository's `data/` directory.

`npm pack` builds the application and requires a complete index bundle in `data/`: both corpus JSON files, both SQLite indexes, and their matching manifest. It validates corpus hashes and exact corpus-to-index row parity, SQLite and FTS5 integrity, index hashes, and version/revision metadata before packing. The corpus files are used for this check but excluded from the npm tarball. The packed-package check then installs the generated tarball into a temporary production-only project and exercises both NestJS majors through the stdio executable. It confirms that searches and fetches work from the packaged indexes, stdout contains protocol messages, and shutdown is clean. The tarball exposes stdio as `nestjs-docs-mcp` and loopback HTTP as `nestjs-docs-mcp-http`; it includes both entry points, both SQLite indexes, their source manifest, README, and license notices, while excluding tests and source documentation.

To rebuild indexes locally from the official sources instead of downloading the latest release bundle:

```sh
npm run docs:ingest
NESTJS_VERSION=11 npm run docs:ingest
npm run search:index
NESTJS_VERSION=11 npm run search:index
```

This local ingestion path creates corpus and index files but not the release manifest required by `npm pack`; use a validated release bundle when preparing a package.

Before the first automated bundle is available, generate the package bundle from official sources and copy its validated indexes into `data/`:

```sh
set -euo pipefail
bundle_dir="$(mktemp -d)"
trap 'rm -r "$bundle_dir"' EXIT
node scripts/release/synchronize-documentation-indexes.mjs --output "$bundle_dir/indexes"
mkdir -p data
cp "$bundle_dir/indexes/documentation-v11.json" \
  "$bundle_dir/indexes/documentation-v11.sqlite" \
  "$bundle_dir/indexes/documentation-v12.json" \
  "$bundle_dir/indexes/documentation-v12.sqlite" \
  "$bundle_dir/indexes/manifest.json" data/
```

## Connect from Codex

After installing the package, register the stdio server using the current [Codex MCP setup](https://learn.chatgpt.com/docs/extend/mcp):

```sh
codex mcp add nestjs-docs --env NESTJS_VERSION=12 -- nestjs-docs-mcp
```

Or configure it in `~/.codex/config.toml` (or a trusted project's `.codex/config.toml`):

```toml
[mcp_servers.nestjs-docs]
command = "nestjs-docs-mcp"

[mcp_servers.nestjs-docs.env]
NESTJS_VERSION = "12"
# DEBUG = "1" # optional MCP call timing logs
```

For source development, point Codex to the compiled stdio entry point and choose the major in its environment:

```toml
[mcp_servers.nestjs-docs-local]
command = "node"
args = ["/absolute/path/to/nestjs-docs-mcp/dist/apps/mcp-server/bootstrap/stdio.js"]

[mcp_servers.nestjs-docs-local.env]
NESTJS_VERSION = "11"
```

The stdio entry point uses the client's stdin and stdout and does not start an HTTP listener. The separate HTTP entry point serves the same tools at `/mcp`, binds only to `127.0.0.1`, and defaults to port 3000; set `PORT` to choose another local port. The HTTP Host allowlist reads the optional `NESTJS_DOCS_MCP_ALLOWED_HOSTS` environment variable as a comma-separated list. When it is unset or contains no hosts, the default is `localhost,127.0.0.1,[::1]`; a configured list replaces that default. Its read-only tools are `search_docs` (natural-language or identifier query, optional limit 1–10) and `fetch_docs` (bounded Markdown for a deterministic document ID). Version selection stays in the local process environment, outside model-controlled tool arguments. The default is v12; v11 uses the archived official source described below.

Set `DEBUG=1` in the process environment to register the MCP timing interceptor at startup. It logs the call kind, name, outcome, and elapsed time without logging inputs or results. In stdio mode, these messages go to stderr so stdout remains reserved for MCP protocol messages.

Codex desktop, CLI, and IDE extension share the local MCP configuration. Refresh an already-running local client after adding the server.

## Run from a source checkout

After downloading the index bundle as described above, run `npm ci` and `npm run build`. Start stdio with `node dist/apps/mcp-server/bootstrap/stdio.js` or `npm run start:stdio`; start HTTP with `node dist/apps/mcp-server/bootstrap/http.js` or `npm run start:prod`. Use the direct stdio Node command in MCP client configurations to avoid npm banners on stdout. `npm run start:dev` rebuilds and restarts the HTTP entry point; its compiler output makes it unsuitable as an MCP client command.

The npm executable is `nestjs-docs-mcp`; it launches the compiled stdio entry point. Stdout is reserved for MCP protocol messages. Nest startup logs and errors go to stderr through `McpStdioLogger`. Closing stdin ends the MCP connection and closes the application context. Both entries close cleanly on SIGINT and SIGTERM.

## Package maintenance

The npm package is a release-time snapshot. For a data-only refresh, choose the newest successful `docs-index-*` prerelease, extract its complete archive into a clean staging directory, then promote its two corpus files, two SQLite files, and `manifest.json` together into `data/`. The two majors are synchronized independently: a bundle may contain a new v12 index and an unchanged v11 index, or vice versa. That is expected; each manifest entry ties one major's corpus and database to its own upstream commit and hashes. Never combine files from different bundles or replace a database without its matching corpus and manifest.

Keep both corpus JSON files in `data/` while preparing the package. `npm pack` runs `prepack`, which checks each corpus against its index and manifest, then tests the actual tarball from a production-only install for both majors. The `files` list omits corpora from the published tarball, but the packaged SQLite files and manifest remain a validated pair. The package version is independent of the NestJS documentation major or source commit; a docs-only npm release would normally use the next package patch version. Review the generated `.tgz`, then publish that exact tarball with `npm publish ./nestjs-docs-mcp-<package-version>.tgz`. Index generation and GitHub prerelease creation do not publish npm packages; npm publication remains a separate maintainer action.

## Third-party documentation content

The bundled indexes contain normalized Markdown derived from the official NestJS documentation repository. They retain their source revisions and content hashes in `data/manifest.json`. The v11 and v12 snapshots are MIT-licensed at their respective indexed commits; the package includes the matching copyright notices and full license texts in `THIRD-PARTY-NOTICES.md` and `licenses/`.

## Select a documentation major

Set `NESTJS_VERSION=11` or `NESTJS_VERSION=12` to choose the documentation major. The default is `12`, the latest supported major in the [official migration guide](https://docs.nestjs.com/migration-guide). Any other value fails when the application or an ingestion/index command starts. The MCP tools do not accept a version argument; each server process keeps the configured major for its lifetime.

The official [v12 documentation source](https://github.com/nestjs/docs.nestjs.com/tree/master) is the `master` branch. The official site links its v11 archive through [See Version 11](https://docs.nestjs.com/v11); its Markdown source is the repository's [`11.0.0` branch](https://github.com/nestjs/docs.nestjs.com/tree/11.0.0). The branch still exists, but its [official commit history](https://github.com/nestjs/docs.nestjs.com/commits/11.0.0) currently ends at `7b1c9394992ad4d8e8d17b30604e02003ee8f98f`, dated January 17, 2025. Treat v11 as effectively frozen: the update workflow will index a new commit if the branch moves, but polling does not guarantee that upstream maintains it. The manifest records the resolved commit for each major independently.

## Ingest documentation

```sh
npm run docs:ingest
# Build the v11 corpus separately:
NESTJS_VERSION=11 npm run docs:ingest
# Optional output path and soft chunk size, measured in characters:
NESTJS_VERSION=11 npm run docs:ingest -- --output /tmp/nestjs-documentation-v11.json --max-chars 4000
```

The command builds the project and downloads original Markdown from `content/` in the official docs repository. For v12, the [tracked navigation](https://github.com/nestjs/docs.nestjs.com/blob/master/src/app/shared/nav/nav-items.ts) selects published chapters and the upstream [content aliases](https://github.com/nestjs/docs.nestjs.com/blob/master/tools/generate-llms-txt.ts) map renamed files to their canonical routes. For v11, the pinned commit's Git tree selects Markdown files and the historical route aliases resolve the official `/v11` URLs. All downloaded files use the source commit SHA. Static metadata is parsed as data; upstream code and examples are never executed. No HTML scraping is used.

The default outputs are `data/documentation-v11.json` and `data/documentation-v12.json` (ignored by Git). Each contains a source manifest with the major, source ref, and commit revision, plus sorted documents with:

- A stable, major-qualified document ID, plus the title and version-appropriate canonical URL.
- The source commit, path, immutable raw URL, and SHA-256 hash of the original source bytes.
- Normalized Markdown, its SHA-256 hash, and ordered headings with levels, titles, and the site's anchor slugs.
- Ordered chunks with heading ancestry, section URLs, source revisions, content hashes, and code examples with languages and optional filenames.

Normalization removes the UTF-8 BOM, standardizes line endings, removes presentation banners, and decodes the docs' literal-brace template escapes in prose. Marked parses Markdown structure, including nested and indented code. The `@@filename` and `@@switch` directives supply example filenames and TypeScript/JavaScript variants; both variants are preserved. Other embedded HTML remains literal source content.

Chunks stay within sections and pack whole Markdown blocks up to a soft size target. Large code blocks, tables, lists, and paragraphs remain intact even when they exceed that target. Chunk IDs derive from the document ID, heading ancestry, and part number; content edits change hashes, while document IDs stay stable. Identical snapshots and settings produce identical output without timestamps.

Downloads have a 30-second timeout and a 4 MiB limit per file, with at most four chapter downloads in flight. Invalid metadata or failed downloads stop ingestion. Output is replaced atomically only after the complete snapshot is processed, preserving a previous corpus on failure. Ingestion runs separately from the MCP runtime, which does not download source documentation.

## Build and use the local search index

After ingestion, create or replace the SQLite FTS5 index from the generated corpus:

```sh
npm run search:index
# Build the v11 index separately:
NESTJS_VERSION=11 npm run search:index
# Optional corpus and SQLite paths:
NESTJS_VERSION=11 npm run search:index -- --input /tmp/nestjs-documentation-v11.json --database /tmp/nestjs-documentation-v11.sqlite
```

The default indexes are `data/documentation-v11.sqlite` and `data/documentation-v12.sqlite` (ignored by Git). SQLite FTS5 rows are tagged with their documentation major. Indexing synchronizes only that major's rows, retaining unchanged content and removing obsolete documents. Search and fetch always filter by the major fixed in the service. A shared custom SQLite path can safely hold both indexes. A corpus for the wrong major is rejected; an older unversioned index schema must be rebuilt with `npm run search:index`.

Each index contains section chunks with document titles, heading paths, normalized Markdown, and code examples. Search uses SQLite FTS5 ranking and snippets, with title and heading matches weighted above body text. Queries are converted to quoted terms so caller text cannot inject FTS operators; punctuation around identifiers such as `@Injectable()` is handled. Empty queries return no results. Queries are limited to 256 characters and 32 terms, and result limits default to 10 and cap at 50.

The injectable `DocumentationSearchService` is exported by `DocumentationSearchModule` and can be used independently of the MCP server. It returns chunk and document identifiers, title, section canonical URL, source revision, excerpt, and relevance score. The MCP tools delegate to this service. SQLite comes from Node's built-in `node:sqlite` module, so no database service or production database package is required.

The stdio MCP server reads the index matching `NESTJS_VERSION` when it starts. `search_docs` accepts a natural-language query or technical identifier and an optional result limit from 1 to 10. `fetch_docs` accepts only a deterministic document ID from the selected major; IDs from another major are rejected. Search results include a section ID and source revision. Pass `documentId` and `sectionId` to `fetch_docs` to retrieve the matching section, or omit `sectionId` to retrieve the document. Results include MCP structured content with the documentation major, source revision, section data, truncation flag, and next cursor, alongside readable text. Output is bounded at 12,000 section characters; pass the returned `cursor` with the same document and section to continue. Cursors are bound to the requested document, section, and indexed content; restart retrieval if the index changes. The source revision identifies the indexed snapshot but does not establish its age. Both tools use strict input schemas, so unsupported arguments such as `version` are rejected. Set `NESTJS_DOCS_SEARCH_DB` to use a different index path; its rows remain isolated by major.

## Automated index updates and distribution

Run `npm run search:evaluate` to compare the current ranker with a fixed OR-query baseline across 25 target-labeled queries for each bundled major. The cases cover API identifiers, decorators, multiword concepts, natural-language questions, and overlapping concepts. It reports top-1/3/5 accuracy and MRR@10 for exact AND-first matching, phrase-first fallback, quoted phrase weighting, camel-case query expansion, and several BM25 title/heading weights. Baseline results for v11 revision `7b1c9394992ad4d8e8d17b30604e02003ee8f98f` are 16/25 top-1, 22/25 top-3, and 0.751 MRR@10; v12 revision `3e764dea70dbeb3cd193a037d6017c4b41c27525` scores 16/25, 24/25, and 0.780. Adding a quoted phrase clause moves “request scoped providers” from rank 3 to rank 1 on v11, leaves v12 unchanged, and has no target-rank regressions in this sample. The broader ranker changes tested did not perform as well.

The GitHub Actions workflow checks the official `11.0.0` and `master` refs weekly and on manual dispatch. It resolves each ref before downloading Markdown, reuses an unchanged major's existing corpus and index, reindexes a changed major independently, and removes deleted documents when a source revision advances. Source revisions and document content hashes are recorded in each corpus and its release manifest entry. The workflow validates both majors together, including corpus hashes, SQLite and FTS5 integrity, and exact corpus-to-index row parity, before packaging.

Only after both majors validate does the workflow publish a **prerelease** with a unique tag beginning `docs-index-` and a single `documentation-indexes.tar.gz` asset. Each archive is a complete set: the v11 corpus and database, the v12 corpus and database, and their manifest. Each update uses a new release; the workflow never replaces the previous published bundle, so a failed build or upload leaves it available. This uses GitHub Releases as the generated-index distribution channel; it does not publish npm packages. The MCP server never synchronizes or downloads documentation during tool requests.

These are three separate freshness points:

- **Upstream documentation:** the current commit at each configured source ref (`11.0.0` for v11 and `master` for v12). The weekly job samples these refs; it does not promise an update schedule from upstream or capture edits that are not committed there.
- **Latest generated bundle:** the newest successful `docs-index-*` prerelease on the [GitHub Releases page](https://github.com/rafaself/nestjs-docs-mcp/releases). Its manifest records the exact upstream commit and content/index hashes for each major. It advances only when a validated bundle is published, and a changed major can be paired with the unchanged index for the other major.
- **Installed npm package:** the fixed index snapshot shipped with that npm package version. A later GitHub prerelease does not update existing installations. Users receive newer bundled documentation only after maintainers promote a validated bundle into a new npm package version and publish that release.

For local development, download one complete `documentation-indexes.tar.gz` from the latest `docs-index-*` prerelease and extract its five files into the checkout's `data/` directory as a set. Do not copy an individual database or manifest from a different release. Set `NESTJS_VERSION` before starting the MCP process to choose which local index it opens.

When the ingestion or SQLite index format changes, increment `INDEX_PIPELINE_VERSION` in `scripts/release/synchronize-documentation-indexes.mjs` to force a rebuild from the official sources.

## Checks

```sh
npm run check
```

This runs formatting verification, ESLint, strict TypeScript checking (including tests), the production build, and tests. MCP tool integration tests use Nest's in-memory MCP client to discover and invoke both tools and validate rejected arguments. Stdio lifecycle tests verify shutdown on stdin EOF, SIGINT, and SIGTERM, with protocol messages on stdout and diagnostics on stderr. Ingestion tests use local synthetic documentation fixtures and a stubbed downloader to verify normalization, source metadata, code preservation, chunking, deterministic IDs/hashes, failure handling, and output replacement. Search tests build an index from local fixtures through the ingestion pipeline, then verify relevance, empty input, exact identifiers, and result bounds through both the service and its standalone Nest module. Tests use no external services or network listeners. Jest rebuilds the application before each run, including watch mode.

Individual commands are `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`. Use `npm run format` or `npm run lint:fix` to apply formatting or lint fixes; `npm run test:watch` and `npm run test:cov` are also available.

TypeScript is pinned to the latest compatible 6.0 patch line because the current TypeScript ESLint tooling and Jest transformer do not support TypeScript 7. Dependency versions are recorded in `package-lock.json` for reproducible installs.

## Structure

- `src/apps/mcp-server/`: separate HTTP and stdio bootstraps and MCP process configuration.
- `src/apps/docs-indexer/`: indexing and ingestion CLI commands.
- `src/modules/documentation/domain/`: supported versions and documentation corpus types.
- `src/modules/documentation/application/`: ingestion and search use cases plus reader/store contracts.
- `src/modules/documentation/infrastructure/`: GitHub source retrieval, Markdown parsing, corpus files, and SQLite indexing/runtime persistence.
- `src/modules/documentation/retrieval/`: query validation and bounded document pagination.
- `src/modules/documentation/mcp/`: tool contracts, thin tool adapters, response presenters, and MCP module composition.
- `src/shared/config/`: package metadata shared across runtime and package verification.
- `scripts/ci/`, `scripts/evaluation/`, and `scripts/release/`: package checks, search evaluation, and index synchronization.
- `test/unit/`, `test/integration/`, and `test/e2e/`: coverage organized by verification boundary; `test/fixtures/` contains shared offline inputs.

## License

[MIT](LICENSE)
