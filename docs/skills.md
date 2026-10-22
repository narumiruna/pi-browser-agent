# Browser skills

Skills are reviewed, text-only task guidance. Import a single `SKILL.md` in **Settings → Skills**, enable it, and ask for it by name in chat. No local agent, new browser permission, or general filesystem access is required.

## Import and use

1. Select one UTF-8 file named exactly `SKILL.md` with the Skills file picker. Only the selected file is read.
2. Review the name, description, complete body, and compatibility warnings in the plain-text preview. Selection and preview do not install the skill.
3. Select **Import reviewed skill**. The new record starts disabled. Select it from the installed list and enable it only if its content is safe to share.
4. Submit a chat request. Enabled metadata becomes available to the model; the model can call `skills_load({id})` to read a relevant skill body. There is no separate skill slash command. Skills also work without a readable page, but do not enable page tools.

Skill controls save immediately, independently of the general Settings form. File selection, preview, import, replacement, and enablement make no model request. A run snapshots enabled records at its start. Changes made during that run apply to the next run; they do not replace its active content.

To replace a skill, select the installed record, select and review the new file, then select **Replace selected skill**. Replacement is explicit, preserves the installed ID, and starts disabled. A duplicate name cannot be imported as another record. To delete, select the record, select **Delete selected skill**, and confirm the named record. Cancel leaves it unchanged.

## Supported format

```markdown
---
name: review-checklist
description: "Review a change against a short checklist."
---
Check the requested scope, tests, and permission boundaries.
Report failures before optional improvements.
```

The filename is case-sensitive: `SKILL.md`. The format is a fixed frontmatter subset, not a general YAML parser:

- Decode UTF-8 with fatal error handling. Invalid byte sequences are rejected, not replaced. An initial UTF-8 byte-order mark is optional.
- Start with a line containing exactly `---`. Close the frontmatter with another exact `---` line. Use LF or CRLF line endings; do not indent the delimiters.
- Include exactly one unindented `name: value` and one `description: value`. Their order can differ. Empty lines are allowed. Duplicate or unknown fields are rejected.
- Each value is one plain string, a JSON double-quoted string, or a YAML single-quoted string.
  - Plain values have no implicit Boolean or number conversion. They cannot start with `!`, `&`, `*`, `|`, `>`, `{`, `}`, `[`, `]`, `,`, `#`, `%`, `@`, a backtick, or a quote. A leading `-`, `?`, or `:` cannot be followed by whitespace or the end of the value. A colon followed by whitespace or the end of the value, and a `#` preceded by whitespace, require quoting. For example, use `description: "Check scope: tests and permissions."`.
  - Double quotes use JSON escapes, such as `\"` and `\\`. The decoded value must still meet the metadata rules.
  - Inside single quotes, use two single quotes for one literal quote: `description: 'Review the user''s checklist.'`. Backslashes remain literal.
  - Spaces outside a scalar are ignored. A decoded description must have no surrounding whitespace.
- Comments, tabs in frontmatter, nested values, multiline values, block scalars (`|` or `>`), tags, anchors, aliases, and flow collections are not supported.
- The name must match `[a-z0-9]+(?:-[a-z0-9]+)*`: lowercase letters or digits separated by single hyphens. No leading, trailing, or repeated hyphen is allowed.
- The description must be non-empty, one line, and free of control characters.
- The Markdown body must contain non-whitespace text. Its text and line endings are preserved. Tabs, CR, and LF are allowed in the body; other control characters are rejected. Invalid Unicode is rejected in stored content as well.

Only this text is imported. No script executes, supporting file opens, link fetches, or directory traversal occurs. ZIP packages, remote installation, marketplaces, shell commands, and executable plugins are not supported. A skill that requires `scripts/`, `references/`, assets, or local tools needs adaptation to standalone text. Compatibility warnings use heuristics and cannot detect every unsupported dependency; review the complete body even when there is no specific warning.

