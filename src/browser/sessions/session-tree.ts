import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { ImageContent } from "@earendil-works/pi-ai"

export const MAX_TREE_NODES = 5000

export interface SessionTreeNode {
  id: string
  parentId: string | null
  message: AgentMessage
}

export interface SessionTree {
  version: 1
  nodes: SessionTreeNode[]
  activeLeafId: string | null
}

export interface SessionTreeItem {
  id: string
  parentId: string | null
  depth: number
  role: AgentMessage["role"]
  label: string
  selectable: boolean
  active: boolean
  onActivePath: boolean
}

export interface SessionTreeSelection {
  tree: SessionTree
  messages: AgentMessage[]
  draft: { text: string; images: ImageContent[] }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isContent(value: unknown, role: string): boolean {
  if (!isObject(value)) return false
  switch (value.type) {
    case "text":
      return typeof value.text === "string"
    case "image":
      return (
        (role === "user" || role === "toolResult") &&
        typeof value.data === "string" &&
        typeof value.mimeType === "string"
      )
    case "thinking":
      return role === "assistant" && typeof value.thinking === "string"
    case "toolCall":
      return (
        role === "assistant" &&
        typeof value.id === "string" &&
        value.id.length > 0 &&
        typeof value.name === "string" &&
        value.name.length > 0 &&
        isObject(value.arguments)
      )
    default:
      return false
  }
}

function isMessage(value: unknown): value is AgentMessage {
  if (!isObject(value) || typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp))
    return false
  const role = value.role
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "toolResult")
    return false
  if (typeof value.content === "string") {
    if (role !== "system" && role !== "user") return false
  } else {
    if (!Array.isArray(value.content)) return false
    for (const item of value.content) {
      if (!isContent(item, role)) return false
    }
  }
  if (role === "system") {
    if (
      value.sections !== undefined &&
      (!isObject(value.sections) ||
        Object.values(value.sections).some(
          (section) => section !== null && typeof section !== "string",
        ))
    )
      return false
    if (
      value.toolsAdded !== undefined &&
      (!Array.isArray(value.toolsAdded) ||
        value.toolsAdded.some(
          (tool) =>
            !isObject(tool) ||
            typeof tool.name !== "string" ||
            typeof tool.description !== "string" ||
            !isObject(tool.parameters),
        ))
    )
      return false
    if (
      value.toolsRemoved !== undefined &&
      (!Array.isArray(value.toolsRemoved) ||
        value.toolsRemoved.some((tool) => !isObject(tool) || typeof tool.name !== "string"))
    )
      return false
  }
  if (role === "assistant") {
    if (
      typeof value.api !== "string" ||
      typeof value.provider !== "string" ||
      typeof value.model !== "string" ||
      !["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"].includes(
        String(value.stopReason),
      ) ||
      !isObject(value.usage) ||
      !isObject(value.usage.cost)
    )
      return false
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
      if (typeof value.usage[key] !== "number" || !Number.isFinite(value.usage[key])) return false
    }
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
      if (typeof value.usage.cost[key] !== "number" || !Number.isFinite(value.usage.cost[key]))
        return false
    }
  }
  return (
    role !== "toolResult" ||
    (typeof value.toolCallId === "string" &&
      value.toolCallId.length > 0 &&
      typeof value.toolName === "string" &&
      typeof value.isError === "boolean")
  )
}

/** Structural validation retains interrupted history, even when it is not a safe boundary. */
export function validateSessionTree(value: unknown): value is SessionTree {
  if (
    !isObject(value) ||
    value.version !== 1 ||
    !Array.isArray(value.nodes) ||
    value.nodes.length > MAX_TREE_NODES
  )
    return false
  const ids = new Set<string>()
  for (const node of value.nodes) {
    if (
      !isObject(node) ||
      typeof node.id !== "string" ||
      !node.id ||
      ids.has(node.id) ||
      (node.parentId !== null && (typeof node.parentId !== "string" || !ids.has(node.parentId))) ||
      !isMessage(node.message)
    )
      return false
    ids.add(node.id)
  }
  return (
    value.activeLeafId === null ||
    (typeof value.activeLeafId === "string" && ids.has(value.activeLeafId))
  )
}

function assertTree(tree: SessionTree): void {
  if (!validateSessionTree(tree)) throw new Error("Invalid session tree")
}

function withoutBaseline(messages: AgentMessage[]): AgentMessage[] {
  if (messages[0]?.role !== "system") return messages
  if (!isMessage(messages[0])) throw new Error("Invalid session tree system message")
  return messages.slice(1)
}

function messagesEqual(left: unknown, right: unknown): boolean {
  const pairs: [unknown, unknown][] = [[left, right]]
  const visited = new WeakMap<object, WeakSet<object>>()
  while (pairs.length) {
    const [a, b] = pairs.pop() as [unknown, unknown]
    if (Object.is(a, b)) continue
    if (
      typeof a !== "object" ||
      a === null ||
      typeof b !== "object" ||
      b === null ||
      Array.isArray(a) !== Array.isArray(b)
    )
      return false
    if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return false
    const matches = visited.get(a) ?? new WeakSet<object>()
    if (matches.has(b)) continue
    matches.add(b)
    visited.set(a, matches)
    const keys = Object.keys(a)
    if (keys.length !== Object.keys(b).length) return false
    for (const key of keys) {
      if (!Object.hasOwn(b, key)) return false
      pairs.push([(a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]])
    }
  }
  return true
}

export function createSessionTree(messages: AgentMessage[]): SessionTree {
  return syncSessionTree({ version: 1, nodes: [], activeLeafId: null }, messages)
}

