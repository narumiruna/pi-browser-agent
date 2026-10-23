import { expect, type Page, test } from "@playwright/test"
import {
  configureMockCodex,
  launchExtensionHarness,
  waitForConversationReady,
} from "./support/extension-harness.js"
import { CODEX_RESPONSES_URL, finalTextResponse, toolCallResponse } from "./support/mock-codex.js"

test.setTimeout(120_000)

const STORAGE_KEY = "piBrowserAgentSkillsV1"
const NAME = "e2e-review-checklist"
const DESCRIPTION = "Review scope safely. <script>window.skillInjected=true</script>"
const BODY =
  "SKILL_BODY_PRIVATE_E2E_MARKER\nCheck scope and tests. Never bypass browser permissions."

type SkillRecord = {
  id: string
  name: string
  description: string
  body: string
  enabled: boolean
}
type ModelRequest = {
  instructions: string
  tools: { name: string }[]
  input: { type?: string; tools?: { name: string }[]; output?: string }[]
}

function advertisedTools(request: ModelRequest | undefined): string[] {
  return [
    ...(request?.tools ?? []),
    ...(request?.input.flatMap((item) =>
      item.type === "additional_tools" ? (item.tools ?? []) : [],
    ) ?? []),
  ].map((tool) => tool.name)
}

function source(body = BODY): Buffer {
  return Buffer.from(
    `---\nname: ${NAME}\ndescription: ${JSON.stringify(DESCRIPTION)}\n---\n${body}`,
    "utf8",
  )
}

async function records(page: Page): Promise<SkillRecord[]> {
  return page.evaluate(async (key) => {
    const data = (await chrome.storage.local.get(key))[key] as
      | { version: number; records: SkillRecord[] }
      | undefined
    return data?.records ?? []
  }, STORAGE_KEY)
}

async function selectFile(page: Page, buffer = source(), name = "SKILL.md"): Promise<void> {
  // Settings stays hidden until its asynchronous initialization installs the file handler.
  await expect(page.locator("#skills-file-input")).toBeVisible()
  await expect(page.locator("#skills-file-input")).toBeEnabled()
  await page.locator("#skills-file-input").setInputFiles({
    name,
    mimeType: "text/markdown",
    buffer,
  })
}

async function importSkill(page: Page): Promise<SkillRecord> {
  await selectFile(page)
  await expect(page.locator("#skills-preview")).toContainText(BODY)
  await expect(page.locator("#skills-preview")).toContainText(DESCRIPTION)
  await expect(page.locator("#skills-preview script")).toHaveCount(0)
  await expect(page.locator("#skills-import-reviewed")).toBeEnabled()
  expect(await records(page)).toEqual([])
  await page.locator("#skills-import-reviewed").focus()
  await page.locator("#skills-import-reviewed").press("Enter")
  await expect(page.locator("#skills-status")).toContainText("imported disabled")
  const installed = await records(page)
  expect(installed).toHaveLength(1)
  expect(installed[0]).toMatchObject({
    name: NAME,
    description: DESCRIPTION,
    body: BODY,
    enabled: false,
  })
  const record = installed[0]
  if (!record) throw new Error("Imported skill was not stored")
  await page.locator("#skills-list").selectOption(record.id)
  return record
}

async function savedSessions(page: Page): Promise<unknown[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("pi-browser-agent-sessions", 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<unknown[]>((resolve, reject) => {
        const request = database
          .transaction("sessions", "readonly")
          .objectStore("sessions")
          .getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    } finally {
      database.close()
    }
  })
}

async function send(page: Page, prompt: string, answer: string): Promise<void> {
  await page.locator("#prompt").fill(prompt)
  await page.locator("#send").click()
  await expect(page.locator("#transcript .message.assistant").last()).toContainText(answer)
  await expect(page.locator("#abort")).toBeHidden()
}

