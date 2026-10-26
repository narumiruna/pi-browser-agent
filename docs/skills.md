# Browser skills

Skills are reviewed, text-only task guidance. Import a single local or public GitHub `SKILL.md` in **Settings → Skills**, enable it, and ask for it by name in chat. No local agent or general filesystem access is required. GitHub import requires optional access to `https://api.github.com/*`; local import needs no host access. This is partial Agent Skills support, not full skill or plugin execution.

## Import and use

1. Open **Settings → Skills**. The installed native list precedes import/review and shows each name, description, and **Enabled**/**Disabled** state. Select a row for its installed plain-text preview and enable/delete controls.
2. Select one UTF-8 file named exactly `SKILL.md` with the Skills file picker, or use [GitHub import](#github-import). Only the selected file is read. A valid review shows the complete original source, parsed fields, optional metadata, and compatibility warnings as plain text. Selection and preview do not install the skill.
3. Select **Import reviewed skill**. The new record starts disabled. Select it from the installed list and enable it only if its content is safe to share.
4. Submit a chat request. Enabled metadata becomes available to the model; the model can call `skills_load({id})` to read a relevant skill body. There is no separate skill slash command. Skills also work without a readable page, but do not enable page tools.

Skill actions save independently of **Save general settings**; selection and review remain unsaved until import or replacement. The persistent footer identifies an unimported review separately from general changes and MCP edits. General Save and exit actions protect that review; Cancel does not undo saved skill actions. Pending skill operations block general Save, Back, and Cancel; use **Cancel fetch** to stop GitHub work. Selection, preview, import, replacement, and enablement make no model request. Only the explicit GitHub fetch action requests host access. A run snapshots enabled records at its start. Changes made during that run apply to the next run; they do not replace its active content.

To replace a skill, explicitly select the installed target, select and review the new source, then select **Replace selected skill**. This action appears only with a valid review and selected installed target. Replacement is explicit, preserves the installed ID, and starts disabled. A duplicate name cannot be imported as another record. To delete, select the record, select **Delete selected skill**, and confirm the named record. Cancel leaves it unchanged. Deleting an installed skill keeps any unimported review, preview, and draft warning; the reviewed text can still be imported.

## GitHub import

1. Enter `owner/repo` or the equivalent HTTPS repository-root URL, such as `https://github.com/owner/repo`.
   - Credentials, query strings, fragments, custom ports, SSH syntax, other hosts, and branch, tag, or subdirectory URLs are not supported.
2. Select **Find GitHub skills** to request `https://api.github.com/*` access. Chrome permission and recorded exact-origin approval are both required before each request. A screenshot `<all_urls>` grant alone is not sufficient.
3. Select one candidate by its full path. Discovery accepts a root `SKILL.md` or `skills/**/SKILL.md`, including category and dot-directories such as `.curated` and `.system`.
   - Only regular-file blobs are accepted, not symlinks or submodules. A second skill nested inside a discovered skill directory is excluded.
   - Other containers, including `.agents/skills/` and `plugins/<name>/skills/`, are not searched. Plugin components are never installed.
4. Select **Review selected GitHub skill** to fetch that file. Review the repository, full path, commit SHA, user-opened source link, complete original `SKILL.md`, parsed fields, and warnings. Review any declared `license`; do not assume that all files in a repository share a license.
5. Import or explicitly replace a selected record. The reviewed snapshot is saved without refetching and starts disabled.

GitHub reads run only in Settings. `GET /repos/{owner}/{repo}/commits?per_page=1` resolves the default-branch commit and tree SHA without assuming a branch name. `GET /repos/{owner}/{repo}/git/trees/{tree_sha}?recursive=1` lists the immutable tree. Only after selection does `GET /repos/{owner}/{repo}/git/blobs/{blob_sha}` read the selected Base64 blob. Decoding validates bytes and UTF-8. Listing uses two requests; each uncached selection uses one more.

Requests use only `api.github.com`, omit cookies and credentials, and reject redirects. They do not follow response-supplied URLs or read linked resources. Renamed-repository redirects fail; enter the canonical repository instead. No raw-content host, archive download, clone, plugin fetch, or command execution is used. Private repositories, tokens, and GitHub OAuth are not supported. GitHub receives the repository identifiers during explicit fetch and the selected blob identifier during selected-file review. Opening the source link is a separate user action.

| Network item           | Fixed limit                                              |
| ---------------------- | -------------------------------------------------------- |
| Commit response        | 131,072 received bytes; one valid result required        |
| Recursive tree         | 2,097,152 received bytes and 10,000 entries              |
| Candidate paths        | 200                                                      |
| Selected blob response | 131,072 received JSON bytes; 65,536 decoded source bytes |
| Operation duration     | 30 seconds after host approval                           |

Actual streamed bytes are measured. Oversized responses, excessive candidates, and a tree marked `truncated: true` fail rather than present an incomplete list. GitHub's unauthenticated REST limit is 60 requests per hour per originating IP. Rate-limit failures stop; there is no automatic retry or token request. Reset details are shown when available.

Fetch cancellation, source changes, Settings disposal, and permission revocation abort pending work. Stale responses cannot replace a newer review. Discovery, preview, errors, and cancellation do not write or enable skill records. Keep using the local picker if GitHub is unavailable. Revoking GitHub access does not delete imported text.

The `openai/skills` README at [commit `49f948f`](https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/README.md) marks that repository deprecated and points to `openai/plugins`. The extension does not change the entered source automatically. Nested plugin skill layouts are outside the discovery scope, and a parsed skill can still require unavailable local tools.

## Supported format

```markdown
---

