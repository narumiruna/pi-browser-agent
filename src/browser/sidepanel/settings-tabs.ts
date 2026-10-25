/** Keep panels mounted so tab changes do not discard unsaved settings. */
export function initializeSettingsTabs(page: HTMLElement): void {
  const tabs = [...page.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  const panels = page.querySelectorAll<HTMLElement>('[role="tabpanel"]')
  const content = page.querySelector<HTMLElement>(".settings-content")

  function activate(tab: HTMLButtonElement): void {
    for (const candidate of tabs) {
      const selected = candidate === tab
      candidate.setAttribute("aria-selected", String(selected))
      candidate.tabIndex = selected ? 0 : -1
    }
    for (const panel of panels) panel.hidden = panel.id !== tab.getAttribute("aria-controls")
    if (content) content.scrollTop = 0
  }

  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => activate(tab))
    tab.addEventListener("keydown", (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      let next: HTMLButtonElement | undefined
      switch (event.key) {
        case "ArrowLeft":
          next = tabs[(index + tabs.length - 1) % tabs.length]
          break
        case "ArrowRight":
          next = tabs[(index + 1) % tabs.length]
          break
        case "Home":
          next = tabs[0]
          break
        case "End":
          next = tabs.at(-1)
          break
      }
      if (!next) return
      event.preventDefault()
      activate(next)
      next.focus()
    })
  }

  if (tabs[0]) activate(tabs[0])
}
