/** Registers the reset command independently of the footer and its polling lifecycle. */

import { randomUUID } from "node:crypto";
import { CODEX_PROVIDER_ID, createResetCommand, extractChatgptAccountId } from "../src/reset.js";

/** Register a command whose confirmation is invalidated by session or model changes. */
export default function codexReset(pi) {
	let generation = 0;

	/** Invalidate any pending confirmation on a lifecycle transition. */
	function invalidate() {
		generation += 1;
	}

	const handler = createResetCommand({
		/** Resolve credentials from the invoking context, not the status extension. */
		async resolveCredentials(ctx) {
			const capturedGeneration = generation;
			const selectedModel = ctx.model;
			const sessionId = ctx.sessionManager.getSessionId();
			const model = selectedModel?.provider === CODEX_PROVIDER_ID
				? selectedModel
				: ctx.modelRegistry.getAll().find((item) => item.provider === CODEX_PROVIDER_ID);
			if (!model) return undefined;
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			const accountId = auth.ok && extractChatgptAccountId(auth.apiKey);
			if (!accountId) return undefined;
			return { accessToken: auth.apiKey, accountId, generation: capturedGeneration, selectedModel, sessionId };
		},
		/** Reject stale command contexts even if a model or session later changes back. */
		isCurrent(ctx, credentials) {
			return generation === credentials.generation &&
				ctx.sessionManager.getSessionId() === credentials.sessionId &&
				ctx.model?.provider === credentials.selectedModel?.provider &&
				ctx.model?.id === credentials.selectedModel?.id;
		},
		makeId: randomUUID,
	});
	pi.registerCommand("codex-reset", {
		description: "Confirm and use an available Codex reset credit",
		handler,
	});
	pi.on("session_start", invalidate);
	pi.on("model_select", invalidate);
	pi.on("session_shutdown", invalidate);
}
