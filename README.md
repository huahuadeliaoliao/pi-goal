<p align="center">
  <img src="docs/logo.svg" width="640" alt="pi-goal — moon phases ending in a target">
</p>

<h1 align="center">pi-goal</h1>

<p align="center">
  Goal mode for the <a href="https://github.com/earendil-works/pi">pi</a> coding agent:<br>
  one persistent objective, worked autonomously across turns until it is verifiably done.<br>
  <a href="https://github.com/MoonshotAI/kimi-code">kimi-code</a>-style goals, rebuilt as a pi extension.
</p>

<p align="center">
  🌑 🌒 🌓 🌔 🌕<br>
  <sub>one moon phase per goal turn — a nod to kimi-code's TUI moon loader</sub>
</p>

## What is a goal?

A normal prompt tells the agent what to do *next*. A goal says what must become *true*:

```
/goal Fix every failing test in test/auth, rerun npm test until it exits 0,
      and stop and report if a failure needs changes outside test/ or src/auth
```

Once a goal is active, the agent keeps working. Each time a run ends with the goal still
active, pi-goal queues a hidden continuation and the agent picks the work back up — slice
by slice, across as many runs as it takes. The loop ends only when the agent marks the goal
`complete` (with evidence) or `blocked` (with a concrete reason), or when you stop it.

## Install

```sh
git clone https://github.com/huahuadeliaoliao/pi-goal.git
cp -r pi-goal ~/.pi/agent/extensions/goal
```

Or ad-hoc, without installing: `pi -e /path/to/pi-goal/index.ts`

## Usage

| Command | Action |
| --- | --- |
| `/goal <objective>` | Start a goal (bare `/goal` with no goal opens an editor) |
| `/goal status` | Show the current goal |
| `/goal pause` | Pause after the current run finishes |
| `/goal resume` | Resume a paused/blocked goal (starts a run when idle) |
| `/goal cancel` | Drop the goal and abort goal-driven work |
| `/goal replace <objective>` | Drop the current goal and start a new one |

The agent can also start goals itself via its `goal` tool — you get a confirmation prompt
first (skip it with `--goal-auto-approve`). Say *"help me write a goal"* and the bundled
**write-goal** skill walks the agent through drafting a verifiable completion contract.

Flags:

- `--goal "<objective>"` — start a TUI/RPC session with a goal already running
- Headless: `pi -p "/goal <objective>"` runs the goal to completion, then exits

## How it works

- **Continuation loop** — on `agent_end`, if the goal is still active, a hidden
  continuation message is queued as a follow-up, so pi continues the run. No timers;
  user messages steered mid-run are always delivered first.
- **Compaction-proof** — goal state lives in session custom entries (never enters LLM
  context), and the objective is re-injected before every LLM call via the `context`
  event. Compaction summarizes the conversation; it cannot lose the goal.
- **Honest endings** — the prompt wording (adapted from kimi-code's iterated audit
  language) pushes the agent to verify against current evidence before `complete`, and
  to only declare `blocked` after the same blocker repeats for 3 consecutive goal turns.
- **Interrupts** — Esc pauses the goal; resuming a session restores an active goal as
  paused; explicit `/goal resume` continues it.
- **Visibility** — a footer status (`goal: active (turn N)`), inline lifecycle markers
  (started/paused/complete/blocked), hidden continuation messages.

## Design provenance

The design is ported from [kimi-code](https://github.com/MoonshotAI/kimi-code)'s goal
feature (`packages/agent-core-v2/src/features/goal`, MIT), with
[oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT) as a cross-reference. Deliberately
dropped: token/turn/wall-clock budgets and the `/goal next` queue — the goal is the goal.
Re-add them if real usage asks.

## License

[MIT](LICENSE) © 2026 huahuadeliaoliao
