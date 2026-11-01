import { vi } from "vitest"
import { mockElementPickerSurface } from "./element-picker-surface.js"

/** Layout and trusted Pointer Events are absent in jsdom. Chrome proof covers real routing. */
export function mockPageAnnotationSurface() {
  const restoreTopLayer = mockElementPickerSurface()
  const frames = new Map<number, FrameRequestCallback>()
  const handlers = new Map<string, EventListener>()
  const paint = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    rect: vi.fn(),
    fill: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    lineCap: "",
    lineJoin: "",
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: "",
  }
  const capture = vi.fn()
  const release = vi.fn()
  let nextFrame = 0
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    paint as unknown as CanvasRenderingContext2D,
  )
  const addListener = window.addEventListener.bind(window)
  vi.spyOn(window, "addEventListener").mockImplementation((name, callback, options) => {
    if (typeof callback === "function") handlers.set(name, callback as EventListener)
    addListener(name, callback, options)
  })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, window.innerWidth + 1, window.innerHeight + 1),
  )
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: capture,
  })
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: release,
  })
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id))
  return {
    paint,
    capture,
    release,
    frames,
    advanceFrames(count = 2) {
      for (let index = 0; index < count; index += 1) {
        const batch = [...frames.values()]
        frames.clear()
        for (const callback of batch) callback(0)
      }
    },
    pointer(name: string, values: Partial<PointerEvent> = {}) {
      const event = {
        isTrusted: true,
        isPrimary: true,
        button: 0,
        pointerId: 1,
        clientX: 100,
        clientY: 120,
        preventDefault: vi.fn(),
        stopImmediatePropagation: vi.fn(),
        ...values,
      }
      handlers.get(name)?.(event as unknown as Event)
      return event
    },
    restore() {
      restoreTopLayer()
      Reflect.deleteProperty(HTMLElement.prototype, "setPointerCapture")
      Reflect.deleteProperty(HTMLElement.prototype, "releasePointerCapture")
    },
  }
}
