import { expect, test } from "@playwright/test"
import {
  fakeCredential,
  fixtureMarker,
  launchLocalBrowserHarness,
} from "./support/local-browser-harness.js"
import { finalTextResponse, toolCallResponse } from "./support/mock-codex.js"

test.setTimeout(120_000)

// Reasoning and page-tool history must not become a selected task answer.
function withThinking(response: string): string {
  const item = {
    type: "reasoning",
    id: "private-reasoning",
    summary: [{ type: "summary_text", text: "PRIVATE_THINKING_NOT_AN_ANSWER" }],
  }
  return (
    ["response.output_item.added", "response.output_item.done"]
      .map((type) => `data: ${JSON.stringify({ type, output_index: 10, item })}\n\n`)
      .join("") + response
  )
}

async function attachDiagnostics(
  env: Awaited<ReturnType<typeof launchLocalBrowserHarness>>,
): Promise<void> {
  await test.info().attach("local-browser-diagnostics", {
    contentType: "application/json",
    body: JSON.stringify(
      {
        transcript: await env.panel.text("body"),
        requests: env.requests,
        unexpectedRequests: env.unexpectedRequests,
        pageErrors: env.pageErrors,
      },
      null,
      2,
    ),
  })
}

function expectClean(env: Awaited<ReturnType<typeof launchLocalBrowserHarness>>): void {
  expect(env.unexpectedRequests).toEqual([])
  expect(env.pageErrors).toEqual([])
}

test("Coding → Browser starts automatically after connection consent and returns only redacted final text", async () => {
  const env = await launchLocalBrowserHarness()
  try {
    const { client, panel, requests, responses } = env
    const text = "Read the visible fixture marker. Do not export the conversation history."
    responses.push(
      withThinking(toolCallResponse(1, "browser_read_page")),
      withThinking(
        finalTextResponse(2, `Selected marker answer. Credential echo: ${fakeCredential}`),
      ),
    )
    const queued = await client.send("coding-read-fixture", text)
    expect(queued).toMatchObject({
      id: "coding-read-fixture",
      from: "coding",
      to: "browser",
      task: text,
    })
    expect(
      await panel.evaluate(
        "document.querySelectorAll('.selected-element-chip, .remove-selected-element').length",
      ),
    ).toBe(0)
    const completed = await client.wait(queued, AbortSignal.timeout(30_000))
    expect(completed).toEqual({
      ...queued,
      status: "completed",
      answer: "Selected marker answer. Credential echo: [REDACTED]",
    })
    expect(requests).toHaveLength(2)
    // This marker is served only by the ordinary fixture page, not by the model mock.
    expect(JSON.stringify(requests[1])).toContain(fixtureMarker)
    expect(completed.answer).not.toContain(fixtureMarker)
    expect(JSON.stringify(completed)).not.toContain("PRIVATE_THINKING_NOT_AN_ANSWER")
    expect(JSON.stringify(completed)).not.toContain(fakeCredential)
    expect(Object.keys(completed).sort()).toEqual(["answer", "from", "id", "status", "task", "to"])
    await expect.poll(() => panel.text("#transcript")).toContain("Selected marker answer.")
    await expect.poll(() => panel.text("#transcript")).toContain("PRIVATE_THINKING_NOT_AN_ANSWER")
    expectClean(env)
  } catch (error) {
    await attachDiagnostics(env)
    throw error
  } finally {
    await env.close()
  }
})

test("missing origin approval waits for a real permission gesture, not another Send", async () => {
  const env = await launchLocalBrowserHarness()
  try {
    const { client, panel, requests, responses, settings } = env
    await settings.evaluate(() =>
      chrome.storage.local.set({ piBrowserAgentApprovedHostPermissions: [] }),
    )
    responses.push(finalTextResponse(31, "Approved automatic task answer."))
    const queued = await client.send(
      "coding-needs-access",
      "Answer after provider and site access approval.",
    )
    await expect.poll(() => panel.visible("#confirm-dialog")).toBe(true)
    expect(await panel.text("#confirm-message")).toContain(
      "Allow model-provider and current-site access",
    )
    expect(await panel.text("#confirm-dialog")).toContain("chatgpt.com")
    expect((await client.get(queued)).status).toBe("queued")
    expect(requests).toEqual([])
    await panel.evaluate("document.querySelector('#confirm-action').click()")
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await panel.visible("#confirm-dialog")).toBe(true)
    expect(requests).toEqual([])
    await panel.click('#confirm-dialog button[value="confirm"]')
    expect((await client.wait(queued, AbortSignal.timeout(30_000))).answer).toBe(
      "Approved automatic task answer.",
    )
    expect(requests).toHaveLength(1)
    expectClean(env)
  } catch (error) {
    await attachDiagnostics(env)
    throw error
  } finally {
    await env.close()
  }
})

