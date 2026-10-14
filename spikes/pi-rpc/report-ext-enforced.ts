// Spike: report tool plus enforcement. If a run completes without a report call, force exactly one more request.
export default function (pi: any) {
	let reported = false;
	let reminded = false;

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
			reported = true;
			return { content: [{ type: "text", text: "report recorded" }], details: params };
		},
	});

	pi.on("agent_start", () => {
		reported = false;
		reminded = false;
	});

	pi.on("agent_before_settle", (event: any) => {
		if (event.outcome !== "completed" || reported || reminded) return undefined;
		reminded = true;
		return {
			entries: [
				{
					type: "custom_message",
					customType: "shepherd.report-reminder",
					content: "You finished without calling the report tool. Call report now with the final status and a one-sentence summary.",
					display: true,
				},
			],
			continue: true,
		};
	});
}
