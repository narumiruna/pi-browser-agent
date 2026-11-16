import { expect, test } from "@playwright/test"
import { CODEX_RESPONSES_URL } from "./support/mock-codex.js"
import { menu, setupTranslation } from "./support/translation.js"

const videoUrl = "https://www.youtube.com/watch?v=fixture-video"
const caption =
  "A clear caption explains safe browser translation without changing the original video controls."
const fixture = `<!doctype html><meta charset="utf-8"><style>.ytp-caption-window-container{position:absolute;inset:0;pointer-events:none}#movie_player{position:relative;width:720px;height:420px;background:#222;color:white}.ytp-right-controls{position:absolute;bottom:0;right:0}.caption-window{position:absolute;bottom:50px;left:50px}.ytp-button{width:40px;height:36px}</style><div id="movie_player" class="html5-video-player"><video class="html5-main-video"></video><div id="ytp-caption-window-container" class="ytp-caption-window-container"><div class="caption-window" hidden><span class="ytp-caption-segment">${caption}</span></div></div><div class="ytp-right-controls"><button class="ytp-subtitles-button ytp-button" aria-pressed="false" aria-label="Subtitles">CC</button><button class="ytp-settings-button ytp-button">⚙</button><button class="ytp-fullscreen-button ytp-button">□</button></div></div><script>
const player=document.querySelector("#movie_player"),video=player.querySelector("video"),button=player.querySelector(".ytp-subtitles-button");
const track={baseUrl:"https://www.youtube.com/api/timedtext?v=fixture-video&lang=en&sig=fixture-private-signature",languageCode:"en",kind:"asr",vssId:"a.en",name:{simpleText:"English"}};
window.ytInitialPlayerResponse={videoDetails:{videoId:"fixture-video"},captions:{playerCaptionsTracklistRenderer:{captionTracks:[track]}}};
player.getPlayerResponse=()=>window.ytInitialPlayerResponse;player.getVideoData=()=>({video_id:"fixture-video"});player.getOption=(_group,key)=>key==="tracklist"?[track]:track;player.getCurrentTime=()=>video.currentTime;player.getPlaybackRate=()=>video.playbackRate;player.setOption=()=>{};
Object.defineProperty(video,"paused",{get:()=>false});Object.defineProperty(video,"duration",{get:()=>300});
button.onclick=()=>{button.setAttribute("aria-pressed","true");player.querySelector(".caption-window").hidden=false;fetch(track.baseUrl+"&fmt=json3&pot=fixture-native-token").catch(()=>{})};
player.querySelector(".ytp-fullscreen-button").onclick=()=>player.requestFullscreen();
</script>`

for (const cancellation of ["Stop", "panel closure", "SPA navigation"] as const)
  test(`five pending subtitle SSE requests abort on ${cancellation} and cannot replace native captions`, async () => {
    const { harness } = await setupTranslation({ hostPatterns: ["https://www.youtube.com/*"] })
    let pending = 0
    let cancelled = 0
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      harness.context.on("requestfailed", (request) => {
        if (request.url() === CODEX_RESPONSES_URL) cancelled++
      })
      await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
        expect(route.request().postDataJSON().stream).toBe(true)
        pending++
        await gate
        await route.abort().catch(() => undefined)
      })
      await harness.context.route("https://www.youtube.com/watch?*", (route) =>
        route.fulfill({ contentType: "text/html", body: fixture }),
      )
      const cues = Array.from({ length: 40 }, (_value, index) => ({
        tStartMs: index * 1000,
        dDurationMs: 1000,
        segs: [
          {
            utf8: `Owned cue ${index}: ${Array.from({ length: 40 }, (_value, part) => `Distinct passage ${part} of cue ${index} explains bounded cancellation, native readability, and the current playback context. `).join("")}`,
          },
        ],
      }))
      await harness.context.route("https://www.youtube.com/api/timedtext?*", (route) =>
        route.fulfill({ contentType: "application/json", body: JSON.stringify({ events: cues }) }),
      )
      await harness.fixturePage.goto(videoUrl)
      await menu(harness, "pi-translate-youtube")
      await expect.poll(() => pending, { timeout: 15000 }).toBe(5)
      await expect(harness.fixturePage.locator(".ytp-caption-segment")).toBeVisible()
      if (cancellation === "Stop") await harness.controller.locator("#translation-stop").click()
      else if (cancellation === "panel closure") await harness.controller.close()
      else
        await harness.fixturePage.evaluate(() =>
          history.pushState({}, "", "/watch?v=replacement-video"),
        )
      if (cancellation === "panel closure") {
        // Playwright drops requestfailed events with the destroyed Page. Check the
        // request-owning context and worker capability teardown instead.
        expect(harness.controller.isClosed()).toBe(true)
        await expect
          .poll(() =>
            harness.worker.evaluate(async () =>
              Object.keys(await chrome.storage.session.get(null)).filter((key) =>
                key.startsWith("piBrowserAgentTranslationOwnerV1:"),
              ),
            ),
          )
          .toEqual([])
        const reopened = await harness.context.newPage()
        await reopened.goto(`chrome-extension://${harness.extensionId}/sidebar/index.html`)
        await expect(reopened.locator("#translation-stop")).toBeHidden()
      } else await expect.poll(() => cancelled, { timeout: 10000 }).toBe(5)
      release()
      await expect(
        harness.fixturePage.locator('[data-ot-role="note-body"][data-state="ready"]'),
      ).toHaveCount(0)
      await expect(harness.fixturePage.locator(".ytp-caption-segment")).toContainText(caption)
      expect(pending).toBe(5)
      expect(harness.pageErrors).toEqual([])
    } finally {
      release()
      await harness.close()
    }
  })

