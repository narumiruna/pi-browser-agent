import { BROWSER_TOOL_OPTIONS } from "../agent/browser-tools.js"
import { t } from "../i18n/index.js"

const TOOL_LABELS = {
  browser_list_tabs: "List web tabs",
  browser_switch_tab: "Switch web tab",
  browser_open_website: "Open website",
  browser_get_active_tab: "Browser active tab",
  browser_search_bookmarks: "Search bookmarks",
  browser_get_recent_bookmarks: "Recent bookmarks",
  browser_read_page: "Read page",
  browser_list_elements: "List visible elements",
  browser_find_text: "Find page text",
  browser_wait_for: "Wait for page condition",
  browser_get_selection: "Read selection",
  browser_capture_visible: "Capture viewport",
  browser_scroll: "Scroll page or container",
  browser_select_option: "Select native option",
  browser_set_checked: "Set checked state",
  browser_get_select_options: "Read native select options",
  browser_get_element_details: "Inspect element details",
  browser_click: "Click element",
  browser_type: "Type text",
  browser_navigate: "Navigate",
  browser_webmcp: "WebMCP",
} as const

export const TOOL_GROUPS = [
  {
    name: "Read",
    tools: [
      ["browser_read_page", "Read rendered page text."],
      ["browser_list_elements", "Find visible controls and scroll containers."],
      ["browser_find_text", "Find literal text on the page."],
      ["browser_wait_for", "Wait for a page condition."],
      ["browser_get_selection", "Read selected page text."],
      ["browser_capture_visible", "Capture the visible viewport."],
      ["browser_get_select_options", "Read native option labels."],
      ["browser_get_element_details", "Inspect a visible element."],
    ],
  },
  {
    name: "Interact",
    tools: [
      ["browser_scroll", "Scroll the page or a container."],
      ["browser_select_option", "Choose a native select option."],
      ["browser_set_checked", "Change a checkbox or radio state."],
      ["browser_click", "Activate a page element."],
      ["browser_type", "Enter text in an editable field."],
    ],
  },
  {
    name: "Navigate",
    tools: [
      ["browser_list_tabs", "List web tabs in this window."],
      ["browser_switch_tab", "Switch to a web tab."],
      ["browser_open_website", "Open an approved destination."],
      ["browser_get_active_tab", "Read current web-tab metadata."],
      ["browser_navigate", "Navigate the current page."],
    ],
  },
  {
    id: "bookmarks",
    name: "Bookmarks",
    tools: [
      ["browser_search_bookmarks", "Search bookmark titles and URLs."],
      ["browser_get_recent_bookmarks", "Read recently added bookmarks."],
    ],
  },
  {
    name: "WebMCP",
    tools: [["browser_webmcp", "Discover or call tools provided by the current page."]],
  },
] as const

export function renderToolOptions(container: HTMLElement): HTMLInputElement[] {
  const document = container.ownerDocument
  const checkboxes: HTMLInputElement[] = []
  for (const group of TOOL_GROUPS) {
    const fieldset = document.createElement("fieldset")
    fieldset.className = "tool-group"
    const legend = document.createElement("legend")
    legend.textContent = t(group.name)
    fieldset.append(legend)
    if ("id" in group && group.id === "bookmarks") {
      const help = document.createElement("p")
      help.id = "bookmark-tools-help"
      help.className = "field-hint"
      help.textContent = t(
        "Bookmark reads require approval. Your confirmation mode can reuse approval for identical arguments. Results are untrusted.",
      )
      fieldset.setAttribute("aria-describedby", help.id)
      fieldset.append(help)
    }
    for (const [name, description] of group.tools) {
      const tool = BROWSER_TOOL_OPTIONS.find((candidate) => candidate.name === name)
      if (!tool) continue
      const row = document.createElement("div")
      row.className = "tool-option"
      const label = document.createElement("label")
      label.className = "check-field"
      const checkbox = document.createElement("input")
      checkbox.type = "checkbox"
      checkbox.value = name
      checkbox.setAttribute("aria-describedby", `tool-description-${name}`)
      const text = document.createElement("span")
      const title = document.createElement("strong")
      title.textContent = t(TOOL_LABELS[name])
      const note = document.createElement("small")
      note.id = `tool-description-${name}`
      note.textContent = t(description)
      text.append(title, note)
      label.append(checkbox, text)
      const details = document.createElement("details")
      details.className = "tool-technical"
      const summary = document.createElement("summary")
      summary.textContent = t("Technical name")
      const code = document.createElement("code")
      code.textContent = name
      details.append(summary, code)
      row.append(label, details)
      fieldset.append(row)
      checkboxes.push(checkbox)
    }
    container.append(fieldset)
  }
  return checkboxes
}
