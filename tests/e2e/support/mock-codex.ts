export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses"

function sseResponse(item: Record<string, unknown>, index: number): string {
  const response = {
    id: `response-${index}`,
    status: "completed",
    output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }
  return [
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")
}

export function toolCallResponse(
  index: number,
  name: string,
  args: Record<string, unknown> = {},
): string {
  return sseResponse(
    {
      type: "function_call",
      id: `fc_${index}`,
      call_id: `call_${index}`,
      name,
      arguments: JSON.stringify(args),
    },
    index,
  )
}

export function finalTextResponse(index: number, text: string): string {
  return sseResponse(
    {
      type: "message",
      id: `message_${index}`,
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text, annotations: [] }],
    },
    index,
  )
}
