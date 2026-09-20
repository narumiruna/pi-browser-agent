import { safeErrorMessage } from "../auth/redaction.js"
import type { FontFamily } from "../storage.js"

export function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id)
  if (!value) throw new Error(`Missing UI element: ${id}`)
  return value as T
}

export function setErrorOutput(output: HTMLElement, error?: unknown): void {
  output.textContent = error === undefined ? "" : safeErrorMessage(error)
}

export function applyAppearance(fontFamily: FontFamily, fontSize: number): void {
  document.documentElement.dataset.fontFamily = fontFamily
  document.documentElement.dataset.fontSize = String(fontSize)
  document.documentElement.style.setProperty("--app-font-size", `${fontSize}px`)
}

export async function run(
  action: () => Promise<void>,
  updateError: (error?: unknown) => void,
): Promise<void> {
  updateError()
  try {
    await action()
  } catch (error) {
    updateError(error)
  }
}
