import { isPageAnnotationId, PAGE_ANNOTATION_REASONS } from "./page-annotation.js"
import { RuntimeError, type TabContext } from "./types.js"

export const REGION_CAPTURE_LIMITS = {
  minSide: 8,
  maxDimension: 4096,
  maxPixels: 16_000_000,
  maxSourceCharacters: 3_000_000,
  maxBytes: 3_000_000,
  lifetimeMs: 300_000,
} as const

export type RegionCaptureLimits = typeof REGION_CAPTURE_LIMITS
export type RegionRectangle = { x: number; y: number; width: number; height: number }
export type RegionOwner = { clientId: string; operationId: string }
export type RegionCaptureOperation = "start" | "update" | "state" | "freeze" | "resume" | "stop"
export const REGION_CAPTURE_REASONS = [...PAGE_ANNOTATION_REASONS, "unsupported-viewport"] as const
export type RegionCaptureReason = (typeof REGION_CAPTURE_REASONS)[number]
export type RegionCaptureState =
  | { active: false }
  | {
      active: true
      rectangle: RegionRectangle | null
      dragging: boolean
      frozen: boolean
      revision: number
      width: number
      height: number
    }
export type RegionCaptureNotification = {
  kind: "region-capture-state"
  token: string
  tabContext: TabContext
  state: RegionCaptureState
  reason?: RegionCaptureReason
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
function malformed(): never {
  throw new RuntimeError("INVALID_REQUEST", "Malformed region capture data")
}
export function validRegionRectangle(
  value: unknown,
  width = 4096,
  height = 4096,
): value is RegionRectangle {
  return (
    record(value) &&
    keys(value, ["x", "y", "width", "height"]) &&
    [value.x, value.y, value.width, value.height].every(
      (v) => typeof v === "number" && Number.isFinite(v),
    ) &&
    (value.x as number) >= 0 &&
    (value.y as number) >= 0 &&
    (value.width as number) >= REGION_CAPTURE_LIMITS.minSide &&
    (value.height as number) >= REGION_CAPTURE_LIMITS.minSide &&
    (value.x as number) + (value.width as number) <= width &&
    (value.y as number) + (value.height as number) <= height
  )
}
export function validRegionCaptureParams(method: string, value: Record<string, unknown>): boolean {
  if (!isPageAnnotationId(value.clientId) || !isPageAnnotationId(value.operationId)) return false
  const owner = ["clientId", "operationId"]
  if (method === "regionCapture.update")
    return keys(value, [...owner, "rectangle"]) && validRegionRectangle(value.rectangle)
  if (method === "regionCapture.capture")
    return (
      keys(value, [...owner, "maxBytes"]) &&
      integer(value.maxBytes, 1, REGION_CAPTURE_LIMITS.maxBytes)
    )
  return ["regionCapture.start", "regionCapture.stop"].includes(method) && keys(value, owner)
}
export function parseRegionCaptureState(value: unknown): RegionCaptureState {
  if (!record(value)) return malformed()
  if (value.active === false && keys(value, ["active"])) return { active: false }
  if (
    value.active !== true ||
    !keys(value, ["active", "rectangle", "dragging", "frozen", "revision", "width", "height"]) ||
    typeof value.dragging !== "boolean" ||
    typeof value.frozen !== "boolean" ||
    (value.dragging && value.frozen) ||
    !integer(value.revision, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(value.width, 1, REGION_CAPTURE_LIMITS.maxDimension) ||
    !integer(value.height, 1, REGION_CAPTURE_LIMITS.maxDimension) ||
    value.width * value.height > REGION_CAPTURE_LIMITS.maxPixels ||
    !(
      value.rectangle === null || validRegionRectangle(value.rectangle, value.width, value.height)
    ) ||
    (value.frozen && !value.rectangle)
  )
    return malformed()
  return {
    active: true,
    rectangle: value.rectangle,
    dragging: value.dragging,
    frozen: value.frozen,
    revision: value.revision,
    width: value.width,
    height: value.height,
  }
}
export function parseRegionCaptureNotification(value: unknown): RegionCaptureNotification {
  if (
    !record(value) ||
    !keys(value, ["kind", "token", "tabContext", "state", "reason"]) ||
    value.kind !== "region-capture-state" ||
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
    !context.url.length ||
    context.url.length > 16_384
  )
    return malformed()
  const state = parseRegionCaptureState(value.state)
  if (
    value.reason !== undefined &&
    (state.active || !REGION_CAPTURE_REASONS.some((reason) => reason === value.reason))
  )
    return malformed()
  return {
    kind: "region-capture-state",
    token: value.token,
    tabContext: { tabId: context.tabId, url: context.url, epoch: context.epoch },
    state,
    ...(value.reason === undefined ? {} : { reason: value.reason as RegionCaptureReason }),
  }
}
