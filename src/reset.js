/** Implements reset credit selection and confirmed, single-shot redemption. */

export const CODEX_PROVIDER_ID = "openai-codex";
export const RESET_ENDPOINT = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CHATGPT_AUTH_CLAIM = "https://api.openai.com/auth";

/** Accept only ordinary record-like values when decoding the account claim. */
function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

/** Decode the account ID carried by a Codex OAuth access token without retaining the token. */
export function extractChatgptAccountId(accessToken) {
	if (typeof accessToken !== "string") {
		return undefined;
	}

	const encodedPayload = accessToken.split(".")[1];
	if (!encodedPayload) {
		return undefined;
	}

	try {
		const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
		const auth = asRecord(payload)?.[CHATGPT_AUTH_CLAIM];
		const accountId = asRecord(auth)?.chatgpt_account_id;
		return typeof accountId === "string" && accountId.trim() ? accountId : undefined;
	} catch {
		return undefined;
	}
}

/** Order available, unexpired grants consistently for selection and counting. */
function eligibleResetCredits(payload, now = Date.now()) {
	if (!Array.isArray(payload?.credits)) throw new Error("Invalid reset credit list");
	const eligible = payload.credits.filter((credit) => {
		if (!credit || credit.status !== "available" || typeof credit.id !== "string" || !credit.id.trim()) return false;
		if (credit.expires_at === null) return true;
		if (typeof credit.expires_at !== "string") return false;
		const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i.exec(credit.expires_at);
		if (!parts) return false;
		const [, year, month, day, hour, minute, second] = parts.map(Number);
		const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
		if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > maxDay || hour > 23 || minute > 59 || second > 59) return false;
		const expiry = Date.parse(credit.expires_at);
		return Number.isFinite(expiry) && expiry > now;
	});
	eligible.sort((a, b) => {
		const left = a.expires_at === null ? Infinity : Date.parse(a.expires_at);
		const right = b.expires_at === null ? Infinity : Date.parse(b.expires_at);
		return left === right ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : left < right ? -1 : 1;
	});
	return eligible;
}

/** Choose the earliest eligible grant, with explicit no-expiry grants last. */
export function selectResetCredit(payload, now = Date.now()) {
	return eligibleResetCredits(payload, now)[0];
}

/** Coordinate one confirmed redemption at a time without retrying an uncertain POST. */
export function createResetCommand({ resolveCredentials, isCurrent, fetchImpl = globalThis.fetch, makeId }) {
	let busy = false;
	return async function resetCommand(_args, ctx) {
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			ctx.ui.notify("Codex reset requires an interactive terminal confirmation.", "warning");
			return;
		}
		if (busy) {
			ctx.ui.notify("A Codex reset is already in progress.", "warning");
			return;
		}
		busy = true;
		let posted = false;
		try {
			const initial = await resolveCredentials(ctx);
			if (!initial || !isCurrent(ctx, initial)) throw new Error("Codex account or model is unavailable");
			const headers = { Authorization: `Bearer ${initial.accessToken}`, "ChatGPT-Account-Id": initial.accountId };
			const response = await fetchImpl(RESET_ENDPOINT, { method: "GET", headers, redirect: "error" });
			if (!response.ok) throw new Error(`Reset credit list request failed (${response.status})`);
			const eligible = eligibleResetCredits(await response.json());
			const credit = eligible[0];
			if (!isCurrent(ctx, initial)) throw new Error("Codex account or model changed");
			if (!credit) {
				ctx.ui.notify("No eligible Codex reset credits are available.", "info");
				return;
			}
			// Display only bounded, printable server fields before asking to spend the selected credit.
			const safe = (value) => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 200);
			const expiry = credit.expires_at === null ? "never" : credit.expires_at;
			const confirmed = await ctx.ui.confirm("Use a Codex reset credit?", `Credit: ${safe(credit.id)}\nType: ${safe(credit.reset_type ?? "unknown")}\nExpires: ${safe(expiry)}\n${eligible.length - 1} reset credits would remain.`);
			if (confirmed !== true) {
				ctx.ui.notify("Codex reset cancelled.", "info");
				return;
			}
			const current = await resolveCredentials(ctx);
			if (!current || !isCurrent(ctx, initial) || current.accountId !== initial.accountId || !isCurrent(ctx, current)) {
				throw new Error("Codex account or model changed; reset cancelled");
			}
			if (credit.expires_at !== null && Date.parse(credit.expires_at) <= Date.now()) throw new Error("Selected credit expired; reset cancelled");
			posted = true;
			const result = await fetchImpl(`${RESET_ENDPOINT}/consume`, {
				method: "POST",
				headers: { Authorization: `Bearer ${current.accessToken}`, "ChatGPT-Account-Id": current.accountId, "Content-Type": "application/json" },
				body: JSON.stringify({ redeem_request_id: makeId(), credit_id: credit.id }),
				redirect: "error",
			});
			if (!result.ok) throw new Error(`Reset request failed (${result.status}); outcome may be unknown`);
			const body = await result.json();
			if (!["reset", "nothing_to_reset", "no_credit", "already_redeemed"].includes(body?.code)) throw new Error("Reset response was invalid; outcome may be unknown");
			const messages = {
				reset: `Codex reset completed (${Number.isSafeInteger(body.windows_reset) && body.windows_reset >= 0 ? body.windows_reset : "?"} windows reset).`,
				nothing_to_reset: "No Codex usage windows needed resetting.",
				no_credit: "The selected reset credit was not available.",
				already_redeemed: "This reset request was already redeemed; check usage.",
			};
			ctx.ui.notify(messages[body.code], body.code === "reset" ? "info" : "warning");
		} catch (error) {
			// Avoid exposing response bodies, credentials, or network error details.
			const message = error instanceof Error && /^(Codex account|Selected credit|Reset (credit list request failed|request failed|response was invalid))/.test(error.message)
				? error.message : posted ? "Codex reset outcome is unknown; check usage before trying again." : "Could not retrieve Codex reset credits.";
			ctx.ui.notify(message, "warning");
		} finally {
			busy = false;
		}
	};
}
