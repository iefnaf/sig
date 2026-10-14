// Spike: extension injected per process by the connector. Gives the agent a structured way to end a task.
export default function (pi: any) {
	pi.registerTool({
		name: "report",
		label: "Report",
		description:
			"Call this exactly once when you finish, are blocked, or need a decision from the user. " +
			"status is one of: done, blocked, needs_decision.",
		parameters: {
			type: "object",
			properties: {
				status: { type: "string", enum: ["done", "blocked", "needs_decision"] },
				summary: { type: "string", description: "One sentence result" },
				changes: { type: "array", items: { type: "string" }, description: "What changed, with locations" },
				question: { type: "string", description: "Only for needs_decision/blocked" },
			},
			required: ["status", "summary"],
		},
		async execute(_toolCallId: string, params: unknown) {
			return { content: [{ type: "text", text: "report recorded" }], details: params };
		},
	});
}
