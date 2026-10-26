import { safeErrorMessage } from "../auth/redaction.js"
import { observeDocumentLanguage } from "../i18n/dom.js"
import { t, translateDiagnostic } from "../i18n/index.js"
import { element } from "./ui.js"
import { getMicrophonePermissionState, requestMicrophoneAccess } from "./voice-input.js"

function microphoneAccessErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return t(
      "Chrome blocked microphone access. Open Chrome microphone settings, remove Pi Browser Agent from Not allowed, then return here and try again.",
    )
  }
  if (error instanceof DOMException && error.name === "NotFoundError") {
    return t("Chrome could not find a microphone. Connect or enable one, then try again.")
  }
  return t("Microphone access failed: {error}", {
    error: translateDiagnostic(safeErrorMessage(error)),
  })
}

export async function initializeMicrophonePage(): Promise<void> {
  const page = element<HTMLElement>("microphone-access-page")
  const status = element<HTMLElement>("microphone-access-status")
  const allowButton = element<HTMLButtonElement>("allow-microphone")
  const openSettingsButton = element<HTMLButtonElement>("open-microphone-settings")
  let permission: PermissionState = "prompt"
  let requestPending = false
  let failure: { error: unknown } | undefined

  const render = (): void => {
    document.title = t("Microphone access · Pi Browser Agent")
    allowButton.disabled = requestPending
    allowButton.hidden = requestPending
      ? false
      : failure
        ? permission === "denied"
        : permission !== "prompt"
    openSettingsButton.hidden = requestPending || (!failure && permission !== "denied")
    status.textContent = requestPending
      ? t("Waiting for Chrome's microphone prompt…")
      : failure
        ? microphoneAccessErrorMessage(failure.error)
        : permission === "granted"
          ? t(
              "Microphone access is allowed. Close this tab and select the microphone in Pi Browser Agent.",
            )
          : permission === "denied"
            ? t("Microphone access is blocked. Open Chrome microphone settings to allow it.")
            : t("Select Allow microphone access, then approve Chrome's prompt.")
  }
  const languageWatcher = observeDocumentLanguage({ isBusy: () => requestPending, refresh: render })

  const refresh = async (): Promise<void> => {
    if (requestPending) return
    const state = await getMicrophonePermissionState().catch(() => "prompt" as const)
    if (requestPending) return
    permission = state
    failure = undefined
    render()
  }

  allowButton.addEventListener("click", () => {
    if (requestPending) return
    requestPending = true
    failure = undefined
    render()
    void requestMicrophoneAccess()
      .then(() => {
        permission = "granted"
      })
      .catch(async (error: unknown) => {
        permission = await getMicrophonePermissionState().catch(() => "prompt" as const)
        failure = { error }
      })
      .finally(() => {
        requestPending = false
        languageWatcher.flush()
        render()
      })
  })

  openSettingsButton.addEventListener("click", () => {
    void chrome.tabs.create({ url: "chrome://settings/content/microphone" })
  })
  element<HTMLButtonElement>("close-microphone-access").addEventListener("click", () => {
    window.close()
  })
  window.addEventListener("focus", () => void refresh())
  window.addEventListener("pagehide", () => languageWatcher(), { once: true })
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh()
  })

  document.body.dataset.view = "microphone"
  page.hidden = false
  await refresh()
}
