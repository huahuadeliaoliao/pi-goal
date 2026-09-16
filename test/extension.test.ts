import { strict as assert } from "node:assert";
import test from "node:test";
import goalMode from "../index.ts";
import { createMockCtx, createMockPi, fireAsync } from "./helpers.ts";

function setup(ctxOptions = {}) {
	const mockPi = createMockPi();
	goalMode(mockPi.pi);
	const mockCtx = createMockCtx(ctxOptions);
	return { ...mockPi, ...mockCtx };
}

type Mock = ReturnType<typeof setup>;

/** Last persisted goal-state entry's data (null after a cancel). */
function stateOf(mock: Mock): any {
	const states = mock.appendedEntries.filter((e) => e.customType === "goal-state");
	return states.at(-1)?.data;
}

function stateEntries(mock: Mock) {
	return mock.appendedEntries.filter((e) => e.customType === "goal-state");
}

function goalEvents(mock: Mock): string[] {
	return mock.appendedEntries.filter((e) => e.customType === "goal-event").map((e) => e.data.kind);
}

function continuations(mock: Mock) {
	return mock.sentMessages.filter((m) => m.message.customType === "goal-continuation");
}

function messageText(m: any): string {
	return Array.isArray(m.content) ? m.content.map((c: any) => c.text ?? "").join("\n") : String(m.content);
}

const endedRun = (stopReason: string) => ({ messages: [{ role: "assistant", stopReason }] });

// ------------------------------------------------------------- registration

test("registers the goal tool, /goal command, flags and the event renderer", () => {
	const { tools, commands, flagDefs, entryRenderers } = setup();
	assert.ok(tools.has("goal"));
	assert.ok(commands.has("goal"));
	assert.ok(flagDefs.has("goal"));
	assert.ok(flagDefs.has("goal-confirm"));
	assert.ok(entryRenderers.has("goal-event"));
});

test("resources_discover bundles the write-goal skill directory", async () => {
	const mock = setup();
	const out = await fireAsync(mock, "resources_discover", {}, mock.ctx);
	const paths = (out[0] as { skillPaths: string[] }).skillPaths;
	assert.equal(paths.length, 1);
	assert.ok(paths[0].endsWith("skills"), `expected the bundled skills dir, got ${paths[0]}`);
});

// ----------------------------------------------------------------- command

test("/goal <objective> creates an active goal and sends it as a user message", async () => {
	const mock = setup();
	await mock.commands.get("goal")!.handler("fix every failing test", mock.ctx);

	assert.equal(stateOf(mock).status, "active");
	assert.equal(stateOf(mock).objective, "fix every failing test");
	assert.deepEqual(goalEvents(mock), ["created"]);
	assert.equal(mock.statuses.get("goal"), "goal: active (turn 0)");

	assert.equal(mock.sentUserMessages.length, 1);
	assert.equal(mock.sentUserMessages[0].content, "fix every failing test");
	assert.equal(mock.sentUserMessages[0].options, undefined, "idle start sends a plain user message");
	assert.ok(mock.notifications.some((n) => n.level === "info" && n.text.includes("Goal started")));
});

test("a second goal without replace is rejected", async () => {
	const mock = setup();
	const cmd = mock.commands.get("goal")!.handler;
	await cmd("first", mock.ctx);
	await cmd("second", mock.ctx);
	assert.equal(mock.sentUserMessages.length, 1, "the second goal must not start");
	assert.equal(stateOf(mock).objective, "first");
	assert.ok(mock.notifications.some((n) => n.level === "error" && n.text.includes("A goal already exists")));
});

test("bare /goal opens the editor; empty text starts nothing", async () => {
	const dismissed = setup();
	await dismissed.commands.get("goal")!.handler("", dismissed.ctx);
	assert.equal(dismissed.appendedEntries.length, 0, "dismissed editor starts no goal");

	const filled = setup({ editorText: "  migrate the payment module  " });
	await filled.commands.get("goal")!.handler("", filled.ctx);
	assert.equal(filled.sentUserMessages[0]?.content, "migrate the payment module");
	assert.equal(stateOf(filled).status, "active");
});

test("/goal status reports the current goal or its absence", async () => {
	const mock = setup();
	const cmd = mock.commands.get("goal")!.handler;
	await cmd("status", mock.ctx);
	assert.ok(mock.notifications.at(-1)?.text.includes("No goal"));

	await cmd("fix tests", mock.ctx);
	await cmd("status", mock.ctx);
	const text = mock.notifications.at(-1)?.text ?? "";
	assert.ok(text.includes("Status: active"));
	assert.ok(text.includes("fix tests"));
});

