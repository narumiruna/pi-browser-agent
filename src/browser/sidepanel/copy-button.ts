import { conversationText } from "./conversation-copy.js"

const feedbackIcons = {
  copying: "M7.5 1.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12ZM7.5 4v3.5H10",
  copied: "m2.5 7.5 3.5 3.5 6.5-7",
  copyFailed: "M7.5 1.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12ZM7.5 4v4M7.5 10.5h.01",
} as const

/** A message-scoped control whose feedback survives streamed content updates. */
export class CopyButton {
  readonly element: HTMLButtonElement
  private attempt = 0

  constructor(
    label: string,
    private text: string,
  ) {
    const button = document.createElement("button")
    this.element = button
    button.type = "button"
    button.className = "icon-button copy-button"
    button.title = label
    button.setAttribute("aria-label", label)
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    icon.setAttribute("class", "radix-icon")
    icon.setAttribute("viewBox", "0 0 15 15")
    icon.setAttribute("aria-hidden", "true")
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
    path.setAttribute("d", "M5.5 3.5v-2h8v9h-2M1.5 5.5h8v8h-8Z")
    icon.append(path)
    const status = document.createElement("span")
    status.className = "visually-hidden"
    status.setAttribute("role", "status")
    status.setAttribute("aria-atomic", "true")
    button.append(icon, status)
    button.addEventListener("click", () => {
      const attempt = ++this.attempt
      const report = (feedback: keyof typeof feedbackIcons) => {
        if (attempt !== this.attempt) return
        const message = conversationText(feedback)
        path.setAttribute("d", feedbackIcons[feedback])
        button.title = `${label}: ${message}`
        status.textContent = message
      }
      report("copying")
      // Capture current text synchronously in the user gesture; updates never copy automatically.
      try {
        void navigator.clipboard.writeText(this.text).then(
          () => report("copied"),
          () => report("copyFailed"),
        )
      } catch {
        report("copyFailed")
      }
    })
  }

  updateText(text: string): void {
    this.text = text
  }
}
