import type {
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core"
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai"
import { Type } from "typebox"

export const CLARIFICATION_TOOL = "request_user_input"
export const CLARIFICATION_LIMITS = { question: 512, label: 128, other: 2048, calls: 3 } as const
export interface ClarificationTarget {
  id: string
  summary: string
  image?: ImageContent
  element: boolean
}
export interface ClarificationRequest {
  question: string
  options: { label: string; attachmentId?: string }[]
}
export interface ClarificationKey {
  sessionId: string
  generation: number
  toolCallId: string
}
export interface PendingClarification extends ClarificationKey {
  question: string
  options: { id: string; label: string; attachmentId?: string }[]
  targets: ClarificationTarget[]
}
export type ClarificationAnswer = { optionId: string } | { other: string }

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key))
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && [...value].length <= max

export function parseClarification(value: unknown, ids: ReadonlySet<string>): ClarificationRequest {
  if (
    !record(value) ||
    !exact(value, ["question", "options"]) ||
    !text(value.question, CLARIFICATION_LIMITS.question) ||
    !Array.isArray(value.options) ||
    value.options.length < 2 ||
    value.options.length > 5
  )
    throw new Error("Invalid clarification request")
  const options = value.options.map((option) => {
    if (
      !record(option) ||
      !exact(option, "attachmentId" in option ? ["label", "attachmentId"] : ["label"]) ||
      !text(option.label, CLARIFICATION_LIMITS.label) ||
      ("attachmentId" in option &&
        (typeof option.attachmentId !== "string" || !ids.has(option.attachmentId)))
    ) {
      throw new Error("Invalid clarification option")
    }
    return {
      label: option.label,
      ...(typeof option.attachmentId === "string" ? { attachmentId: option.attachmentId } : {}),
    }
  })
  if (new Set(options.map((option) => option.label)).size !== options.length)
    throw new Error("Duplicate clarification options")
  return { question: value.question, options }
}

function sameKey(left: ClarificationKey, right: ClarificationKey): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.generation === right.generation &&
    left.toolCallId === right.toolCallId
  )
}

export function createClarificationTool(execute: AgentTool["execute"]): AgentTool {
  return {
    name: CLARIFICATION_TOOL,
    label: "Ask the user",
    description:
      "Ask one focused question when the intended target or result is unclear. Supply two to five plain-text options. Optional attachmentId must be from this run's submitted user-context manifest. No default answer. This does not approve actions. Do not combine with other tools: sibling calls are discarded, not deferred.",
    parameters: Type.Object(
      {
        question: Type.String({ minLength: 1, maxLength: CLARIFICATION_LIMITS.question }),
        options: Type.Array(
          Type.Object(
            {
              label: Type.String({ minLength: 1, maxLength: CLARIFICATION_LIMITS.label }),
              attachmentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
            },
            { additionalProperties: false },
          ),
          { minItems: 2, maxItems: 5 },
        ),
      },
      { additionalProperties: false },
    ),
    replay: "never",
    execute,
  }
}

/** Owns one run's local callback. A clarification never produces action approval. */
export class ClarificationRun {
  private calls = 0
  private readonly batches = new WeakMap<AssistantMessage, boolean>()
  private readonly questionIds = new Set<string>()
  private pending?: { card: PendingClarification; settle: (answer?: ClarificationAnswer) => void }
  private active = true
  private elementContextValid = true

  constructor(
    private readonly sessionId: string,
    private readonly generation: number,
    private readonly targets: ClarificationTarget[],
    private readonly changed: (card?: PendingClarification) => void,
  ) {}

  includeTargets(targets: readonly ClarificationTarget[]): void {
    if (this.pending) throw new Error("Answer or stop the pending question first")
    for (const target of targets) {
      const index = this.targets.findIndex((item) => item.id === target.id)
      if (index < 0) this.targets.push(structuredClone(target))
      else this.targets[index] = structuredClone(target)
    }
  }

  get hasRequests(): boolean {
    return this.calls > 0
  }

  get waiting(): boolean {
    return this.pending !== undefined
  }

  inspect(message: AssistantMessage): boolean {
    const previous = this.batches.get(message)
    if (previous !== undefined) return previous
    const toolCalls = message.content.filter((part) => part.type === "toolCall")
    const calls = toolCalls.filter((part) => part.name === CLARIFICATION_TOOL)
    this.calls += calls.length
    const reusedId = calls.some(
      (call) =>
        !call.id ||
        this.questionIds.has(call.id) ||
        toolCalls.filter((other) => other.id === call.id).length !== 1,
    )
    for (const call of calls) this.questionIds.add(call.id)
    const rejected = calls.length > 1 || reusedId || this.calls > CLARIFICATION_LIMITS.calls
    this.batches.set(message, rejected)
    return rejected
  }

