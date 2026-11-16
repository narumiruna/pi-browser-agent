import { assertTabContext } from "./content/tab-context.js"
import { ELEMENT_PICKER_PORT } from "./element-picker-shortcut.js"
import { hasApprovedHostPermission } from "./permissions.js"
import {
  boundedJson,
  parseTranslationRequest,
  record,
  TRANSLATION_MENU_IDS,
  type TranslationIntent,
  type TranslationRequest,
  translationContext,
} from "./runtime/translation.js"
import type { TabContext } from "./runtime/types.js"
import { getSelectionAnchor } from "./translation/background/selection-anchor.js"
import {
  captureNativeYoutubeCaptionRequestUrl,
  enableYoutubeCaptions,
} from "./translation/background/youtube-caption-runtime.js"

const CONTENT_FILE = "scripts/translation.js"
const READER_PATH = "pages/pdf.html"
const LAUNCH_PREFIX = "piBrowserAgentPdfLaunchV1:"
const OWNER_PREFIX = "piBrowserAgentTranslationOwnerV1:"
const ROUTE_TTL = 24 * 60 * 60 * 1000
const outgoing = new Set([
  "ping",
  "start-page-translation-session",
  "render-page-placeholders",
  "render-page-translation-updates",
  "render-youtube-diagnostic-event",
  "render-selection-error",
  "render-selection-placeholder",
  "render-selection-translation",
  "clear-pending-translations",
  "clear-page-placeholders",
  "show-toast",
])
type Frame = { url: string; documentId: string; owned?: boolean }
type Owner = {
  token: string
  context: TabContext
  frames: Map<number, Frame>
  windowId: number
  windowRevision: number
  client: string
  createdAt: number
  abort: AbortController
  pending: Set<Promise<unknown>>
  release?: Promise<void>
}

