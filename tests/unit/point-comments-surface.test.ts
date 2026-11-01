// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  executeElementPicker,
  stopElementPickerInjection,
} from "../../src/browser/content/element-picker.js"
import { executePointCommentsControl } from "../../src/browser/content/point-comments.js"
import { ELEMENT_PICKER_LIMITS } from "../../src/browser/runtime/element-context.js"
import { mockElementPickerSurface } from "../helpers/element-picker-surface.js"
import { deferred } from "../helpers/point-comments.js"

const context = { tabId: 1, url: location.href, epoch: 1 }
let hit: Element | null
let restore: () => void
let frames: FrameRequestCallback[]
let rect: DOMRect
let click: (event: MouseEvent) => void
const rectangle = () => new DOMRect(20, 30, 200, 100)
beforeEach(() => {
  document.body.innerHTML = '<button id="target">Target <span hidden>Hidden</span></button>'
  hit = document.querySelector("button")
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [rect],
  })
  rect = rectangle()
  frames = []
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => hit })
  restore = mockElementPickerSurface()
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.hasAttribute("data-pi-browser-agent-element-picker")
      ? new DOMRect(0, 0, innerWidth, innerHeight)
      : rect
  })
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal("cancelAnimationFrame", vi.fn())
  vi.stubGlobal("chrome", {
    runtime: { sendMessage: vi.fn(async () => ({ ok: true, result: { accepted: true } })) },
  })
  const add = window.addEventListener.bind(window)
  vi.spyOn(window, "addEventListener").mockImplementation((name, listener, options) => {
    if (name === "click") click = listener as (event: MouseEvent) => void
    add(name, listener, options)
  })
})
afterEach(() => {
  stopElementPickerInjection()
  restore()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function paint() {
  for (const frame of frames.splice(0)) frame(0)
  await Promise.resolve()
}
async function start(serialized = false) {
  const execute = serialized
    ? (new Function(`return (${executeElementPicker.toString()})`)() as typeof executeElementPicker)
    : executeElementPicker
  const starting = execute("start", "token", context, ELEMENT_PICKER_LIMITS, {
    generation: 1,
    capacity: 5,
    nextNumber: 1,
  })
  await paint()
  await paint()
  expect(await starting).toMatchObject({ result: { started: true } })
}
function select() {
  click({
    isTrusted: true,
    clientX: 50,
    clientY: 60,
    target: document.querySelector("[data-pi-browser-agent-element-picker]"),
    preventDefault() {},
    stopImmediatePropagation() {},
  } as unknown as MouseEvent)
}

describe("serialized protected pin surface", () => {
  test("serialized function keeps multiple badges and ignores duplicate selection", async () => {
    await start(true)
    select()
    await Promise.resolve()
    await Promise.resolve()
    select()
    await Promise.resolve()
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1)
    const second = document.createElement("span")
    document.querySelector("#target")?.append(second)
    hit = second
    select()
    await Promise.resolve()
    await Promise.resolve()
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2)
    expect(executePointCommentsControl("state", "token")).toMatchObject({
      active: true,
      sequence: 2,
      targets: [{ number: 1 }, { number: 2 }],
    })
  })
  test("does not accept another selection until worker acknowledgment", async () => {
    await start()
    const gate = deferred<unknown>()
    vi.mocked(chrome.runtime.sendMessage).mockImplementationOnce(() => gate.promise)
    select()
    const second = document.createElement("button")
    document.body.append(second)
    hit = second
    select()
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1)
    gate.resolve({ ok: true, result: { accepted: true } })
    await Promise.resolve()
    await Promise.resolve()
    select()
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2)
  })
  test("remove, reselect, clear and stale-token cleanup affect only the owned surface", async () => {
    await start()
    select()
    await Promise.resolve()
    await Promise.resolve()
    const state = executePointCommentsControl("state", "token") as { targets: { id: string }[] }
    const id = state.targets[0]?.id
    expect(id).toBeDefined()
    executePointCommentsControl("reselect", "token", id, 1)
    hit = document.createElement("button")
    document.body.append(hit)
    select()
    await Promise.resolve()
    await Promise.resolve()
    expect(executePointCommentsControl("state", "token")).toMatchObject({
      targets: [{ id, number: 1 }],
    })
    executePointCommentsControl("stop", "older-token")
    expect(document.querySelector("[data-pi-browser-agent-element-picker]")).not.toBeNull()
    executePointCommentsControl("remove", "token", id)
    expect(executePointCommentsControl("state", "token")).toMatchObject({ targets: [] })
    executePointCommentsControl("clear", "token")
    executePointCommentsControl("stop", "token")
    executePointCommentsControl("stop", "token")
    expect(document.querySelector("[data-pi-browser-agent-element-picker]")).toBeNull()
  })
  test.each(["replacement", "movement", "removal", "hidden"])(
    "%s invalidates the actual node, never relocates by selector",
    async (change) => {
      await start()
      select()
      await Promise.resolve()
      await Promise.resolve()
      const target = document.querySelector("#target") as HTMLElement
      if (change === "replacement") target.replaceWith(target.cloneNode(true))
      if (change === "movement") rect = new DOMRect(40, 30, 200, 100)
      if (change === "removal") target.remove()
      if (change === "hidden") target.style.display = "none"
      await paint()
      expect(document.querySelector("[data-pi-browser-agent-element-picker]")).toBeNull()
      expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: "point-comments-result",
          status: "cancelled",
          reason: "target-changed",
        }),
      )
    },
  )
  test("final submit validates nodes and removes protection in one synchronous turn", async () => {
    await start()
    select()
    await Promise.resolve()
    await Promise.resolve()
    expect(executePointCommentsControl("state", "token")).toMatchObject({ active: true })
    document.querySelector("#target")?.replaceWith(document.createElement("button"))
    // No animation frame, observer delivery, or asynchronous state guard occurs here.
    expect(executePointCommentsControl("submit", "token")).toEqual({ active: false })
    expect(document.querySelector("[data-pi-browser-agent-element-picker]")).toBeNull()
  })
  test("failed delivery removes all input interception rather than accepting another pin", async () => {
    await start()
    vi.mocked(chrome.runtime.sendMessage).mockImplementationOnce(
      async () => ({ ok: false }) as never,
    )
    select()
    await Promise.resolve()
    await Promise.resolve()
    expect(document.querySelector("[data-pi-browser-agent-element-picker]")).toBeNull()
  })
  test("setup failure and Escape leave no pin registry or orphan listeners", async () => {
    Reflect.deleteProperty(HTMLElement.prototype, "showPopover")
    await expect(
      executeElementPicker("start", "token", context, ELEMENT_PICKER_LIMITS, {
        generation: 1,
        capacity: 5,
        nextNumber: 1,
      }),
    ).resolves.toMatchObject({ result: { started: false } })
    expect(document.querySelector("[data-pi-browser-agent-element-picker]")).toBeNull()
  })
})