  beforeToolCall({
    assistantMessage,
    toolCall,
  }: BeforeToolCallContext): BeforeToolCallResult | undefined {
    const requests = assistantMessage.content.filter(
      (part) => part.type === "toolCall" && part.name === CLARIFICATION_TOOL,
    )
    if (!requests.length) return undefined
    const rejected = this.inspect(assistantMessage)
    if (!this.active || rejected || toolCall.name !== CLARIFICATION_TOOL) {
      return {
        block: true,
        reason: rejected
          ? "Clarification batch rejected: use one new question ID, at most three per run."
          : "Sibling call discarded: ask the user first. This call will not be replayed.",
      }
    }
    return undefined
  }

  answer(key: ClarificationKey, value: unknown): boolean {
    const pending = this.pending
    if (!this.active || !pending || !sameKey(pending.card, key)) return false
    if (!record(value)) throw new Error("Invalid clarification answer")
    if (exact(value, ["optionId"]) && typeof value.optionId === "string") {
      const option = pending.card.options.find((option) => option.id === value.optionId)
      if (!option) throw new Error("Invalid clarification answer")
      if (
        option.attachmentId &&
        !this.elementContextValid &&
        this.targets.some((target) => target.id === option.attachmentId && target.element)
      )
        throw new Error("The target context changed")
    } else if (!exact(value, ["other"]) || !text(value.other, CLARIFICATION_LIMITS.other)) {
      throw new Error("Invalid clarification answer")
    }
    pending.settle(value as ClarificationAnswer)
    return true
  }

  invalidateElements(): void {
    this.elementContextValid = false
    if (
      this.pending?.card.options.some(
        (option) =>
          option.attachmentId &&
          this.targets.some((target) => target.id === option.attachmentId && target.element),
      )
    )
      this.abort()
  }

  abort(): void {
    this.active = false
    this.pending?.settle()
    this.targets.length = 0
  }

  tool(): AgentTool {
    return createClarificationTool(async (toolCallId, args, signal) => {
      if (
        !this.active ||
        signal?.aborted ||
        this.pending ||
        this.calls > CLARIFICATION_LIMITS.calls
      )
        throw new Error("Clarification is no longer available")
      const request = parseClarification(args, new Set(this.targets.map((target) => target.id)))
      if (
        !this.elementContextValid &&
        request.options.some(
          (option) =>
            option.attachmentId &&
            this.targets.some((target) => target.id === option.attachmentId && target.element),
        )
      )
        throw new Error("The target context changed")
      const card: PendingClarification = {
        ...request,
        sessionId: this.sessionId,
        generation: this.generation,
        toolCallId,
        options: request.options.map((option, index) => ({
          ...option,
          id: `option-${index + 1}`,
        })),
        targets: structuredClone(
          this.targets.filter((target) =>
            request.options.some((option) => option.attachmentId === target.id),
          ),
        ),
      }
      const answer = await new Promise<ClarificationAnswer | undefined>((resolve) => {
        let settled = false
        const cancel = () => settle()
        const settle = (value?: ClarificationAnswer) => {
          if (settled) return
          settled = true
          signal?.removeEventListener("abort", cancel)
          this.pending = undefined
          resolve(value)
          try {
            this.changed(undefined)
          } catch {
            /* A disposed view must not retain the callback. */
          }
        }
        this.pending = { card, settle }
        signal?.addEventListener("abort", cancel, { once: true })
        if (signal?.aborted || !this.active) settle()
        else {
          try {
            this.changed(structuredClone(card))
          } catch {
            settle()
          }
        }
      })
      if (!answer || signal?.aborted || !this.active)
        return {
          content: [
            {
              type: "text",
              text: "Clarification cancelled. No answer or action approval was given.",
            },
          ],
          details: {},
          isError: true,
          terminate: true,
        }
      const option =
        "optionId" in answer
          ? card.options.find((option) => option.id === answer.optionId)
          : undefined
      const result = {
        version: 1,
        question: request.question,
        answer: option ?? answer,
        actionApproval: false,
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} }
    })
  }
}
