# Contributing

Read `AGENTS.md` first; it holds the product and engineering rules this project is built on (JSON-driven pages, Animate UI first, organization scoping, no custom widgets).

- Backend: `core/`, Node 22.18+ (runs the TypeScript directly through its built-in type stripping, no build step) with Hono as its only dependency, one module per subsystem; `core/server.ts` is the entry point, `core/app.ts` and `core/routes/` the HTTP layer. CLI and TUI: `tui/`. UI: `web/` (Vite, React, Tailwind). Build the UI with `cd web && pnpm build`; the build is a strict type check. `pnpm typecheck` is the strict check for `core/`, `tui/`, `bin/`, `test/` and `web/scripts/`. `pnpm test` runs the core tests (`node:test`) and the web tests (Vitest). `pnpm test:core`, `pnpm test:watch`, `pnpm test:coverage` for the backend alone; `pnpm -C web test` for the UI; `pnpm test:e2e` for the Playwright smoke run (needs `pnpm -C web build` and `pnpm -C web exec playwright install chromium`); `pnpm test:forgejo` and `pnpm test:gitea` need Docker.
- Run locally: `pnpm dev` (single command: backend on 4747, Vite on 5173 with HMR, and auto-managed local PocketBase on 8090) or `pnpm start` (production server).
- Schema changes go in `core/pb_migrations/`. Documentation changes travel with the code change: user documentation lives in [dharmeshgurnani/codeotter-docs](https://github.com/dharmeshgurnani/codeotter-docs) (published at [docs.codeotter.io](https://docs.codeotter.io)), so open a matching pull request there; ROADMAP for status, CHANGELOG entry.

## Tests

- Major new functionality comes with automated tests in the same pull request: `node:test` in `test/` for `core/` and `tui/`, Vitest + Testing Library in `web/src/**/*.test.tsx` for UI components, Playwright in `web/e2e/` for flows that need the real server in a browser.
- A bug fix adds a regression test that fails without the fix.
- Pull requests that add or change behaviour without tests are not merged.

## Pull requests

- Open a pull request; the project reviews its own pull requests with itself.
