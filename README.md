# nestjs-docs-mcp

A standalone NestJS application using the official [`@nestjs/mcp`](https://docs.nestjs.com/mcp/overview) package.

This repository currently contains project initialization only. No MCP tools, resources, prompts, documentation ingestion, search, or versioning are implemented.

## Requirements

- Node.js 24 LTS (24.15.0 or newer); `.nvmrc` selects the 24 release line.
- npm (included with Node.js).

## Setup and run

```sh
nvm use
npm ci
npm run start:dev
```

The application serves Streamable HTTP MCP at `http://127.0.0.1:3000/mcp`, bound to loopback for local development. Set `PORT` to change the port. There is no root HTTP route.

To build and run the compiled application:

```sh
npm run build
npm run start:prod
```

## Checks

```sh
npm run check
```

This runs formatting verification, ESLint, strict TypeScript checking (including tests), MCP startup and HTTP smoke tests, and the production build. Tests use no external services.

Individual commands are `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`. Use `npm run format` or `npm run lint:fix` to apply formatting or lint fixes; `npm run test:watch` and `npm run test:cov` are also available.

TypeScript is pinned to the latest compatible 6.0 patch line because the current TypeScript ESLint tooling and Jest transformer do not support TypeScript 7. Dependency versions are recorded in `package-lock.json` for reproducible installs.

## Structure

- `src/main.ts`: application entry point and shutdown handling.
- `src/app.module.ts`: root module and MCP server registration.
- `test/app.spec.ts`: MCP identity, empty tool listing, and HTTP endpoint smoke tests.

## License

[MIT](LICENSE)
