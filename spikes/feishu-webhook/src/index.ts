// Spike: receive Feishu webhook events, answer the URL verification challenge, log the rest.
export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== "POST") return new Response("ok", { status: 200 });
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
		const headers = Object.fromEntries([...request.headers].map(([k, v]) => [k, String(v).slice(0, 60)]));
		// Feishu URL verification: echo the challenge
		if (body.type === "url_verification") {
			console.log("URL_VERIFICATION", JSON.stringify({ headers, challenge: body.challenge }));
			return Response.json({ challenge: body.challenge });
		}
		// Real events: log type + event id, return 200 quickly (Feishu retries on non-2xx)
		console.log("EVENT", JSON.stringify({
			path: url.pathname,
			type: body.type ?? (body as any).header?.event_type,
			event_id: (body as any).header?.event_id ?? body.event_id,
			schema: (body as any).header?.schema_version,
			ts: (body as any).header?.create_time,
			body: JSON.stringify(body).slice(0, 800),
			headers,
		}));
		return new Response(null, { status: 200 });
	},
};
