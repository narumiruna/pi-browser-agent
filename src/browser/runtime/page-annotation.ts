import { RuntimeError, type TabContext } from "./types.js"

export const PAGE_ANNOTATION_COLORS = {
  red: "#ef4444",
  yellow: "#eab308",
  green: "#22c55e",
  blue: "#3b82f6",
  white: "#ffffff",
  black: "#000000",
} as const

export const PAGE_ANNOTATION_LIMITS = {
  minPenWidth: 2,
  maxPenWidth: 32,
  defaultPenWidth: 8,
  minShapeSize: 4,
  maxStrokes: 256,
  maxPointsPerStroke: 4096,
  maxTotalPoints: 8192,
  maxCanvasDimension: 4096,
  maxCanvasPixels: 16_000_000,
  lifetimeMs: 300_000,
} as const

export type PageAnnotationColor = keyof typeof PAGE_ANNOTATION_COLORS
export type PageAnnotationLimits = typeof PAGE_ANNOTATION_LIMITS & {
  colors: Record<PageAnnotationColor, string>
}
export const PAGE_ANNOTATION_TOOLS = ["pen", "arrow", "rectangle"] as const
export type PageAnnotationTool = (typeof PAGE_ANNOTATION_TOOLS)[number]
export type PageAnnotationSettings = {
  color: PageAnnotationColor
  width: number
  tool?: PageAnnotationTool
}
export type PageAnnotationOperation =
  | "start"
  | "tool"
  | "color"
  | "width"
  | "undo"
  | "clear"
  | "freeze"
  | "resume"
  | "state"
  | "stop"
export type PageAnnotationUpdate =
  | { clientId: string; action: "tool"; tool: PageAnnotationTool }
  | { clientId: string; action: "color"; color: PageAnnotationColor }
  | { clientId: string; action: "width"; width: number }
  | { clientId: string; action: "undo" | "clear" | "resume" }
export type PageAnnotationState =
  | { active: false }
  | {
      active: true
      hasStrokes: boolean
      drawing: boolean
      frozen: boolean
      revision: number
      width: number
      height: number
    }
