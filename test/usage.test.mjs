/**
 * Exercises usage parsing, native-footer replacement, and non-sensitive API failure behavior with no network access.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
	USAGE_ENDPOINT,
	extractChatgptAccountId,
	fetchUsage,
	formatUsageSummary,
	parseUsageResponse,
} from "../src/usage.js";
import { delimitNativeStats, renderNativeFooterWithQuota, replaceNativeCostInLines } from "../src/footer.js";

/** Build a valid endpoint payload with intentionally non-integer usage for formatting coverage. */
function samplePayload() {
	return {
		rate_limit: {
			primary_window: {
				used_percent: 12.5,
				reset_at: 1_700_000_000,
				limit_window_seconds: 18_000,
			},
			secondary_window: {
				used_percent: 67,
				reset_at: "2024-01-01T12:30:00.000Z",
				limit_window_seconds: 604_800,
			},
		},
	};
}

/** Measure the plain-text fixtures used by native-footer replacement tests. */
function plainVisibleWidth(value) {
	return value.length;
}

/** Truncate the plain-text fixtures used by native-footer replacement tests. */
function plainTruncateToWidth(value, width) {
	return value.slice(0, width);
}

/** Verify that used percentages become remaining percentages and retain their reset metadata. */
test("parseUsageResponse parses both rate-limit windows", () => {
	const usage = parseUsageResponse(samplePayload());

	assert.deepEqual(usage, {
		primary: {
			remainingPercent: 87.5,
			resetAt: 1_700_000_000,
			limitWindowSeconds: 18_000,
		},
		secondary: {
			remainingPercent: 33,
			resetAt: "2024-01-01T12:30:00.000Z",
			limitWindowSeconds: 604_800,
		},
	});
});

/** Verify that footer text omits labels, uses a primary time and secondary date-time, and never shows a dollar cost. */
test("formatUsageSummary renders compact primary and secondary availability", () => {
	const text = formatUsageSummary(
		parseUsageResponse(samplePayload()),
		(resetAt) => `time:${resetAt}`,
		(resetAt) => `date-time:${resetAt}`,
	);

	assert.equal(
		text,
		"87.5% (time:1700000000) / 33% (date-time:2024-01-01T12:30:00.000Z)",
	);
	assert.equal(text.includes("$"), false);
	assert.equal(text.includes("Primary"), false);
	assert.equal(text.includes("Secondary"), false);
});

/** Verify that a native stats cost is replaced without touching Pi's cwd or dispatcher-status lines. */
test("replaceNativeCostInLines preserves native cwd and dispatcher context", () => {
	const nativeLines = [
		"/work/native-cwd",
		"↑1.2k · $0.123 · model",
		"dispatcher · extension status",
	];
	const quota = "87.5% (10:30 AM) / 33% (Jan 2, 10:30 AM)";
	const result = replaceNativeCostInLines(nativeLines, quota);

	assert.deepEqual(result, [
		"/work/native-cwd",
		`↑1.2k · ${quota} · model`,
		"dispatcher · extension status",
	]);
	assert.equal(result[0], nativeLines[0]);
	assert.equal(result[2], nativeLines[2]);
});

/** Verify that a wider quota rerenders only the native stats line at the compensating narrower width. */
test("renderNativeFooterWithQuota narrows only the stats render for a wider quota", () => {
	const widths = [];
	const quota = "87.5% (10:30)";
	const nativeWidth = 80;
	const cost = "$1.234";
	const expectedNarrowWidth = nativeWidth - (quota.length - cost.length);

	/** Return distinguishable native lines for each requested width. */
	const renderNative = (width) => {
		widths.push(width);
		return [
			`cwd rendered at ${width}`,
			`stats rendered at ${width} · ${cost} · model`,
			`dispatcher rendered at ${width}`,
		];
	};

	const result = renderNativeFooterWithQuota(renderNative, nativeWidth, quota, {
		visibleWidth: plainVisibleWidth,
		truncateToWidth: plainTruncateToWidth,
	});

	assert.deepEqual(widths, [nativeWidth, expectedNarrowWidth]);
	assert.deepEqual(result, [
		`cwd rendered at ${nativeWidth}`,
		`stats rendered at ${expectedNarrowWidth} · ${quota} · model`,
		`dispatcher rendered at ${nativeWidth}`,
	]);
});