/** Routing capabilities only. Provider configuration and credentials never enter this worker. */
export function installTranslationWorker(options: {
  initialize: Promise<unknown>
  current: () => Promise<TabContext>
  validate: (context: TabContext) => Promise<void>
  invalidateReferences: () => void
}) {
  const boot = crypto.randomUUID()
  let lifecycleVersion = 0
  const intents = new Map<number, TranslationIntent>()
  const tickets = new Map<string, { intent: TranslationIntent; client: string; expires: number }>()
  const owners = new Map<string, Owner>()
  const releases = new Set<Promise<void>>()
  const windowRevisions = new Map<number, number>()
  const windowClaims = new Map<number, number>()

  function trusted(sender: chrome.runtime.MessageSender): boolean {
    const path = chrome.runtime.getManifest().side_panel?.default_path
    if (
      !path ||
      sender.id !== chrome.runtime.id ||
      !sender.documentId ||
      (sender.frameId !== undefined && sender.frameId !== 0)
    )
      return false
    try {
      const url = new URL(sender.url ?? "")
      const expected = new URL(chrome.runtime.getURL(path))
      return (
        url.protocol === expected.protocol &&
        url.host === expected.host &&
        url.pathname === expected.pathname &&
        !url.search &&
        !url.hash
      )
    } catch {
      return false
    }
  }
  function alive(owner: Owner): void {
    owner.abort.signal.throwIfAborted()
    if (
      owners.get(owner.token) !== owner ||
      owner.windowRevision !== (windowRevisions.get(owner.windowId) ?? 0)
    )
      throw new Error("Translation ownership expired")
  }
  async function frame(owner: Owner, frameId: number): Promise<Frame> {
    alive(owner)
    await options.validate(owner.context)
    alive(owner)
    const bound = owner.frames.get(frameId)
    if (!bound || !(await hasApprovedHostPermission(bound.url)))
      throw new Error("Translation frame approval is required")
    alive(owner)
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId: owner.context.tabId, frameIds: [frameId] },
      args: [owner.token],
      func: (token) => ({
        url: location.href,
        contentType: document.contentType,
        owned:
          (globalThis as typeof globalThis & { __piTranslationToken?: string })
            .__piTranslationToken === token,
      }),
    })
    alive(owner)
    if (
      !probe?.documentId ||
      probe.result?.url !== bound.url ||
      probe.result?.contentType === "application/pdf" ||
      (bound.documentId && bound.documentId !== probe.documentId)
    )
      throw new Error("Translation frame changed")
    bound.documentId = probe.documentId
    bound.owned = probe.result?.owned === true
    await options.validate(owner.context)
    alive(owner)
    return bound
  }
  async function persist(owner: Owner): Promise<void> {
    alive(owner)
    await chrome.storage.session.set({
      [`${OWNER_PREFIX}${owner.token}`]: {
        version: 1,
        boot,
        token: owner.token,
        context: owner.context,
        windowId: owner.windowId,
        client: owner.client,
        createdAt: owner.createdAt,
        frames: [...owner.frames],
      },
    })
    alive(owner)
  }
  function release(owner: Owner): Promise<void> {
    if (owner.release) return owner.release
    owners.delete(owner.token)
    owner.abort.abort()
    // Queue record removal before any await so a later worker cannot revive a cancelled owner.
    const removed = chrome.storage.session
      .remove(`${OWNER_PREFIX}${owner.token}`)
      .catch(() => undefined)
    void chrome.runtime
      .sendMessage({ kind: "translation-owner-stopped", owner: owner.token })
      .catch(() => undefined)
    const work = (async () => {
      await Promise.allSettled([...owner.pending, removed])
      for (const bound of owner.frames.values()) {
        if (!bound.documentId) continue
        await chrome.scripting
          .executeScript({
            target: { tabId: owner.context.tabId, documentIds: [bound.documentId] },
            args: [owner.token],
            func: (token) => {
              const runtime = globalThis as typeof globalThis & {
                __piTranslationToken?: string
                __piTranslationCleanup?: () => void
              }
              if (runtime.__piTranslationToken === token) {
                runtime.__piTranslationCleanup?.()
                delete runtime.__piTranslationToken
                delete runtime.__piTranslationCleanup
              }
            },
          })
          .catch(() => undefined)
      }
      if (![...owners.values()].some((active) => active.context.tabId === owner.context.tabId))
        await chrome.action
          .setBadgeText({ tabId: owner.context.tabId, text: "" })
          .catch(() => undefined)
    })()
    owner.release = work
    releases.add(work)
    void work.finally(() => releases.delete(work))
    return work
  }
  async function storedOwner(
    token: string,
    sender: chrome.runtime.MessageSender,
  ): Promise<{ owner: Owner; previousBoot: string }> {
    const raw = (await chrome.storage.session.get(`${OWNER_PREFIX}${token}`))[
      `${OWNER_PREFIX}${token}`
    ]
    if (
      !record(raw) ||
      raw.version !== 1 ||
      raw.token !== token ||
      raw.client !== sender.documentId ||
      typeof raw.boot !== "string" ||
      !Number.isFinite(raw.createdAt) ||
      Date.now() - Number(raw.createdAt) > ROUTE_TTL ||
      !Number.isSafeInteger(raw.windowId) ||
      !Array.isArray(raw.frames) ||
      raw.frames.length > 16 ||
      !boundedJson(raw)
    )
      throw new Error("Translation routing expired")
    const frames = new Map<number, Frame>()
    for (const entry of raw.frames) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        !Number.isSafeInteger(entry[0]) ||
        entry[0] < 0 ||
        !record(entry[1]) ||
        typeof entry[1].url !== "string" ||
        typeof entry[1].documentId !== "string" ||
        entry[1].documentId.length > 128
      )
        throw new Error("Invalid translation routing")
      const url = new URL(entry[1].url)
      if (!/^https?:$/.test(url.protocol) || url.username || url.password)
        throw new Error("Invalid translation frame")
      frames.set(entry[0], { url: url.href, documentId: entry[1].documentId })
    }
    if (!frames.get(0)?.documentId) throw new Error("Translation document expired")
    return {
      previousBoot: raw.boot,
      owner: {
        token,
        context: translationContext(raw.context),
        frames,
        windowId: Number(raw.windowId),
        windowRevision: windowRevisions.get(Number(raw.windowId)) ?? 0,
        client: String(raw.client),
        createdAt: Number(raw.createdAt),
        abort: new AbortController(),
        pending: new Set(),
      },
    }
  }
  function clientMatches(owner: Owner, sender: chrome.runtime.MessageSender): void {
    if (
      owner.client !== sender.documentId ||
      (sender.tab && sender.tab.windowId !== owner.windowId)
    )
      throw new Error("Invalid translation owner")
  }
  async function run(owner: Owner, request: TranslationRequest): Promise<unknown> {
    const payload = request.payload
    alive(owner)
    await options.validate(owner.context)
    alive(owner)
    if (request.operation === "validate") {
      if (payload.frameId !== undefined) {
        const bound = await frame(owner, Number(payload.frameId))
        if (payload.documentId !== bound.documentId)
          throw new Error("Translation sender document changed")
      }
      return owner.context
    }
    const frameId = Number(payload.frameId ?? 0)
    const bound = await frame(owner, frameId)
    let result: unknown = null
    switch (request.operation) {
      case "inject":
        await chrome.scripting.executeScript({
          target: { tabId: owner.context.tabId, documentIds: [bound.documentId] },
          args: [owner.token],
          func: (token) => {
            const runtime = globalThis as typeof globalThis & {
              __piTranslationToken?: string
              __piTranslationCleanup?: () => void
            }
            runtime.__piTranslationCleanup?.()
            runtime.__piTranslationToken = token
          },
        })
        alive(owner)
        await options.validate(owner.context)
        alive(owner)
        await chrome.scripting.executeScript({
          target: { tabId: owner.context.tabId, documentIds: [bound.documentId] },
          files: [CONTENT_FILE],
        })
        break
      case "message":
        if (record(payload.message) && payload.message.type === "ping" && !bound.owned)
          return { ok: false }
        if (!bound.owned) throw new Error("Translation runtime needs explicit reinjection")
        if (
          !record(payload.message) ||
          typeof payload.message.type !== "string" ||
          !outgoing.has(payload.message.type) ||
          !boundedJson(payload.message)
        )
          throw new Error("Invalid translation content operation")
        options.invalidateReferences()
        result = await chrome.tabs.sendMessage(owner.context.tabId, payload.message, {
          documentId: bound.documentId,
        })
        if (!boundedJson(result)) throw new Error("Translation result is too large")
        break
      case "anchor":
        if (typeof payload.text !== "string" || payload.text.length > 50000)
          throw new Error("Invalid translation selection")
        result = await getSelectionAnchor({
          chrome,
          tabId: owner.context.tabId,
          frameId,
          selectionText: payload.text,
          isTabMessageDisconnectError: () => false,
        })
        break
      case "youtubeProbe":
      case "youtubeCapture": {
        if (
          frameId !== 0 ||
          !["https://youtube.com", "https://www.youtube.com", "https://m.youtube.com"].includes(
            new URL(owner.context.url).origin,
          )
        )
          throw new Error("YouTube translation requires its active page")
        if (request.operation === "youtubeCapture") {
          if (typeof payload.url !== "string" || payload.url.length > 16384)
            throw new Error("Invalid caption endpoint")
          const url = new URL(payload.url)
          if (
            !["https://youtube.com", "https://www.youtube.com", "https://m.youtube.com"].includes(
              url.origin,
            ) ||
            url.username ||
            url.password ||
            url.pathname !== "/api/timedtext" ||
            !(await hasApprovedHostPermission(url))
          )
            throw new Error("Invalid caption endpoint")
          alive(owner)
        }
        result =
          request.operation === "youtubeProbe"
            ? await enableYoutubeCaptions(chrome, owner.context.tabId)
            : await captureNativeYoutubeCaptionRequestUrl(
                chrome,
                owner.context.tabId,
                String(payload.url),
              )
        break
      }
      case "frames": {
        if (
          !["antirez.com", "www.antirez.com"].includes(new URL(owner.context.url).hostname) ||
          !(await hasApprovedHostPermission("https://disqus.com"))
        )
          return []
        alive(owner)
        const entries = await chrome.scripting.executeScript({
          target: { tabId: owner.context.tabId, allFrames: true },
          func: () => (location.origin === "https://disqus.com" ? location.href : null),
        })
        alive(owner)
        const accepted: { frameId: number; url: string }[] = []
        for (const entry of entries.slice(0, 64)) {
          if (owner.frames.size >= 16 || !entry.result || !entry.documentId || !entry.frameId)
            continue
          const url = new URL(entry.result)
          const existing = owner.frames.get(entry.frameId)
          if (
            url.origin !== "https://disqus.com" ||
            url.username ||
            url.password ||
            (existing?.documentId && existing.documentId !== entry.documentId)
          )
            continue
          owner.frames.set(entry.frameId, { url: url.href, documentId: entry.documentId })
          accepted.push({ frameId: entry.frameId, url: url.href })
        }
        await persist(owner)
        result = accepted
        break
      }
      case "badge":
        if (typeof payload.text !== "string" || !/^(?:\d{1,7}|TR|!|)$/u.test(payload.text))
          throw new Error("Invalid translation badge")
        await chrome.action.setBadgeText({ tabId: owner.context.tabId, text: payload.text })
        break
      default:
        throw new Error("Invalid translation operation")
    }
    alive(owner)
    await options.validate(owner.context)
    alive(owner)
    if (!boundedJson(result)) throw new Error("Translation result is too large")
    return result
  }
  async function handle(message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
    const request = parseTranslationRequest(message)
    if (!trusted(sender)) throw new Error("Translation requires the conversation page")
    await options.initialize
    const payload = request.payload
    if (request.operation === "boot") return boot
    if (request.operation === "take") {
      if (
        !Number.isSafeInteger(payload.windowId) ||
        (sender.tab && sender.tab.windowId !== payload.windowId)
      )
        throw new Error("Invalid translation window")
      const intent = intents.get(Number(payload.windowId))
      intents.delete(Number(payload.windowId))
      for (const [id, ticket] of tickets) if (Date.now() > ticket.expires) tickets.delete(id)
      if (!intent || Date.now() >= intent.expiresAt) return null
      tickets.set(intent.id, {
        intent,
        client: sender.documentId as string,
        expires: Date.now() + 300000,
      })
      return intent
    }
    if (request.operation === "claim") {
      if (typeof payload.intentId !== "string")
        throw new Error("A native translation intent is required")
      const ticket = tickets.get(payload.intentId)
      tickets.delete(payload.intentId)
      if (!ticket || ticket.client !== sender.documentId || Date.now() > ticket.expires)
        throw new Error("Translation intent expired")
      const generation = lifecycleVersion
      const context = translationContext(payload.context)
      const intent = ticket.intent
      const windowId = intent.tab.windowId
      const windowRevision = (windowRevisions.get(windowId) ?? 0) + 1
      windowRevisions.set(windowId, windowRevision)
      windowClaims.set(windowId, intent.tab.id)
      const assertClaim = () => {
        if (generation !== lifecycleVersion || windowRevisions.get(windowId) !== windowRevision)
          throw new Error("Translation startup was superseded")
      }
      try {
        const frameId = Number(payload.frameId ?? 0)
        const frameUrl = frameId ? String(payload.frameUrl ?? "") : context.url
        if (
          context.tabId !== intent.tab.id ||
          context.url !== intent.tab.url ||
          frameId !== intent.frameId ||
          frameUrl !== intent.frameUrl
        )
          throw new Error("Translation intent target changed")
        assertTabContext(context, await options.current())
        await options.validate(context)
        const tab = await chrome.tabs.get(context.tabId)
        if (
          tab.windowId !== intent.tab.windowId ||
          (sender.tab && sender.tab.windowId !== tab.windowId)
        )
          throw new Error("Invalid translation window")
        const url = new URL(frameUrl)
        if (
          !/^https?:$/.test(url.protocol) ||
          url.username ||
          url.password ||
          !(await hasApprovedHostPermission(url))
        )
          throw new Error("Translation frame approval is required")
        assertClaim()
        for (const previous of [...owners.values()]) {
          assertClaim()
          if (previous.windowId === tab.windowId) await release(previous)
        }
        assertClaim()
        await withdrawWindow(windowId, assertClaim)
        await Promise.allSettled([...releases])
        if (generation !== lifecycleVersion || windowRevisions.get(windowId) !== windowRevision)
          throw new Error("Translation startup was superseded")
        const owner: Owner = {
          token: crypto.randomUUID(),
          context,
          windowId: tab.windowId,
          windowRevision,
          client: sender.documentId as string,
          createdAt: Date.now(),
          frames: new Map([
            [0, { url: context.url, documentId: "" }],
            [frameId, { url: frameUrl, documentId: "" }],
          ]),
          abort: new AbortController(),
          pending: new Set(),
        }
        owners.set(owner.token, owner)
        try {
          await frame(owner, 0)
          if (frameId) await frame(owner, frameId)
          await persist(owner)
          return { owner: owner.token, context, boot }
        } catch (error) {
          await release(owner)
          throw error
        }
      } finally {
        if (windowRevisions.get(windowId) === windowRevision) windowClaims.delete(windowId)
      }
    }
    if (request.operation === "resume") {
      const revisions = new Map(windowRevisions)
      const generation = lifecycleVersion
      const existing = owners.get(request.owner)
      if (existing) {
        clientMatches(existing, sender)
        if (windowClaims.has(existing.windowId)) throw new Error("Translation startup was replaced")
        await frame(existing, 0)
        return { context: existing.context, boot }
      }
      const { owner, previousBoot } = await storedOwner(request.owner, sender)
      if (
        windowClaims.has(owner.windowId) ||
        (revisions.get(owner.windowId) ?? 0) !== (windowRevisions.get(owner.windowId) ?? 0)
      )
        throw new Error("Translation startup was replaced")
      if (
        previousBoot === boot ||
        [...owners.values()].some((active) => active.windowId === owner.windowId)
      )
        throw new Error("Translation owner was replaced")
      const context = translationContext(payload.context)
      if (context.tabId !== owner.context.tabId || context.url !== owner.context.url)
        throw new Error("Translation document changed")
      assertTabContext(context, await options.current())
      const tab = await chrome.tabs.get(context.tabId)
      clientMatches(owner, sender)
      if (tab.windowId !== owner.windowId) throw new Error("Translation window changed")
      if (generation !== lifecycleVersion) throw new Error("Translation routing changed")
      owner.context = context
      owners.set(owner.token, owner)
      try {
        for (const frameId of owner.frames.keys()) await frame(owner, frameId)
        await persist(owner)
        return { context, boot }
      } catch (error) {
        await release(owner)
        throw error
      }
    }
    const owner =
      owners.get(request.owner) ??
      (request.operation === "release"
        ? (await storedOwner(request.owner, sender)).owner
        : undefined)
    if (!owner) throw new Error("Translation ownership expired")
    clientMatches(owner, sender)
    if (request.operation === "release") {
      await release(owner)
      return null
    }
    const operation = run(owner, request)
    owner.pending.add(operation)
    try {
      return await operation
    } finally {
      owner.pending.delete(operation)
    }
  }

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (
      !TRANSLATION_MENU_IDS.includes(info.menuItemId as (typeof TRANSLATION_MENU_IDS)[number]) ||
      tab?.id === undefined ||
      !tab.url
    )
      return
    if (info.menuItemId === "pi-translate-pdf" || /\.pdf(?:[?#]|$)/iu.test(tab.url)) {
      void (async () => {
        const source = new URL(tab.url ?? "")
        if (
          !["http:", "https:", "file:"].includes(source.protocol) ||
          source.username ||
          source.password
        )
          return
        const token = `launch-${crypto.randomUUID()}`
        const key = `${LAUNCH_PREFIX}${token}`
        const value = {
          token,
          createdAt: Date.now(),
          sourceTabId: tab.id,
          sourceUrl: source.protocol === "file:" ? "" : source.href,
          localOnly: source.protocol === "file:",
          title: "PDF document",
          readerTabId: 0,
        }
        await chrome.storage.session.set({ [key]: value })
        try {
          const reader = await chrome.tabs.create({
            url: `${chrome.runtime.getURL(READER_PATH)}#${token}`,
          })
          // Preserve a claim written by a fast reader startup.
          const current = (await chrome.storage.session.get(key))[key]
          await chrome.storage.session.set({
            [key]: { ...value, ...(record(current) ? current : {}), readerTabId: reader.id },
          })
        } catch (error) {
          await chrome.storage.session.remove(key)
          throw error
        }
      })().catch(() => undefined)
      return
    }
    void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined)
    const selection = info.menuItemId === "pi-translate-selection"
    const intent: TranslationIntent = {
      id: crypto.randomUUID(),
      action: info.menuItemId as TranslationIntent["action"],
      tab: { id: tab.id, url: tab.url, windowId: tab.windowId },
      selectionText: (info.selectionText ?? "").slice(0, 50000),
      frameId: selection ? (info.frameId ?? 0) : 0,
      frameUrl: selection ? (info.frameUrl ?? tab.url) : tab.url,
      expiresAt: Date.now() + 10000,
    }
    intents.set(tab.windowId, intent)
    void chrome.runtime
      .sendMessage({ kind: "translation-intent", windowId: tab.windowId })
      .catch(() => undefined)
  })
  function cancel(): void {
    lifecycleVersion += 1
    intents.clear()
    tickets.clear()
    for (const owner of [...owners.values()]) void release(owner)
  }
  async function withdrawWindow(windowId: number, assertClaim: () => void): Promise<void> {
    const records = await chrome.storage.session.get(null)
    assertClaim()
    for (const [key, value] of Object.entries(records)) {
      if (
        !key.startsWith(OWNER_PREFIX) ||
        !record(value) ||
        value.windowId !== windowId ||
        typeof value.client !== "string"
      )
        continue
      try {
        const { owner } = await storedOwner(key.slice(OWNER_PREFIX.length), {
          documentId: value.client,
        })
        assertClaim()
        await release(owners.get(owner.token) ?? owner)
      } catch {
        assertClaim()
        await chrome.storage.session.remove(key)
      }
      assertClaim()
    }
  }
  async function withdrawStored(client?: string): Promise<void> {
    const records = await chrome.storage.session.get(null)
    for (const [key, value] of Object.entries(records)) {
      if (
        !key.startsWith(OWNER_PREFIX) ||
        !record(value) ||
        typeof value.client !== "string" ||
        (client && value.client !== client)
      )
        continue
      try {
        const { owner } = await storedOwner(key.slice(OWNER_PREFIX.length), {
          documentId: value.client,
        })
        await release(owners.get(owner.token) ?? owner)
      } catch {
        await chrome.storage.session.remove(key)
      }
    }
  }
  async function stopForCapture(): Promise<void> {
    cancel()
    await withdrawStored()
    await Promise.allSettled([...releases])
  }
  // Reuse the conversation document lifetime channel. An idle Port does not keep MV3 alive.
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== ELEMENT_PICKER_PORT || !port.sender || !trusted(port.sender)) return
    const client = port.sender.documentId as string
    port.onDisconnect.addListener(() => {
      for (const owner of [...owners.values()]) if (owner.client === client) void release(owner)
      for (const [id, ticket] of tickets) if (ticket.client === client) tickets.delete(id)
      void withdrawStored(client).catch(() => undefined)
    })
  })
  chrome.tabs.onActivated.addListener(cancel)
  chrome.tabs.onUpdated.addListener((id, change) => {
    if (
      (change.url || change.status === "loading") &&
      ([...owners.values()].some((owner) => owner.context.tabId === id) ||
        [...intents.values()].some((intent) => intent.tab.id === id) ||
        [...tickets.values()].some((ticket) => ticket.intent.tab.id === id) ||
        [...windowClaims.values()].includes(id))
    )
      cancel()
  })
  chrome.windows.onFocusChanged.addListener(cancel)
  chrome.permissions.onRemoved.addListener(() => {
    for (const owner of [...owners.values()])
      void options.validate(owner.context).catch(() => release(owner))
  })
  chrome.tabs.onRemoved.addListener((id) => {
    for (const owner of owners.values()) if (owner.context.tabId === id) void release(owner)
    void chrome.storage.session
      .get(null)
      .then((records) => {
        const expired = Object.entries(records)
          .filter(
            ([key, value]) =>
              record(value) &&
              ((key.startsWith(LAUNCH_PREFIX) &&
                (value.readerTabId === id || Date.now() - Number(value.createdAt) > ROUTE_TTL)) ||
                (key.startsWith(OWNER_PREFIX) && Date.now() - Number(value.createdAt) > ROUTE_TTL)),
          )
          .map(([key]) => key)
        if (expired.length) return chrome.storage.session.remove(expired)
      })
      .catch(() => undefined)
  })
  return { handle, stopForCapture }
}
