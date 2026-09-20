import "./styles.css"
import { safeErrorMessage } from "../auth/redaction.js"

const params = new URLSearchParams(window.location.search)
const view = params.get("view")

async function initialize(): Promise<void> {
  if (view === "microphone") {
    const { initializeMicrophonePage } = await import("./microphone-page.js")
    await initializeMicrophonePage()
    return
  }
  if (view === "settings") {
    const { initializeSettingsPage } = await import("./settings-page.js")
    await initializeSettingsPage(params)
    return
  }
  const { initializeConversationPage } = await import("./conversation-page.js")
  await initializeConversationPage(params)
}

void initialize().catch((error) => {
  const outputId =
    view === "settings"
      ? "settings-error"
      : view === "microphone"
        ? "microphone-access-status"
        : "error"
  const output = document.getElementById(outputId)
  if (output) output.textContent = safeErrorMessage(error)
})
