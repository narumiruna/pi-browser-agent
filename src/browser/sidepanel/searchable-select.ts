export interface SearchableSelectOption {
  value: string
  label: string
  keywords?: string[]
}

interface SearchableSelectElements {
  container: HTMLElement
  input: HTMLInputElement
  select: HTMLSelectElement
  listbox: HTMLElement
  emptyText: string
}

export class SearchableSelect {
  private options: SearchableSelectOption[] = []
  private filteredOptions: SearchableSelectOption[] = []
  private activeIndex = -1

  constructor(private readonly elements: SearchableSelectElements) {
    const { container, input, select } = elements

    input.addEventListener("focus", () => {
      input.select()
      this.open("")
    })
    input.addEventListener("input", () => this.open(input.value))
    input.addEventListener("click", () => {
      if (elements.listbox.hidden) {
        input.select()
        this.open("")
      }
    })
    input.addEventListener("keydown", (event) => this.onKeyDown(event))
    input.addEventListener("blur", () => {
      if (!container.contains(input.ownerDocument.activeElement)) this.close(true)
    })
    select.addEventListener("change", () => {
      this.syncInputToSelection()
      this.close()
    })
    input.ownerDocument.addEventListener("mousedown", (event) => {
      if (!container.contains(event.target as Node)) this.close(true)
    })
  }

  setOptions(options: SearchableSelectOption[], preferredValue?: string): void {
    const { input, select } = this.elements
    this.options = options
    select.replaceChildren()

    for (const item of options) {
      const option = select.ownerDocument.createElement("option")
      option.value = item.value
      option.textContent = item.label
      select.append(option)
    }

    const selectedValue = options.some((item) => item.value === preferredValue)
      ? preferredValue
      : options[0]?.value
    if (selectedValue !== undefined) select.value = selectedValue

    const disabled = options.length === 0
    select.disabled = disabled
    input.disabled = disabled
    input.placeholder = disabled ? this.elements.emptyText : input.dataset.placeholder || "Search"
    this.syncInputToSelection()
    this.close()
  }

  private open(query: string): void {
    if (this.elements.input.disabled) return
    const normalizedQuery = query.trim().toLocaleLowerCase()
    this.filteredOptions = this.options.filter((option) => {
      if (!normalizedQuery) return true
      return [option.label, option.value, ...(option.keywords ?? [])].some((candidate) =>
        candidate.toLocaleLowerCase().includes(normalizedQuery),
      )
    })
    this.renderOptions()
    this.elements.listbox.hidden = false
    this.elements.input.setAttribute("aria-expanded", "true")

    const selectedIndex = this.filteredOptions.findIndex(
      (option) => option.value === this.elements.select.value,
    )
    this.setActiveIndex(selectedIndex >= 0 ? selectedIndex : this.filteredOptions.length ? 0 : -1)
  }

  private renderOptions(): void {
    const { listbox, select } = this.elements
    listbox.replaceChildren()
    if (this.filteredOptions.length === 0) {
      const empty = listbox.ownerDocument.createElement("div")
      empty.className = "searchable-select-empty"
      empty.setAttribute("role", "option")
      empty.setAttribute("aria-disabled", "true")
      empty.textContent = "No matches"
      listbox.append(empty)
      return
    }

    this.filteredOptions.forEach((item, index) => {
      const option = listbox.ownerDocument.createElement("div")
      option.id = `${listbox.id}-option-${index}`
      option.className = "searchable-select-option"
      option.dataset.index = String(index)
      option.setAttribute("role", "option")
      option.setAttribute("aria-selected", String(item.value === select.value))
      option.textContent = item.label
      option.addEventListener("mousedown", (event) => {
        event.preventDefault()
        this.choose(index)
      })
      listbox.append(option)
    })
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (this.elements.listbox.hidden) {
        this.open("")
        return
      }
      if (this.filteredOptions.length === 0) return
      const direction = event.key === "ArrowDown" ? 1 : -1
      const nextIndex =
        this.activeIndex < 0
          ? direction > 0
            ? 0
            : this.filteredOptions.length - 1
          : (this.activeIndex + direction + this.filteredOptions.length) %
            this.filteredOptions.length
      this.setActiveIndex(nextIndex)
      return
    }
    if (event.key === "Enter" && !this.elements.listbox.hidden && this.activeIndex >= 0) {
      event.preventDefault()
      this.choose(this.activeIndex)
      return
    }
    if (event.key === "Escape" && !this.elements.listbox.hidden) {
      event.preventDefault()
      event.stopPropagation()
      this.close(true)
    }
  }

  private choose(index: number): void {
    const option = this.filteredOptions[index]
    if (!option) return
    const { input, select } = this.elements
    const changed = select.value !== option.value
    select.value = option.value
    input.value = option.label
    this.close()
    if (changed) {
      const EventConstructor = select.ownerDocument.defaultView?.Event ?? Event
      select.dispatchEvent(new EventConstructor("change", { bubbles: true }))
    }
  }

  private setActiveIndex(index: number): void {
    this.activeIndex = index
    const options = this.elements.listbox.querySelectorAll<HTMLElement>("[role='option']")
    options.forEach((option, optionIndex) => {
      option.dataset.active = String(optionIndex === index)
    })
    const active = options.item(index)
    if (active) {
      this.elements.input.setAttribute("aria-activedescendant", active.id)
      active.scrollIntoView?.({ block: "nearest" })
    } else {
      this.elements.input.removeAttribute("aria-activedescendant")
    }
  }

  private close(restoreSelection = false): void {
    if (restoreSelection) this.syncInputToSelection()
    this.elements.listbox.hidden = true
    this.elements.input.setAttribute("aria-expanded", "false")
    this.elements.input.removeAttribute("aria-activedescendant")
    this.filteredOptions = []
    this.activeIndex = -1
  }

  private syncInputToSelection(): void {
    const selected = this.options.find((option) => option.value === this.elements.select.value)
    this.elements.input.value = selected?.label ?? ""
  }
}