test("pause and resume flip the goal; resume from idle kicks a continuation", async () => {
	const mock = setup();
	const cmd = mock.commands.get("goal")!.handler;
	await cmd("fix tests", mock.ctx);
	await cmd("pause", mock.ctx);
	assert.equal(stateOf(mock).status, "paused");
	assert.deepEqual(goalEvents(mock), ["created", "paused"]);

	await cmd("resume", mock.ctx);
	assert.equal(stateOf(mock).status, "active");
	assert.deepEqual(goalEvents(mock), ["created", "paused", "resumed"]);
	assert.equal(continuations(mock).length, 1);
	assert.equal(continuations(mock)[0].options?.triggerTurn, true);
	assert.equal(continuations(mock)[0].message.display, false);
});

test("pause/resume/cancel without a matching goal warn and do nothing", async () => {
	const mock = setup();
	const cmd = mock.commands.get("goal")!.handler;
	await cmd("pause", mock.ctx);
	await cmd("resume", mock.ctx);
	await cmd("cancel", mock.ctx);
	assert.equal(mock.notifications.filter((n) => n.level === "warning").length, 3);
	assert.equal(mock.appendedEntries.length, 0);
});

test("cancel drops the goal and aborts goal-driven work when busy", async () => {
	const mock = setup({ idle: false });
	const cmd = mock.commands.get("goal")!.handler;
	await cmd("fix tests", mock.ctx);
	assert.equal(mock.sentUserMessages[0].options?.deliverAs, "steer", "mid-run start steers the objective in");

	await cmd("cancel", mock.ctx);
	assert.equal(stateOf(mock), null);
	assert.ok(mock.isAborted(), "cancel aborts the running turn");
	assert.deepEqual(goalEvents(mock), ["created", "cancelled"]);
});

test("/goal replace cancels the old goal and starts the new one", async () => {
	const mock = setup();
	const cmd = mock.commands.get("goal")!.handler;
	await cmd("old objective", mock.ctx);
	await cmd("replace new objective", mock.ctx);
	assert.deepEqual(goalEvents(mock), ["created", "cancelled", "created"]);
	assert.equal(stateOf(mock).objective, "new objective");
	assert.equal(mock.sentUserMessages.at(-1)?.content, "new objective");

	await cmd("replace", mock.ctx);
	assert.ok(mock.notifications.some((n) => n.level === "warning" && n.text.includes("Usage")));
});

// -------------------------------------------------------------------- tool

test("goal tool get reports state", async () => {
	const mock = setup();
	const tool = mock.tools.get("goal")!;
	const empty = await tool.execute("t1", { op: "get" }, undefined, undefined, mock.ctx);
	assert.ok(empty.content[0].text.includes("No goal set."));

	await mock.commands.get("goal")!.handler("fix tests", mock.ctx);
	const res = await tool.execute("t2", { op: "get" }, undefined, undefined, mock.ctx);
	assert.ok(res.content[0].text.includes("fix tests"));
	assert.equal(res.details.goal.status, "active");
});

test("goal tool create starts immediately by default, without a confirmation prompt", async () => {
	const mock = setup({ confirm: false }); // if asked, the answer would be no
	const res = await mock.tools
		.get("goal")!
		.execute("t1", { op: "create", objective: "fix tests" }, undefined, undefined, mock.ctx);
	assert.ok(!res.isError);
	assert.equal(mock.confirmCalls.length, 0, "no confirm prompt by default");
	assert.equal(stateOf(mock).status, "active");
	assert.deepEqual(goalEvents(mock), ["created"]);
});

test("--goal-confirm re-enables the gate: approval starts, decline cancels", async () => {
	const declined = setup({ confirm: false });
	declined.flags.set("goal-confirm", true);
	const deny = await declined.tools
		.get("goal")!
		.execute("t1", { op: "create", objective: "fix tests" }, undefined, undefined, declined.ctx);
	assert.equal(deny.isError, true);
	assert.ok(deny.content[0].text.includes("declined"));
	assert.equal(declined.confirmCalls.length, 1);
	assert.equal(declined.appendedEntries.length, 0, "declined create leaves no trace");

	const accepted = setup({ confirm: true });
	accepted.flags.set("goal-confirm", true);
	const ok = await accepted.tools
		.get("goal")!
		.execute("t1", { op: "create", objective: "fix tests" }, undefined, undefined, accepted.ctx);
	assert.ok(!ok.isError);
	assert.equal(accepted.confirmCalls.length, 1);
	assert.equal(stateOf(accepted).status, "active");
});

