/**
 * Micro-spike: validate agent_end -> followUp -> agent.continue() re-entry.
 * On the first agent_end, queue exactly one followUp custom message.
 * If the machinery works, a second agent run starts after the first settles-without-settling.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let queued = false;
	pi.on("agent_end", async () => {
		if (queued) return;
		queued = true;
		console.error("[cont-spike] agent_end: queueing followUp continuation");
		pi.sendMessage(
			{ customType: "test-continuation", content: "Reply with exactly: continuation-ok", display: false },
			{ deliverAs: "followUp" },
		);
	});
	pi.on("agent_start", async () => {
		console.error("[cont-spike] agent_start");
	});
	pi.on("agent_settled", async () => {
		console.error("[cont-spike] agent_settled");
	});
}
