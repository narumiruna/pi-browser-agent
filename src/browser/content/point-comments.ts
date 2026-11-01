import type { PointCommentsControl } from "../runtime/point-comments.js"
import type { JsonObject } from "../runtime/types.js"

/** Fixed isolated-world controls. An unknown token must not remove a replacement surface. */
export function executePointCommentsControl(
  operation: PointCommentsControl,
  token?: string,
  id?: string,
  number?: number,
): JsonObject {
  const isolated = globalThis as typeof globalThis & {
    __piBrowserAgentElementPicker?: {
      token: string
      pinControl?: (operation: string, id?: string, number?: number) => JsonObject
    }
  }
  const picker = isolated.__piBrowserAgentElementPicker
  if (!picker?.pinControl || (token !== undefined && picker.token !== token))
    return { active: false }
  return picker.pinControl(operation, id, number)
}
