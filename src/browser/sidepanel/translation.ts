import { CREDENTIALS_KEY } from "../auth/credential-store.js"
import type { BrowserConfiguration } from "../configuration.js"
import { translationUiStrings } from "../i18n/translation-ui.js"
import { hasApprovedHostPermission, requestHostPermissions } from "../permissions.js"
import { boundedResponse } from "../runtime/bounded-response.js"
import type { RuntimeRequest, RuntimeResponse } from "../runtime/messages.js"
import {
  isTranslationContentMessage,
  record,
  type TranslationIntent,
  type TranslationOperation,
} from "../runtime/translation.js"
import type { TabContext } from "../runtime/types.js"
import { createBackgroundController } from "../translation/background/controller.js"
import { createBackgroundPlatform } from "../translation/background/platform.js"
import * as SiteProfiles from "../translation/content/extraction/site-profiles.js"
import { TranslationProvider } from "../translation/provider.js"
import * as Appearance from "../translation/shared/appearance.js"
import * as EmbeddedFrames from "../translation/shared/embedded-frames.js"
import * as Messages from "../translation/shared/messages.js"
import * as Settings from "../translation/shared/settings.js"
import * as TranslationSession from "../translation/shared/translation-session.js"
import { createTranslationApi } from "../translation/translation/api.js"

async function worker(
  operation: TranslationOperation,
  owner = "",
  payload: Record<string, unknown> = {},
): Promise<unknown> {
  const response = await chrome.runtime.sendMessage({
    kind: "translation",
    operation,
    owner,
    payload,
  })
  if (!record(response) || response.ok !== true)
    throw new Error("Translation stopped because access expired or the page changed")
  return response.result
}

async function currentContext(): Promise<TabContext> {
  const request: RuntimeRequest = {
    kind: "request",
    requestId: crypto.randomUUID(),
    method: "app.getState",
    params: {},
  }
  const response: RuntimeResponse = await chrome.runtime.sendMessage(request)
  if (!response.ok || !record(response.result) || !record(response.result.tabContext))
    throw new Error("Open a supported HTTP or HTTPS page before translating")
  return response.result.tabContext as unknown as TabContext
}

/** One menu-initiated translation owner; it never submits chat or exposes credentials. */
export class TranslationController {
  private owner = ""
  private selectionRequestId = ""
  private abort?: AbortController
  private controller?: ReturnType<typeof createBackgroundController>
  private intent?: TranslationIntent
  private windowId = -1
  private context?: TabContext
  private disposed = false
  private sequence = 0
  private starting?: Promise<void>
  private operation?: (
    kind: TranslationOperation,
    payload?: Record<string, unknown>,
  ) => Promise<unknown>
  private snapshot?: Awaited<ReturnType<typeof Settings.getSettings>>
  private readonly provider: TranslationProvider
  private scopedProvider?: TranslationProvider
  private readonly approve: HTMLButtonElement
  private readonly stopButton: HTMLButtonElement

  constructor(
    configuration: BrowserConfiguration,
    private readonly ui: {
      busy: () => boolean
      error: (error?: unknown) => void
      status: (message: string) => void
      changed: () => void
    },
  ) {
    this.provider = new TranslationProvider(configuration)
    this.approve = document.getElementById("translation-approve") as HTMLButtonElement
    this.stopButton = document.getElementById("translation-stop") as HTMLButtonElement
    this.approve.addEventListener("click", () => {
      const intent = this.intent
      const snapshot = this.snapshot
      if (!intent || !snapshot) return
      // All URLs were resolved before showing this button. No await precedes permission request.
      const permission = requestHostPermissions(this.requiredOrigins)
      this.approve.disabled = true
      void permission
        .then(async (granted) => {
          if (!granted) throw new Error("Translation access was not granted")
          await this.begin(intent, snapshot)
        })
        .catch(ui.error)
        .finally(() => {
          this.approve.disabled = false
        })
    })
    this.stopButton.addEventListener("click", () => {
      void this.stop().catch(ui.error)
    })
    chrome.runtime.onMessage.addListener(this.onMessage)
    chrome.storage.onChanged.addListener(this.onStorage)
    chrome.permissions.onRemoved.addListener(this.onRevoked)
  }

  private requiredOrigins: string[] = []
  get active(): boolean {
    return Boolean(this.abort)
  }

  async initialize(): Promise<void> {
    this.windowId = (await chrome.windows.getCurrent()).id ?? -1
    await this.takeIntent()
  }

  private onRevoked = (): void => {
    const sequence = this.sequence
    void Promise.all(this.requiredOrigins.map(hasApprovedHostPermission))
      .then((grants) => {
        if (sequence === this.sequence && !grants.every(Boolean)) return this.stop()
      })
      .catch(() => this.stop())
  }