/** Reclaim native alignment padding instead of clipping quota to the old six-character cost slot. */
test("padded native stats retain the full quota and right-aligned model", () => {
	const quota = "87% (03:09 PM) / 98% (Oct 20, 10:09 AM)";
	const renderNative = (width) => {
		const left = "↑58k $0.371 20.0%/272k (auto)";
		const right = "codex • high";
		return ["cwd", left + " ".repeat(Math.max(0, width - left.length - right.length)) + right, "dispatcher • working"];
	};
	const lines = renderNativeFooterWithQuota(renderNative, 120, quota, {
		visibleWidth: plainVisibleWidth,
		truncateToWidth: plainTruncateToWidth,
	});
	assert.ok(lines[1].includes(quota));
	assert.equal(lines[1].length, 120);
	assert.ok(lines[1].endsWith("codex • high"));
	assert.ok(lines[1].includes("20.0%/272k (auto)"));
	assert.equal(lines[2], "dispatcher • working");
});

/** Preserve native ANSI context styling and model delimiters while separating statistics. */
test("native statistics use bullets without touching model padding or ANSI styles", () => {
	const line = "↑529k ↓74k R3.2M CH99.7% $0.371 \x1b[31m26.9%/272k (auto)\x1b[0m  codex • high";
	const expected = "↑529k • ↓74k • R3.2M • CH99.7% • $0.371 • \x1b[31m26.9%/272k (auto)\x1b[0m  codex • high";
	assert.equal(delimitNativeStats(line), expected);
	assert.equal(delimitNativeStats(expected), expected);
});

/** Verify the real formatter omits labels and the primary reset date. */
test("real quota formatter uses time-only primary and dated secondary", () => {
	const text = formatUsageSummary(parseUsageResponse(samplePayload()));
	const [primary, secondary] = text.split(" / ");
	assert.match(primary, /^87\.5% \(/);
	assert.doesNotMatch(primary, /Primary|Secondary|Nov|2023/);
	assert.match(secondary, /^33% \(/);
	assert.doesNotMatch(text, /Primary|Secondary/);
});

/** Verify that malformed provider data fails before it reaches the footer. */
test("parseUsageResponse rejects an incomplete response", () => {
	assert.throws(
		() => parseUsageResponse({ rate_limit: { primary_window: { used_percent: 10, reset_at: 1 } } }),
		/secondary_window/,
	);
});

/** Verify that the request uses the official endpoint and the two required headers without logging either value. */
test("fetchUsage sends Codex OAuth credentials only as request headers", async () => {
	let request;
	const result = await fetchUsage({
		accessToken: "test-access-token",
		accountId: "test-account-id",
		fetchImpl: async (url, options) => {
			request = { url, options };
			return {
				ok: true,
				status: 200,
				json: async () => samplePayload(),
			};
		},
	});

	assert.equal(request.url, USAGE_ENDPOINT);
	assert.equal(request.options.method, "GET");
	assert.deepEqual(request.options.headers, {
		Authorization: "Bearer test-access-token",
		"ChatGPT-Account-Id": "test-account-id",
	});
	assert.equal(result.primary.remainingPercent, 87.5);
});

/** Verify that HTTP failures become a bounded status error rather than leaking an endpoint response body. */
test("fetchUsage reports a bounded HTTP failure", async () => {
	await assert.rejects(
		fetchUsage({
			accessToken: "test-access-token",
			accountId: "test-account-id",
			fetchImpl: async () => ({
				ok: false,
				status: 401,
				json: async () => ({ secret: "never-read" }),
			}),
		}),
		/Usage request failed \(401\)/,
	);
});

/** Verify that account extraction follows Pi's Codex JWT claim without retaining a credential file. */
test("extractChatgptAccountId reads the Codex account claim", () => {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "acct-test" },
		}),
	).toString("base64url");
	const token = `header.${payload}.signature`;

	assert.equal(extractChatgptAccountId(token), "acct-test");
	assert.equal(extractChatgptAccountId("not-a-jwt"), undefined);
});

