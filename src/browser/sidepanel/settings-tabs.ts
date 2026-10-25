/** Keep panels mounted so tab changes do not discard unsaved settings. */
export function initializeSettingsTabs(page: HTMLElement): void {
  const tabs = [...page.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  const panels = page.querySelectorAll<HTMLElement>('[role="tabpanel"]')
  const content = page.querySelector<HTMLElement>(".settings-content")
  const tablist = page.querySelector<HTMLElement>('[role="tablist"]')
  const desktop = page.ownerDocument.defaultView?.matchMedia?.("(min-width: 800px)")

  function updateOrientation(): void {
    tablist?.setAttribute("aria-orientation", desktop?.matches ? "vertical" : "horizontal")
    tabs
      .find((tab) => tab.getAttribute("aria-selected") === "true")
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
  }

  updateOrientation()
  desktop?.addEventListener("change", updateOrientation)

  function activate(tab: HTMLButtonElement): void {
    for (const candidate of tabs) {
      const selected = candidate === tab
      candidate.setAttribute("aria-selected", String(selected))
      candidate.tabIndex = selected ? 0 : -1
    }
    for (const panel of panels) panel.hidden = panel.id !== tab.getAttribute("aria-controls")
    if (content) content.scrollTop = 0
    tab.scrollIntoView?.({ block: "nearest", inline: "nearest" })
  }

  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => activate(tab))
    tab.addEventListener("keydown", (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const previousKey = desktop?.matches ? "ArrowUp" : "ArrowLeft"
      const nextKey = desktop?.matches ? "ArrowDown" : "ArrowRight"
      let next: HTMLButtonElement | undefined
      switch (event.key) {
        case previousKey:
          next = tabs[(index + tabs.length - 1) % tabs.length]
          break
        case nextKey:
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
