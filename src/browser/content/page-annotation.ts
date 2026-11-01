import type {
  PageAnnotationLimits,
  PageAnnotationMark,
  PageAnnotationOperation,
  PageAnnotationReason,
  PageAnnotationSettings,
  PageAnnotationState,
} from "../runtime/page-annotation.js"
import type { TabContext } from "../runtime/types.js"

export interface PageAnnotationOperationResult {
  ok: true
  result: PageAnnotationState & { reason?: PageAnnotationReason }
}

/** Independent fallback for worker restart. A late token cannot remove a newer surface. */
export function stopPageAnnotationInjection(token?: string): PageAnnotationOperationResult {
  const isolated = globalThis as typeof globalThis & {
    __piBrowserAgentPageAnnotation?: { token: string; cleanup: () => void }
  }
  const surface = isolated.__piBrowserAgentPageAnnotation
  if (surface && (token === undefined || token === surface.token)) surface.cleanup()
  return { ok: true, result: { active: false } }
}

/** Serialized by chrome.scripting.executeScript: keep all runtime helpers inside this function. */
export async function executePageAnnotation(
  operation: PageAnnotationOperation,
  token: string,
  expectedContext: TabContext,
  settings: PageAnnotationSettings,
  limits: PageAnnotationLimits,
): Promise<PageAnnotationOperationResult> {
  type Surface = {
    token: string
    cleanup: () => void
    control: (
      operation: PageAnnotationOperation,
      settings: PageAnnotationSettings,
    ) => Promise<PageAnnotationOperationResult>
  }
  const isolated = globalThis as typeof globalThis & { __piBrowserAgentPageAnnotation?: Surface }
  const previous = isolated.__piBrowserAgentPageAnnotation
  if (operation === "stop") {
    if (previous?.token === token) previous.cleanup()
    return { ok: true, result: { active: false } }
  }
  if (operation !== "start") {
    if (previous?.token !== token)
      return { ok: true, result: { active: false, reason: "cancelled" } }
    return previous.control(operation, settings)
  }
  previous?.cleanup()
  const inactive = (reason: PageAnnotationReason): PageAnnotationOperationResult => ({
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
  const pixelWidth = Math.ceil(width * dpr)
  const pixelHeight = Math.ceil(height * dpr)
  if (
    ![width, height, pixelWidth, pixelHeight].every(
      (value) => Number.isSafeInteger(value) && value > 0 && value <= limits.maxCanvasDimension,
    ) ||
    !Number.isFinite(dpr) ||
    dpr <= 0 ||
    pixelWidth * pixelHeight > limits.maxCanvasPixels
  )
    return inactive("overlay-unavailable")
  const validSettings = (value: PageAnnotationSettings): boolean =>
    Object.keys(value).every((key) => ["color", "width", "tool"].includes(key)) &&
    (value.tool === undefined || ["pen", "arrow", "rectangle"].includes(value.tool)) &&
    Object.hasOwn(limits.colors, value.color) &&
    Number.isSafeInteger(value.width) &&
    value.width >= limits.minPenWidth &&
    value.width <= limits.maxPenWidth
  if (!validSettings(settings)) return inactive("invalid-result")
  let pen = { ...settings, tool: settings.tool ?? "pen" }
  // Never alter page-owned dialogs, layout, zoom, or styles.
  const parent =
    document.elementFromPoint(width / 2, height / 2)?.closest("dialog:modal") ??
    document.documentElement
  const previousFocus = document.activeElement
  const host = document.createElement("div")
  host.dataset.piBrowserAgentPageAnnotation = ""
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
  const canvas = document.createElement("canvas")
  canvas.width = pixelWidth
  canvas.height = pixelHeight
  canvas.style.cssText = `display:block;width:${width}px;height:${height}px;pointer-events:none`
  shadow.append(style, canvas)
  let context2d: CanvasRenderingContext2D | null
  try {
    context2d = canvas.getContext("2d")
  } catch {
    return inactive("overlay-unavailable")
  }
  if (!context2d) return inactive("overlay-unavailable")
  const paint = context2d
  const controller = new AbortController()
  const strokes: PageAnnotationMark[] = []
  let current: PageAnnotationMark | undefined
  let pointer: number | undefined
  let pointCount = 0
  let revision = 0
  let frozen = false
  let cleaned = false
  let reason: PageAnnotationReason = "cancelled"
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
  const viewport = window.visualViewport
  const initialViewport = viewport
    ? [viewport.width, viewport.height, viewport.scale, viewport.offsetLeft, viewport.offsetTop]
    : []
  const scroll = [window.scrollX, window.scrollY]
  const state = (): PageAnnotationState =>
    cleaned
      ? { active: false }
      : {
          active: true,
          hasStrokes: strokes.length > 0,
          drawing: pointer !== undefined,
          frozen,
          revision,
          width,
          height,
        }
  const result = (): PageAnnotationOperationResult => ({
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
  const emit = (cancelReason?: PageAnnotationReason): void => {
    // Only bounded state transitions are sent; vectors and page data never leave this world.
    notification = chrome.runtime
      .sendMessage({
        kind: "page-annotation-state",
        token,
        tabContext: expectedContext,
        state: state(),
        ...(cancelReason ? { reason: cancelReason } : {}),
      })
      .catch(() => undefined)
  }
  const completeMark = (mark: PageAnnotationMark): boolean => {
    if (mark.tool === "pen") return mark.points.length > 0
    const [start, end] = mark.points
    const dx = Math.abs(end.x - start.x)
    const dy = Math.abs(end.y - start.y)
    return mark.tool === "arrow"
      ? Math.hypot(dx, dy) >= limits.minShapeSize
      : dx >= limits.minShapeSize && dy >= limits.minShapeSize
  }
  const redraw = (): void => {
    paint.setTransform(1, 0, 0, 1, 0, 0)
    paint.clearRect(0, 0, pixelWidth, pixelHeight)
    paint.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0)
    for (const stroke of current ? [...strokes, current] : strokes) {
      paint.lineCap = "round"
      paint.lineJoin = "round"
      paint.lineWidth = stroke.width
      paint.strokeStyle = limits.colors[stroke.color]
      paint.fillStyle = limits.colors[stroke.color]
      const first = stroke.points[0]
      if (!first || !completeMark(stroke)) continue
      paint.beginPath()
      if (stroke.tool === "rectangle") {
        const end = stroke.points[1]
        paint.rect(
          Math.min(first.x, end.x),
          Math.min(first.y, end.y),
          Math.abs(end.x - first.x),
          Math.abs(end.y - first.y),
        )
        paint.stroke()
      } else if (stroke.tool === "arrow") {
        const end = stroke.points[1]
        const length = Math.hypot(end.x - first.x, end.y - first.y)
        const ux = (end.x - first.x) / length
        const uy = (end.y - first.y) / length
        const head = Math.min(48, Math.max(12, stroke.width * 3), length * 0.4)
        paint.moveTo(first.x, first.y)
        paint.lineTo(end.x, end.y)
        paint.moveTo(end.x - ux * head - uy * head * 0.5, end.y - uy * head + ux * head * 0.5)
        paint.lineTo(end.x, end.y)
        paint.lineTo(end.x - ux * head + uy * head * 0.5, end.y - uy * head - ux * head * 0.5)
        paint.stroke()
      } else if (stroke.points.length === 1) {
        paint.arc(first.x, first.y, stroke.width / 2, 0, Math.PI * 2)
        paint.fill()
      } else {
        paint.moveTo(first.x, first.y)
        for (const point of stroke.points.slice(1)) paint.lineTo(point.x, point.y)
        paint.stroke()
      }
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
    current = undefined
    strokes.length = 0
    const restoreFocus = document.activeElement === host
    try {
      host.hidePopover()
    } catch {
      /* The popover can already be closed. */
    }
    host.remove()
    if (isolated.__piBrowserAgentPageAnnotation?.token === token)
      delete isolated.__piBrowserAgentPageAnnotation
    if (restoreFocus && previousFocus instanceof HTMLElement && previousFocus.isConnected)
      previousFocus.focus({ preventScroll: true })
  }
  const cancel = (value: PageAnnotationReason): void => {
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
      if (pointer !== undefined || strokes.length === 0) return result()
      frozen = true
      revision += 1
      emit()
      await waitForPaint()
      validate()
      return result()
    }
    if (action === "state") return result()
    if (action === "resume") {
      frozen = false
      revision += 1
    } else if (action === "tool" || action === "color" || action === "width") {
      if (frozen || !validSettings(value)) throw new Error("Page drawing settings were not applied")
      // A delayed idle update can arrive after pointer down. Only the next mark uses it.
      pen = {
        tool: action === "tool" ? (value.tool ?? "pen") : pen.tool,
        color: action === "color" ? value.color : pen.color,
        width: action === "width" ? value.width : pen.width,
      }
      revision += 1
    } else if (frozen || pointer !== undefined) return result()
    else if (action === "undo") {
      const removed = strokes.pop()
      if (removed) {
        pointCount -= removed.points.length
        revision += 1
        redraw()
      }
    } else if (action === "clear") {
      if (strokes.length > 0) {
        strokes.length = 0
        pointCount = 0
        revision += 1
        redraw()
      }
    }
    emit()
    return result()
  }
  const block = (event: Event): void => {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const clampedPoint = (event: PointerEvent): { x: number; y: number } => ({
    x: Math.max(0, Math.min(width, event.clientX)),
    y: Math.max(0, Math.min(height, event.clientY)),
  })
  const addPoint = (event: PointerEvent): void => {
    if (!current || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return
    const point = clampedPoint(event)
    const last = current.points.at(-1)
    if (last?.x === point.x && last.y === point.y) return
    if (current.tool === "pen") {
      if (current.points.length >= limits.maxPointsPerStroke || pointCount >= limits.maxTotalPoints)
        return
      current.points.push(point)
      pointCount += 1
    } else current.points[1] = point
    redraw()
  }
  const finishPointer = (discard: boolean): void => {
    const id = pointer
    pointer = undefined
    if (current) {
      if (discard || !completeMark(current)) pointCount -= current.points.length
      else {
        strokes.push(current)
      }
      revision += 1
      current = undefined
    }
    if (id !== undefined) {
      try {
        host.releasePointerCapture(id)
      } catch {
        /* The pointer can already be released. */
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
          message.kind !== "page-annotation-stop"
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
        strokes.length >= limits.maxStrokes ||
        pointCount + (pen.tool === "pen" ? 1 : 2) > limits.maxTotalPoints ||
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
      const point = clampedPoint(event)
      current =
        pen.tool === "pen"
          ? { ...pen, tool: "pen", points: [point] }
          : { ...pen, tool: pen.tool, points: [point, point] }
      pointCount += current.points.length
      redraw()
      emit()
    })
    listen("pointermove", (raw) => {
      block(raw)
      const event = raw as PointerEvent
      if (event.isTrusted && validate() && event.pointerId === pointer) addPoint(event)
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
    isolated.__piBrowserAgentPageAnnotation = { token, cleanup, control }
    await waitForPaint()
    validate()
    if (cleaned) await notification
    return result()
  } catch {
    cleanup()
    return inactive("overlay-unavailable")
  }
}
