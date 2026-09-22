import { conversationText } from "./conversation-copy.js"

const feedbackIcons = {
  copying: "M7.5 1.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12ZM7.5 4v3.5H10",
  copied: "m2.5 7.5 3.5 3.5 6.5-7",
  copyFailed: "M7.5 1.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12ZM7.5 4v4M7.5 10.5h.01",
} as const

const defaultIcons = {
  answer: "M5.5 3.5v-2h8v9h-2M1.5 5.5h8v8h-8Z",
  code: "M5 3V1.5h5V3M4 2.5H2.5v11h10v-11H11M5 6h5M5 9h5",
}

export type CopyButtonKind = keyof typeof defaultIcons

/** A message-scoped control whose feedback survives streamed content updates. */
export class CopyButton {
  readonly element: HTMLButtonElement
  private attempt = 0
  private resetTimer?: ReturnType<typeof setTimeout>

  constructor(
    label: string,
    private text: string,
    kind: CopyButtonKind,
  ) {
    const button = document.createElement("button")
    this.element = button
    button.type = "button"
    button.className = `copy-button ${kind}-copy-button`
    button.title = label
    button.setAttribute("aria-label", label)

    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    icon.setAttribute("class", "radix-icon")
    icon.setAttribute("viewBox", "0 0 15 15")
    icon.setAttribute("aria-hidden", "true")
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
    path.setAttribute("d", defaultIcons[kind])
    icon.append(path)

    const visibleLabel = document.createElement("span")
    visibleLabel.className = "copy-label"
    visibleLabel.textContent = label
    const status = document.createElement("span")
    status.className = "visually-hidden"
    status.setAttribute("role", "status")
    status.setAttribute("aria-atomic", "true")
    button.append(icon, visibleLabel, status)

    const showDefault = (attempt: number): void => {
      if (attempt !== this.attempt) return
      path.setAttribute("d", defaultIcons[kind])
      visibleLabel.textContent = label
      button.title = label
      status.textContent = ""
      delete button.dataset.copyState
    }
    const report = (attempt: number, feedback: keyof typeof feedbackIcons): void => {
      if (attempt !== this.attempt) return
      const message = conversationText(feedback)
      path.setAttribute("d", feedbackIcons[feedback])
      visibleLabel.textContent = message
      button.title = `${label}: ${message}`
      button.dataset.copyState = feedback
      status.textContent = message
      if (feedback === "copying") return
      this.resetTimer = setTimeout(() => showDefault(attempt), 2_000)
    }

    button.addEventListener("click", () => {
      const attempt = ++this.attempt
      if (this.resetTimer !== undefined) clearTimeout(this.resetTimer)
      report(attempt, "copying")
      // Capture current text synchronously in the user gesture; updates never copy automatically.
      try {
        void navigator.clipboard.writeText(this.text).then(
          () => report(attempt, "copied"),
          () => report(attempt, "copyFailed"),
        )
      } catch {
        report(attempt, "copyFailed")
      }
    })
  }

  updateText(text: string): void {
    this.text = text
  }
}
