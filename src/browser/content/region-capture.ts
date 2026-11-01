import type {
  RegionCaptureLimits,
  RegionCaptureOperation,
  RegionCaptureReason,
  RegionCaptureState,
  RegionRectangle,
} from "../runtime/region-capture.js"
import type { TabContext } from "../runtime/types.js"

export interface RegionCaptureOperationResult {
  ok: true
  result: RegionCaptureState & { reason?: RegionCaptureReason }
}

/** Independent fallback for worker restart. A late token cannot remove a newer surface. */
export function stopRegionCaptureInjection(token?: string): RegionCaptureOperationResult {
  const isolated = globalThis as typeof globalThis & {
    __piBrowserAgentRegionCapture?: { token: string; cleanup: () => void }
  }
  const surface = isolated.__piBrowserAgentRegionCapture
  if (surface && (token === undefined || token === surface.token)) surface.cleanup()
  return { ok: true, result: { active: false } }
}

/** Serialized by chrome.scripting.executeScript: keep all runtime helpers inside this function. */
export async function executeRegionCapture(
  operation: RegionCaptureOperation,
  token: string,
  expectedContext: TabContext,
  rectangle: RegionRectangle | null,
  limits: RegionCaptureLimits,
): Promise<RegionCaptureOperationResult> {
  type Surface = {
    token: string
    cleanup: () => void
    control: (
      operation: RegionCaptureOperation,
      rectangle: RegionRectangle | null,
    ) => Promise<RegionCaptureOperationResult>
  }
  const isolated = globalThis as typeof globalThis & { __piBrowserAgentRegionCapture?: Surface }
  const previous = isolated.__piBrowserAgentRegionCapture
  if (operation === "stop") {
    if (previous?.token === token) previous.cleanup()
    return { ok: true, result: { active: false } }
  }
  if (operation !== "start") {
    if (previous?.token !== token)
      return { ok: true, result: { active: false, reason: "cancelled" } }
    return previous.control(operation, rectangle)
  }
  previous?.cleanup()
  const inactive = (reason: RegionCaptureReason): RegionCaptureOperationResult => ({
    ok: true,
    result: { active: false, reason },
  })
  if (
    location.href !== expectedContext.url ||
    document.visibilityState !== "visible" ||
    !document.documentElement
  )
    return inactive("cancelled")

  const width = window.innerWidth
  const height = window.innerHeight
  const dpr = window.devicePixelRatio
  const viewport = window.visualViewport
  // Pinch zoom changes the capture's visual viewport independently of CSS client geometry.
  if (viewport && (viewport.scale !== 1 || viewport.offsetLeft !== 0 || viewport.offsetTop !== 0))
    return inactive("unsupported-viewport")
  if (
    ![width, height].every(
      (value) => Number.isSafeInteger(value) && value > 0 && value <= limits.maxDimension,
    ) ||
    !Number.isFinite(dpr) ||
    dpr <= 0 ||
    width * height > limits.maxPixels
  )
    return inactive("overlay-unavailable")
  const validRectangle = (value: RegionRectangle | null): value is RegionRectangle =>
    value !== null &&
    [value.x, value.y, value.width, value.height].every(Number.isFinite) &&
    value.x >= 0 &&
    value.y >= 0 &&
    value.width >= limits.minSide &&
    value.height >= limits.minSide &&
    value.x + value.width <= width &&
    value.y + value.height <= height
  let selection: RegionRectangle | null = null
  let painted: RegionRectangle | null = null
  // Never alter page-owned dialogs, layout, zoom, or styles.
  const parent =
    document.elementFromPoint(width / 2, height / 2)?.closest("dialog:modal") ??
    document.documentElement
  const previousFocus = document.activeElement
  const host = document.createElement("div")
  host.dataset.piBrowserAgentRegionCapture = ""
  host.popover = "manual"
  host.tabIndex = -1
  for (const [name, value] of Object.entries({
    all: "initial",
    "background-color": "rgba(0, 0, 0, 0.01)", // Painted OOPIF input shield; do not make transparent.
    contain: "strict",
    cursor: "crosshair",
    display: "block",
    "forced-color-adjust": "none",
    height: "calc(100vh + 1px)",
    inset: "0",
    margin: "0",
    opacity: "1",
    filter: "none",
    outline: "none",
    padding: "0",
    "pointer-events": "auto",
    position: "fixed",
    "touch-action": "none",
    visibility: "visible",
    width: "calc(100vw + 1px)",
    zoom: "1",
  }))
    host.style.setProperty(name, value, "important")
  const cssZoom = (element: Element): number => {
    let scale = 1
    for (let current: Element | null = element; current; current = current.parentElement) {
      const value = getComputedStyle(current).zoom
      const zoom = Number.parseFloat(value)
      if (Number.isFinite(zoom) && zoom > 0) scale *= value.endsWith("%") ? zoom / 100 : zoom
    }
    return scale
  }
  const initialZoom = cssZoom(parent)
  let legacyZoomGeometry = false
  const fitShield = (): void => {
    host.style.setProperty("zoom", String(2 / initialZoom), "important")
    const computedWidth = Number.parseFloat(getComputedStyle(host).width)
    legacyZoomGeometry = Math.abs(host.getBoundingClientRect().width / computedWidth - 1) < 0.1
    host.style.setProperty("zoom", String(1 / initialZoom), "important")
  }
  const shadow = host.attachShadow({ mode: "closed" })
  const style = document.createElement("style")
  style.textContent =
    ":host::backdrop { background:transparent!important;pointer-events:none!important }"
  const outline = document.createElement("div")
  outline.style.cssText =
    "position:absolute;box-sizing:border-box;border:2px solid #3b82f6;pointer-events:none;display:none"
  shadow.append(style, outline)
  const controller = new AbortController()
  let origin: { x: number; y: number } | undefined
  let pointer: number | undefined
  let revision = 0
  let frozen = false
  let cleaned = false
  let reason: RegionCaptureReason = "cancelled"
  let frame = 0
  let expiryTimer = 0
  let notification: Promise<unknown> = Promise.resolve()
  let stopListener:
    | ((
        message: unknown,
        sender: chrome.runtime.MessageSender,
        respond: (value: unknown) => void,
      ) => boolean)
    | undefined
  const waits = new Set<() => void>()
  const paintFrames = new Set<number>()
  const initialViewport = viewport
    ? [viewport.width, viewport.height, viewport.scale, viewport.offsetLeft, viewport.offsetTop]
    : []
  const scroll = [window.scrollX, window.scrollY]
  const state = (): RegionCaptureState =>
    cleaned
      ? { active: false }
      : {
          active: true,
          rectangle: selection,
          dragging: pointer !== undefined,
          frozen,
          revision,
          width,
          height,
        }
  const result = (): RegionCaptureOperationResult => ({
    ok: true,
    result: { ...state(), ...(cleaned ? { reason } : {}) },
  })
  const geometryIntact = (): boolean =>
    width === window.innerWidth &&
    height === window.innerHeight &&
    dpr === window.devicePixelRatio &&
    initialZoom === cssZoom(parent) &&
    scroll[0] === window.scrollX &&
    scroll[1] === window.scrollY &&
    (!viewport ||
      initialViewport.every(
        (value, index) =>
          value ===
          [
            viewport.width,
            viewport.height,
            viewport.scale,
            viewport.offsetLeft,
            viewport.offsetTop,
          ][index],
      ))
  const shieldIntact = (): boolean => {
    const computed = getComputedStyle(host)
    const rectangle = host.getBoundingClientRect()
    const scale = legacyZoomGeometry ? cssZoom(host) : 1
    return (
      host.isConnected &&
      host.parentElement === parent &&
      host.matches(":popover-open") &&
      !host.hidden &&
      computed.display !== "none" &&
      !["hidden", "collapse"].includes(computed.visibility) &&
      host.style.pointerEvents === "auto" &&
      host.style.getPropertyPriority("pointer-events") === "important" &&
      computed.pointerEvents === "auto" &&
      computed.backgroundColor === "rgba(0, 0, 0, 0.01)" &&
      computed.position === "fixed" &&
      ["", "none"].includes(computed.transform) &&
      ["", "none"].includes(computed.clipPath) &&
      ["", "none"].includes(computed.getPropertyValue("mask-image")) &&
      ["", "none"].includes(computed.getPropertyValue("-webkit-mask-image")) &&
      computed.filter === "none" &&
      computed.opacity === "1" &&
      computed.touchAction === "none" &&
      rectangle.left * scale <= 0 &&
      rectangle.top * scale <= 0 &&
      rectangle.right * scale >= width &&
      rectangle.bottom * scale >= height &&
      [0.05, 0.5, 0.95].every((x) =>
        [0.05, 0.5, 0.95].every((y) => document.elementFromPoint(width * x, height * y) === host),
      )
    )
  }
  const emit = (cancelReason?: RegionCaptureReason): void => {
    // Only bounded state transitions are sent; vectors and page data never leave this world.
    notification = chrome.runtime
      .sendMessage({
        kind: "region-capture-state",
        token,
        tabContext: expectedContext,
        state: state(),
        ...(cancelReason ? { reason: cancelReason } : {}),
      })
      .catch(() => undefined)
  }
  const redraw = (): void => {
    outline.style.display = !frozen && painted ? "block" : "none"
    if (painted) {
      outline.style.left = `${painted.x}px`
      outline.style.top = `${painted.y}px`
      outline.style.width = `${painted.width}px`
      outline.style.height = `${painted.height}px`
    }
  }
  const observer = new MutationObserver(() => validate())
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    controller.abort()
    observer.disconnect()
    if (stopListener) chrome.runtime.onMessage.removeListener(stopListener)
    if (frame) cancelAnimationFrame(frame)
    if (expiryTimer) clearTimeout(expiryTimer)
    for (const id of paintFrames) cancelAnimationFrame(id)
    paintFrames.clear()
    for (const resolve of waits) resolve()
    waits.clear()
    if (pointer !== undefined) {
      try {
        host.releasePointerCapture(pointer)
      } catch {
        /* The pointer can already be released. */
      }
    }
    pointer = undefined
    origin = undefined
    selection = painted = null
    const restoreFocus = document.activeElement === host
    try {
      host.hidePopover()
    } catch {
      /* The popover can already be closed. */
    }
    host.remove()
    if (isolated.__piBrowserAgentRegionCapture?.token === token)
      delete isolated.__piBrowserAgentRegionCapture
    if (restoreFocus && previousFocus instanceof HTMLElement && previousFocus.isConnected)
      previousFocus.focus({ preventScroll: true })
  }
  const cancel = (value: RegionCaptureReason): void => {
    if (cleaned) return
    reason = value
    cleanup()
    emit(value)
  }
  function validate(): boolean {
    if (cleaned) return false
    if (!geometryIntact()) cancel("viewport-changed")
    else if (location.href !== expectedContext.url || document.visibilityState !== "visible")
      cancel("page")
    else if (!shieldIntact() || document.activeElement !== host) cancel("protection-lost")
    return !cleaned
  }
  const waitForPaint = async (): Promise<void> => {
    if (cleaned) return
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        waits.delete(finish)
        resolve()
      }
      waits.add(finish)
      const next = (callback: () => void): void => {
        const id = requestAnimationFrame(() => {
          paintFrames.delete(id)
          callback()
        })
        paintFrames.add(id)
      }
      next(() => next(finish))
    })
  }
  const control: Surface["control"] = async (action, value) => {
    if (!validate()) return result()
    if (action === "freeze") {
      if (pointer !== undefined || !selection) return result()
      frozen = true
      revision += 1
      redraw()
      emit()
      await waitForPaint()
      validate()
      return result()
    }
    if (action === "state") return result()
    if (action === "resume") {
      frozen = false
      revision += 1
    } else if (frozen || pointer !== undefined) return result()
    else if (action === "update") {
      if (!validRectangle(value)) return result()
      selection = painted = { ...value }
      revision += 1
    }
    redraw()
    emit()
    return result()
  }
  const block = (event: Event): void => {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const addPoint = (event: PointerEvent): void => {
    if (!origin || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return
    const x = Math.max(0, Math.min(width, event.clientX))
    const y = Math.max(0, Math.min(height, event.clientY))
    painted = {
      x: Math.min(origin.x, x),
      y: Math.min(origin.y, y),
      width: Math.abs(x - origin.x),
      height: Math.abs(y - origin.y),
    }
    selection = validRectangle(painted) ? { ...painted } : null
    revision += 1
    redraw()
  }
  const finishPointer = (discard: boolean): void => {
    const id = pointer
    pointer = undefined
    origin = undefined
    if (discard) selection = painted = null
    else painted = selection
    revision += 1
    if (id !== undefined) {
      try {
        host.releasePointerCapture(id)
      } catch {
        /* Already released. */
      }
    }
    redraw()
    emit()
  }
  try {
    parent.append(host)
    host.showPopover()
    fitShield()
    host.focus({ preventScroll: true })
    if (!shieldIntact() || document.activeElement !== host) {
      cleanup()
      return inactive("overlay-unavailable")
    }
  } catch {
    cleanup()
    return inactive("overlay-unavailable")
  }
  try {
    if (typeof chrome.runtime.onMessage?.addListener === "function") {
      stopListener = (message, sender, respond) => {
        if (
          sender.id !== chrome.runtime.id ||
          typeof message !== "object" ||
          message === null ||
          !("kind" in message) ||
          message.kind !== "region-capture-stop"
        )
          return false
        if (!("token" in message) || message.token === token) cleanup()
        respond({ active: false })
        return false
      }
      chrome.runtime.onMessage.addListener(stopListener)
    }
    const listen = (name: string, callback: EventListener): void =>
      window.addEventListener(name, callback, {
        capture: true,
        passive: false,
        signal: controller.signal,
      })
    listen("pointerdown", (raw) => {
      block(raw)
      const event = raw as PointerEvent
      if (
        !event.isTrusted ||
        !validate() ||
        frozen ||
        pointer !== undefined ||
        event.button !== 0 ||
        !event.isPrimary ||
        !Number.isFinite(event.clientX) ||
        !Number.isFinite(event.clientY)
      )
        return
      try {
        host.setPointerCapture(event.pointerId)
      } catch {
        cancel("protection-lost")
        return
      }
      pointer = event.pointerId
      revision += 1
      origin = {
        x: Math.max(0, Math.min(width, event.clientX)),
        y: Math.max(0, Math.min(height, event.clientY)),
      }
      selection = painted = null
      addPoint(event)
      emit()
    })
    listen("pointermove", (raw) => {
      block(raw)
      const event = raw as PointerEvent
      if (event.isTrusted && validate() && event.pointerId === pointer) {
        addPoint(event)
        emit()
      }
    })
    listen("pointerup", (raw) => {
      block(raw)
      const event = raw as PointerEvent
      if (event.isTrusted && validate() && event.pointerId === pointer) {
        addPoint(event)
        finishPointer(false)
      }
    })
    for (const name of ["pointercancel", "lostpointercapture"])
      listen(name, (raw) => {
        block(raw)
        if (raw.isTrusted && (raw as PointerEvent).pointerId === pointer) finishPointer(true)
      })
    for (const name of [
      "click",
      "auxclick",
      "dblclick",
      "contextmenu",
      "dragstart",
      "drag",
      "drop",
      "wheel",
      "touchstart",
      "touchmove",
      "touchend",
      "keypress",
      "keyup",
    ])
      listen(name, block)
    listen("keydown", (raw) => {
      block(raw)
      if ((raw as KeyboardEvent).key === "Escape") cancel("user")
    })
    for (const name of ["scroll", "resize"]) listen(name, () => cancel("viewport-changed"))
    viewport?.addEventListener("resize", () => cancel("viewport-changed"), {
      signal: controller.signal,
    })
    viewport?.addEventListener("scroll", () => cancel("viewport-changed"), {
      signal: controller.signal,
    })
    listen("focusin", () => {
      if (document.activeElement !== host) cancel("protection-lost")
    })
    for (const name of ["blur", "focus"])
      listen(name, (event) => {
        if (event.target === window)
          queueMicrotask(() => {
            if (!cleaned && document.activeElement !== host) cancel("protection-lost")
          })
      })
    listen("beforetoggle", (raw) => {
      const event = raw as ToggleEvent
      if (
        (event.target === host && event.newState === "closed") ||
        (event.target !== host && event.newState === "open")
      )
        cancel("protection-lost")
    })
    document.addEventListener("fullscreenchange", () => cancel("protection-lost"), {
      signal: controller.signal,
    })
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState !== "visible") cancel("page")
      },
      { signal: controller.signal },
    )
    listen("pagehide", () => cancel("page"))
    observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true })
    const monitor = (): void => {
      if (validate()) frame = requestAnimationFrame(monitor)
    }
    frame = requestAnimationFrame(monitor)
    expiryTimer = window.setTimeout(() => cancel("timeout"), limits.lifetimeMs)
    isolated.__piBrowserAgentRegionCapture = { token, cleanup, control }
    await waitForPaint()
    validate()
    if (cleaned) await notification
    return result()
  } catch {
    cleanup()
    return inactive("overlay-unavailable")
  }
}
