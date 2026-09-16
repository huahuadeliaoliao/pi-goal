/**
 * Test doubles for pi's ExtensionAPI / ExtensionContext.
 *
 * The extension's default export is a plain factory: feed it the mock `pi`
 * and every registration (event handlers, tools, commands, flags, renderers)
 * is captured for the test to drive directly. No real pi process is involved.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type CapturedHandler = (event: any, ctx: any) => unknown;

export interface MockPi {
	pi: ExtensionAPI;
	handlers: Map<string, CapturedHandler[]>;
	tools: Map<string, { name: string; execute: (...args: any[]) => Promise<any>; [k: string]: unknown }>;
	commands: Map<string, { handler: (args: string, ctx: any) => Promise<void>; description?: string }>;
	/** Values returned by pi.getFlag; set these in tests. */
	flags: Map<string, unknown>;
	flagDefs: Map<string, unknown>;
	entryRenderers: Map<string, unknown>;
	sentMessages: Array<{ message: any; options?: any }>;
	sentUserMessages: Array<{ content: string; options?: any }>;
	appendedEntries: Array<{ customType: string; data?: any }>;
}

export function createMockPi(): MockPi {
	const handlers = new Map<string, CapturedHandler[]>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const flags = new Map<string, unknown>();
	const flagDefs = new Map<string, unknown>();
	const entryRenderers = new Map<string, unknown>();
	const sentMessages: MockPi["sentMessages"] = [];
	const sentUserMessages: MockPi["sentUserMessages"] = [];
	const appendedEntries: MockPi["appendedEntries"] = [];

	const pi = {
		on(event: string, handler: CapturedHandler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(def: any) {
			tools.set(def.name, def);
		},
		registerCommand(name: string, def: any) {
			commands.set(name, def);
		},
		registerFlag(name: string, def: unknown) {
			flagDefs.set(name, def);
		},
		getFlag(name: string) {
			return flags.get(name);
		},
		registerEntryRenderer(customType: string, renderer: unknown) {
			entryRenderers.set(customType, renderer);
		},
		registerMessageRenderer() {},
		sendMessage(message: any, options?: any) {
			sentMessages.push({ message, options });
		},
		sendUserMessage(content: string, options?: any) {
			sentUserMessages.push({ content, options });
		},
		appendEntry(customType: string, data?: any) {
			appendedEntries.push({ customType, data });
		},
	} as unknown as ExtensionAPI;

	return {
		pi,
		handlers,
		tools,
		commands,
		flags,
		flagDefs,
		entryRenderers,
		sentMessages,
		sentUserMessages,
		appendedEntries,
	};
}

export interface MockCtxOptions {
	/** "tui" (default) | "print" | "json" | "rpc" — print/json engage the headless wait path. */
	mode?: string;
	hasUI?: boolean;
	/** Whether the runtime is idle; /goal cancel aborts only when busy. */
	idle?: boolean;
	/** Answer for ctx.ui.confirm (model-created goals). Default: true. */
	confirm?: boolean;
	/** Text returned by ctx.ui.editor for a bare /goal. Default: undefined (dismissed). */
	editorText?: string;
	storedEntries?: any[];
}

export interface MockCtx {
	ctx: ExtensionContext;
	notifications: Array<{ text: string; level: string }>;
	statuses: Map<string, string | undefined>;
	/** Every ctx.ui.confirm invocation, in order. Empty = the gate never fired. */
	confirmCalls: Array<{ title: string; text: string }>;
	isAborted: () => boolean;
}

export function createMockCtx(options: MockCtxOptions = {}): MockCtx {
	const notifications: MockCtx["notifications"] = [];
	const statuses = new Map<string, string | undefined>();
	const confirmCalls: MockCtx["confirmCalls"] = [];
	let aborted = false;
	const idle = options.idle ?? true;

	const ctx = {
		cwd: "/tmp/pi-goal-test",
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		ui: {
			notify(text: string, level: string) {
				notifications.push({ text, level });
			},
			setStatus(key: string, text?: string) {
				statuses.set(key, text);
			},
			async confirm(title: string, text: string) {
				confirmCalls.push({ title, text });
				return options.confirm ?? true;
			},
			async editor() {
				return options.editorText;
			},
		},
		isIdle: () => idle,
		waitForIdle: async () => {},
		abort() {
			aborted = true;
		},
		sessionManager: {
			getEntries: () => options.storedEntries ?? [],
		},
	} as unknown as ExtensionContext;

	return { ctx, notifications, statuses, confirmCalls, isAborted: () => aborted };
}

export function fire(pi: MockPi, event: string, eventPayload: any, ctx: any): unknown[] {
	return (pi.handlers.get(event) ?? []).map((h) => h(eventPayload, ctx));
}

/** Fire an event and await every (possibly async) handler result. */
export async function fireAsync(pi: MockPi, event: string, eventPayload: any, ctx: any): Promise<any[]> {
	return Promise.all(fire(pi, event, eventPayload, ctx).map((r) => Promise.resolve(r)));
}
