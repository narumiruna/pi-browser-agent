# Optional local-file and PDF reading

## Goal

Determine whether explicitly selected local documents can be read safely without treating `file://` pages or Chrome's PDF viewer as ordinary web pages.

## Context

Chat without a supported page deliberately leaves file and PDF page tools disabled. Chrome's separate **Allow access to file URLs** setting does not imply that its PDF viewer can be injected, and the current manifest, host-permission audit, worker, and privacy policy allow page tools only on approved HTTP(S) sites.

## Plan

- [ ] Measure Chrome file-URL grant and PDF viewer behavior in a disposable stable-Chrome profile; record successful and denied APIs, extension settings, and browser versions in `docs/manual-acceptance.md`.
- [ ] Choose a narrow, explicit user-selection flow (for example a local file picker), supported text/PDF formats, byte/text limits, path-redaction rules, and revocation behavior; document the threat model in `docs/security.md` before implementation.
- [ ] Implement read-only bounded import, separate from page injection, if the selected design passes Chrome and privacy review; test malformed/oversized files, revoked access, path leakage, cancellation, provider sharing, and persistence. Otherwise document a deliberate unsupported outcome.

## Completion Checklist

- [ ] `npm run check`, `npm test`, `npm run build`, `npm run test:e2e`, and `npm run audit:artifact` pass for any implementation.
- [ ] `README.md`, `PRIVACY.md`, `docs/security.md`, and stable-Chrome manual results state exactly what content is readable and which permission or explicit selection authorizes it.
