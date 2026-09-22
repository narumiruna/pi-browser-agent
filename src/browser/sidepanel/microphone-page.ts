import { safeErrorMessage } from "../auth/redaction.js"
import { element } from "./ui.js"
import { getMicrophonePermissionState, requestMicrophoneAccess } from "./voice-input.js"

function microphoneAccessErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Chrome blocked microphone access. Open Chrome microphone settings, remove Pi Browser Agent from Not allowed, then return here and try again."
  }
  if (error instanceof DOMException && error.name === "NotFoundError") {
    return "Chrome could not find a microphone. Connect or enable one, then try again."
  }
  return `Microphone access failed: ${safeErrorMessage(error)}`
}

export async function initializeMicrophonePage(): Promise<void> {
  const page = element<HTMLElement>("microphone-access-page")
  const status = element<HTMLElement>("microphone-access-status")
  const allowButton = element<HTMLButtonElement>("allow-microphone")
  const openSettingsButton = element<HTMLButtonElement>("open-microphone-settings")

  const refresh = async (): Promise<void> => {
    const state = await getMicrophonePermissionState().catch(() => "prompt" as const)
    allowButton.hidden = state !== "prompt"
    openSettingsButton.hidden = state !== "denied"
    status.textContent =
      state === "granted"
        ? "Microphone access is allowed. Close this tab and select the microphone in Pi Browser Agent."
        : state === "denied"
          ? "Microphone access is blocked. Open Chrome microphone settings to allow it."
          : "Select Allow microphone access, then approve Chrome's prompt."
  }

  allowButton.addEventListener("click", () => {
    allowButton.disabled = true
    openSettingsButton.hidden = true
    status.textContent = "Waiting for Chrome's microphone prompt…"
    void requestMicrophoneAccess()
      .then(() => {
        allowButton.disabled = false
        allowButton.hidden = true
        status.textContent =
          "Microphone access is allowed. Close this tab and select the microphone in Pi Browser Agent."
      })
      .catch(async (error: unknown) => {
        const state = await getMicrophonePermissionState().catch(() => undefined)
        allowButton.disabled = false
        allowButton.hidden = state === "denied"
        openSettingsButton.hidden = false
        status.textContent = microphoneAccessErrorMessage(error)
      })
  })

  openSettingsButton.addEventListener("click", () => {
    void chrome.tabs.create({ url: "chrome://settings/content/microphone" })
  })
  element<HTMLButtonElement>("close-microphone-access").addEventListener("click", () => {
    window.close()
  })
  window.addEventListener("focus", () => void refresh())
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh()
  })

  document.title = "Microphone access · Pi Browser Agent"
  document.body.dataset.view = "microphone"
  page.hidden = false
  await refresh()
}
