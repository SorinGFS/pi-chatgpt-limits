/** Exercises command registration and lifecycle isolation without live requests. */

import assert from "node:assert/strict";
import test from "node:test";
import codexReset from "../extensions/codex-reset.js";

/** Bind a mocked command context and invalidate a confirmation through real registered events. */
test("registered command uses its context and cancels on model or session lifecycle changes", async () => {
	const handlers = new Map();
	const commands = new Map();
	const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url");
	const requests = [], notifications = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, options) => {
		requests.push({ url, options });
		return { ok: true, json: async () => options.method === "GET"
			? { credits: [{ id: "credit", status: "available", expires_at: null }] }
			: { code: "reset", windows_reset: 1 } };
	};
	try {
		codexReset({
			on: (name, handler) => handlers.set(name, handler),
			registerCommand: (name, command) => commands.set(name, command),
		});
		assert.ok(commands.has("codex-reset"));
		let invalidate = false;
		const ctx = {
			mode: "tui", hasUI: true,
			model: { provider: "openai-codex", id: "model" },
			sessionManager: { getSessionId: () => "session" },
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: `a.${payload}.b` }) },
			ui: {
				notify: (message) => notifications.push(message),
				confirm: async () => { if (invalidate) handlers.get("model_select")(); return true; },
			},
		};
		handlers.get("session_start")();
		const handler = commands.get("codex-reset").handler;
		await handler("", ctx);
		await handler("", ctx);
		const posts = requests.filter((request) => request.options.method === "POST");
		assert.equal(posts.length, 2);
		const ids = posts.map((request) => JSON.parse(request.options.body));
		assert.equal(ids[0].credit_id, "credit");
		assert.notEqual(ids[0].redeem_request_id, ids[1].redeem_request_id);
		invalidate = true;
		await handler("", ctx);
		assert.equal(requests.filter((request) => request.options.method === "POST").length, 2);
		assert.match(notifications.at(-1), /changed/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
