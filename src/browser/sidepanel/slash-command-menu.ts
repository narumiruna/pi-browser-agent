import { getSlashCommandMatches } from "./slash-commands.js"

interface SlashCommandMenuOptions {
  input: HTMLTextAreaElement
  listbox: HTMLElement
  onInput: () => void
}

let nextListboxId = 0

export class SlashCommandMenu {
  private matches: ReturnType<typeof getSlashCommandMatches> = []
  private activeIndex = 0
  private tokenStart = 0
  private tokenEnd = 0
  private renderedState = ""
  private dismissedState: string | undefined
  private composing = false
  private readonly status: HTMLElement

  constructor(private readonly options: SlashCommandMenuOptions) {
    const { input, listbox } = options
    if (!listbox.id) listbox.id = `slash-command-listbox-${++nextListboxId}`
    listbox.setAttribute("role", "listbox")
    if (!listbox.hasAttribute("aria-label") && !listbox.hasAttribute("aria-labelledby")) {
      listbox.setAttribute("aria-label", "Slash commands")
    }
    // Keep the native multiline textbox role; textarea does not allow a combobox override.
    this.status = listbox.ownerDocument.createElement("span")
    this.status.id = `${listbox.id}-status`
    this.status.className = "visually-hidden"
    this.status.setAttribute("role", "status")
    this.status.setAttribute("aria-live", "polite")
    this.status.setAttribute("aria-atomic", "true")
    listbox.after(this.status)
    const descriptions = input.getAttribute("aria-describedby")?.split(/\s+/).filter(Boolean) ?? []
    input.setAttribute("aria-describedby", [...descriptions, this.status.id].join(" "))
    input.setAttribute("aria-autocomplete", "list")
    input.setAttribute("aria-haspopup", "listbox")
    input.setAttribute("aria-controls", listbox.id)
    this.hide()

    for (const type of ["input", "select", "click", "focus"]) {
      input.addEventListener(type, () => this.update())
    }
    input.addEventListener("blur", () => this.close())
    input.addEventListener("compositionstart", () => {
      this.composing = true
      this.hide()
    })
    input.addEventListener("compositionend", () => {
      this.composing = false
      this.update()
    })
    input.ownerDocument.addEventListener("selectionchange", () => this.update())
    for (const type of ["pointerdown", "mousedown"]) {
      listbox.addEventListener(type, (event) => {
        if (!listbox.hidden) event.preventDefault()
      })
      input.ownerDocument.addEventListener(type, (event) => {
        const target = event.target as Node | null
        if (target !== input && !listbox.contains(target)) this.close()
      })
    }
    input.ownerDocument.addEventListener("focusin", (event) => {
      if (event.target !== input) this.close()
    })
  }

  update(): void {
    const { input } = this.options
    const state = this.state()
    if (state !== this.dismissedState) this.dismissedState = undefined
    if (
      this.composing ||
      input.disabled ||
      input.readOnly ||
      input.ownerDocument.activeElement !== input ||
      input.selectionStart !== input.selectionEnd ||
      state === this.dismissedState ||
      /[\r\n\u2028\u2029]/.test(input.value)
    ) {
      this.hide()
      return
    }

    const token = /^(\s*)\/([a-z-]*)(?=\s|$)/.exec(input.value)
    const start = token?.[1]?.length ?? 0
    const end = token ? token[0].length : 0
    if (!token || input.selectionStart < start + 1 || input.selectionStart > end) {
      this.hide()
      return
    }

    this.matches = getSlashCommandMatches(token[2] ?? "")
    if (this.matches.length === 0) {
      this.hide()
      return
    }
    this.tokenStart = start
    this.tokenEnd = end
    if (state !== this.renderedState) this.activeIndex = 0
    this.renderedState = state
    this.render()
  }

  close(): void {
    this.dismissedState = this.state()
    this.hide()
  }

  /** Return true to skip conversation handling. IME input retains its browser default. */
  handleKeyDown(event: KeyboardEvent): boolean {
    if (event.isComposing || event.keyCode === 229 || this.composing) return true
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return false
    }
    this.update()
    if (this.options.listbox.hidden) return false

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const direction = event.key === "ArrowDown" ? 1 : -1
      this.activeIndex = (this.activeIndex + direction + this.matches.length) % this.matches.length
      this.render()
    } else if (event.key === "Enter" || event.key === "Tab") {
      this.choose(this.activeIndex)
    } else if (event.key === "Escape") {
      this.close()
    } else {
      return false
    }
    event.preventDefault()
    event.stopPropagation()
    return true
  }

  private state(): string {
    const { input } = this.options
    return JSON.stringify([input.value, input.selectionStart, input.selectionEnd])
  }

  private hide(): void {
    const wasOpen = !this.options.listbox.hidden
    this.options.listbox.hidden = true
    if (wasOpen) this.status.textContent = "Command list closed."
    this.options.input.removeAttribute("aria-activedescendant")
  }

  private render(): void {
    const { input, listbox } = this.options
    const active = this.matches[this.activeIndex]
    if (!active) {
      this.hide()
      return
    }
    listbox.replaceChildren()
    for (const [index, command] of this.matches.entries()) {
      const option = listbox.ownerDocument.createElement("div")
      option.id = `${listbox.id}-option-${command.name}`
      option.className = "slash-command-option"
      option.setAttribute("role", "option")
      option.setAttribute("aria-selected", String(index === this.activeIndex))

      const name = listbox.ownerDocument.createElement("span")
      name.className = "slash-command-name"
      name.textContent = `/${command.name}`
      const description = listbox.ownerDocument.createElement("span")
      description.className = "slash-command-description"
      description.textContent = command.description
      option.append(name, description)
      option.addEventListener("click", () => this.choose(index))
      listbox.append(option)
    }
    listbox.hidden = false
    const status = `Command list open. ${this.matches.length} commands available.`
    if (this.status.textContent !== status) this.status.textContent = status
    input.setAttribute("aria-activedescendant", `${listbox.id}-option-${active.name}`)
    const activeOption = listbox.children.item(this.activeIndex) as HTMLElement | null
    if (activeOption) {
      const top = activeOption.offsetTop
      const bottom = top + activeOption.offsetHeight
      if (top < listbox.scrollTop) listbox.scrollTop = top
      else if (bottom > listbox.scrollTop + listbox.clientHeight) {
        listbox.scrollTop = bottom - listbox.clientHeight
      }
    }
  }

  private choose(index: number): void {
    const { input, listbox, onInput } = this.options
    // Recheck the draft and caret before applying a pointer selection.
    if (listbox.hidden || this.state() !== this.renderedState) return
    const command = this.matches[index]
    if (!command) return
    const suffix = input.value.slice(this.tokenEnd)
    const replacement = `/${command.name}`
    input.value = input.value.slice(0, this.tokenStart) + replacement + (suffix || " ")
    const caret = this.tokenStart + replacement.length + 1
    input.setSelectionRange(caret, caret)
    this.close()
    input.focus()
    onInput()
  }
}
