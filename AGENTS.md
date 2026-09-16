# AGENTS.md

Guidance for agents working in this repository.

## What this is

`pi-goal` — goal mode for the pi coding agent, shipped as a pi extension (`index.ts`, no build step; pi loads TypeScript via jiti). A goal says what must become *true*; after each agent run ends with the goal still active, the extension queues a hidden continuation so the agent keeps working across runs until the model marks the goal complete/blocked via the `goal` tool.

Layout: `index.ts` (extension), `state.ts` (pure state module), `prompts.ts` (prompt templates), `skills/write-goal/` (bundled skill).

## Commands

- `npm test` — node:test suites in `test/`; they mock `ExtensionAPI`/`ExtensionContext` and never touch a real pi process.
- `npm run check` — `tsc --noEmit` (strict). jiti has no build step: this is the only compile check.
- `npm run lint` — `biome check .` (must be clean, warnings included).

## Invariants

These break silently if changed; the test suite pins most of them.

- **Goal state lives in session custom entries** (`goal-state`), outside LLM context, so compaction cannot touch it. The objective is re-injected before every LLM call via the `context` event; that injection must stay non-destructive (never persisted into history).
- **The continuation loop is the product.** `agent_end` with an active goal queues a hidden `goal-continuation` custom message as a followUp. The `context` filter keeps only the last continuation; stale ones are dropped.
- **Honest endings.** The audit language in `prompts.ts` is adapted from kimi-code's iterated prompt wording — edit conservatively.
- **Model-created goals start without a confirmation prompt** (explicit maintainer decision, 2026-09, pre-0.1.0): the write-goal flow's checkpoint is conversational — show the draft, get approval, then create. `--goal-confirm` re-enables the TUI gate for users who want one. Do not restore the gate by default.
- **Turn counting is in-memory between runs.** State persists on status changes, at run boundaries (`agent_end`), and on `session_shutdown` — not on every `turn_end`. The counter is not cosmetic: the active reminder's "Goal turns so far" and the 3-turn blocked audit both anchor on it. A hard kill (SIGKILL) under-reports it and a blocked declaration may land slightly late after a crash; accepted, because quit/reload/SIGTERM/SIGHUP all emit `session_shutdown` (verified in pi's runtime) and per-turn writes to survive SIGKILL are a poor trade.
- **Interrupted or errored runs never continue the loop.** Abort pauses; error waits for pi's retry, with `agent_settled` as the safety net.
- **The objective is untrusted text** and goes through `escapeUntrusted` before entering any prompt.
- `state.ts` stays pure (no pi APIs) so it remains unit-testable.

## Packaging

- `@earendil-works/pi-*` and `typebox` stay in `peerDependencies` with `"*"` and `optional: true`; pinned versions live in `devDependencies` for tests and type-checking only. pi resolves these imports to its own bundled modules at load time.
- The package is multi-file: the `files` whitelist in package.json must keep covering `index.ts`, `state.ts`, `prompts.ts` and `skills/`, or installs silently lose functionality. CI runs `npm pack --dry-run` to catch regressions.

## Testing notes

- `test/helpers.ts` builds the mock harness: `createMockPi()` captures registrations (handlers, tools, commands, flags, renderers) and sent messages; `createMockCtx()` fakes ui/idle/session entries; `fireAsync()` drives event handlers.
- `MockCtxOptions.confirm` answers the goal-creation confirm dialog (only reached with `--goal-confirm` on); `editorText` answers the bare `/goal` editor; `idle: false` exercises the steer/abort paths.
