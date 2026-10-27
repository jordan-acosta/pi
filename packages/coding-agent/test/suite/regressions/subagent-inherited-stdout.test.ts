import type * as ChildProcessModule from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import subagentExtension from "../../../examples/extensions/subagent/index.ts";
import { createHarness, getMessageText } from "../harness.ts";

/**
 * The subagent example only finished on the child's "close" event. A descendant of the
 * subagent that inherits its stdout (e.g. a backgrounded shell command) keeps the pipe
 * open after the subagent exits, so "close" never fired and the tool call never returned.
 * The fake child below emits "exit" but never "close" or stream "end", like a process
 * whose pipes are held open by a lingering descendant.
 */

const mockState = vi.hoisted(() => ({
	agentDir: "",
	spawnSubagent: undefined as (() => unknown) | undefined,
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcessModule>();
	return {
		...actual,
		spawn: (command: string, args: readonly string[], options: SpawnOptions) =>
			Array.isArray(args) && args.includes("--no-session") && mockState.spawnSubagent
				? mockState.spawnSubagent()
				: actual.spawn(command, args, options),
	};
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
	CONFIG_DIR_NAME: ".pi",
	getAgentDir: () => mockState.agentDir,
	getMarkdownTheme: () => ({}),
	parseFrontmatter: (content: string) => ({
		frontmatter: { name: "worker", description: "Test worker" },
		body: content,
	}),
	withFileMutationQueue: async (_path: string, fn: () => Promise<unknown>) => fn(),
}));

function createHeldOpenChild() {
	return Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		exitCode: null,
		signalCode: null,
		kill: () => true,
	});
}

function messageEndLine(text: string): string {
	const message = {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
	};
	return `${JSON.stringify({ type: "message_end", message })}\n`;
}

async function runWorker(spawnSubagent: () => unknown): Promise<string> {
	const harness = await createHarness({ extensionFactories: [subagentExtension] });
	mockState.agentDir = join(harness.tempDir, "agent");
	mockState.spawnSubagent = spawnSubagent;

	try {
		const agentsDir = join(mockState.agentDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(join(agentsDir, "worker.md"), "---\nname: worker\ndescription: Test worker\n---\n\nDo the task.\n");

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("subagent", { agent: "worker", task: "Write a report" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Delegate this task");

		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		return getMessageText(toolResult);
	} finally {
		mockState.spawnSubagent = undefined;
		harness.cleanup();
	}
}

describe("regression: subagent example with stdout held open by a descendant", () => {
	it("returns the subagent's output when the process exits but its pipes never close", async () => {
		const result = await runWorker(() => {
			const child = createHeldOpenChild();
			setImmediate(() => {
				child.stdout.write(messageEndLine("subagent report"));
				child.emit("exit", 0, null);
			});
			return child;
		});

		expect(result).toBe("subagent report");
	});

	it("keeps reading output that arrives after exit while the pipes stay active", async () => {
		const result = await runWorker(() => {
			const child = createHeldOpenChild();
			setImmediate(() => {
				child.emit("exit", 0, null);
				setTimeout(() => child.stdout.write(messageEndLine("partial report")), 50);
				setTimeout(() => child.stdout.write(messageEndLine("final report")), 120);
			});
			return child;
		});

		expect(result).toBe("final report");
	});
});
