/**
 * Decorates Pi's native footer cost field with non-persistent ChatGPT Codex rate-limit availability.
 */

import { FooterComponent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	CODEX_PROVIDER_ID,
	extractChatgptAccountId,
	fetchUsage,
	formatUsageSummary,
} from "../src/usage.js";
import { renderNativeFooterWithQuota } from "../src/footer.js";

const REFRESH_INTERVAL_MS = 60_000;
const STATUS_KEY = "pi-chatgpt-status";
const LOADING_TEXT = "Usage: loading…";
const UNAVAILABLE_TEXT = "Usage: unavailable";

/** Select the active Codex model or another registered Codex model used only for credential resolution. */
function findCodexModel(ctx) {
	if (ctx.model?.provider === CODEX_PROVIDER_ID) {
		return ctx.model;
	}

	return ctx.modelRegistry.getAll().find((model) => model.provider === CODEX_PROVIDER_ID);
}

/**
 * Register lifecycle handlers that replace only Pi's native footer cost token.
 * @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi
 */
export default function chatgptStatus(pi) {
	let activeContext;
	let footerText = LOADING_TEXT;
	let refreshTimer;
	let refreshAbort;
	let refreshGeneration = 0;
	let originalFooterRender;
	let footerRenderWrapper;

	/** Ask Pi's native UI to render again without leaving an extension status entry behind. */
	function requestNativeFooterRender() {
		activeContext?.ui.setStatus(STATUS_KEY, undefined);
	}

	/** Update the in-memory quota label and redraw the already-native footer. */
	function setFooterText(nextText) {
		footerText = nextText;
		requestNativeFooterRender();
	}

	/** Stop the current polling lifecycle before a session replacement or extension teardown. */
	function stopRefreshing() {
		refreshGeneration += 1;
		if (refreshTimer !== undefined) {
			clearInterval(refreshTimer);
			refreshTimer = undefined;
		}
		refreshAbort?.abort();
		refreshAbort = undefined;
	}

	/** Resolve the OAuth token through Pi, derive its account ID locally, and update the footer safely. */
	async function refreshUsage(ctx) {
		const generation = ++refreshGeneration;
		refreshAbort?.abort();
		const controller = new AbortController();
		refreshAbort = controller;

		try {
			const model = findCodexModel(ctx);
			if (!model) {
				setFooterText(UNAVAILABLE_TEXT);
				return;
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (generation !== refreshGeneration || controller.signal.aborted) {
				return;
			}
			if (!auth.ok || !auth.apiKey) {
				setFooterText(UNAVAILABLE_TEXT);
				return;
			}

			const accountId = extractChatgptAccountId(auth.apiKey);
			if (!accountId) {
				setFooterText(UNAVAILABLE_TEXT);
				return;
			}

			const usage = await fetchUsage({
				accessToken: auth.apiKey,
				accountId,
				signal: controller.signal,
			});

			if (generation === refreshGeneration && !controller.signal.aborted) {
				setFooterText(formatUsageSummary(usage));
			}
		} catch {
			if (generation === refreshGeneration && !controller.signal.aborted) {
				setFooterText(UNAVAILABLE_TEXT);
			}
		} finally {
			if (refreshAbort === controller) {
				refreshAbort = undefined;
			}
		}
	}

	/** Start one immediate refresh and then keep the displayed quota current at a modest cadence. */
	function startRefreshing(ctx) {
		stopRefreshing();
		activeContext = ctx;
		setFooterText(LOADING_TEXT);
		void refreshUsage(ctx);

		// Abort-and-replace prevents overlapping slow requests from applying stale results.
		refreshTimer = setInterval(() => {
			void refreshUsage(ctx);
		}, REFRESH_INTERVAL_MS);
	}

	/** Decorate the native footer once, retaining every native line and all native session state. */
	function installNativeFooter() {
		if (footerRenderWrapper) {
			return;
		}

		const nativeRender = FooterComponent.prototype.render;
		originalFooterRender = nativeRender;
		footerRenderWrapper = function renderNativeFooterWithUsage(width) {
			return renderNativeFooterWithQuota(
				(nativeWidth) => nativeRender.call(this, nativeWidth),
				width,
				footerText,
				{ visibleWidth, truncateToWidth },
			);
		};
		FooterComponent.prototype.render = footerRenderWrapper;
	}

	/** Restore the original renderer only when no later decorator has replaced this extension's wrapper. */
	function restoreNativeFooter() {
		if (footerRenderWrapper && FooterComponent.prototype.render === footerRenderWrapper) {
			FooterComponent.prototype.render = originalFooterRender;
		}
		originalFooterRender = undefined;
		footerRenderWrapper = undefined;
	}

	/** Install the native-footer decorator and begin polling only for Pi's terminal UI. */
	function handleSessionStart(_event, ctx) {
		if (ctx.mode !== "tui") {
			return;
		}

		installNativeFooter();
		startRefreshing(ctx);
	}

	/** Refresh credentials and usage after a model change while retaining the native-footer decorator. */
	function handleModelSelect(_event, ctx) {
		if (ctx.mode === "tui") {
			startRefreshing(ctx);
		}
	}

	/** Dispose polling and restore the native footer when Pi ends the active terminal session. */
	function handleSessionShutdown() {
		stopRefreshing();
		restoreNativeFooter();
		activeContext = undefined;
	}

	pi.on("session_start", handleSessionStart);
	pi.on("model_select", handleModelSelect);
	pi.on("session_shutdown", handleSessionShutdown);
}
