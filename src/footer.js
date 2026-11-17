/**
 * Replaces only Pi's native footer cost token while retaining every other native footer line.
 */

const COST_TOKEN_PATTERN = /\$\d+\.\d{3}(?: \(sub\))?/;

/** Find Pi 1.2.0's dollar-cost token only within the native stats line. */
function findNativeCostToken(line) {
	if (typeof line !== "string") {
		return undefined;
	}

	const match = line.match(COST_TOKEN_PATTERN);
	if (!match || match.index === undefined) {
		return undefined;
	}

	return {
		start: match.index,
		end: match.index + match[0].length,
		text: match[0],
	};
}

/** Separate native statistics without touching quota text, model padding, or other footer lines. */
export function delimitNativeStats(line) {
	const context = /(?:\d+(?:\.\d+)?%|\?)\/\d+(?:\.\d+)?[kM]?(?: \(auto\))?/.exec(line);
	if (!context) return line;
	const end = context.index + context[0].length;
	const stats = line.slice(0, end);
	const separated = stats.replace(
		/(?<![•·]) (\x1b\[[0-9;]*m)*(?=(?:[↑↓RW]\d+(?:\.\d+)?[kM]?|CH\d+(?:\.\d+)?%|\$\d+\.\d{3}|(?:\d+(?:\.\d+)?%|\?)\/\d))/g,
		(match) => ` • ${match.slice(1)}`,
	);
	return separated + line.slice(end);
}

/** Replace the native cost on line one without changing Pi's cwd or extension-status lines. */
export function replaceNativeCostInLines(lines, quota) {
	const nativeCost = findNativeCostToken(lines[1]);
	if (!nativeCost) {
		return lines;
	}

	return lines.map((line, index) =>
		index === 1
			? `${line.slice(0, nativeCost.start)}${quota}${line.slice(nativeCost.end)}`
			: line,
	);
}

/** Render native lines at a narrower stats width when a quota label is wider than the dollar cost. */
export function renderNativeFooterWithQuota(renderNative, width, quota, { visibleWidth, truncateToWidth }) {
	const rawLines = renderNative(width);
	const nativeLines = rawLines.map((line, index) => index === 1 ? delimitNativeStats(line) : line);
	const nativeCost = findNativeCostToken(nativeLines[1]);
	if (!nativeCost) {
		return nativeLines;
	}

	// Native right-alignment padding is reclaimable, not fixed content; reserve the full quota first.
	const fittedQuota = truncateToWidth(quota, Math.max(0, width));
	const delimiterWidth = visibleWidth(nativeLines[1]) - visibleWidth(rawLines[1]);
	const extraWidth = Math.max(0, visibleWidth(fittedQuota) - visibleWidth(nativeCost.text) + delimiterWidth);
	const statsLines = extraWidth === 0 ? nativeLines : renderNative(Math.max(0, width - extraWidth))
		.map((line, index) => index === 1 ? delimitNativeStats(line) : line);
	const replacedStatsLines = replaceNativeCostInLines(statsLines, fittedQuota);

	if (replacedStatsLines === statsLines) {
		const fallbackLines = replaceNativeCostInLines(nativeLines, fittedQuota);
		if (fallbackLines === nativeLines) {
			return nativeLines;
		}

		const fallbackStats = fallbackLines[1];
		return nativeLines.map((line, index) =>
			index === 1 && visibleWidth(fallbackStats) > width
				? truncateToWidth(fallbackStats, Math.max(0, width))
				: index === 1
					? fallbackStats
					: line,
		);
	}

	return nativeLines.map((line, index) => (index === 1 ? replacedStatsLines[1] : line));
}
