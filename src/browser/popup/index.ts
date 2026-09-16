interface RuntimeResponse<T> {
  ok: boolean
  result?: T
  error?: { message: string }
}

interface PopupState {
  status: { state: string; error?: string }
  tabContext?: { tabId: number; url: string; epoch: number }
}

const statusElement = document.querySelector<HTMLSpanElement>("#status")
const tabElement = document.querySelector<HTMLParagraphElement>("#tab-status")
const errorElement = document.querySelector<HTMLParagraphElement>("#error")
const secretInput = document.querySelector<HTMLInputElement>("#secret")
const portInput = document.querySelector<HTMLInputElement>("#port")

function required<T extends Element>(value: T | null, name: string): T {
  if (!value) throw new Error(`Missing popup element: ${name}`)
  return value
}

async function send<T>(message: Record<string, unknown>): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as RuntimeResponse<T>
  if (!response.ok || response.result === undefined) {
    throw new Error(response.error?.message ?? "Bridge request failed")
  }
  return response.result
}

function showError(error?: string): void {
  const element = required(errorElement, "error")
  element.hidden = !error
  element.textContent = error ?? ""
}

function render(state: PopupState): void {
  const status = required(statusElement, "status")
  status.textContent = state.status.state.replace(/^./, (character) => character.toUpperCase())
  status.className = `status ${state.status.state}`
  required(tabElement, "tab status").textContent = state.tabContext
    ? `Tab ${state.tabContext.tabId} · ${state.tabContext.url}`
    : "No tab bound"
  showError(state.status.error)
}

async function refresh(): Promise<void> {
  try {
    render(await send<PopupState>({ type: "bridge.getStatus" }))
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error))
  }
}

required(document.querySelector<HTMLButtonElement>("#pair"), "pair").addEventListener(
  "click",
  () => {
    const secret = required(secretInput, "secret").value.trim()
    const port = Number(required(portInput, "port").value)
    void send<PopupState>({ type: "bridge.pair", secret, port })
      .then((state) => {
        required(secretInput, "secret").value = ""
        render(state)
      })
      .catch((error: unknown) => showError(error instanceof Error ? error.message : String(error)))
  },
)

required(document.querySelector<HTMLButtonElement>("#bind"), "bind").addEventListener(
  "click",
  () => {
    void send<{ tabContext: PopupState["tabContext"] }>({ type: "bridge.bindTab" })
      .then(refresh)
      .catch((error: unknown) => showError(error instanceof Error ? error.message : String(error)))
  },
)

required(document.querySelector<HTMLButtonElement>("#grant-site"), "grant site").addEventListener(
  "click",
  () => {
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.url) throw new Error("The active tab URL is unavailable")
      const url = new URL(tab.url)
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Only HTTP and HTTPS sites can be granted access")
      }
      const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] })
      if (!granted) throw new Error("Site access was not granted")
      await send({ type: "bridge.bindTab" })
      await refresh()
    })().catch((error: unknown) =>
      showError(error instanceof Error ? error.message : String(error)),
    )
  },
)

required(
  document.querySelector<HTMLButtonElement>("#send-selection"),
  "send selection",
).addEventListener("click", () => {
  void send({ type: "bridge.sendSelection" })
    .then(() => window.close())
    .catch((error: unknown) => showError(error instanceof Error ? error.message : String(error)))
})

required(document.querySelector<HTMLButtonElement>("#disconnect"), "disconnect").addEventListener(
  "click",
  () => {
    void send<PopupState>({ type: "bridge.disconnect" })
      .then(render)
      .catch((error: unknown) => showError(error instanceof Error ? error.message : String(error)))
  },
)

required(document.querySelector<HTMLButtonElement>("#revoke"), "revoke").addEventListener(
  "click",
  () => {
    void send<PopupState>({ type: "bridge.revoke" })
      .then(render)
      .catch((error: unknown) => showError(error instanceof Error ? error.message : String(error)))
  },
)

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "bridge.status.changed"
  ) {
    render(message as unknown as PopupState)
  }
})

void refresh()