/** Existing nodes never change. Only a suffix of the active path can be added. */
export function syncSessionTree(tree: SessionTree, messages: AgentMessage[]): SessionTree {
  const path = getTreePath(tree)
  const projection = withoutBaseline(messages)
  if (
    projection.length < path.length ||
    path.some((node, index) => !messagesEqual(node.message, projection[index]))
  ) {
    throw new Error("Session tree messages diverge from the active path")
  }
  if (tree.nodes.length + projection.length - path.length > MAX_TREE_NODES)
    throw new Error("Session tree node limit exceeded")
  const next = structuredClone(tree)
  const ids = new Set(next.nodes.map((node) => node.id))
  for (const message of projection.slice(path.length)) {
    if (!isMessage(message)) throw new Error("Invalid session tree message")
    let id = crypto.randomUUID()
    while (ids.has(id)) id = crypto.randomUUID()
    ids.add(id)
    next.nodes.push({ id, parentId: next.activeLeafId, message: structuredClone(message) })
    next.activeLeafId = id
  }
  return next
}

export function getTreePath(
  tree: SessionTree,
  leafId: string | null = tree.activeLeafId,
): SessionTreeNode[] {
  assertTree(tree)
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]))
  const path: SessionTreeNode[] = []
  let id = leafId
  while (id !== null) {
    const node = nodes.get(id)
    if (!node) throw new Error("Session tree node not found")
    path.push(node)
    id = node.parentId
  }
  return structuredClone(path.reverse())
}

function messageLabel(message: AgentMessage): string {
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .map((item) => {
            if (item.type === "text") return item.text
            if (item.type === "image") return "[image]"
            if (item.type === "thinking") return "[thinking]"
            return `Tool: ${item.name}`
          })
          .join(" ")
  // Labels are text, not HTML or Markdown. Remove control and directional characters.
  return (
    text
      .replace(/[\p{Cc}\p{Cf}]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim() || message.role
  )
    .slice(0, 160)
    .replace(/[\uD800-\uDBFF]$/u, "")
}

/** Traverse iteratively, with reversible path state, so deep trees need no recursion. */
export function getTreeItems(tree: SessionTree): SessionTreeItem[] {
  assertTree(tree)
  const activePath = new Set(getTreePath(tree).map((node) => node.id))
  const children = new Map<string | null, SessionTreeNode[]>()
  for (const node of tree.nodes) {
    const siblings = children.get(node.parentId) ?? []
    siblings.push(node)
    children.set(node.parentId, siblings)
  }
  const items: SessionTreeItem[] = []
  const pending = new Map<string, string>()
  const seen = new Set<string>()
  let valid = true
  type Step = { node: SessionTreeNode; depth: number } | { undo: () => void }
  const stack: Step[] = (children.get(null) ?? []).map((node) => ({ node, depth: 0 })).reverse()
  while (stack.length) {
    const step = stack.pop() as Step
    if ("undo" in step) {
      step.undo()
      continue
    }
    const { node, depth } = step
    const message = node.message
    const previousValid = valid
    const parentSafe = valid && pending.size === 0
    const added: string[] = []
    let resolved: [string, string] | undefined
    if (message.role === "assistant") {
      const calls = message.content.filter((item) => item.type === "toolCall")
      if (
        !parentSafe ||
        !["stop", "length", "toolUse"].includes(message.stopReason) ||
        calls.length > 0 !== (message.stopReason === "toolUse")
      )
        valid = false
      for (const call of calls) {
        if (seen.has(call.id)) {
          valid = false
          continue
        }
        seen.add(call.id)
        pending.set(call.id, call.name)
        added.push(call.id)
      }
    } else if (message.role === "toolResult") {
      const name = pending.get(message.toolCallId)
      if (name === undefined || name !== message.toolName) valid = false
      else {
        resolved = [message.toolCallId, name]
        pending.delete(message.toolCallId)
      }
    } else if (!parentSafe) valid = false
    const safe = valid && pending.size === 0
    items.push({
      id: node.id,
      parentId: node.parentId,
      depth,
      role: message.role,
      label: messageLabel(message),
      selectable:
        message.role === "user"
          ? parentSafe
          : (message.role === "assistant" || message.role === "toolResult") && safe,
      active: node.id === tree.activeLeafId,
      onActivePath: activePath.has(node.id),
    })
    stack.push({
      undo: () => {
        valid = previousValid
        for (const id of added) {
          seen.delete(id)
          pending.delete(id)
        }
        if (resolved) pending.set(...resolved)
      },
    })
    const descendants = children.get(node.id) ?? []
    for (const descendant of [...descendants].reverse())
      stack.push({ node: descendant, depth: depth + 1 })
  }
  return items
}

export function selectTreeNode(tree: SessionTree, nodeId: string | null): SessionTreeSelection {
  assertTree(tree)
  const draft: SessionTreeSelection["draft"] = { text: "", images: [] }
  let leafId = nodeId
  if (nodeId !== null) {
    const node = tree.nodes.find((item) => item.id === nodeId)
    if (!node) throw new Error("Session tree node not found")
    if (!getTreeItems(tree).find((item) => item.id === nodeId)?.selectable)
      throw new Error("Session tree node is not a complete continuation boundary")
    if (node.message.role === "user") {
      leafId = node.parentId
      const content = node.message.content
      draft.text =
        typeof content === "string"
          ? content
          : content
              .filter((item) => item.type === "text")
              .map((item) => item.text)
              .join("\n")
      if (Array.isArray(content))
        draft.images = structuredClone(content.filter((item) => item.type === "image"))
    }
  }
  return {
    tree: { ...structuredClone(tree), activeLeafId: leafId },
    messages: getTreePath(tree, leafId).map((node) => node.message),
    draft,
  }
}
