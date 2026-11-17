/** Tests reset selection and redemption with mocked network and UI. */

import assert from "node:assert/strict";
import test from "node:test";
import { RESET_ENDPOINT, createResetCommand, selectResetCredit } from "../src/reset.js";

/** Exercise ordering, invalid expiries, expired grants, and unsupported statuses. */
test("selectResetCredit chooses earliest finite expiry then ID, with null last", () => {
	const grant = (id, status, expires_at) => ({ id, status, expires_at });
	const credits = [
		grant("null", "available", null), grant("unknown", "other", "2099-01-01T00:00:00Z"),
		grant("expired", "available", "2020-01-01T00:00:00Z"), grant("invalid", "available", "invalid"),
		{ id: "missing", status: "available" }, grant("z", "available", "2099-01-01T00:00:00Z"),
		grant("a", "available", "2099-01-01T00:00:00Z"), grant("redeemed", "redeemed", "2098-01-01T00:00:00Z"),
	];
	assert.equal(selectResetCredit({ credits }).id, "a");
	assert.equal(selectResetCredit({ credits: credits.slice(0, 5) }).id, "null");
	assert.equal(selectResetCredit({ credits: credits.slice(1, 5) }), undefined);
	assert.equal(selectResetCredit({ credits: [grant("bad-date", "available", "2099-02-30T00:00:00Z")] }), undefined);
	assert.throws(() => selectResetCredit({}), /Invalid/);
});

/** Create an isolated command harness with controlled UI, authentication, and network. */
function resetHarness({ confirm = async () => true, outcome = { code: "reset", windows_reset: 2 }, fetchFailure = false, listStatus = 200, postStatus = 200, credits = [
	{ id: "later", status: "available", expires_at: null },
	{ id: "chosen", status: "available", reset_type: "codex_rate_limits", expires_at: "2099-01-01T00:00:00Z" },
	{ id: "expired", status: "available", expires_at: "2020-01-01T00:00:00Z" },
	{ id: "used", status: "redeemed", expires_at: null },
] } = {}) {
	const requests = [], notifications = [], prompts = [];
	let account = "account", current = true;
	const ctx = { mode: "tui", hasUI: true, ui: {
		notify: (message) => notifications.push(message),
		confirm: async (...args) => { prompts.push(args); return confirm(); },
	} };
	const command = createResetCommand({
		resolveCredentials: async () => ({ accountId: account, accessToken: "token" }),
		isCurrent: () => current,
		makeId: () => "request-123",
		fetchImpl: async (url, options) => {
			requests.push({ url, options });
			if (options.method === "GET") return { ok: listStatus === 200, status: listStatus, json: async () => ({ credits }) };
			if (fetchFailure) throw new Error("network secret");
			return { ok: postStatus === 200, status: postStatus, json: async () => outcome };
		},
	});
	return { ctx, command, requests, notifications, prompts,
		setAccount: (value) => { account = value; }, setCurrent: (value) => { current = value; } };
}

/** Confirm the actual request is explicit, authenticated, single-shot. */
test("confirmed reset posts selected credit and handles response code", async () => {
	const h = resetHarness();
	await h.command("", h.ctx);
	assert.equal(h.requests.length, 2);
	assert.equal(h.requests[0].url, RESET_ENDPOINT);
	assert.equal(h.requests[1].url, RESET_ENDPOINT + "/consume");
	assert.deepEqual(JSON.parse(h.requests[1].options.body), { redeem_request_id: "request-123", credit_id: "chosen" });
	assert.equal(h.requests[1].options.headers.Authorization, "Bearer token");
	assert.equal(h.requests[1].options.headers["ChatGPT-Account-Id"], "account");
	assert.deepEqual(h.requests.map((request) => request.options.method), ["GET", "POST"]);
	assert.deepEqual(h.prompts[0], ["Use a Codex reset credit?", "Credit: chosen\nType: codex_rate_limits\nExpires: 2099-01-01T00:00:00Z\n1 reset credits would remain."]);
	assert.match(h.notifications.at(-1), /completed \(2 windows/);
});

/** Count only selectable credits and show zero remaining for a single grant. */
test("confirmation counts eligible credits from the existing list", async () => {
	const h = resetHarness({ credits: [
		{ id: "only", status: "available", expires_at: null },
		{ id: "expired", status: "available", expires_at: "2020-01-01T00:00:00Z" },
		{ id: "used", status: "redeemed", expires_at: null },
	] });
	await h.command("", h.ctx);
	assert.equal(h.prompts[0][1], "Credit: only\nType: unknown\nExpires: never\n0 reset credits would remain.");
	assert.deepEqual(h.requests.map((request) => request.options.method), ["GET", "POST"]);
});

/** Cancellation, noninteractive mode and changed account must never issue a POST. */
test("reset refuses cancelled, noninteractive, changed account and changed model cases", async () => {
	const cancelled = resetHarness({ confirm: async () => false });
	await cancelled.command("", cancelled.ctx);
	assert.equal(cancelled.requests.length, 1);
	const noninteractive = resetHarness();
	noninteractive.ctx.mode = "print";
	await noninteractive.command("", noninteractive.ctx);
	assert.equal(noninteractive.requests.length, 0);
	let changed;
	changed = resetHarness({ confirm: async () => { changed.setAccount("other"); return true; } });
	await changed.command("", changed.ctx);
	assert.equal(changed.requests.length, 1);
	let model;
	model = resetHarness({ confirm: async () => { model.setCurrent(false); return true; } });
	await model.command("", model.ctx);
	assert.equal(model.requests.length, 1);
});

/** Distinguish unsuccessful application outcomes from HTTP success without retrying. */
test("reset reports outcomes and does not retry uncertain requests", async () => {
	for (const code of ["nothing_to_reset", "no_credit", "already_redeemed", "unknown"]) {
		const h = resetHarness({ outcome: { code } });
		await h.command("", h.ctx);
		assert.doesNotMatch(h.notifications.at(-1), /completed/);
		assert.equal(h.requests.length, 2);
	}
	const h = resetHarness({ fetchFailure: true });
	await h.command("", h.ctx);
	assert.match(h.notifications.at(-1), /outcome is unknown/);
	assert.equal(h.requests.length, 2);
	const failedPost = resetHarness({ postStatus: 500 });
	await failedPost.command("", failedPost.ctx);
	assert.match(failedPost.notifications.at(-1), /outcome may be unknown/);
	assert.equal(failedPost.requests.length, 2);
	const failedList = resetHarness({ listStatus: 401 });
	await failedList.command("", failedList.ctx);
	assert.match(failedList.notifications.at(-1), /list request failed/);
	assert.equal(failedList.requests.length, 1);
});

/** Serialize invocations while a confirmation remains outstanding. */
test("concurrent reset invocations cannot consume twice", async () => {
	let release;
	const h = resetHarness({ confirm: () => new Promise((resolve) => { release = resolve; }) });
	const first = h.command("", h.ctx);
	while (!release) await new Promise((resolve) => setImmediate(resolve));
	await h.command("", h.ctx);
	assert.equal(h.requests.length, 1);
	release(true);
	await first;
	assert.equal(h.requests.length, 2);
});