for (const outcome of ["exhaustion", "navigation"] as const)
  test(`packaged subtitle recovery handles ${outcome} without stale publication or unbounded retries`, async () => {
    test.setTimeout(60000)
    const { harness, requests } = await setupTranslation({
      hostPatterns: ["https://www.youtube.com/*"],
    })
    try {
      await harness.context.route("https://www.youtube.com/watch?*", (route) =>
        route.fulfill({ contentType: "text/html", body: fixture }),
      )
      await harness.context.route("https://www.youtube.com/api/timedtext?*", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            events: [{ tStartMs: 0, dDurationMs: 10000, segs: [{ utf8: caption }] }],
          }),
        }),
      )
      await harness.fixturePage.goto(videoUrl)
      await menu(harness, "pi-translate-youtube")
      await expect(
        harness.fixturePage.locator('[data-ot-role="note-body"][data-state="ready"]'),
      ).toBeVisible()
      const completed = requests()
      // Test-only isolated-world transport faults; no production hook or artifact edit.
      const tabId = await harness.controller.evaluate(async (outcome) => {
        const [tab] = await chrome.tabs.query({ url: "https://www.youtube.com/watch*" })
        if (tab?.id === undefined) throw new Error("Missing fixture tab")
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          args: [outcome],
          func: (outcome) => {
            const state = globalThis as typeof globalThis & {
              __piRecoveryAttempts?: number
              __piReleaseRecovery?: () => void
            }
            state.__piRecoveryAttempts = 0
            const send = chrome.runtime.sendMessage.bind(chrome.runtime)
            chrome.runtime.sendMessage = ((message: {
              type?: string
              payload?: { recovery?: boolean }
            }) => {
              if (message.type === "prefetch-youtube-subtitles")
                return Promise.resolve({ sessionStatus: "missing" })
              if (
                message.type === "start-youtube-subtitle-translation" &&
                message.payload?.recovery
              ) {
                state.__piRecoveryAttempts = (state.__piRecoveryAttempts ?? 0) + 1
                if (outcome === "navigation")
                  return new Promise<{ ok: boolean; sessionId: string }>((resolve) => {
                    state.__piReleaseRecovery = () =>
                      resolve({ ok: true, sessionId: "late-superseded-session" })
                  })
                return Promise.resolve({ ok: false, retryable: true })
              }
              return send(message)
            }) as typeof chrome.runtime.sendMessage
          },
        })
        return tab.id
      }, outcome)
      const attempts = () =>
        harness.controller.evaluate(async (tabId) => {
          const [result] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () =>
              (globalThis as typeof globalThis & { __piRecoveryAttempts?: number })
                .__piRecoveryAttempts,
          })
          return result?.result
        }, tabId)
      await harness.fixturePage.evaluate(() => {
        const video = document.querySelector("video")
        if (!video) throw new Error("Missing video")
        video.currentTime = 30
        video.dispatchEvent(new Event("seeking"))
      })
      await expect.poll(attempts).toBe(1)
      if (outcome === "exhaustion") {
        await expect.poll(attempts, { timeout: 30000, intervals: [1000] }).toBe(3)
        await expect(
          harness.fixturePage.locator('[data-ot-role="youtube-diagnostics"]'),
        ).toContainText("session-recovery-exhausted")
        await expect(harness.fixturePage.locator("[data-ot-youtube-control]")).toHaveCount(1)
        await harness.fixturePage.waitForTimeout(11000)
        expect(await attempts()).toBe(3)
      } else {
        await harness.fixturePage.evaluate(() =>
          history.pushState({}, "", "/watch?v=recovery-replacement"),
        )
        await expect(harness.controller.locator("#translation-stop")).toBeHidden()
        await harness.controller.evaluate(async (tabId) => {
          await chrome.scripting.executeScript({
            target: { tabId },
            func: () =>
              (
                globalThis as typeof globalThis & { __piReleaseRecovery?: () => void }
              ).__piReleaseRecovery?.(),
          })
        }, tabId)
        await expect(harness.fixturePage.locator("[data-ot-youtube-control]")).toHaveCount(0)
      }
      await expect(harness.fixturePage.locator(".ytp-caption-segment")).toBeVisible()
      await expect(
        harness.fixturePage.locator('[data-ot-role="note-body"][data-state="ready"]'),
      ).toHaveCount(0)
      expect(requests()).toBe(completed)
      expect(harness.pageErrors).toEqual([])
    } finally {
      await harness.close()
    }
  })

