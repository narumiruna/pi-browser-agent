import { element } from "./ui.js"

export interface SettingsConfirmationRequest {
  title: string
  message: string
  confirmLabel: string
}

export type ConfirmSettingsAction = (request: SettingsConfirmationRequest) => Promise<boolean>

/** One confirmation at a time; Cancel is always the initial keyboard action. */
export function initializeSettingsConfirmation(): ConfirmSettingsAction {
  const dialog = element<HTMLDialogElement>("settings-confirm-dialog")
  const title = element<HTMLElement>("settings-confirm-title")
  const message = element<HTMLElement>("settings-confirm-message")
  const cancel = element<HTMLButtonElement>("settings-confirm-cancel")
  const confirm = element<HTMLButtonElement>("settings-confirm-action")
  let pending: ((approved: boolean) => void) | undefined
  let previousFocus: HTMLElement | null = null

  function finish(approved: boolean): void {
    const resolve = pending
    pending = undefined
    if (dialog.open) dialog.close()
    if (resolve) {
      previousFocus?.focus()
      previousFocus = null
      resolve(approved)
    }
  }

  cancel.addEventListener("click", () => finish(false))
  confirm.addEventListener("click", () => finish(true))
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault()
    event.stopPropagation()
    finish(false)
  })
  dialog.addEventListener("close", () => {
    if (!dialog.open) finish(false)
  })
  window.addEventListener("pagehide", () => finish(false), { once: true })

  return (request) => {
    if (pending) return Promise.resolve(false)
    title.textContent = request.title
    message.textContent = request.message
    confirm.textContent = request.confirmLabel
    previousFocus = document.activeElement as HTMLElement | null
    return new Promise<boolean>((resolve) => {
      pending = resolve
      dialog.showModal()
      cancel.focus()
    })
  }
}
