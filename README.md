# pi-chatgpt-limits

A package that contains two Pi extensions:

- `chatgpt-limits` that decorates Pi's native footer and replaces only its dollar-cost
fragment with:

```text
<primary remaining%> (<local time>) / <secondary remaining%> (<local date and time>)
```

- `codex-reset` that triggers the oldest `reset limit` available (if any) via `/codex-reset`

## Requirements

- Pi 1.2.0 or later with an **OpenAI** or **OpenAI Codex** ChatGPT OAuth login.
- Network access to `https://chatgpt.com/backend-api/wham/usage` and, for resets,
  `https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`.

The extension obtains a refreshed OAuth access token through Pi's public
`ctx.modelRegistry.getApiKeyAndHeaders()` API. It derives the account ID in memory
from the token's Codex claim, sends it only in the request headers, and never logs,
stores, or reads `auth.json`.

## Install

From this directory:

```powershell
pi install npm:pi-chatgpt-limits
```

The package manifest declares both entry points separately, so a load failure in one
does not prevent loading the other.

## Optional project-local package registration

Pi documents `pi install --local <path-to-this-project>` as writing a package
declaration to the current project's `.pi/settings.json`, rather than the user-level
agent settings. A local package is loaded from its resolved source path without copying.
That configuration requires project trust.

This repository intentionally does **not** run that command: registering a project
resource is a separate configuration change. If you want persistent registration, run
the command from the project that should own the Pi configuration after reviewing its
scope and trust prompt. No user-wide Pi configuration is modified by this project.

## Behavior

- Decorates `FooterComponent.prototype.render` for a TUI session and restores it on
  session shutdown without replacing Pi's footer component.
- Refreshes on session start, model changes, and every 60 seconds.
- Uses `GET /backend-api/wham/usage` with `Authorization: Bearer …` and
  `ChatGPT-Account-Id`.
- Converts `used_percent` to remaining percentage, showing the primary reset as local
  time and the secondary reset as local date and time.
- `/codex-reset` fetches fresh credits and asks for terminal confirmation before consuming
  the available, unexpired credit with the earliest expiry (non-expiring credits last;
  equal expiries are ordered by ID). The prompt identifies the credit, type, and expiry.
  Other Pi modes cannot consume credits. A changed account or model cancels the request.
- Sends the chosen credit ID and a unique request ID once; no automatic redemption retry
  occurs. An uncertain outcome must be checked in refreshed usage before trying again.
  The `chatgpt-limits` extension polls independently every 60 seconds; allow up to one polling
  interval for a successful reset to appear in the footer.
- Shows `Usage: unavailable` for missing Codex auth, malformed responses, or request
  failures; it does not display error bodies or credentials.

## Tests

```powershell
npm test
```

The tests use mocked fetches only; they do not contact ChatGPT.