test("permission-only focus epochs do not reject an unchanged document", async () => {
  const env = await launchLocalBrowserHarness()
  try {
    const { client, panel, requests, responses, settings } = env
    await settings.evaluate(() =>
      chrome.storage.local.set({ piBrowserAgentApprovedHostPermissions: [] }),
    )
    // Native permission windows can change only the worker epoch. Simulate that
    // metadata change without changing a tab or granting any access in script.
    await panel.evaluate(`(() => {
      let permissionFinished = false;
      const request = chrome.permissions.request.bind(chrome.permissions);
      chrome.permissions.request = async (options) => {
        const granted = await request(options);
        permissionFinished = true;
        return granted;
      };
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = async (...args) => {
        const response = await send(...args);
        if (permissionFinished && args[0]?.method === 'app.getState' && response?.result?.tabContext) {
          response.result.tabContext.epoch += 1;
        }
        return response;
      };
    })()`)
    responses.push(finalTextResponse(32, "Unchanged document accepted after permission."))
    const queued = await client.send("coding-permission-focus", "Answer after permission approval.")
    await expect.poll(() => panel.visible("#confirm-dialog")).toBe(true)
    await panel.click('#confirm-dialog button[value="confirm"]')
    expect((await client.wait(queued, AbortSignal.timeout(30_000))).answer).toBe(
      "Unchanged document accepted after permission.",
    )
    expect(requests).toHaveLength(1)
    expectClean(env)
  } catch (error) {
    await attachDiagnostics(env)
    throw error
  } finally {
    await env.close()
  }
})

test("cancellation during permission approval cannot revive or replay the task", async () => {
  const env = await launchLocalBrowserHarness()
  try {
    const { client, panel, requests, settings } = env
    await settings.evaluate(() =>
      chrome.storage.local.set({ piBrowserAgentApprovedHostPermissions: [] }),
    )
    await panel.evaluate(`(() => {
      window.permissionAttempts = 0;
      chrome.permissions.request = () => {
        window.permissionAttempts++;
        return new Promise(resolve => { window.finishPermission = resolve; });
      };
    })()`)
    const queued = await client.send("coding-cancel-permission", "Wait for approved access.")
    await expect.poll(() => panel.visible("#confirm-dialog")).toBe(true)
    await panel.click('#confirm-dialog button[value="confirm"]')
    expect(await panel.evaluate("window.permissionAttempts")).toBe(1)
    const cancelled = await client.cancel(queued)
    expect(cancelled.status).toBe("cancelled")
    await expect.poll(() => panel.visible("#confirm-dialog")).toBe(false)
    await panel.evaluate("window.finishPermission(true)")
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(await client.get(cancelled)).toEqual(cancelled)
    expect(requests).toEqual([])
    expect(await panel.evaluate("window.permissionAttempts")).toBe(1)
    expectClean(env)
  } catch (error) {
    await attachDiagnostics(env)
    throw error
  } finally {
    await env.close()
  }
})

test("an occupied composer rejects automatic work without changing the user's draft", async () => {
  const env = await launchLocalBrowserHarness()
  try {
    await env.panel.fillPrompt("Unsent user draft")
    await expect(env.client.send("coding-occupied", "Do not replace a draft.")).rejects.toThrow()
    expect(await env.panel.evaluate("document.querySelector('#prompt').value")).toBe(
      "Unsent user draft",
    )
    expect(await env.panel.visible("#coding-task-chip")).toBe(false)
    expect(env.requests).toEqual([])
    expectClean(env)
  } finally {
    await env.close()
  }
})

test("same-URL navigation during permission confirmation fails without automatic retry", async () => {
  const env = await launchLocalBrowserHarness()
  try {
    const { client, panel, requests, settings, fixturePage } = env
    await settings.evaluate(() =>
      chrome.storage.local.set({ piBrowserAgentApprovedHostPermissions: [] }),
    )
    const queued = await client.send("coding-stale-page", "Read only the original page context.")
    await expect.poll(() => panel.visible("#confirm-dialog")).toBe(true)
    await fixturePage.reload()
    await panel.click('#confirm-dialog button[value="confirm"]')
    const failed = await client.wait(queued, AbortSignal.timeout(30_000))
    expect(failed.status).toBe("failed")
    expect(requests).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await client.get(failed)).toEqual(failed)
    expect(requests).toEqual([])
    expectClean(env)
  } catch (error) {
    await attachDiagnostics(env)
    throw error
  } finally {
    await env.close()
  }
})

test("delegated slash text reaches the model without executing a local command", async () => {
  const env = await launchLocalBrowserHarness()
  try {
    env.responses.push(finalTextResponse(41, "Slash text received as model input."))
    const task = await env.client.send("coding-literal-slash", "/new")
    const completed = await env.client.wait(task, AbortSignal.timeout(30_000))
    expect(completed.answer).toBe("Slash text received as model input.")
    expect(env.requests).toHaveLength(1)
    expect(JSON.stringify(env.requests[0])).toContain("/new")
    expectClean(env)
  } catch (error) {
    await attachDiagnostics(env)
    throw error
  } finally {
    await env.close()
  }
})