## Fixed limits

| Item | Limit and measurement |
| --- | --- |
| Selected input | 65,536 UTF-8 bytes, including frontmatter and an optional byte-order mark |
| Name | 64 UTF-16 code units; the permitted ASCII syntax makes these ordinary characters |
| Description | 512 UTF-16 code units after scalar decoding |
| Installed skills | 20 records, including disabled records |
| Skill store | 524,288 UTF-8 bytes of the serialized JSON `{version:1,records:[...]}` envelope |
| Enabled catalog | 16,384 UTF-8 bytes of the serialized JSON metadata array; fixed surrounding instructions are excluded |
| Loaded content per run | 131,072 UTF-8 bytes in total of successful serialized JSON tool-result text, including its guidance wrapper, ID, name, and body; every repeated load counts again |

Stored metadata and body together also must fit the 65,536-byte content ceiling when read. JSON escaping and envelope overhead can make stored or loaded data larger than the source body. Limits apply before saving or returning content. A failed load returns no new body; previously loaded content remains in the conversation.

## Model disclosure and authorization

The initial enabled catalog is a JSON array containing only `id`, `name`, and `description`. It does not contain bodies. `skills_load` accepts exactly `{id: string}` and can load only an enabled record from the current run's snapshot. Disabled, deleted, or unknown IDs do not authorize loads in later runs. With no enabled skills, later runs omit both the catalog and loader.

Metadata and loaded bodies are untrusted, user-authorized task guidance, not higher-priority instructions. They can influence model behavior, but cannot change system rules, grant permissions, enable unavailable tools, or bypass browser confirmations. Do not import credentials or other content that is unsafe to share with the selected provider. The model is not required to request every enabled body.

Loaded bodies enter ordinary message history and saved sessions. Later submissions can send that history again. Disabling, replacing, or deleting a skill does not remove its earlier metadata or body from transcripts. Delete affected sessions separately to remove local history; provider-held data follows the provider's retention policy. **Clear all session data** does not delete installed skills.

## Storage and recovery

Skills use the trusted `chrome.storage.local` key `piBrowserAgentSkillsV1`, separate from settings and credentials. Its envelope is `{version:1,records:[...]}`; each record has only `{id,name,description,body,enabled}`. IDs are stable UUIDs. Cross-context updates are serialized, and each successful mutation publishes the complete envelope in one write.

- **Invalid file or unsupported metadata:** correct the file and select it again. Nothing is installed until the reviewed import succeeds.
- **Duplicate name:** use explicit replacement of the intended installed record, or choose a distinct valid name.
- **Count or storage limit:** delete unused skills or shorten their bodies, then retry. Disabled records still consume storage.
- **Catalog limit:** disable unused skills or shorten descriptions before enabling more.
- **Load budget exhausted:** continue in a new run only if needed. Repeated loads consume the same run budget; they do not reset it.
- **Failed import, replacement, or storage write:** the previous valid record remains unchanged. Review the error and retry after the underlying problem is corrected.
- **Invalid saved store:** operations fail without overwriting records. Preserve a private copy before recovery; it can contain sensitive text. Do not attach it to public diagnostics.

Disable all skills to remove discovery and loading from subsequent runs. To remove local skill data, delete each installed skill in Settings. If corrupt data prevents that, open DevTools for the extension Settings page, use **Application → Storage → Extension storage**, and remove only `piBrowserAgentSkillsV1`. If that view is unavailable, execute `await chrome.storage.local.remove("piBrowserAgentSkillsV1")` in that trusted extension page's DevTools console. Close active runs and reopen Settings afterward. Do not clear all extension storage: that also removes credentials and unrelated settings. This recovery does not delete sessions or retract content already sent to a provider.

Older builds ignore the separate skill key. Remove it before downgrading if imported text must not remain in the profile. See [permissions and storage](permissions-and-storage.md), [security](security.md), and [privacy](../PRIVACY.md).