name: review-checklist
description: "Review a change against a short checklist."
---

Check the requested scope, tests, and permission boundaries.
Report failures before optional improvements.
```

The filename is case-sensitive: `SKILL.md`. Local and GitHub imports use the same bundled, browser-compatible YAML parser with bounded syntax validation:
- Decode UTF-8 with fatal error handling. Invalid byte sequences are rejected, not replaced. An initial UTF-8 byte-order mark is optional.
- Start with a line containing exactly `---`. Close the frontmatter with another exact `---` line. Use LF or CRLF line endings; do not indent the delimiters.
- Include a string `name` and a string `description`. Their order can differ. Plain and quoted scalar forms remain supported.
- Optional fields are `license` (string), `compatibility` (string of at most 500 UTF-16 code units), `metadata` (string-to-string map), and experimental `allowed-tools` (string).
  - These fields are visible during review only. `allowed-tools` does not enable tools, and `compatibility` does not establish browser compatibility.
- Reject unknown top-level fields, duplicate keys, tags, anchors, aliases, and multiple YAML documents. YAML is limited to 8 container levels and 256 nodes.
- The name must match `[a-z0-9]+(?:-[a-z0-9]+)*`: lowercase letters or digits separated by single hyphens. No leading, trailing, or repeated hyphen is allowed.
- The description must be non-empty, one line, free of control characters, and without surrounding whitespace. Folded descriptions are accepted only if their normalized result meets this rule and the 512 UTF-16-unit limit.
- The Markdown body must contain non-whitespace text. Its text and line endings are preserved. Tabs, CR, and LF are allowed in the body; other control characters are rejected. Invalid Unicode is rejected in stored content as well.

Only name, description, and body are saved. Scripts, `references/`, assets, linked files, local tools, and client-specific execution capabilities remain unavailable. ZIP packages, marketplaces, shell commands, executable plugins, and local directory discovery are not supported. Adapt dependent skills to standalone text. Compatibility warnings use heuristics and cannot detect every unsupported dependency; review the complete source even when there is no specific warning. Parser acceptance is not proof that a skill can run in this browser.

## Fixed limits

| Item                   | Limit and measurement                                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selected input         | 65,536 UTF-8 bytes, including frontmatter and an optional byte-order mark                                                                                         |
| Name                   | 64 UTF-16 code units; the permitted ASCII syntax makes these ordinary characters                                                                                  |
| Description            | 512 UTF-16 code units after scalar decoding                                                                                                                       |
| Installed skills       | 20 records, including disabled records                                                                                                                            |
| Skill store            | 524,288 UTF-8 bytes of the serialized JSON `{version:1,records:[...]}` envelope                                                                                   |
| Enabled catalog        | 16,384 UTF-8 bytes of the serialized JSON metadata array; fixed surrounding instructions are excluded                                                             |
| Loaded content per run | 131,072 UTF-8 bytes in total of successful serialized JSON tool-result text, including its guidance wrapper, ID, name, and body; every repeated load counts again |

Stored metadata and body together also must fit the 65,536-byte content ceiling when read. JSON escaping and envelope overhead can make stored or loaded data larger than the source body. Limits apply before saving or returning content. A failed load returns no new body; previously loaded content remains in the conversation.

## Model disclosure and authorization

The initial enabled catalog is a JSON array containing only `id`, `name`, and `description`. It does not contain bodies. `skills_load` accepts exactly `{id: string}` and can load only an enabled record from the current run's snapshot. Disabled, deleted, or unknown IDs do not authorize loads in later runs. With no enabled skills, later runs omit both the catalog and loader.

Metadata and loaded bodies are untrusted, user-authorized task guidance, not higher-priority instructions. They can influence model behavior, but cannot change system rules, grant permissions, enable unavailable tools, or bypass browser confirmations. Do not import credentials or other content that is unsafe to share with the selected provider. The model is not required to request every enabled body.

Loaded bodies enter ordinary message history and saved sessions. Later submissions can send that history again. Disabling, replacing, or deleting a skill does not remove its earlier metadata or body from transcripts. Delete affected sessions separately to remove local history; provider-held data follows the provider's retention policy. **Clear all session data** does not delete installed skills.

## Storage and recovery

Skills use the trusted `chrome.storage.local` key `piBrowserAgentSkillsV1`, separate from settings and credentials. Its envelope remains `{version:1,records:[...]}`; each record has only `{id,name,description,body,enabled}`. IDs are stable UUIDs. Cross-context updates are serialized, and each successful mutation publishes the complete envelope in one write.

Repository identity, path, commit SHA, source link, original source, and optional frontmatter fields remain in memory for the current review. They are not persisted as provenance or sent as catalog fields. Installed records are local text snapshots with no update checks or background synchronization. A later GitHub import requires a new explicit review. Runtime loading reads the saved snapshot and makes no GitHub request.
- **Invalid file or unsupported metadata:** correct the source and select it again. Nothing is installed until the reviewed import succeeds.
- **Duplicate name:** use explicit replacement of the intended installed record, or choose a distinct valid name.
- **Count or storage limit:** delete unused skills or shorten their bodies, then retry. Disabled records still consume storage.
- **Catalog limit:** disable unused skills or shorten descriptions before enabling more.
- **Load budget exhausted:** continue in a new run only if needed. Repeated loads consume the same run budget; they do not reset it.
- **Failed import, replacement, or storage write:** the previous valid record remains unchanged. Review the error and retry after the underlying problem is corrected.
- **Invalid saved store:** operations fail without overwriting records. Preserve a private copy before recovery; it can contain sensitive text. Do not attach it to public diagnostics.

Disable all skills to remove discovery and loading from subsequent runs. To remove local skill data, delete each installed skill in Settings. If corrupt data prevents that, open DevTools for the extension Settings page, use **Application → Storage → Extension storage**, and remove only `piBrowserAgentSkillsV1`. If that view is unavailable, execute `await chrome.storage.local.remove("piBrowserAgentSkillsV1")` in that trusted extension page's DevTools console. Close active runs and reopen Settings afterward. Do not clear all extension storage: that also removes credentials and unrelated settings. This recovery does not delete sessions or retract content already sent to a provider.

Older builds ignore the separate skill key. Remove it before downgrading if imported text must not remain in the profile. See [permissions and storage](permissions-and-storage.md), [security](security.md), and [privacy](../PRIVACY.md).
