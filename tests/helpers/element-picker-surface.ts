import { vi } from "vitest"

/** jsdom has no top layer or layout. Real surface protection is tested in Playwright. */
export function mockElementPickerSurface(): () => void {
  const prototype = HTMLElement.prototype
  const show = Object.getOwnPropertyDescriptor(prototype, "showPopover")
  const hide = Object.getOwnPropertyDescriptor(prototype, "hidePopover")
  const point = Object.getOwnPropertyDescriptor(document, "elementFromPoint")
  const points = Object.getOwnPropertyDescriptor(document, "elementsFromPoint")
  const matches = Element.prototype.matches
  const closest = Element.prototype.closest
  const open = new Set<HTMLElement>()
  let underlying: typeof document.elementFromPoint | undefined

  vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector) {
    if (selector === ":popover-open") return open.has(this as HTMLElement)
    return matches.call(this, selector)
  })
  vi.spyOn(Element.prototype, "closest").mockImplementation(function (
    this: Element,
    selector: string,
  ) {
    if (selector === "dialog:modal") return null
    return closest.call(this, selector)
  })
  Object.defineProperty(prototype, "showPopover", {
    configurable: true,
    value(this: HTMLElement) {
      if (open.size === 0) {
        underlying = document.elementFromPoint
        Object.defineProperty(document, "elementFromPoint", {
          configurable: true,
          value: (x: number, y: number) => {
            const host = [...open].at(-1)
            if (host?.isConnected && getComputedStyle(host).pointerEvents === "auto") return host
            return underlying?.call(document, x, y) ?? null
          },
        })
      }
      open.add(this)
      Object.defineProperty(document, "elementsFromPoint", {
        configurable: true,
        value: (x: number, y: number) => {
          const host = [...open].at(-1)
          const target = underlying?.call(document, x, y)
          return [host, target].filter(
            (element): element is Element => element !== undefined && element !== null,
          )
        },
      })
    },
  })
  Object.defineProperty(prototype, "hidePopover", {
    configurable: true,
    value(this: HTMLElement) {
      open.delete(this)
      if (open.size === 0) {
        if (point) Object.defineProperty(document, "elementFromPoint", point)
        else Reflect.deleteProperty(document, "elementFromPoint")
        if (points) Object.defineProperty(document, "elementsFromPoint", points)
        else Reflect.deleteProperty(document, "elementsFromPoint")
      }
    },
  })
  return () => {
    const state = globalThis as typeof globalThis & {
      __piBrowserAgentElementPicker?: { cleanup: () => void }
    }
    state.__piBrowserAgentElementPicker?.cleanup()
    if (show) Object.defineProperty(prototype, "showPopover", show)
    else Reflect.deleteProperty(prototype, "showPopover")
    if (hide) Object.defineProperty(prototype, "hidePopover", hide)
    else Reflect.deleteProperty(prototype, "hidePopover")
    if (point) Object.defineProperty(document, "elementFromPoint", point)
    else Reflect.deleteProperty(document, "elementFromPoint")
    if (points) Object.defineProperty(document, "elementsFromPoint", points)
    else Reflect.deleteProperty(document, "elementsFromPoint")
  }
}