test("reviewed skills disclose metadata before model-requested load and retain history after disable/delete", async () => {
  const harness = await launchExtensionHarness()
  try {
    const requests: ModelRequest[] = []
    let id = ""
    await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
      requests.push(route.request().postDataJSON() as ModelRequest)
      const index = requests.length
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          index === 1
            ? toolCallResponse(index, "skills_load", { id })
            : finalTextResponse(index, `Skill round ${index} complete`),
      })
    })
    await configureMockCodex(harness)
    const settings = await harness.context.newPage()
    await settings.goto(`${harness.controller.url()}?view=settings`)
    const installed = await importSkill(settings)
    id = installed.id
    expect(requests).toHaveLength(0)
    await settings.locator("#skills-enabled").focus()
    await settings.locator("#skills-enabled").press("Space")
    await expect(settings.locator("#skills-enabled")).toBeChecked()
    await expect(settings.locator("#skills-status")).toContainText("enabled for the next run")
    expect((await records(settings))[0]?.enabled).toBe(true)
    expect(requests).toHaveLength(0)
    expect(
      await settings.evaluate(() => (window as Window & { skillInjected?: boolean }).skillInjected),
    ).toBeUndefined()

    await harness.fixturePage.goto("about:blank")
    await harness.fixturePage.bringToFront()
    await expect(harness.controller.locator("#page-status")).toContainText("cannot read or operate")
    await send(harness.controller, `Use the enabled ${NAME} skill.`, "Skill round 2 complete")
    expect(requests).toHaveLength(2)
    const catalog = JSON.stringify([{ id, name: NAME, description: DESCRIPTION }])
    expect(requests[0]?.instructions).toContain(catalog)
    expect(JSON.stringify(requests[0])).not.toContain("SKILL_BODY_PRIVATE_E2E_MARKER")
    expect(requests[0]?.instructions).not.toContain('"body":')
    // Codex can anchor new declarations in additional_tools rather than top-level tools.
    expect(advertisedTools(requests[0])).toContain("skills_load")
    expect(JSON.stringify(requests[1]?.input)).toContain("SKILL_BODY_PRIVATE_E2E_MARKER")
    expect(JSON.stringify(requests[1]?.input)).toContain("skills_load")
    await expect
      .poll(async () => JSON.stringify(await savedSessions(harness.controller)))
      .toContain(BODY.split("\n")[0])

    await settings.locator("#skills-enabled").uncheck()
    await expect(settings.locator("#skills-status")).toContainText("disabled for the next run")
    expect(requests).toHaveLength(2)
    await harness.controller.reload({ waitUntil: "domcontentloaded" })
    await waitForConversationReady(harness.controller)
    await expect(harness.controller.locator("#transcript")).toContainText("Skill round 2 complete")
    expect(requests).toHaveLength(2)
    await harness.fixturePage.bringToFront()
    await send(harness.controller, "Continue without loading skills.", "Skill round 3 complete")
    expect(advertisedTools(requests[2])).not.toContain("skills_load")
    expect(requests[2]?.instructions).not.toContain(catalog)
    // Removing availability does not redact a previously authorized tool result.
    expect(JSON.stringify(requests[2]?.input)).toContain("SKILL_BODY_PRIVATE_E2E_MARKER")

    await settings.locator("#skills-enabled").check()
    await expect(settings.locator("#skills-status")).toContainText("enabled for the next run")
    await settings.locator("#skills-delete").click()
    await expect(settings.locator("#skills-delete-dialog")).toBeVisible()
    await expect(settings.locator("#skills-cancel-delete")).toBeFocused()
    await settings.locator("#skills-cancel-delete").press("Enter")
    expect(await records(settings)).toHaveLength(1)
    await settings.locator("#skills-delete").click()
    await settings.locator("#skills-confirm-delete").focus()
    await settings.locator("#skills-confirm-delete").press("Enter")
    await expect(settings.locator("#skills-status")).toContainText(
      "Previous session history is retained",
    )
    expect(await records(settings)).toEqual([])
    expect(requests).toHaveLength(3)
    await harness.fixturePage.bringToFront()
    await send(harness.controller, "Continue after skill deletion.", "Skill round 4 complete")
    expect(advertisedTools(requests[3])).not.toContain("skills_load")
    expect(requests[3]?.instructions).not.toContain(catalog)
    expect(JSON.stringify(requests[3]?.input)).toContain("SKILL_BODY_PRIVATE_E2E_MARKER")
    expect(JSON.stringify(await savedSessions(harness.controller))).toContain(
      "SKILL_BODY_PRIVATE_E2E_MARKER",
    )
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("skill validation and explicit replacement are local and clearing sessions preserves installed skills", async () => {
  const harness = await launchExtensionHarness()
  try {
    const requests: string[] = []
    await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
      requests.push(route.request().postData() ?? "")
      await route.fulfill({ status: 500, body: "Unexpected provider request" })
    })
    await configureMockCodex(harness)
    const settings = await harness.context.newPage()
    await settings.goto(`${harness.controller.url()}?view=settings`)
    await selectFile(settings, source(), "skill.md")
    await expect(settings.locator("#skills-status")).toContainText("named SKILL.md")
    await expect(settings.locator("#skills-import-reviewed")).toBeDisabled()
    await selectFile(settings, Buffer.from([0xff, 0xfe, 0x80]))
    await expect(settings.locator("#skills-status")).toContainText("valid UTF-8")
    await selectFile(
      settings,
      Buffer.from("---\nname: bad\ndescription: text\nextra: denied\n---\nBody"),
    )
    await expect(settings.locator("#skills-status")).toContainText("Unknown frontmatter field")
    expect(await records(settings)).toEqual([])

    const original = await importSkill(settings)
    await settings.locator("#skills-enabled").check()
    await expect(settings.locator("#skills-status")).toContainText("enabled for the next run")
    await selectFile(settings)
    await settings.locator("#skills-import-reviewed").click()
    await expect(settings.locator("#skills-status")).toContainText("explicit replacement")
    expect((await records(settings))[0]).toEqual({ ...original, enabled: true })
    const replacement =
      "REPLACEMENT_BODY_E2E_MARKER\nDo not run scripts/review.py or open supporting files."
    await selectFile(settings, source(replacement))
    await expect(settings.locator("#skills-preview")).toContainText("not available")
    await settings.locator("#skills-replace-reviewed").click()
    await expect(settings.locator("#skills-status")).toContainText("replaced and disabled")
    expect(await records(settings)).toEqual([{ ...original, body: replacement, enabled: false }])

    const session = await harness.controller.locator("#sessions").inputValue()
    await harness.controller.locator("#account-menu-trigger").click()
    harness.controller.once("dialog", (dialog) => dialog.accept())
    await harness.controller.locator("#clear-sessions").click()
    await expect(harness.controller.locator("#sessions")).not.toHaveValue(session)
    await expect(harness.controller.locator("#transcript .message")).toHaveCount(0)
    expect(await records(settings)).toEqual([{ ...original, body: replacement, enabled: false }])
    expect(requests).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})
