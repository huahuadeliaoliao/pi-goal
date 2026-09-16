/**
 * Goal Mode for pi
 *
 * A persistent autonomous objective loop, modeled on kimi-code's goal feature:
 * - A goal says what must become *true*, not what to do next.
 * - After each agent run ends with the goal still active, the runtime queues a
 *   hidden continuation (agent_end -> followUp), so the agent keeps working
 *   across runs until the model marks the goal complete/blocked via the tool.
 * - Goal state lives in custom session entries (outside LLM context), so
 *   compaction cannot touch it. The objective is re-injected before every LLM
 *   call via the `context` event, so compaction cannot lose it either.
 * - Interrupt (Esc) pauses the goal; resuming a session restores an active
 *   goal as paused. Errors pause via the agent_settled safety net.
 *
 * Surfaces:
 * - /goal command: status | pause | resume | cancel | replace <obj> | <obj>
 * - goal tool for the model: get | create | complete | blocked | resume
 * - Bundled write-goal skill (help the user author a good objective)
 * - Flags: --goal "<objective>" (start a TUI/RPC session with a goal),
 *   --goal-confirm (require user confirmation for model-created goals)
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	buildActiveReminder,
	buildBlockedOutcome,
	buildCompleteOutcome,
	buildContinuationPrompt,
	buildInactiveNote,
} from "./prompts.ts";
import { createGoalState, type GoalState, isLiveGoal, validateObjective } from "./state.ts";

const CONTINUATION_TYPE = "goal-continuation";
const STATE_ENTRY_TYPE = "goal-state";
const EVENT_ENTRY_TYPE = "goal-event";

type GoalEventKind = "created" | "resumed" | "paused" | "cancelled" | "complete" | "blocked";

const extensionDir = dirname(fileURLToPath(import.meta.url));

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant";
}

export default function goalMode(pi: ExtensionAPI): void {
	let goal: GoalState | null = null;

	// ------------------------------------------------------------- state core

	function persistState(): void {
		pi.appendEntry(STATE_ENTRY_TYPE, goal ? { ...goal } : null);
	}

	function recordEvent(kind: GoalEventKind, g: GoalState | null): void {
		pi.appendEntry(EVENT_ENTRY_TYPE, {
			kind,
			objective: g?.objective,
			turnsUsed: g?.turnsUsed,
			reason: g?.reason,
		});
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!goal) {
			ctx.ui.setStatus("goal", undefined);
			return;
		}
		const text = goal.status === "active" ? `goal: active (turn ${goal.turnsUsed})` : `goal: ${goal.status}`;
		ctx.ui.setStatus("goal", text);
	}

	function setGoal(next: GoalState | null, ctx?: ExtensionContext, event?: GoalEventKind): void {
		goal = next ? { ...next, updatedAt: Date.now() } : null;
		persistState();
		if (event) recordEvent(event, goal);
		if (ctx) updateStatus(ctx);
	}

	function createGoal(objective: string, ctx?: ExtensionContext): GoalState {
		const next = createGoalState(validateObjective(objective));
		if (isLiveGoal(goal))
			throw new Error(`A goal already exists (${goal.status}). Use /goal replace or /goal cancel first.`);
		setGoal(next, ctx, "created");
		return next;
	}

	function describeGoal(): string {
		if (!goal) return "No goal. Start one with /goal <objective>.";
		const lines = [`Status: ${goal.status}`, `Goal turns: ${goal.turnsUsed}`, `Objective: ${goal.objective}`];
		if (goal.reason) lines.push(`Reason: ${goal.reason}`);
		return lines.join("\n");
	}

	// ------------------------------------------------------------------ flags

	pi.registerFlag("goal", {
		description: "Start the session with an autonomous goal (TUI/RPC only)",
		type: "string",
	});
	pi.registerFlag("goal-confirm", {
		description: "Ask for user confirmation when the agent creates a goal",
		type: "boolean",
		default: false,
	});

	// ------------------------------------------------------------ run control

	/** Bound pi.send* APIs are fire-and-forget (return undefined), so print/json
	 *  mode keeps the process alive via ctx.waitForIdle(). A fired run needs a
	 *  few microtasks before it registers as active; poll isIdle() first
	 *  (bounded: if the send failed, proceed and let the mode exit normally).
	 *  Only command-handler entry points call this, and command contexts
	 *  (ExtensionCommandContext) carry waitForIdle. */
	async function awaitRunIfHeadless(ctx: ExtensionCommandContext): Promise<void> {
		if (ctx.mode !== "print" && ctx.mode !== "json") return;
		// Defensive: only command contexts carry waitForIdle. If a future caller
		// passes a plainer ctx, skip the wait instead of throwing mid-headless-run.
		if (typeof ctx.waitForIdle !== "function") return;
		const deadline = Date.now() + 10_000;
		while (ctx.isIdle() && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 20));
		}
		await ctx.waitForIdle();
	}

	/** Kick off a goal run from an idle state (command/flag entry points). */
	async function kick(content: string, ctx: ExtensionCommandContext): Promise<void> {
		if (ctx.isIdle()) {
			pi.sendMessage({ customType: CONTINUATION_TYPE, content, display: false }, { triggerTurn: true });
		} else {
			// Mid-stream: steer it in; the agent_end hook keeps the loop going.
			pi.sendUserMessage(content, { deliverAs: "steer" });
		}
		await awaitRunIfHeadless(ctx);
	}

	function lastAssistantStopReason(messages: AgentMessage[]): string | undefined {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (isAssistantMessage(m)) return m.stopReason;
		}
		return undefined;
	}

	// ---------------------------------------------------------------- command

	pi.registerCommand("goal", {
		description: "Goal mode: /goal <objective> | status | pause | resume | cancel | replace <objective>",
		handler: async (args, ctx) => {
			const sub = args.trim();
			try {
				if (!sub || sub === "status") {
					if (!sub && !goal && ctx.hasUI) {
						const objective = (await ctx.ui.editor("Goal objective", ""))?.trim();
						if (!objective) return;
						await startFromCommand(objective, ctx);
						return;
					}
					ctx.ui.notify(describeGoal(), "info");
					return;
				}
				if (sub === "pause") {
					if (goal?.status !== "active") {
						ctx.ui.notify("No active goal to pause.", "warning");
						return;
					}
					setGoal({ ...goal, status: "paused", reason: "paused by user" }, ctx, "paused");
					ctx.ui.notify("Goal paused. Resume with /goal resume.", "info");
					return;
				}
				if (sub === "resume") {
					if (!goal || (goal.status !== "paused" && goal.status !== "blocked")) {
						ctx.ui.notify("No paused/blocked goal to resume.", "warning");
						return;
					}
					setGoal({ ...goal, status: "active", reason: undefined }, ctx, "resumed");
					ctx.ui.notify("Goal resumed.", "info");
					if (ctx.isIdle()) await kick(buildContinuationPrompt(goal), ctx);
					return;
				}
				if (sub === "cancel") {
					if (!goal) {
						ctx.ui.notify("No goal to cancel.", "warning");
						return;
					}
					setGoal(null, ctx, "cancelled");
					ctx.ui.notify("Goal cancelled.", "info");
					// Cancel stops goal-driven work, not just future continuations.
					if (!ctx.isIdle()) ctx.abort();
					return;
				}
				if (sub === "replace" || sub.startsWith("replace ")) {
					const objective = sub === "replace" ? "" : sub.slice("replace".length).trim();
					if (!objective) {
						ctx.ui.notify("Usage: /goal replace <objective>", "warning");
						return;
					}
					if (goal) setGoal(null, ctx, "cancelled");
					await startFromCommand(objective, ctx);
					return;
				}
				await startFromCommand(sub, ctx);
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			}
		},
	});

	async function startFromCommand(objective: string, ctx: ExtensionCommandContext): Promise<void> {
		const created = createGoal(objective, ctx);
		ctx.ui.notify("Goal started. It will keep working across turns until complete or blocked.", "info");
		// The objective goes in as a real user message (visible in transcript).
		if (ctx.isIdle()) {
			pi.sendUserMessage(created.objective);
		} else {
			pi.sendUserMessage(created.objective, { deliverAs: "steer" });
		}
		await awaitRunIfHeadless(ctx);
	}

	// ------------------------------------------------------------------- tool

	pi.registerTool({
		name: "goal",
		label: "Goal",
		description:
			"Inspect or update the session goal. Ops: get (current goal state), create (start an autonomous goal), complete (only with verified evidence for every requirement), blocked (genuine impasse only, after the blocking condition repeats for 3 consecutive goal turns), resume (reactivate a paused/blocked goal).",
		parameters: Type.Object({
			op: StringEnum(["get", "create", "complete", "blocked", "resume"] as const),
			objective: Type.Optional(Type.String({ description: "Required for create" })),
			replace: Type.Optional(Type.Boolean({ description: "For create: replace the current live goal" })),
			reason: Type.Optional(Type.String({ description: "For blocked: the concrete blocker" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true, details: {} });
			switch (params.op) {
				case "get": {
					const text = goal
						? `Goal: ${goal.objective}\nStatus: ${goal.status}\nGoal turns: ${goal.turnsUsed}${goal.reason ? `\nReason: ${goal.reason}` : ""}`
						: "No goal set.";
					return { content: [{ type: "text", text }], details: { goal } };
				}
				case "create": {
					let objective: string;
					try {
						objective = validateObjective(params.objective ?? "");
					} catch (err) {
						return fail(err instanceof Error ? err.message : String(err));
					}
					if (isLiveGoal(goal) && params.replace !== true) {
						return fail(
							`A goal already exists (${goal.status}): "${goal.objective.slice(0, 120)}". Pass replace: true to replace it.`,
						);
					}
					// Model-created goals start immediately by default; --goal-confirm
					// re-enables the gate (the write-goal flow's checkpoint is the
					// conversational approval of the drafted objective).
					if (pi.getFlag("goal-confirm") === true && ctx.hasUI) {
						const ok = await ctx.ui.confirm(
							"Start goal?",
							`The agent wants to start an autonomous goal:\n\n${objective}\n\nIt will keep working across turns until complete or blocked.`,
						);
						if (!ok) return fail("Goal creation declined by the user.");
					}
					if (isLiveGoal(goal)) setGoal(null, ctx, "cancelled");
					const created = createGoalState(objective);
					setGoal(created, ctx, "created");
					return {
						content: [
							{
								type: "text",
								text: `Goal created and active: ${created.objective}\nWork toward it; the runtime continues the goal across turns until you call complete or blocked.`,
							},
						],
						details: { goal: created },
					};
				}
				case "complete": {
					if (goal?.status !== "active") return fail("No active goal to complete.");
					setGoal({ ...goal, status: "complete" }, ctx, "complete");
					return { content: [{ type: "text", text: buildCompleteOutcome(goal) }], details: { goal } };
				}
				case "blocked": {
					if (goal?.status !== "active") return fail("No active goal to block.");
					setGoal({ ...goal, status: "blocked", reason: params.reason?.trim() || "blocked by agent" }, ctx, "blocked");
					return { content: [{ type: "text", text: buildBlockedOutcome(goal) }], details: { goal } };
				}
				case "resume": {
					if (!goal || (goal.status !== "paused" && goal.status !== "blocked")) {
						return fail("No paused/blocked goal to resume.");
					}
					setGoal({ ...goal, status: "active", reason: undefined }, ctx, "resumed");
					return {
						content: [
							{
								type: "text",
								text: "Goal resumed. Continue working toward the objective; the runtime keeps the goal going across turns.",
							},
						],
						details: { goal },
					};
				}
			}
		},
	});

	// ------------------------------------------------------------------ hooks

	// Per-LLM-call injection (compaction-safe) + stale continuation cleanup.
	pi.on("context", async (event) => {
		const messages = event.messages.filter((m, i) => {
			const msg = m as AgentMessage & { customType?: string };
			if (msg.role !== "custom" || msg.customType !== CONTINUATION_TYPE) return true;
			// Keep only the LAST goal-continuation message.
			return !event.messages.slice(i + 1).some((n) => (n as { customType?: string }).customType === CONTINUATION_TYPE);
		});
		if (goal && goal.status !== "complete") {
			const content = goal.status === "active" ? buildActiveReminder(goal) : buildInactiveNote(goal);
			messages.push({
				role: "user",
				content: [{ type: "text", text: content }],
				timestamp: Date.now(),
			} as AgentMessage);
		}
		return { messages };
	});

	// Count goal turns (kimi semantics: a turn is a turn, whether it starts a
	// new run or continues the current one). In-memory between runs: persists at
	// run boundaries (agent_end) and on session_shutdown instead of once per turn.
	// The counter feeds the reminder's "Goal turns so far" and the 3-turn blocked
	// audit, so a hard kill under-reports it and a blocked declaration may land
	// slightly late after a crash — accepted trade (quit/reload/SIGTERM/SIGHUP
	// all emit session_shutdown; only SIGKILL slips through).
	pi.on("turn_end", async (_event, ctx) => {
		if (goal?.status !== "active") return;
		goal = { ...goal, turnsUsed: goal.turnsUsed + 1, updatedAt: Date.now() };
		updateStatus(ctx);
	});

	// The continuation loop: a run ended with the goal still active -> queue a
	// hidden continuation as a followUp. pi drains queues after agent_end and
	// continues the run, so this works identically in TUI, print, and RPC mode.
	pi.on("agent_end", async (event, ctx) => {
		if (goal?.status !== "active") return;
		const stopReason = lastAssistantStopReason(event.messages);
		if (stopReason === "aborted") {
			setGoal({ ...goal, status: "paused", reason: "paused after interruption" }, ctx, "paused");
			return;
		}
		// Run boundary: persist the turn counter accrued since the last write.
		// Isolated from the loop: a failing appendEntry must not silently stop
		// continuations — the loop matters more than the counter.
		try {
			persistState();
		} catch {
			/* session store may be unavailable */
		}
		if (stopReason === "error") {
			// Pi may auto-retry; the agent_settled safety net handles exhaustion.
			return;
		}
		pi.sendMessage(
			{ customType: CONTINUATION_TYPE, content: buildContinuationPrompt(goal), display: false },
			{ deliverAs: "followUp" },
		);
	});

	// Safety net: an active goal should never see the agent settle. If it does
	// (e.g. retries exhausted after an error), pause instead of spinning idle.
	pi.on("agent_settled", async (_event, ctx) => {
		if (goal?.status === "active" && ctx.isIdle()) {
			setGoal({ ...goal, status: "paused", reason: "paused after run ended unexpectedly" }, ctx, "paused");
		}
	});

	// Clean exit: persist the latest counter so a resumed session restores it.
	pi.on("session_shutdown", async () => {
		if (!goal) return;
		try {
			persistState();
		} catch {
			/* session store may already be closed */
		}
	});

	// Restore state on start/resume; an active goal always comes back paused.
	pi.on("session_start", async (event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const stateEntry = entries
			.filter((e) => e.type === "custom" && (e as { customType?: string }).customType === STATE_ENTRY_TYPE)
			.pop() as { data?: GoalState | null } | undefined;
		if (stateEntry?.data) {
			goal = stateEntry.data;
			if (goal.status === "active") {
				setGoal({ ...goal, status: "paused", reason: "session resumed" }, ctx, "paused");
			}
		}
		updateStatus(ctx);

		// --goal "<objective>": start the session with a goal (TUI/RPC only;
		// headless goal usage is `pi -p "/goal ..."`).
		const flagObjective = pi.getFlag("goal");
		if (typeof flagObjective === "string" && flagObjective.trim() && !isLiveGoal(goal) && event.reason === "startup") {
			if (ctx.mode === "tui" || ctx.mode === "rpc") {
				try {
					const created = createGoal(flagObjective, ctx);
					// Defer the kick so the interactive mode finishes subscribing.
					setTimeout(() => {
						if (goal?.status === "active") pi.sendUserMessage(created.objective);
					}, 400);
				} catch {
					// Invalid objective: surfaced via notify on the next line anyway.
					ctx.ui.notify("Invalid --goal objective (empty or too long).", "error");
				}
			}
		}
	});

	// Bundle the write-goal skill with the extension.
	pi.on("resources_discover", async () => ({ skillPaths: [join(extensionDir, "skills")] }));

	// Lifecycle markers in the transcript (goal-state entries stay unrendered).
	pi.registerEntryRenderer(EVENT_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data as
			| { kind?: GoalEventKind; objective?: string; turnsUsed?: number; reason?: string }
			| undefined;
		if (!data?.kind) return new Text("", 0, 0);
		const objective =
			data.objective && data.objective.length > 80 ? `${data.objective.slice(0, 77)}...` : (data.objective ?? "");
		let line: string;
		switch (data.kind) {
			case "created":
				line = theme.fg("accent", `● goal started`) + (objective ? theme.fg("muted", `  ${objective}`) : "");
				break;
			case "resumed":
				line = theme.fg("accent", "● goal resumed");
				break;
			case "paused":
				line = theme.fg("muted", `❚❚ goal paused${data.reason ? ` (${data.reason})` : ""}`);
				break;
			case "cancelled":
				line = theme.fg("muted", "○ goal cancelled");
				break;
			case "complete":
				line = theme.fg("success", `✓ goal complete after ${data.turnsUsed ?? 0} turns`);
				break;
			case "blocked":
				line = theme.fg("warning", `▲ goal blocked${data.reason ? `: ${data.reason}` : ""}`);
				break;
		}
		return new Text(line, 0, 0);
	});
}