test("goal tool create validates and refuses to clobber a live goal without replace", async () => {
	const mock = setup();
	const tool = mock.tools.get("goal")!;
	const invalid = await tool.execute("t1", { op: "create", objective: "   " }, undefined, undefined, mock.ctx);
	assert.equal(invalid.isError, true);
	assert.ok(invalid.content[0].text.includes("cannot be empty"));

	await tool.execute("t2", { op: "create", objective: "first" }, undefined, undefined, mock.ctx);
	const clobber = await tool.execute("t3", { op: "create", objective: "second" }, undefined, undefined, mock.ctx);
	assert.equal(clobber.isError, true);
	assert.ok(clobber.content[0].text.includes("replace: true"));
	assert.equal(stateOf(mock).objective, "first");

	const replaced = await tool.execute(
		"t4",
		{ op: "create", objective: "second", replace: true },
		undefined,
		undefined,
		mock.ctx,
	);
	assert.ok(!replaced.isError);
	assert.equal(stateOf(mock).objective, "second");
	assert.deepEqual(goalEvents(mock), ["created", "cancelled", "created"]);
});

test("goal tool complete and blocked end the loop with an outcome", async () => {
	const mock = setup();
	const tool = mock.tools.get("goal")!;
	const noGoal = await tool.execute("t0", { op: "complete" }, undefined, undefined, mock.ctx);
	assert.equal(noGoal.isError, true, "no active goal to complete");

	await tool.execute("t1", { op: "create", objective: "fix tests" }, undefined, undefined, mock.ctx);
	const done = await tool.execute("t2", { op: "complete" }, undefined, undefined, mock.ctx);
	assert.ok(done.content[0].text.includes("Goal completed"));
	assert.equal(stateOf(mock).status, "complete");

	// A completed goal is history: a new goal starts without replace.
	const next = await tool.execute("t3", { op: "create", objective: "next thing" }, undefined, undefined, mock.ctx);
	assert.ok(!next.isError);

	const blocked = await tool.execute(
		"t4",
		{ op: "blocked", reason: "needs credentials" },
		undefined,
		undefined,
		mock.ctx,
	);
	assert.ok(blocked.content[0].text.includes("Goal blocked"));
	assert.equal(stateOf(mock).status, "blocked");
	assert.equal(stateOf(mock).reason, "needs credentials");
});

test("goal tool resume reactivates paused/blocked goals only", async () => {
	const mock = setup();
	const tool = mock.tools.get("goal")!;
	await tool.execute("t1", { op: "create", objective: "fix tests" }, undefined, undefined, mock.ctx);
	const premature = await tool.execute("t2", { op: "resume" }, undefined, undefined, mock.ctx);
	assert.equal(premature.isError, true, "an active goal cannot resume");

	await mock.commands.get("goal")!.handler("pause", mock.ctx);
	const resumed = await tool.execute("t3", { op: "resume" }, undefined, undefined, mock.ctx);
	assert.ok(!resumed.isError);
	assert.equal(stateOf(mock).status, "active");
});

// -------------------------------------------------------- continuation loop

test("agent_end with an active goal queues a hidden continuation as followUp", async () => {
	const mock = setup();
	await mock.commands.get("goal")!.handler("fix tests", mock.ctx);
	mock.sentMessages.length = 0;

	await fireAsync(mock, "agent_end", endedRun("end"), mock.ctx);
	assert.equal(mock.sentMessages.length, 1);
	const { message, options } = mock.sentMessages[0];
	assert.equal(message.customType, "goal-continuation");
	assert.equal(message.display, false);
	assert.equal(options?.deliverAs, "followUp");
	assert.ok(String(message.content).includes("fix tests"));
});