  contextChanged(): void {
    if (this.active && this.operation) void this.operation("validate").catch(() => this.stop())
  }
  private onStorage = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area !== "local") return
    if (
      Settings.STORAGE_KEY in changes ||
      (record(changes.piBrowserAgentAuthChangeV1?.newValue) &&
        changes.piBrowserAgentAuthChangeV1.newValue.providerId === this.snapshot?.provider)
    )
      void this.stop()
    if (CREDENTIALS_KEY in changes && this.snapshot) {
      const change = changes[CREDENTIALS_KEY]
      const previousMap = record(change?.oldValue) ? change.oldValue : {}
      const nextMap = record(change?.newValue) ? change.newValue : {}
      const previousValue = previousMap[this.snapshot.provider]
      const nextValue = nextMap[this.snapshot.provider]
      const previous = record(previousValue) ? previousValue : undefined
      const next = record(nextValue) ? nextValue : undefined
      // A pre-dispatch serialized OAuth refresh is expected. Removal or explicit account/key replacement is not.
      if (
        !next ||
        previous?.type !== next.type ||
        (next.type === "api_key" && JSON.stringify(previous) !== JSON.stringify(next)) ||
        (next.type === "oauth" && previous?.accountId !== next.accountId)
      )
        void this.stop()
    }
  }
  private onMessage = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    reply: (response: unknown) => void,
  ): boolean | undefined => {
    if (
      record(message) &&
      message.kind === "translation-owner-stopped" &&
      message.owner === this.owner &&
      sender.id === chrome.runtime.id &&
      !sender.tab
    ) {
      void this.stop()
      return false
    }
    if (record(message) && message.kind === "translation-intent") {
      if (message.windowId === this.windowId) void this.takeIntent().catch(this.ui.error)
      return false
    }
    if (
      !isTranslationContentMessage(message) ||
      !this.controller ||
      !this.context ||
      !this.owner ||
      sender.id !== chrome.runtime.id ||
      sender.tab?.id !== this.context.tabId ||
      !sender.documentId
    )
      return false
    const controller = this.controller
    const owner = this.owner
    void (async () => {
      await this.operation?.("validate", {
        frameId: sender.frameId ?? 0,
        documentId: sender.documentId,
      })
      if (this.owner !== owner || this.abort?.signal.aborted)
        throw new Error("Translation was cancelled")
      if (message.type === "dismiss-selection-translation") {
        if (
          this.intent?.action !== "pi-translate-selection" ||
          message.payload?.requestId !== this.selectionRequestId
        )
          return { ok: false }
        await this.stop()
        return { ok: true }
      }
      if (
        message.type === "retry-selection-translation" &&
        (this.intent?.action !== "pi-translate-selection" ||
          message.payload?.sourceText !== this.intent.selectionText.trim())
      )
        return { ok: false }
      if (
        message.type === "start-youtube-subtitle-translation" &&
        this.intent?.action === "pi-translate-selection"
      )
        return { ok: false }
      return controller.handleRuntimeMessage(message, sender)
    })()
      .then(reply)
      .catch(() =>
        reply({ ok: false, error: "Translation stopped. Start again from the page context menu." }),
      )
    return true
  }

  private async takeIntent(): Promise<void> {
    if (this.disposed) return
    const intent = (await worker("take", "", {
      windowId: this.windowId,
    })) as TranslationIntent | null
    if (!intent) return
    await this.stop()
    if (this.ui.busy()) throw new Error("Finish the current operation before translating")
    const sequence = ++this.sequence
    const settings = await Settings.getSettings()
    await this.provider.assertConfigured(settings)
    const scopedProvider = await this.provider.scoped(settings)
    const endpoints = await scopedProvider.getModelEndpointPatterns(settings)
    if (sequence !== this.sequence || this.disposed) return
    this.intent = intent
    this.scopedProvider = scopedProvider
    this.snapshot = settings
    this.requiredOrigins = [
      intent.tab.url,
      ...(intent.frameId ? [intent.frameUrl] : []),
      ...endpoints,
      ...(intent.action === "pi-translate-selection"
        ? []
        : EmbeddedFrames.getEmbeddedFramePatterns(intent.tab.url, SiteProfiles)),
    ]
    if ((await Promise.all(this.requiredOrigins.map(hasApprovedHostPermission))).every(Boolean)) {
      await this.begin(intent, settings)
    } else {
      this.approve.hidden = false
      this.ui.status("Start translation and allow the selected page and provider access")
    }
  }

  private async beginOwned(
    intent: TranslationIntent,
    settings: Awaited<ReturnType<typeof Settings.getSettings>>,
  ): Promise<void> {
    if (this.disposed || this.intent !== intent || this.ui.busy())
      throw new Error("Translation startup was superseded")
    const scopedProvider = this.scopedProvider
    if (!scopedProvider) throw new Error("Translation configuration expired")
    const abort = new AbortController()
    this.abort = abort
    this.stopButton.hidden = false
    this.ui.changed()
    const context = await currentContext()
    abort.signal.throwIfAborted()
    if (context.tabId !== intent.tab.id || context.url !== intent.tab.url)
      throw new Error("The translation page changed")
    const claimed = await worker("claim", "", {
      intentId: intent.id,
      context,
      frameId: intent.frameId,
      frameUrl: intent.frameUrl,
    })
    if (!record(claimed) || typeof claimed.owner !== "string" || typeof claimed.boot !== "string")
      throw new Error("Translation ownership failed")
    const owner = claimed.owner
    const busy = this.ui.busy()
    if (this.disposed || this.intent !== intent || abort.signal.aborted || busy) {
      await worker("release", owner)
      if (busy && !abort.signal.aborted)
        throw new Error("Finish the current operation before translating")
      return
    }
    this.owner = owner
    this.context = context
    this.approve.hidden = true
    this.stopButton.hidden = false
    let boot = claimed.boot
    let reconnecting: Promise<void> | undefined
    const operation = async (kind: TranslationOperation, payload: Record<string, unknown> = {}) => {
      abort.signal.throwIfAborted()
      const attemptedBoot = boot
      if (
        kind === "message" &&
        record(payload.message) &&
        ["start-page-translation-session", "render-selection-placeholder", "show-toast"].includes(
          String(payload.message.type),
        )
      )
        payload = {
          ...payload,
          message: {
            ...payload.message,
            payload: {
              ...(record(payload.message.payload) ? payload.message.payload : {}),
              uiStrings: translationUiStrings(),
            },
          },
        }
      if (
        kind === "message" &&
        record(payload.message) &&
        payload.message.type === "render-selection-placeholder" &&
        record(payload.message.payload) &&
        typeof payload.message.payload.requestId === "string"
      )
        this.selectionRequestId = payload.message.payload.requestId
      try {
        const result = await worker(kind, owner, payload)
        abort.signal.throwIfAborted()
        return result
      } catch (cause) {
        abort.signal.throwIfAborted()
        const currentBoot = await worker("boot")
        if (currentBoot === attemptedBoot) throw cause
        if (currentBoot !== boot)
          reconnecting ??= (async () => {
            const context = await currentContext()
            const restored = (await worker("resume", owner, { context })) as { boot: string }
            abort.signal.throwIfAborted()
            boot = restored.boot
            this.context = context
          })().finally(() => {
            reconnecting = undefined
          })
        await reconnecting
        abort.signal.throwIfAborted()
        if (kind !== "validate")
          throw new Error("Translation routing reconnected. Retry the action explicitly.")
        return worker(kind, owner, payload)
      }
    }
    this.operation = operation
    const facade = {
      translation: {
        anchor: ({ frameId, text }: Record<string, unknown>) =>
          operation("anchor", { frameId, text }),
        youtubeProbe: () => operation("youtubeProbe"),
        youtubeCapture: ({ url }: Record<string, unknown>) => operation("youtubeCapture", { url }),
        frames: () => operation("frames"),
      },
      runtime: {
        id: chrome.runtime.id,
        getManifest: () => ({
          content_scripts: [
            { matches: ["https://www.youtube.com/*"], js: ["scripts/translation.js"] },
          ],
        }),
        openOptionsPage: () =>
          chrome.tabs.create({
            url: `${chrome.runtime.getURL(chrome.runtime.getManifest().side_panel?.default_path ?? "sidebar/index.html")}?view=settings`,
          }),
      },
      tabs: {
        get: async () => {
          await operation("validate")
          return intent.tab
        },
        sendMessage: (_tabId: number, message: unknown, target?: { frameId?: number }) =>
          operation("message", { message, frameId: target?.frameId ?? 0 }),
      },
      scripting: {
        executeScript: (target: { target: { frameIds?: number[] } }) =>
          operation("inject", { frameId: target.target.frameIds?.[0] ?? 0 }),
      },
      permissions: {
        contains: async () =>
          (await Promise.all(this.requiredOrigins.map(hasApprovedHostPermission))).every(Boolean),
        request: async () => false,
      },
      action: {
        setBadgeText: ({ text }: { text: string }) => operation("badge", { text }),
        setBadgeBackgroundColor: async () => undefined,
      },
    }
    const provider = {
      assertConfigured: () => scopedProvider.assertConfigured(settings),
      getModelEndpointPatterns: () => scopedProvider.getModelEndpointPatterns(settings),
      getModelCacheIdentity: () => scopedProvider.getModelCacheIdentity(settings),
      complete: async (
        snapshot: typeof settings,
        input: { systemPrompt: string; userPrompt: string },
        options: { signal?: AbortSignal },
      ) => {
        await operation("validate")
        const result = await scopedProvider.complete(snapshot, input, {
          signal: options.signal ? AbortSignal.any([abort.signal, options.signal]) : abort.signal,
          validate: () => operation("validate"),
        })
        await operation("validate")
        return result
      },
    }
    const Api = createTranslationApi(provider)
    const platform = createBackgroundPlatform({
      chrome: facade,
      Appearance,
      EmbeddedFrames,
      Messages,
      ProviderRuntime: provider,
      Settings: { ...Settings, getSettings: async () => settings },
      SiteProfiles,
    })
    platform.setupContextMenus = async () => undefined
    const controller = createBackgroundController({
      chrome: facade,
      Api,
      Messages,
      ProviderRuntime: provider,
      Settings,
      SiteProfiles,
      TranslationSession,
      platform,
      fetch: async (input: string | URL, init?: RequestInit) => {
        const url = new URL(input)
        if (
          url.protocol !== "https:" ||
          url.port ||
          url.username ||
          url.password ||
          url.pathname !== "/api/timedtext" ||
          !["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname) ||
          !(await hasApprovedHostPermission(url))
        )
          throw new Error("Caption endpoint is not approved")
        await operation("validate")
        return boundedResponse(
          await fetch(url, {
            ...init,
            credentials: "omit",
            redirect: "error",
            signal: init?.signal ? AbortSignal.any([abort.signal, init.signal]) : abort.signal,
          }),
          2_097_152,
        )
      },
    })
    this.controller = controller
    this.ui.changed()
    this.ui.status("Translating…")
    try {
      if (intent.action === "pi-translate-selection")
        await controller.translateSelection(intent.tab.id, intent.selectionText, intent.frameId)
      else if (
        intent.action === "pi-translate-youtube" ||
        SiteProfiles.resolveSiteProfile(new URL(intent.tab.url).hostname).id === "youtube"
      ) {
        await operation("inject")
        await controller.handleRuntimeMessage(
          Messages.startYoutubeSubtitleTranslation({
            videoKey: new URL(intent.tab.url).searchParams.get("v") ?? "",
          }),
          { id: chrome.runtime.id, tab: intent.tab, frameId: 0, url: intent.tab.url },
        )
      } else
        await controller.translatePage(intent.tab, {
          interactive: false,
          signal: abort.signal,
          validate: () => operation("validate"),
        })
      this.ui.status("Translation is active")
    } catch (error) {
      const cancelled = abort.signal.aborted
      this.starting = undefined
      await this.stop()
      if (!cancelled) throw error
    }
  }

  private async begin(
    intent: TranslationIntent,
    settings: Awaited<ReturnType<typeof Settings.getSettings>>,
  ): Promise<void> {
    const run = this.beginOwned(intent, settings)
    this.starting = run
    try {
      await run
    } catch (error) {
      const cancelled =
        this.abort?.signal.aborted || (error instanceof DOMException && error.name === "AbortError")
      if (this.starting === run) {
        this.starting = undefined
        await this.stop()
      }
      if (!cancelled) throw error
    } finally {
      if (this.starting === run) this.starting = undefined
    }
  }

  async stop(): Promise<void> {
    ++this.sequence
    const wasActive = this.active
    this.intent = undefined
    this.abort?.abort()
    const pending = this.starting
    if (pending) await pending.catch(() => undefined)
    if (this.context) this.controller?.removePageTranslationState(this.context.tabId)
    const owner = this.owner
    this.owner = ""
    this.selectionRequestId = ""
    this.abort = undefined
    this.controller = undefined
    this.operation = undefined
    this.intent = undefined
    this.snapshot = undefined
    this.scopedProvider = undefined
    this.approve.hidden = true
    this.stopButton.hidden = true
    if (!this.disposed) {
      if (wasActive) this.ui.status("Translation stopped")
      this.ui.changed()
    }
    if (owner) await worker("release", owner).catch(() => undefined)
  }

  dispose(): void {
    this.disposed = true
    void this.stop()
    chrome.runtime.onMessage.removeListener(this.onMessage)
    chrome.storage.onChanged.removeListener(this.onStorage)
    chrome.permissions.onRemoved.removeListener(this.onRevoked)
  }
}
