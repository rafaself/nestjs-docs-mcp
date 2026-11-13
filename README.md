# nestjs-docs-mcp

A standalone NestJS application using the official [`@nestjs/mcp`](https://docs.nestjs.com/mcp/overview) package.

The server runs locally over [stdio](https://docs.nestjs.com/mcp/transports) and exposes one connectivity tool, `ping`, which takes no arguments and returns `pong`. Documentation ingestion, search, and versioning are not implemented.

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

## Checks

```sh
npm run check
```

This runs formatting verification, ESLint, strict TypeScript checking (including tests), the production build, and stdio integration tests. The tests launch the compiled server through an official MCP client, discover and invoke `ping`, and verify shutdown on stdin EOF, SIGINT, and SIGTERM, with protocol messages on stdout and diagnostics on stderr. Tests use no external services or network listeners. Jest rebuilds the application before each run, including watch mode.

Individual commands are `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`. Use `npm run format` or `npm run lint:fix` to apply formatting or lint fixes; `npm run test:watch` and `npm run test:cov` are also available.

TypeScript is pinned to the latest compatible 6.0 patch line because the current TypeScript ESLint tooling and Jest transformer do not support TypeScript 7. Dependency versions are recorded in `package-lock.json` for reproducible installs.

## Structure

- `src/main.ts`: standalone application context, stdio transport, and shutdown handling.
- `src/app.module.ts`: root module and MCP server registration.
- `src/ping.tool.ts`: minimal connectivity tool.
- `test/stdio.spec.ts`: stdio client and process lifecycle integration tests.

## License

[MIT](LICENSE)