test("agent_end does nothing without an active goal", async () => {
	const mock = setup();
	await fireAsync(mock, "agent_end", endedRun("end"), mock.ctx);
	assert.equal(mock.sentMessages.length, 0);

	await mock.commands.get("goal")!.handler("fix tests", mock.ctx);
	await mock.commands.get("goal")!.handler("pause", mock.ctx);
	mock.sentMessages.length = 0;
	await fireAsync(mock, "agent_end", endedRun("end"), mock.ctx);
	assert.equal(mock.sentMessages.length, 0, "a paused goal never continues");
});

test("an interrupted run pauses the goal instead of continuing", async () => {
	const mock = setup();
	await mock.commands.get("goal")!.handler("fix tests", mock.ctx);
	mock.sentMessages.length = 0;

	await fireAsync(mock, "agent_end", endedRun("aborted"), mock.ctx);
	assert.equal(mock.sentMessages.length, 0);
	assert.equal(stateOf(mock).status, "paused");
	assert.equal(stateOf(mock).reason, "paused after interruption");
	assert.deepEqual(goalEvents(mock), ["created", "paused"]);
});

test("an errored run stays active; agent_settled on an idle runtime is the safety net", async () => {
	const mock = setup();
	await mock.commands.get("goal")!.handler("fix tests", mock.ctx);
	mock.sentMessages.length = 0;

	await fireAsync(mock, "agent_end", endedRun("error"), mock.ctx);
	assert.equal(mock.sentMessages.length, 0, "no continuation on error: pi may auto-retry");
	assert.equal(stateOf(mock).status, "active");

	await fireAsync(mock, "agent_settled", {}, mock.ctx);
	assert.equal(stateOf(mock).status, "paused");
	assert.equal(stateOf(mock).reason, "paused after run ended unexpectedly");
});

// -------------------------------------------------------------- turn counting

test("turn_end counts goal turns for active goals only", async () => {
	const mock = setup();
	await fireAsync(mock, "turn_end", {}, mock.ctx);

	await mock.commands.get("goal")!.handler("fix tests", mock.ctx);
	await fireAsync(mock, "turn_end", {}, mock.ctx);
	await fireAsync(mock, "turn_end", {}, mock.ctx);
	// The counter is in-memory between runs: observe it via /goal status.
	await mock.commands.get("goal")!.handler("status", mock.ctx);
	assert.ok(mock.notifications.at(-1)?.text.includes("Goal turns: 2"));
	assert.equal(mock.statuses.get("goal"), "goal: active (turn 2)");

	await mock.commands.get("goal")!.handler("pause", mock.ctx);
	await fireAsync(mock, "turn_end", {}, mock.ctx);
	assert.equal(stateOf(mock).turnsUsed, 2, "a paused goal does not count turns");
});

test("turns persist at run boundaries and shutdown, not on every turn", async () => {
	const mock = setup();
	await mock.commands.get("goal")!.handler("fix tests", mock.ctx);
	const afterStart = stateEntries(mock).length;

	await fireAsync(mock, "turn_end", {}, mock.ctx);
	await fireAsync(mock, "turn_end", {}, mock.ctx);
	assert.equal(stateEntries(mock).length, afterStart, "no per-turn session writes");
	assert.equal(mock.statuses.get("goal"), "goal: active (turn 2)", "the footer still tracks turns live");

	await fireAsync(mock, "agent_end", endedRun("end"), mock.ctx);
	assert.equal(stateEntries(mock).length, afterStart + 1, "one write per run boundary");
	assert.equal(stateOf(mock).turnsUsed, 2, "the run boundary persists the accrued counter");

	await fireAsync(mock, "session_shutdown", {}, mock.ctx);
	assert.equal(stateEntries(mock).length, afterStart + 2, "shutdown persists the final counter");
});

// ------------------------------------------------------------------- context

test("context injects the active reminder and keeps only the last continuation", async () => {
	const mock = setup();
	await mock.commands.get("goal")!.handler("fix tests", mock.ctx);

	const cont = { role: "custom", customType: "goal-continuation", content: "continue", timestamp: 1 };
	const other = { role: "custom", customType: "other", content: "note", timestamp: 1 };
	const user = { role: "user", content: "hi", timestamp: 2 };
	const out = await fireAsync(mock, "context", { messages: [cont, user, cont, other] }, mock.ctx);

	const messages = (out[0] as { messages: any[] }).messages;
	assert.equal(
		messages.filter((m) => m.customType === "goal-continuation").length,
		1,
		"stale continuations are dropped",
	);
	assert.equal(messages.filter((m) => m.customType === "other").length, 1, "unrelated custom messages survive");

	const last = messages.at(-1);
	assert.equal(last.role, "user");
	const text = messageText(last);
	assert.ok(text.includes("fix tests"));
	assert.ok(text.includes("active goal"));
});