test("detach revokes the local connection without closing existing browser tabs or profile", async () => {
  const env = await launchLocalBrowserHarness()
  try {
    const tabs = env.context.pages().map((page) => page.url())
    await env.client.close()
    expect(env.context.pages().map((page) => page.url())).toEqual(tabs)
    expect(env.fixturePage.isClosed()).toBe(false)
    expect(await env.fixturePage.locator("h1").textContent()).toBe(fixtureMarker)
    await expect(env.settings.locator("#coding-status")).toHaveText("Local connection rejected")
    expect(await env.panel.evaluate("document.body.dataset.conversationReady")).toBe("true")
    expect(env.requests).toEqual([])
    await expect(env.client.inbox()).rejects.toThrow()
    expectClean(env)
  } finally {
    await env.close()
  }
})

test("Browser → Coding requires fresh Browser confirmation and explicit Coding acceptance and selected reply", async () => {
  const env = await launchLocalBrowserHarness()
  try {
    const { client, panel, requests, responses } = env
    const task = "Inspect the local project. Credential echo: [REDACTED]"
    const selectedAnswer = "Selected Coding result: local test passed. Credential echo: [REDACTED]"
    responses.push(
      withThinking(
        toolCallResponse(11, "coding_task", { task: task.replace("[REDACTED]", fakeCredential) }),
      ),
      finalTextResponse(12, "Browser received the selected Coding result."),
    )
    expect(await client.inbox()).toEqual([])
    await panel.fillPrompt(
      "Delegate a bounded local project check to Coding. BROWSER_HISTORY_NOT_A_TASK",
    )
    await env.fixturePage.bringToFront()
    await panel.click("#send")
    await expect.poll(() => panel.visible("#confirm-dialog")).toBe(true)
    expect(await panel.text("#confirm-message")).toContain("Send the following task")
    expect(await panel.text("#confirm-dialog")).toContain(task)
    expect(await panel.text("#confirm-dialog")).not.toContain(fakeCredential)
    expect(await client.inbox()).toEqual([])
    expect(requests).toHaveLength(1)
    await panel.click('#confirm-dialog button[value="confirm"]')
    await expect.poll(async () => (await client.inbox()).length).toBe(1)
    const [inboxTask] = await client.inbox()
    expect(inboxTask).toEqual({
      id: expect.any(String),
      from: "browser",
      to: "coding",
      task,
      status: "queued",
    })
    if (!inboxTask) throw new Error("Missing Coding inbox task")
    expect(JSON.stringify(inboxTask)).not.toContain(fakeCredential)
    expect(JSON.stringify(inboxTask)).not.toContain("BROWSER_HISTORY_NOT_A_TASK")
    expect(JSON.stringify(inboxTask)).not.toContain("PRIVATE_THINKING_NOT_AN_ANSWER")
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect((await client.get(inboxTask)).status).toBe("queued")
    expect(requests).toHaveLength(1)
    const accepted = await client.accept(inboxTask)
    expect(accepted.status).toBe("running")
    expect(await client.inbox()).toEqual([])
    expect(requests).toHaveLength(1)
    const replied = await client.reply(
      accepted,
      selectedAnswer.replace("[REDACTED]", fakeCredential),
    )
    expect(replied).toEqual({ ...accepted, status: "completed", answer: selectedAnswer })
    await expect.poll(() => requests.length).toBe(2)
    expect(JSON.stringify(requests[1])).toContain(selectedAnswer)
    await expect
      .poll(() => panel.text("#transcript"))
      .toContain("Browser received the selected Coding result.")
    expectClean(env)
  } catch (error) {
    await attachDiagnostics(env)
    throw error
  } finally {
    await env.close()
  }
})

test("Coding cancellation aborts a real pending browser mutation without execution, retry, or late completion", async () => {
  const env = await launchLocalBrowserHarness()
  try {
    const { client, panel, requests, responses, fixturePage } = env
    responses.push(toolCallResponse(21, "browser_click", { selector: "#ordinary" }))
    const queued = await client.send(
      "coding-cancel-action",
      "Click the ordinary fixture action after confirmation.",
    )
    await expect.poll(() => panel.visible("#confirm-dialog")).toBe(true)
    expect(await panel.text("#confirm-dialog")).toContain("ordinary")
    expect((await client.get(queued)).status).toBe("running")
    await expect(fixturePage.locator("output")).toHaveText("unchanged")
    const cancelled = await client.cancel(queued)
    expect(cancelled).toEqual({ ...queued, status: "cancelled" })
    await expect.poll(() => panel.visible("#confirm-dialog")).toBe(false)
    await expect.poll(() => panel.evaluate("document.querySelector('#send').disabled")).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(await client.wait(cancelled)).toEqual(cancelled)
    expect(await client.get(cancelled)).toEqual(cancelled)
    await expect(fixturePage.locator("output")).toHaveText("unchanged")
    expect(requests).toHaveLength(1)
    expect(responses).toHaveLength(0)
    expectClean(env)
  } catch (error) {
    await attachDiagnostics(env)
    throw error
  } finally {
    await env.close()
  }
})
