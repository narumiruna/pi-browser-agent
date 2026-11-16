const BADGE_COLOR = "#1f7a4f"
const CONTENT_SCRIPT_READY_ATTEMPTS = 100
const CONTENT_SCRIPT_READY_INTERVAL_MS = 100
const MENU_OPEN_PDF = "open-pdf-reader"
const MENU_TRANSLATE_PAGE = "translate-page"
const MENU_TRANSLATE_SELECTION = "translate-selection"

export function createBackgroundPlatform(options = {}) {
  const {
    chrome,
    Appearance,
    EmbeddedFrames,
    Messages,
    ProviderRuntime,
    Settings,
    SiteProfiles,
    sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  } = options
  let contextMenusSetupPromise = null
  function isSupportedPage(url) {
    return /^https?:\/\//i.test(String(url || ""))
  }

  async function loadSettingsOrOpenOptions({ interactive = true } = {}) {
    const settings = await Settings.getSettings()

    if (Settings.hasCompleteSettings(settings)) {
      try {
        await ProviderRuntime?.assertConfigured(settings)
        return settings
      } catch (_error) {
        // Open Settings below when the selected provider is not ready.
      }
    }

    if (interactive) await chrome.runtime.openOptionsPage()
    throw new Error("Settings are incomplete. Configure the extension first.")
  }

  function isDomainDisabled(url, settings) {
    try {
      const hostname = new URL(url).hostname.toLowerCase()
      const rules = String(settings.disabledDomains || "")
        .split("\n")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)

      return rules.some((rule) => hostname === rule || hostname.endsWith(`.${rule}`))
    } catch (_error) {
      return false
    }
  }

  function setBadge(tabId, text) {
    if (!tabId) {
      return
    }

    chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR, tabId }).catch(() => {})
    chrome.action.setBadgeText({ text, tabId }).catch(() => {})
  }

  function getContentScriptFiles() {
    const contentScripts = chrome.runtime.getManifest().content_scripts || []
    const entry = contentScripts.find((item) =>
      (item.matches || []).some((match) => match.includes("youtube.com")),
    )
    const files = entry?.js?.filter((file) => typeof file === "string" && file)

    if (!files?.length) {
      throw new Error("The generated content-script bundle is missing.")
    }

    return files
  }

  function isTabMessageDisconnectError(error) {
    const message = String(error?.message || "")

    return (
      message.includes("Could not establish connection") ||
      message.includes("Receiving end does not exist") ||
      message.includes("No tab with id")
    )
  }

  function getFrameMessageOptions(frameId) {
    return Number.isInteger(frameId) && frameId >= 0 ? { frameId } : undefined
  }

  function getScriptTarget(tabId, frameId) {
    const target = { tabId }

    if (Number.isInteger(frameId) && frameId >= 0) {
      target.frameIds = [frameId]
    }

    return target
  }

  function buildTranslationAppearancePayload(settings) {
    return {
      translationAppearance: Appearance.normalizeTranslationAppearance(
        settings?.translationAppearance,
      ),
    }
  }

  function buildSelectionPanelPayload(settings, selectionAnchor) {
    return {
      selectionPanelPositionMode: Settings.normalizeSelectionPanelPositionMode(
        settings?.selectionPanelPositionMode,
      ),
      selectionAnchor: selectionAnchor || null,
    }
  }

  function buildYoutubeSubtitlePayload(settings) {
    return {
      youtubeSubtitleDisplayMode: Settings.normalizeYoutubeSubtitleDisplayMode(
        settings?.youtubeSubtitleDisplayMode,
      ),
    }
  }

  function buildDebugPayload(settings) {
    return {
      debug: {
        enabled: Boolean(settings?.showTranslationDebugInfo),
      },
    }
  }

  async function pingContentScript(tabId, frameId) {
    return chrome.tabs.sendMessage(tabId, Messages.ping(), getFrameMessageOptions(frameId))
  }

  async function ensureContentScript(tabId, frameId) {
    try {
      const response = await pingContentScript(tabId, frameId)

      if (response?.ok) {
        return
      }
    } catch (_error) {
      // Fall through and inject the generated bundle.
    }

    await chrome.scripting.executeScript({
      target: getScriptTarget(tabId, frameId),
      files: getContentScriptFiles(),
    })

    let lastError = null

    for (let attempt = 0; attempt < CONTENT_SCRIPT_READY_ATTEMPTS; attempt += 1) {
      try {
        const response = await pingContentScript(tabId, frameId)

        if (response?.ok) {
          return
        }
      } catch (error) {
        lastError = error
      }

      if (attempt < CONTENT_SCRIPT_READY_ATTEMPTS - 1) {
        await sleep(CONTENT_SCRIPT_READY_INTERVAL_MS)
      }
    }

    throw lastError || new Error("The content script did not become ready.")
  }

  async function sendToast(tabId, message, level) {
    try {
      await ensureContentScript(tabId)
      await chrome.tabs.sendMessage(tabId, Messages.showToast({ level: level || "info", message }))
    } catch (_error) {
      // Unsupported and torn-down tabs cannot display extension UI.
    }
  }

  async function renderPageTranslationUpdates(
    tabId,
    targetLanguage,
    translations,
    settings,
    frameId,
    sessionId,
  ) {
    if (!translations?.length) return
    return chrome.tabs.sendMessage(
      tabId,
      Messages.renderPageTranslationUpdates({
        ...(sessionId ? { sessionId } : {}),
        targetLanguage,
        translations,
        ...buildTranslationAppearancePayload(settings),
        ...buildYoutubeSubtitlePayload(settings),
      }),
      getFrameMessageOptions(frameId),
    )
  }

  async function sendYoutubeDiagnosticEvent(tabId, frameId, stage, detail, sessionId) {
    await chrome.tabs
      .sendMessage(
        tabId,
        Messages.renderYoutubeDiagnosticEvent({
          stage,
          detail,
          ...(sessionId ? { sessionId } : {}),
        }),
        getFrameMessageOptions(frameId),
      )
      .catch(() => {})
  }

  async function clearPagePlaceholders(tabId, ids, frameId, failure, sessionId) {
    if (!ids?.length) return
    await chrome.tabs
      .sendMessage(
        tabId,
        Messages.clearPagePlaceholders({
          ids,
          ...failure,
          ...(sessionId ? { sessionId } : {}),
        }),
        getFrameMessageOptions(frameId),
      )
      .catch(() => {})
  }

  function discoverEmbeddedPageFrames(tabId, pageUrl) {
    return EmbeddedFrames.discoverEmbeddedFrames({
      pageUrl,
      permissions: chrome.permissions,
      scripting: chrome.scripting,
      siteProfiles: SiteProfiles,
      tabId,
      translation: chrome.translation,
    })
  }

  async function getModelCacheIdentity(settings) {
    return ProviderRuntime ? ProviderRuntime.getModelCacheIdentity(settings) : ""
  }

  async function ensureApiPermission(settings, { interactive = true } = {}) {
    const origins = ProviderRuntime
      ? await ProviderRuntime.getModelEndpointPatterns(settings)
      : [Settings.getApiPermissionPattern(settings.customBaseUrl || settings.baseUrl)]
    const permissions = { origins }
    return (
      (await chrome.permissions.contains(permissions)) ||
      (interactive && chrome.permissions.request(permissions))
    )
  }

  function getRuntimeLastError() {
    const error = chrome.runtime.lastError

    if (!error) {
      return null
    }

    return new Error(error.message || String(error))
  }

  function removeAllContextMenus() {
    return new Promise((resolve, reject) => {
      chrome.contextMenus.removeAll(() => {
        const error = getRuntimeLastError()

        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    })
  }

  function createContextMenu(properties) {
    return new Promise((resolve, reject) => {
      chrome.contextMenus.create(properties, () => {
        const error = getRuntimeLastError()

        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    })
  }

  function updateContextMenu(properties) {
    const { id, ...updateProperties } = properties

    return new Promise((resolve, reject) => {
      chrome.contextMenus.update(id, updateProperties, () => {
        const error = getRuntimeLastError()

        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    })
  }

  async function createOrUpdateContextMenu(properties) {
    try {
      await createContextMenu(properties)
    } catch (error) {
      if (!String(error.message || "").includes("duplicate id")) {
        throw error
      }

      await updateContextMenu(properties)
    }
  }

  async function doSetupContextMenus() {
    await removeAllContextMenus()
    await createOrUpdateContextMenu({
      id: MENU_TRANSLATE_PAGE,
      title: "Translate entire page",
      contexts: ["page"],
    })
    await createOrUpdateContextMenu({
      id: MENU_TRANSLATE_SELECTION,
      title: "Translate selected text",
      contexts: ["selection"],
    })
    await createOrUpdateContextMenu({
      id: MENU_OPEN_PDF,
      title: "Open current page in Pi PDF Reader",
      contexts: ["page"],
    })
  }

  function setupContextMenus() {
    if (!contextMenusSetupPromise) {
      contextMenusSetupPromise = doSetupContextMenus().finally(() => {
        contextMenusSetupPromise = null
      })
    }

    return contextMenusSetupPromise
  }

  return {
    buildDebugPayload,
    buildSelectionPanelPayload,
    buildTranslationAppearancePayload,
    buildYoutubeSubtitlePayload,
    clearPagePlaceholders,
    discoverEmbeddedPageFrames,
    ensureApiPermission,
    ensureContentScript,
    getContentScriptFiles,
    getFrameMessageOptions,
    getModelCacheIdentity,
    isDomainDisabled,
    isSupportedPage,
    isTabMessageDisconnectError,
    loadSettingsOrOpenOptions,
    renderPageTranslationUpdates,
    sendToast,
    sendYoutubeDiagnosticEvent,
    setBadge,
    setupContextMenus,
  }
}