export const PAGE_ANNOTATION_REASONS = [
  "user",
  "page",
  "cancelled",
  "timeout",
  "replaced",
  "panel-disconnected",
  "tab-context-cleared",
  "tab-changed",
  "tab-activated",
  "window-focus-changed",
  "navigation",
  "access-revoked",
  "overlay-unavailable",
  "protection-lost",
  "viewport-changed",
  "invalid-result",
] as const
export type PageAnnotationReason = (typeof PAGE_ANNOTATION_REASONS)[number]
export type PageAnnotationNotification = {
  kind: "page-annotation-state"
  token: string
  tabContext: TabContext
  state: PageAnnotationState
  reason?: PageAnnotationReason
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}
function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
}
export function isPageAnnotationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
  )
}
export function isPageAnnotationColor(value: unknown): value is PageAnnotationColor {
  return typeof value === "string" && Object.hasOwn(PAGE_ANNOTATION_COLORS, value)
}
export function isPageAnnotationTool(value: unknown): value is PageAnnotationTool {
  return PAGE_ANNOTATION_TOOLS.some((tool) => tool === value)
}
export function isPageAnnotationWidth(value: unknown): value is number {
  return integer(value, PAGE_ANNOTATION_LIMITS.minPenWidth, PAGE_ANNOTATION_LIMITS.maxPenWidth)
}
export function validPageAnnotationParams(method: string, value: Record<string, unknown>): boolean {
  if (!isPageAnnotationId(value.clientId)) return false
  switch (method) {
    case "pageAnnotation.start":
      return (
        keys(value, ["clientId", "color", "width", "tool"]) &&
        (value.tool === undefined || isPageAnnotationTool(value.tool)) &&
        isPageAnnotationColor(value.color) &&
        isPageAnnotationWidth(value.width)
      )
    case "pageAnnotation.capture":
    case "pageAnnotation.stop":
      return keys(value, ["clientId"])
    case "pageAnnotation.update":
      if (value.action === "tool")
        return keys(value, ["clientId", "action", "tool"]) && isPageAnnotationTool(value.tool)
      if (value.action === "color")
        return keys(value, ["clientId", "action", "color"]) && isPageAnnotationColor(value.color)
      if (value.action === "width")
        return keys(value, ["clientId", "action", "width"]) && isPageAnnotationWidth(value.width)
      return (
        keys(value, ["clientId", "action"]) &&
        ["undo", "clear", "resume"].includes(String(value.action))
      )
    default:
      return false
  }
}
function malformed(): never {
  throw new RuntimeError("INVALID_REQUEST", "Malformed page annotation data")
}
export function parsePageAnnotationState(value: unknown): PageAnnotationState {
  if (!record(value)) return malformed()
  if (value.active === false && keys(value, ["active"])) return { active: false }
  if (
    value.active !== true ||
    !keys(value, ["active", "hasStrokes", "drawing", "frozen", "revision", "width", "height"]) ||
    typeof value.hasStrokes !== "boolean" ||
    typeof value.drawing !== "boolean" ||
    typeof value.frozen !== "boolean" ||
    (value.drawing && value.frozen) ||
    !integer(value.revision, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(value.width, 1, PAGE_ANNOTATION_LIMITS.maxCanvasDimension) ||
    !integer(value.height, 1, PAGE_ANNOTATION_LIMITS.maxCanvasDimension) ||
    value.width * value.height > PAGE_ANNOTATION_LIMITS.maxCanvasPixels
  )
    return malformed()
  return {
    active: true,
    hasStrokes: value.hasStrokes,
    drawing: value.drawing,
    frozen: value.frozen,
    revision: value.revision,
    width: value.width,
    height: value.height,
  }
}
export function parsePageAnnotationNotification(value: unknown): PageAnnotationNotification {
  if (
    !record(value) ||
    !keys(value, ["kind", "token", "tabContext", "state", "reason"]) ||
    value.kind !== "page-annotation-state" ||
    !isPageAnnotationId(value.token)
  )
    return malformed()
  const context = value.tabContext
  if (
    !record(context) ||
    !keys(context, ["tabId", "url", "epoch"]) ||
    !integer(context.tabId, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(context.epoch, 0, Number.MAX_SAFE_INTEGER) ||
    typeof context.url !== "string" ||
    context.url.length === 0 ||
    context.url.length > 16_384
  )
    return malformed()
  const state = parsePageAnnotationState(value.state)
  if (
    value.reason !== undefined &&
    (state.active || !PAGE_ANNOTATION_REASONS.some((reason) => reason === value.reason))
  )
    return malformed()
  return {
    kind: "page-annotation-state",
    token: value.token,
    tabContext: { tabId: context.tabId, url: context.url, epoch: context.epoch },
    state,
    ...(value.reason === undefined ? {} : { reason: value.reason as PageAnnotationReason }),
  }
}

export type PageAnnotationStroke = {
  color: PageAnnotationColor
  width: number
  points: { x: number; y: number }[]
}
export type PageAnnotationMark =
  | ({ tool: "pen" } & PageAnnotationStroke)
  | {
      tool: "arrow" | "rectangle"
      color: PageAnnotationColor
      width: number
      points: [{ x: number; y: number }, { x: number; y: number }]
    }

/** Validate local marks; shapes consume exactly two points in the shared budget. */
export function parsePageAnnotationMarks(
  value: unknown,
  width: number,
  height: number,
): PageAnnotationMark[] {
  if (!Array.isArray(value) || value.length > PAGE_ANNOTATION_LIMITS.maxStrokes) return malformed()
  const strokes = parsePageAnnotationStrokes(
    Array.from(value, (mark: unknown) => {
      if (
        !record(mark) ||
        !keys(mark, ["tool", "color", "width", "points"]) ||
        !isPageAnnotationTool(mark.tool)
      )
        return malformed()
      return { color: mark.color, width: mark.width, points: mark.points }
    }),
    width,
    height,
  )
  return strokes.map((stroke, index) => {
    const tool: PageAnnotationTool = value[index].tool
    if (tool === "pen") return { ...stroke, tool }
    const [start, end] = stroke.points
    if (!start || !end || stroke.points.length !== 2) return malformed()
    const dx = Math.abs(end.x - start.x)
    const dy = Math.abs(end.y - start.y)
    if (
      tool === "arrow"
        ? Math.hypot(dx, dy) < PAGE_ANNOTATION_LIMITS.minShapeSize
        : dx < PAGE_ANNOTATION_LIMITS.minShapeSize || dy < PAGE_ANNOTATION_LIMITS.minShapeSize
    )
      return malformed()
    return { tool, color: stroke.color, width: stroke.width, points: [start, end] }
  })
}

/** Validate local vector data without permitting arbitrary CSS or unbounded history. */
export function parsePageAnnotationStrokes(
  value: unknown,
  width: number,
  height: number,
): PageAnnotationStroke[] {
  parsePageAnnotationState({
    active: true,
    hasStrokes: false,
    drawing: false,
    frozen: false,
    revision: 0,
    width,
    height,
  })
  if (!Array.isArray(value) || value.length > PAGE_ANNOTATION_LIMITS.maxStrokes) return malformed()
  let total = 0
  return value.map((stroke) => {
    if (
      !record(stroke) ||
      !keys(stroke, ["color", "width", "points"]) ||
      !isPageAnnotationColor(stroke.color) ||
      !isPageAnnotationWidth(stroke.width) ||
      !Array.isArray(stroke.points) ||
      stroke.points.length === 0 ||
      stroke.points.length > PAGE_ANNOTATION_LIMITS.maxPointsPerStroke
    )
      return malformed()
    total += stroke.points.length
    if (total > PAGE_ANNOTATION_LIMITS.maxTotalPoints) return malformed()
    const points = Array.from(stroke.points, (point: unknown) => {
      if (
        !record(point) ||
        !keys(point, ["x", "y"]) ||
        typeof point.x !== "number" ||
        !Number.isFinite(point.x) ||
        point.x < 0 ||
        point.x > width ||
        typeof point.y !== "number" ||
        !Number.isFinite(point.y) ||
        point.y < 0 ||
        point.y > height
      )
        return malformed()
      return { x: point.x, y: point.y }
    })
    return { color: stroke.color, width: stroke.width, points }
  })
}
