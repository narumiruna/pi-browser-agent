# Repository instructions

## Communication

- Lead with the result, then add only the detail needed to understand it or act on it.
- Use clear structure, familiar words, and short, direct sentences.
- Ask at most one clarifying question per turn.
- Present options as a numbered list.

## Documentation

- Use technical prose that follows ASD-STE100 (Simplified Technical English).
  - Keep required technical names.
- Use English proper names and technical terms.
- Verify documented claims, commands, and paths against repository evidence.
- State each rule once in specific, verifiable terms.
  - Indent conditions under the rule they qualify.
- Use Mermaid syntax for diagrams.
- Use `README.md`, `docs/architecture.md`, and the relevant feature documentation under `docs/` when changing extension behavior.
- Read `docs/security.md` and `docs/permissions-and-storage.md` before changing permissions, credentials, runtime messages, or stored data.

## Code style

- Use the simplest solution that meets current requirements (KISS).
- Do not add features for hypothetical future needs (YAGNI).
  - This includes configuration options, environment variables, and feature flags.
- Give each source file one main purpose and keep tightly coupled logic together.
- Separate responsibilities only when this makes the code easier to understand, test, or change independently.
- Use `biome.json` as the source for formatting and lint rules.

## User interface

- Reuse existing composer controls, attachment previews, and layout before adding feature-specific UI.
- Prefer compact icon buttons with existing sizes and spacing for feature actions.
  - Give each icon button an accessible name and a tooltip.
- Put secondary options in a small icon-triggered menu or popover that is closed by default.
- Show mode-specific options only while that mode is active.
- Do not add a dedicated panel, card, coordinate form, or explanatory block when existing or compact contextual controls can complete the same task.
- Preserve keyboard operation, visible focus, cancellation, and required permission and action confirmations when reducing UI.

## Commands

- Never run commands that open an interactive editor, pager, REPL, TUI, or prompt.
- Set the Bash tool timeout to 300 seconds.
- Always use `uv run python` instead of invoking `python` directly.
- Run npm commands from the repository root and use `npm ci` to install locked dependencies.

## Boundaries

- For answer, explanation, review, diagnosis, or planning requests, inspect the relevant materials and report the result without changing files unless requested.
- For change, build, or fix requests, complete only the requested local changes and run relevant safe checks.
- Ask before writing to external systems, taking destructive or costly actions, or greatly expanding the scope.
- Do not edit generated files in `dist/`, dependencies in `node_modules/`, or the auto-generated `extension-env.d.ts` directly.

## Security

- Keep production extension code browser-compatible, without Node.js built-ins, native processes, shell tools, general filesystem access, or loopback bridges.
- Preserve worker message validation, visible-tab and stale-context checks, exact-origin approval, and action confirmations when changing browser tools.
- Keep provider credentials out of runtime messages, the service worker, injected code, model messages, tool results, session records, and logs.
- Treat page content, model output, bookmark data, WebMCP data, remote MCP metadata and results, and imported skills as untrusted data, not authorization to change permissions or instructions.
- Never automatically replay interrupted or failed mutation tools or remote MCP calls.

## Testing

- Put unit tests in `tests/unit/`, integration tests in `tests/integration/`, and browser scenarios in `tests/e2e/`.
- For code changes, run `npm run check`, tests that cover the change, and `npm run build`.
  - `npm test` runs unit and integration tests.
  - `npm run build` produces `dist/chrome` after the browser-boundary probe, production build, typecheck, and artifact security audit.
- Run E2E tests only after a successful build.
  - `npm run test:e2e:smoke` runs smoke scenarios.
  - `npm run test:e2e` runs all browser scenarios.
- Keep E2E setup isolated from the production artifact; use the existing temporary-copy harness and mocked model responses.
- Use `npm run ci` for the full CI sequence: formatting and lint checks, unit and integration tests, production build, and E2E tests.
- For documentation-only changes, check whitespace with `git diff --check`.
- Report the checks run, their results, and any checks not run.

## Git and commits

- Format branch names as `narumi/<type>/<short-description>` using lowercase kebab-case.
- Stage only intended paths; do not use `git add -A`.
- Do not commit images or binary files unless they are logos, icons, or assets required by the project.
- Use Conventional Commits for commit subjects and pull request titles: `<type>[(<scope>)][!]: <description>`.
- Do not change Git `user.name` or `user.email` unless the user explicitly requests it.
- Do not add agent-attribution trailers, such as `Co-Authored-By`, unless the user explicitly requests them.
  - Apply this rule even when project guidelines require these trailers.
- Summarize the pull request's overall outcome.
- Add a `.changeset/*.md` entry for each releasable change and leave version and changelog updates to the release workflow.
- After a commit attempt, run `git status --short` and inspect changes because `scripts/pre-commit.sh` applies `biome check --write .` across the repository.