test("YouTube menu starts automatic captions, survives idle/video replacement, and keeps diagnostics private", async () => {
  test.setTimeout(90000)
  const { harness, requests } = await setupTranslation({
    hostPatterns: ["https://www.youtube.com/*"],
  })
  try {
    await harness.context.route("https://www.youtube.com/watch?*", (route) =>
      route.fulfill({ contentType: "text/html", body: fixture }),
    )
    await harness.context.route("https://www.youtube.com/api/timedtext?*", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          events: [
            { tStartMs: 0, dDurationMs: 10000, segs: [{ utf8: caption }] },
            {
              tStartMs: 120000,
              dDurationMs: 10000,
              segs: [
                {
                  utf8: "A later caption follows an explicit seek and uses the current video session.",
                },
              ],
            },
          ],
        }),
      }),
    )
    await harness.fixturePage.goto(videoUrl)
    await expect(harness.fixturePage.locator("[data-ot-youtube-control]")).toHaveCount(0)
    await menu(harness, "pi-translate-youtube")
    await expect(harness.controller.locator("#translation-stop")).toBeVisible()
    await expect(
      harness.fixturePage.locator('[data-ot-role="note-body"][data-state="ready"]'),
    ).toContainText("譯文", { timeout: 20000 })
    await expect(harness.fixturePage.locator(".ytp-subtitles-button")).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    expect(requests()).toBeGreaterThan(0)
    await harness.fixturePage.locator("[data-ot-youtube-control]").click()
    const diagnostics = harness.fixturePage.locator('[data-ot-role="youtube-diagnostics"]')
    await expect(diagnostics).toBeVisible()
    expect(await diagnostics.textContent()).not.toContain("fixture-private-signature")
    expect(await diagnostics.textContent()).not.toContain(caption)
    await harness.fixturePage.locator(".ytp-fullscreen-button").click()
    await expect
      .poll(() => harness.fixturePage.evaluate(() => Boolean(document.fullscreenElement)))
      .toBe(true)
    await expect(
      harness.fixturePage.locator('[data-ot-role="note-body"][data-state="ready"]'),
    ).toBeVisible()
    await harness.fixturePage.evaluate(() => document.exitFullscreen())
    const completed = requests()
    const cdp = await harness.context.newCDPSession(harness.fixturePage)
    const { targetInfos } = await cdp.send("Target.getTargets")
    const worker = targetInfos.find(
      (target: { type: string; url: string }) =>
        target.type === "service_worker" && target.url.includes(harness.extensionId),
    )
    if (!worker) throw new Error("Missing extension worker")
    await cdp.send("Target.closeTarget", { targetId: worker.targetId })
    await harness.controller.evaluate(() =>
      chrome.runtime.sendMessage({
        kind: "request",
        requestId: "wake-subtitles",
        method: "app.getState",
        params: {},
      }),
    )
    expect(requests()).toBe(completed)
    await harness.fixturePage.evaluate(() => {
      const original = document.querySelector("video")
      if (!original) throw new Error("Missing original video")
      const replacement = original.cloneNode() as HTMLVideoElement
      Object.defineProperty(replacement, "paused", { configurable: true, get: () => true })
      Object.defineProperty(replacement, "duration", { get: () => 300 })
      original.replaceWith(replacement)
    })
    // Real idle time exceeds the normal MV3 inactivity window; no clock acceleration.
    await harness.fixturePage.waitForTimeout(35000)
    await expect(harness.fixturePage.locator("[data-ot-youtube-control]")).toHaveCount(1)
    expect(requests()).toBe(completed)
    await harness.fixturePage.evaluate(() => {
      const video = document.querySelector("video")
      if (!video) throw new Error("Missing video")
      Object.defineProperty(video, "paused", { configurable: true, get: () => false })
      video.currentTime = 120
      video.playbackRate = 2
      const caption = document.querySelector(".ytp-caption-segment")
      if (caption)
        caption.textContent =
          "A later caption follows an explicit seek and uses the current video session."
      video.dispatchEvent(new Event("seeking"))
      video.dispatchEvent(new Event("seeked"))
      video.dispatchEvent(new Event("ratechange"))
      video.dispatchEvent(new Event("timeupdate"))
    })
    await expect(
      harness.fixturePage.locator('[data-ot-role="note-body"][data-state="ready"]'),
    ).toContainText("A later caption", { timeout: 15000 })
    expect(requests()).toBeGreaterThan(completed)
    const beforeNavigation = requests()
    await harness.fixturePage.evaluate(() =>
      history.pushState({}, "", "/watch?v=another-owned-video"),
    )
    await expect(harness.controller.locator("#translation-stop")).toBeHidden()
    await expect(harness.fixturePage.locator("[data-ot-youtube-control]")).toHaveCount(0)
    expect(requests()).toBe(beforeNavigation)
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})
