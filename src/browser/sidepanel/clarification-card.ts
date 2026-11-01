import {
  CLARIFICATION_LIMITS,
  type ClarificationAnswer,
  type ClarificationKey,
  type PendingClarification,
} from "../agent/clarification.js"
import { t } from "../i18n/index.js"
import { imageContentSource } from "./images.js"

/** Live UI only. Historical tool messages never instantiate this controller. */
export class ClarificationCard {
  private card?: PendingClarification
  private previousFocus?: HTMLElement

  constructor(
    private readonly root: HTMLElement,
    private readonly answer: (key: ClarificationKey, value: ClarificationAnswer) => boolean,
    private readonly fallbackFocus?: HTMLElement,
  ) {}

  show(card?: PendingClarification): void {
    const document = this.root.ownerDocument
    const ownedFocus = this.root.contains(document.activeElement)
    if (!card) {
      this.card = undefined
      this.root.hidden = true
      this.root.replaceChildren()
      if (ownedFocus) {
        const target =
          this.previousFocus?.isConnected &&
          this.previousFocus !== document.body &&
          !this.previousFocus.matches(":disabled")
            ? this.previousFocus
            : this.fallbackFocus
        target?.focus()
      }
      this.previousFocus = undefined
      return
    }
    if (
      this.card?.sessionId === card.sessionId &&
      this.card.generation === card.generation &&
      this.card.toolCallId === card.toolCallId &&
      this.card.questionSequence === card.questionSequence
    )
      return
    this.previousFocus = document.activeElement as HTMLElement
    this.card = card
    this.root.replaceChildren()
    this.root.hidden = false
    const heading = document.createElement("h2")
    heading.id = "clarification-title"
    heading.textContent = t("Question from Pi")
    const choices = document.createElement("fieldset")
    const question = document.createElement("legend")
    question.textContent = card.question
    choices.append(question)
    const radios: HTMLInputElement[] = []
    for (const option of card.options) {
      const label = document.createElement("label")
      label.className = "clarification-option"
      const radio = document.createElement("input")
      radio.type = "radio"
      radio.name = "clarification-choice"
      radio.value = option.id
      radios.push(radio)
      const text = document.createElement("span")
      text.textContent = option.label
      label.append(radio, text)
      const target = card.targets.find((target) => target.id === option.attachmentId)
      if (target) {
        const summary = document.createElement("small")
        const description = target.imagePosition
          ? t("Pasted image {number}", { number: target.imagePosition })
          : target.pinNumber
            ? `${t("Comment {number}", { number: target.pinNumber })} — ${target.summary}`
            : target.summary
        summary.textContent = description
        label.append(summary)
        const src = target.image && imageContentSource(target.image)
        if (src) {
          const image = document.createElement("img")
          image.src = src
          image.alt = description
          label.append(image)
        }
      }
      choices.append(label)
    }
    const otherLabel = document.createElement("label")
    otherLabel.className = "clarification-option"
    const otherRadio = document.createElement("input")
    otherRadio.type = "radio"
    otherRadio.name = "clarification-choice"
    otherRadio.value = "other"
    radios.push(otherRadio)
    otherLabel.append(otherRadio, document.createTextNode(t("Other answer")))
    const other = document.createElement("textarea")
    other.id = "clarification-other"
    other.rows = 2
    other.disabled = true
    other.setAttribute("aria-label", t("Other answer"))
    choices.append(otherLabel, other)
    const help = document.createElement("p")
    help.textContent = t("This answer does not approve browser or remote actions.")
    const error = document.createElement("p")
    error.className = "clarification-error"
    error.setAttribute("role", "alert")
    const submit = document.createElement("button")
    submit.id = "clarification-answer"
    submit.type = "button"
    submit.className = "primary"
    submit.textContent = t("Answer")
    submit.disabled = true
    let settled = false
    const update = () => {
      other.disabled = !otherRadio.checked
      const valid = otherRadio.checked
        ? other.value.trim().length > 0 && [...other.value].length <= CLARIFICATION_LIMITS.other
        : radios.some((radio) => radio !== otherRadio && radio.checked)
      submit.disabled = settled || !valid
      error.textContent =
        otherRadio.checked && other.value && !valid
          ? t("Choose an option or enter an answer of at most 2,048 characters")
          : ""
    }
    choices.addEventListener("change", update)
    other.addEventListener("input", update)
    submit.addEventListener("click", () => {
      if (settled || submit.disabled || this.card !== card) return
      const selected = radios.find((radio) => radio.checked)
      if (!selected) return
      const value = selected === otherRadio ? { other: other.value } : { optionId: selected.value }
      settled = true
      update()
      try {
        if (!this.answer(card, value)) error.textContent = t("The question is no longer active")
      } catch {
        settled = false
        update()
        error.textContent = t("The question is no longer active")
      }
    })
    this.root.append(heading, choices, help, error, submit)
    // Focus the question, not an option. No answer is selected by focus.
    question.tabIndex = -1
    question.focus()
  }
}
