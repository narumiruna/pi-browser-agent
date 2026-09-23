type ConversationTextKey =
  | "activity"
  | "addInstruction"
  | "assistantIdentity"
  | "copied"
  | "copyAll"
  | "copyCode"
  | "copyFailed"
  | "copying"
  | "emptyDescription"
  | "emptyTitle"
  | "hintIdle"
  | "hintRunning"
  | "imageResult"
  | "instructionQueued"
  | "interrupted"
  | "listening"
  | "newSession"
  | "pageReady"
  | "readyWithoutPage"
  | "pastedImage"
  | "removePastedImage"
  | "promptIdle"
  | "promptWithoutPage"
  | "promptRunning"
  | "queueInstruction"
  | "ready"
  | "send"
  | "settingsSaved"
  | "startVoiceInput"
  | "stop"
  | "stopVoiceInput"
  | "table"
  | "thinking"
  | "user"
  | "waitingForPage"
  | "voiceInputStopped"
  | "voiceUnsupported"
  | "working"

const ENGLISH: Record<ConversationTextKey, string> = {
  activity: "Activity",
  addInstruction: "Add instruction",
  assistantIdentity: "Browser assistant",
  copied: "Copied",
  copyAll: "Copy all",
  copyCode: "Copy code",
  copyFailed: "Copy failed",
  copying: "Copying…",
  emptyDescription: "Ask a question, find a detail, or explore the page you're on.",
  emptyTitle: "How can I help?",
  hintIdle: "Enter to send · Shift+Enter for a new line",
  hintRunning: "Enter to add an instruction · Shift+Enter for a new line",
  imageResult: "Image result",
  instructionQueued: "Instruction queued",
  interrupted: "Interrupted",
  listening: "Listening for voice input",
  newSession: "New session",
  pageReady: "available with site access",
  readyWithoutPage: "Ready — no supported page open",
  pastedImage: "Pasted image",
  removePastedImage: "Remove pasted image",
  promptIdle: "Ask about the current page",
  promptWithoutPage: "Ask a question or describe a task",
  promptRunning: "Add an instruction while Pi is working",
  queueInstruction: "Queue for later",
  ready: "Ready",
  send: "Send",
  settingsSaved: "Settings saved",
  startVoiceInput: "Start voice input",
  stop: "Stop",
  stopVoiceInput: "Stop voice input",
  table: "Table",
  thinking: "Thinking",
  user: "You",
  waitingForPage: "Waiting for a web page",
  voiceInputStopped: "Voice input stopped",
  voiceUnsupported: "Voice input is not supported by this browser",
  working: "Working",
}

export function conversationText(key: ConversationTextKey): string {
  return ENGLISH[key]
}

type ActivityStage = "active" | "complete"

type ActivityLabels = { active: string; complete: string; error: string }
type ActivityKey =
  | "bookmarks"
  | "click"
  | "currentTab"
  | "default"
  | "elements"
  | "navigation"
  | "page"
  | "recentBookmarks"
  | "screenshot"
  | "selection"
  | "type"
  | "web"

const ENGLISH_ACTIVITIES: Record<ActivityKey, ActivityLabels> = {
  currentTab: {
    active: "Checking the current tab",
    complete: "Checked the current tab",
    error: "Could not check the current tab",
  },
  bookmarks: {
    active: "Searching bookmarks",
    complete: "Searched bookmarks",
    error: "Could not search bookmarks",
  },
  recentBookmarks: {
    active: "Reading recent bookmarks",
    complete: "Read recent bookmarks",
    error: "Could not read recent bookmarks",
  },
  page: {
    active: "Reading the page",
    complete: "Read the page",
    error: "Could not read the page",
  },
  elements: {
    active: "Finding page controls",
    complete: "Found page controls",
    error: "Could not find page controls",
  },
  selection: {
    active: "Reading the selection",
    complete: "Read the selection",
    error: "Could not read the selection",
  },
  screenshot: {
    active: "Capturing the visible page",
    complete: "Captured the visible page",
    error: "Could not capture the visible page",
  },
  click: {
    active: "Selecting a page control",
    complete: "Selected a page control",
    error: "Could not select the page control",
  },
  type: {
    active: "Entering text",
    complete: "Entered text",
    error: "Could not enter text",
  },
  navigation: {
    active: "Opening a page",
    complete: "Opened a page",
    error: "Could not open the page",
  },
  web: {
    active: "Using a page feature",
    complete: "Used a page feature",
    error: "Could not use the page feature",
  },
  default: {
    active: "Working with the page",
    complete: "Page activity completed",
    error: "Page activity needs attention",
  },
}

const ACTIVITY_KEYS: Record<string, ActivityKey> = {
  "app.getState": "currentTab",
  "bookmarks.getRecent": "recentBookmarks",
  "bookmarks.search": "bookmarks",
  browser_capture_visible: "screenshot",
  browser_click: "click",
  browser_get_active_tab: "currentTab",
  browser_get_recent_bookmarks: "recentBookmarks",
  browser_get_selection: "selection",
  browser_list_elements: "elements",
  browser_navigate: "navigation",
  browser_read_page: "page",
  browser_search_bookmarks: "bookmarks",
  browser_type: "type",
  browser_webmcp: "web",
  "page.captureVisible": "screenshot",
  "page.click": "click",
  "page.getSelection": "selection",
  "page.getVisibleText": "page",
  "page.listElements": "elements",
  "page.type": "type",
  "tabs.getActive": "currentTab",
  "tabs.navigate": "navigation",
  "webmcp.callTool": "web",
  "webmcp.listTools": "web",
}

export function activityText(name: string, stage: ActivityStage, error = false): string {
  const activity = ENGLISH_ACTIVITIES[ACTIVITY_KEYS[name] ?? "default"]
  return error ? activity.error : activity[stage]
}
