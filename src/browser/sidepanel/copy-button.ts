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
    button.className = "copy-button"
    button.textContent = label
    button.setAttribute("aria-label", label)
    button.setAttribute("aria-live", "polite")
    button.addEventListener("click", () => {
      const attempt = ++this.attempt
      const report = (feedback: string) => {
        if (attempt === this.attempt) button.textContent = feedback
      }
      report("Copying…")
      // Capture current text synchronously in the user gesture; updates never copy automatically.
      try {
        void navigator.clipboard.writeText(this.text).then(
          () => report("Copied"),
          () => report("Copy failed"),
        )
      } catch {
        report("Copy failed")
      }
    })
  }

  updateText(text: string): void {
    this.text = text
  }
}
