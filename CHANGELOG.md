# Changelog

## 0.1.0 (2026-09-16)

Initial release.

- Goal mode: one persistent objective worked autonomously across turns — a hidden continuation queued on `agent_end`, goal state in session custom entries (compaction-proof), the objective re-injected before every LLM call.
- `/goal` command (status / pause / resume / cancel / replace) and a `goal` tool for the model (get / create / complete / blocked / resume); model-created goals start immediately by default, with `--goal-confirm` as an opt-in approval gate.
- Audit language adapted from kimi-code: evidence-based completion, blocked only after the same blocker repeats for 3 consecutive goal turns.
- Interrupts: Esc pauses; a restored session brings an active goal back paused; the `agent_settled` safety net pauses the goal after exhausted retries.
- Bundled `write-goal` skill; `--goal "<objective>"` flag to start a TUI/RPC session with a goal running.
- Footer status (`goal: active (turn N)`) and inline lifecycle markers in the transcript.
- Packaging: `pi` manifest (extensions + skills) for `pi install`, strict `tsc --noEmit` gate, biome lint/format, node:test suite over a mock `ExtensionAPI`, CI on node 22.19 and 24.
