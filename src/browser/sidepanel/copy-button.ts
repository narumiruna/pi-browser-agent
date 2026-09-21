export function createCopyButton(label: string, text: string): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "copy-button"
  button.textContent = label
  button.setAttribute("aria-label", label)
  button.setAttribute("aria-live", "polite")
  button.addEventListener("click", () => {
    // Invoke synchronously from the user gesture; never request clipboard access at render time.
    try {
      void navigator.clipboard.writeText(text).then(
        () => {
          button.textContent = "Copied"
        },
        () => {
          button.textContent = "Copy failed"
        },
      )
    } catch {
      button.textContent = "Copy failed"
    }
  })
  return button
}
