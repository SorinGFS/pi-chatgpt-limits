/**
 * Validates and formats the ChatGPT Codex usage response without persisting credentials.
 */

export const CODEX_PROVIDER_ID = "openai-codex";
export const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const CHATGPT_AUTH_CLAIM = "https://api.openai.com/auth";

/** Return an object value only when it is safe to inspect its named fields. */
function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

/** Return a finite number within the inclusive percentage range. */
function asPercent(value, field) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
		throw new Error(`Usage response has an invalid ${field}`);
	}
	return value;
}

/** Parse one provider window into the data required by the footer. */
function parseWindow(value, field) {
	const window = asRecord(value);
	if (!window) {
		throw new Error(`Usage response is missing ${field}`);
	}

	const resetAt = window.reset_at;
	if (typeof resetAt !== "string" && (typeof resetAt !== "number" || !Number.isFinite(resetAt))) {
		throw new Error(`Usage response has an invalid ${field}.reset_at`);
	}

	const limitWindowSeconds = window.limit_window_seconds;
	if (
		limitWindowSeconds !== undefined &&
		(typeof limitWindowSeconds !== "number" || !Number.isFinite(limitWindowSeconds) || limitWindowSeconds < 0)
	) {
		throw new Error(`Usage response has an invalid ${field}.limit_window_seconds`);
	}

	return {
		remainingPercent: 100 - asPercent(window.used_percent, `${field}.used_percent`),
		resetAt,
		limitWindowSeconds,
	};
}

/** Parse the two rate-limit windows returned by the ChatGPT usage endpoint. */
export function parseUsageResponse(value) {
	const response = asRecord(value);
	const rateLimit = asRecord(response?.rate_limit);
	if (!rateLimit) {
		throw new Error("Usage response is missing rate_limit");
	}

	return {
		primary: parseWindow(rateLimit.primary_window, "primary_window"),
		secondary: parseWindow(rateLimit.secondary_window, "secondary_window"),
	};
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

/** Convert a reset value expressed as an ISO timestamp, Unix seconds, or Unix milliseconds into a date. */
function parseResetAt(value) {
	if (typeof value === "number") {
		return new Date(Math.abs(value) < 1_000_000_000_000 ? value * 1_000 : value);
	}

	if (typeof value === "string" && value.trim()) {
		const numericValue = Number(value);
		if (Number.isFinite(numericValue)) {
			return parseResetAt(numericValue);
		}
		return new Date(value);
	}

	return undefined;
}

/** Format a reset time for the user's local clock, leaving malformed values visibly unknown. */
export function formatResetAt(value) {
	const date = parseResetAt(value);
	if (!date || Number.isNaN(date.getTime())) {
		return "?";
	}

	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(date);
}

/** Format a primary-window reset as local time without repeating its date. */
export function formatResetTime(value) {
	const date = parseResetAt(value);
	if (!date || Number.isNaN(date.getTime())) {
		return "?";
	}

	return new Intl.DateTimeFormat(undefined, {
		hour: "2-digit",
		minute: "2-digit",
	}).format(date);
}

/** Render a percentage without unnecessary decimal zeroes. */
export function formatPercent(value) {
	const rounded = Math.round(value * 10) / 10;
	return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

/** Render compact primary and secondary remaining allowances in the footer's cost slot. */
export function formatUsageSummary(
	usage,
	formatPrimaryReset = formatResetTime,
	formatSecondaryReset = formatResetAt,
) {
	return [
		`${formatPercent(usage.primary.remainingPercent)} (${formatPrimaryReset(usage.primary.resetAt)})`,
		`${formatPercent(usage.secondary.remainingPercent)} (${formatSecondaryReset(usage.secondary.resetAt)})`,
	].join(" / ");
}

/** Fetch and validate usage with the OAuth credentials Pi has already resolved for the Codex provider. */
export async function fetchUsage({ fetchImpl = globalThis.fetch, accessToken, accountId, signal }) {
	if (typeof fetchImpl !== "function") {
		throw new Error("Fetch is unavailable");
	}
	if (typeof accessToken !== "string" || !accessToken) {
		throw new Error("Codex OAuth access token is unavailable");
	}
	if (typeof accountId !== "string" || !accountId) {
		throw new Error("ChatGPT account ID is unavailable");
	}

	const response = await fetchImpl(USAGE_ENDPOINT, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"ChatGPT-Account-Id": accountId,
		},
		signal,
	});

	if (!response.ok) {
		throw new Error(`Usage request failed (${response.status})`);
	}

	try {
		return parseUsageResponse(await response.json());
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Usage response")) {
			throw error;
		}
		throw new Error("Usage response was not valid JSON");
	}
}

