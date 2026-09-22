type ConversationTextKey =
  | "activity"
  | "addInstruction"
  | "assistantIdentity"
  | "copied"
  | "copyAnswer"
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
  | "pastedImage"
  | "removePastedImage"
  | "promptIdle"
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
  | "voiceInputStopped"
  | "voiceUnsupported"
  | "working"

const ENGLISH: Record<ConversationTextKey, string> = {
  activity: "Activity",
  addInstruction: "Add instruction",
  assistantIdentity: "Browser assistant",
  copied: "Copied",
  copyAnswer: "Copy answer",
  copyCode: "Copy code",
  copyFailed: "Copy failed",
  copying: "Copying…",
  emptyDescription: "Ask a question, find a detail, or explore the page you're on.",
  emptyTitle: "How can I help?",
  hintIdle: "Enter to send · Shift+Enter for a new line",
  hintRunning: "Enter to add an instruction · Shift+Enter for a new line",
  imageResult: "Image result",
  instructionQueued: "Instruction queued",
  interrupted: "interrupted",
  listening: "Listening for voice input",
  newSession: "New session",
  pastedImage: "Pasted image",
  removePastedImage: "Remove pasted image",
  promptIdle: "Ask about the current page",
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
  voiceInputStopped: "Voice input stopped",
  voiceUnsupported: "Voice input is not supported by this browser",
  working: "Working",
}

const TRADITIONAL_CHINESE: Record<ConversationTextKey, string> = {
  activity: "活動紀錄",
  addInstruction: "追加指令",
  assistantIdentity: "瀏覽器助理",
  copied: "已複製",
  copyAnswer: "複製回答",
  copyCode: "複製程式碼",
  copyFailed: "複製失敗",
  copying: "正在複製…",
  emptyDescription: "你可以詢問問題、尋找資訊，或探索目前頁面。",
  emptyTitle: "有什麼可以幫你？",
  hintIdle: "Enter 傳送 · Shift+Enter 換行",
  hintRunning: "Enter 追加指令 · Shift+Enter 換行",
  imageResult: "圖片結果",
  instructionQueued: "指令已排入佇列",
  interrupted: "已中斷",
  listening: "正在聆聽語音輸入",
  newSession: "新對話",
  pastedImage: "貼上的圖片",
  removePastedImage: "移除貼上的圖片",
  promptIdle: "詢問目前頁面…",
  promptRunning: "在 Pi 處理時追加指令…",
  queueInstruction: "稍後處理",
  ready: "就緒",
  send: "傳送",
  settingsSaved: "設定已儲存",
  startVoiceInput: "開始語音輸入",
  stop: "停止",
  stopVoiceInput: "停止語音輸入",
  table: "表格",
  thinking: "思考中",
  user: "你",
  voiceInputStopped: "語音輸入已停止",
  voiceUnsupported: "此瀏覽器不支援語音輸入",
  working: "處理中",
}

export function conversationLanguage(): "en" | "zh-TW" {
  const languages = globalThis.navigator?.languages?.length
    ? globalThis.navigator.languages
    : [globalThis.navigator?.language ?? "en"]
  for (const language of languages) {
    if (/^zh-(?:Hant|TW|HK|MO)(?:-|$)/i.test(language)) return "zh-TW"
    if (/^en(?:-|$)/i.test(language)) return "en"
  }
  return "en"
}

export function conversationText(key: ConversationTextKey): string {
  return (conversationLanguage() === "zh-TW" ? TRADITIONAL_CHINESE : ENGLISH)[key]
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

const TRADITIONAL_CHINESE_ACTIVITIES: Record<ActivityKey, ActivityLabels> = {
  currentTab: { active: "正在確認目前分頁", complete: "已確認目前分頁", error: "無法確認目前分頁" },
  bookmarks: { active: "正在搜尋書籤", complete: "已搜尋書籤", error: "無法搜尋書籤" },
  recentBookmarks: {
    active: "正在讀取最近書籤",
    complete: "已讀取最近書籤",
    error: "無法讀取最近書籤",
  },
  page: { active: "正在讀取頁面", complete: "已讀取頁面", error: "無法讀取頁面" },
  elements: {
    active: "正在尋找頁面控制項",
    complete: "已找到頁面控制項",
    error: "無法尋找頁面控制項",
  },
  selection: { active: "正在讀取選取內容", complete: "已讀取選取內容", error: "無法讀取選取內容" },
  screenshot: { active: "正在擷取可見頁面", complete: "已擷取可見頁面", error: "無法擷取可見頁面" },
  click: {
    active: "正在選取頁面控制項",
    complete: "已選取頁面控制項",
    error: "無法選取頁面控制項",
  },
  type: { active: "正在輸入文字", complete: "已輸入文字", error: "無法輸入文字" },
  navigation: { active: "正在開啟頁面", complete: "已開啟頁面", error: "無法開啟頁面" },
  web: { active: "正在使用頁面功能", complete: "已使用頁面功能", error: "無法使用頁面功能" },
  default: { active: "正在處理頁面", complete: "已完成頁面活動", error: "頁面活動需要注意" },
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
  const labels =
    conversationLanguage() === "zh-TW" ? TRADITIONAL_CHINESE_ACTIVITIES : ENGLISH_ACTIVITIES
  const activity = labels[ACTIVITY_KEYS[name] ?? "default"]
  return error ? activity.error : activity[stage]
}
