export interface SessionPickerOption {
  value: string
  label: string
  statusLabel?: string
}

interface SessionPickerElements {
  container: HTMLElement
  trigger: HTMLButtonElement
  triggerLabel: HTMLElement
  select: HTMLSelectElement
  menu: HTMLElement
  listbox: HTMLElement
  emptyText: string
  onOpen?: () => void
}

export class SessionPicker {
  private options: SessionPickerOption[] = []

  constructor(private readonly elements: SessionPickerElements) {
    const { container, trigger, select } = elements

    trigger.addEventListener("click", () => {
      if (elements.menu.hidden) this.open()
      else this.close()
    })
    trigger.addEventListener("keydown", (event) => this.onTriggerKeyDown(event))
    select.addEventListener("change", () => {
      this.syncToSelection()
      this.close()
    })
    trigger.ownerDocument.addEventListener("mousedown", (event) => {
      if (!container.contains(event.target as Node)) this.close()
    })
    trigger.ownerDocument.addEventListener("focusin", (event) => {
      if (!container.contains(event.target as Node)) this.close()
    })
  }

  setOptions(options: SessionPickerOption[], preferredValue?: string): void {
    const { select, trigger } = this.elements
    const previousValue = select.value
    this.options = options
    select.replaceChildren()

    for (const item of options) {
      const option = select.ownerDocument.createElement("option")
      option.value = item.value
      option.textContent = item.statusLabel ? `${item.label} (${item.statusLabel})` : item.label
      select.append(option)
    }

    const selectedValue = options.some((item) => item.value === preferredValue)
      ? preferredValue
      : options.some((item) => item.value === previousValue)
        ? previousValue
        : options[0]?.value
    if (selectedValue !== undefined) select.value = selectedValue

    trigger.disabled = options.length === 0
    this.syncToSelection()
    this.close()
  }

  private renderOptions(): void {
    const { listbox, select } = this.elements
    listbox.replaceChildren()

    for (const [index, item] of this.options.entries()) {
      const option = listbox.ownerDocument.createElement("button")
      option.id = `${listbox.id}-option-${index}`
      option.type = "button"
      option.className = "session-option"
      option.dataset.value = item.value
      option.setAttribute("role", "option")
      option.setAttribute("aria-selected", String(item.value === select.value))
      option.title = item.label

      const check = listbox.ownerDocument.createElement("span")
      check.className = "session-option-check"
      check.setAttribute("aria-hidden", "true")
      const checkIcon = listbox.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg")
      checkIcon.setAttribute("viewBox", "0 0 15 15")
      const checkPath = listbox.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path")
      checkPath.setAttribute("d", "m3.5 7.5 2.5 2.5 5.5-5.5")
      checkIcon.append(checkPath)
      check.append(checkIcon)

      const label = listbox.ownerDocument.createElement("span")
      label.className = "session-option-title"
      label.textContent = item.label

      option.append(check, label)
      if (item.statusLabel) {
        const status = listbox.ownerDocument.createElement("span")
        status.className = "session-option-status"
        status.textContent = item.statusLabel
        option.append(status)
      }

      option.addEventListener("click", () => this.choose(index))
      option.addEventListener("keydown", (event) => this.onOptionKeyDown(event, index))
      listbox.append(option)
    }
  }

  private onTriggerKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape" && !this.elements.menu.hidden) {
      event.preventDefault()
      event.stopPropagation()
      this.close()
      return
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return

    event.preventDefault()
    const selectedIndex = this.options.findIndex(
      (option) => option.value === this.elements.select.value,
    )
    const targetIndex =
      event.key === "Home" ? 0 : event.key === "End" ? this.options.length - 1 : selectedIndex
    this.open(Math.max(0, targetIndex))
  }

  private onOptionKeyDown(event: KeyboardEvent, index: number): void {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      this.close(true)
      return
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return

    event.preventDefault()
    let nextIndex = index
    if (event.key === "Home") nextIndex = 0
    else if (event.key === "End") nextIndex = this.options.length - 1
    else {
      const direction = event.key === "ArrowDown" ? 1 : -1
      nextIndex = (index + direction + this.options.length) % this.options.length
    }
    this.optionElements().item(nextIndex).focus()
  }

  private choose(index: number): void {
    const item = this.options[index]
    if (!item) return

    const { select } = this.elements
    const changed = select.value !== item.value
    select.value = item.value
    this.syncToSelection()
    this.close(true)
    if (changed) {
      const EventConstructor = select.ownerDocument.defaultView?.Event ?? Event
      select.dispatchEvent(new EventConstructor("change", { bubbles: true }))
    }
  }

  private open(focusIndex?: number): void {
    const { menu, trigger } = this.elements
    if (trigger.disabled) return

    this.elements.onOpen?.()
    this.renderOptions()
    menu.hidden = false
    trigger.setAttribute("aria-expanded", "true")
    this.elements.container.dataset.open = "true"
    if (focusIndex !== undefined) this.optionElements().item(focusIndex).focus()
  }

  private close(returnFocus = false): void {
    const { menu, trigger, container } = this.elements
    menu.hidden = true
    trigger.setAttribute("aria-expanded", "false")
    delete container.dataset.open
    if (returnFocus) trigger.focus()
  }

  private syncToSelection(): void {
    const { select, trigger, triggerLabel } = this.elements
    const selected = this.options.find((option) => option.value === select.value)
    const label = selected?.label ?? this.elements.emptyText
    triggerLabel.textContent = label
    triggerLabel.title = selected?.label ?? ""
    trigger.title = selected?.label ?? ""
    this.renderOptions()
  }

  private optionElements(): NodeListOf<HTMLButtonElement> {
    return this.elements.listbox.querySelectorAll<HTMLButtonElement>(".session-option")
  }
}