test("context injects an inactive note for paused goals, nothing for absent or completed ones", async () => {
	const mock = setup();
	let out = await fireAsync(mock, "context", { messages: [] }, mock.ctx);
	assert.equal((out[0] as { messages: any[] }).messages.length, 0, "no goal: no injection");

	await mock.commands.get("goal")!.handler("fix tests", mock.ctx);
	await mock.commands.get("goal")!.handler("pause", mock.ctx);
	out = await fireAsync(mock, "context", { messages: [] }, mock.ctx);
	const messages = (out[0] as { messages: any[] }).messages;
	assert.equal(messages.length, 1);
	assert.ok(messageText(messages[0]).includes("currently paused"));

	const done = setup();
	await done.commands.get("goal")!.handler("fix tests", done.ctx);
	await done.tools.get("goal")!.execute("t1", { op: "complete" }, undefined, undefined, done.ctx);
	out = await fireAsync(done, "context", { messages: [] }, done.ctx);
	assert.equal((out[0] as { messages: any[] }).messages.length, 0, "completed goal: no injection");
});

// ------------------------------------------------------------------ restore

test("session_start restores an active goal as paused", async () => {
	const mock = setup({
		storedEntries: [
			{
				type: "custom",
				customType: "goal-state",
				data: { objective: "fix tests", status: "active", turnsUsed: 4, createdAt: 1, updatedAt: 2 },
			},
		],
	});
	await fireAsync(mock, "session_start", { reason: "resume" }, mock.ctx);
	assert.equal(stateOf(mock).status, "paused");
	assert.equal(stateOf(mock).reason, "session resumed");
	assert.equal(stateOf(mock).turnsUsed, 4);
	assert.ok(goalEvents(mock).includes("paused"));
	assert.equal(mock.statuses.get("goal"), "goal: paused");
});

test("session_start without a stored goal starts clean", async () => {
	const mock = setup();
	await fireAsync(mock, "session_start", { reason: "startup" }, mock.ctx);
	assert.equal(mock.statuses.get("goal"), undefined);
	assert.equal(mock.appendedEntries.length, 0);

	await fireAsync(mock, "session_shutdown", {}, mock.ctx);
	assert.equal(mock.appendedEntries.length, 0, "shutdown with no goal writes nothing");
});

test("--goal starts a goal on startup in TUI mode", async () => {
	const mock = setup();
	mock.flags.set("goal", "fix tests from flag");
	await fireAsync(mock, "session_start", { reason: "startup" }, mock.ctx);
	assert.equal(stateOf(mock).status, "active");
	assert.equal(stateOf(mock).objective, "fix tests from flag");

	// The kick is deferred so the interactive mode finishes subscribing.
	await new Promise((r) => setTimeout(r, 500));
	assert.equal(mock.sentUserMessages.at(-1)?.content, "fix tests from flag");
});

test("a headless start without waitForIdle degrades gracefully instead of throwing", async () => {
	const mock = setup({ mode: "print" });
	delete (mock.ctx as any).waitForIdle; // only command contexts carry it
	await mock.commands.get("goal")!.handler("fix tests", mock.ctx);
	assert.equal(mock.sentUserMessages.length, 1, "the objective still goes out");
	assert.equal(stateOf(mock).status, "active");
});

test("--goal is ignored when a live goal exists or the mode is not interactive", async () => {
	const resumed = setup({
		storedEntries: [
			{
				type: "custom",
				customType: "goal-state",
				data: { objective: "old objective", status: "paused", turnsUsed: 1, createdAt: 1, updatedAt: 1 },
			},
		],
	});
	resumed.flags.set("goal", "new objective");
	await fireAsync(resumed, "session_start", { reason: "resume" }, resumed.ctx);
	await resumed.commands.get("goal")!.handler("status", resumed.ctx);
	assert.ok(resumed.notifications.at(-1)?.text.includes("old objective"), "the stored live goal wins over the flag");

	const headless = setup({ mode: "print" });
	headless.flags.set("goal", "fix tests");
	await fireAsync(headless, "session_start", { reason: "startup" }, headless.ctx);
	assert.equal(headless.appendedEntries.length, 0, "print mode: the flag is ignored");
});
