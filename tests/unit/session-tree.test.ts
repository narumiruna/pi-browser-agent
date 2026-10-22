import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai"
import { describe, expect, test } from "vitest"
import {
  createSessionTree,
  getTreeItems,
  getTreePath,
  MAX_TREE_NODES,
  type SessionTree,
  selectTreeNode,
  syncSessionTree,
  validateSessionTree,
} from "../../src/browser/sessions/session-tree.js"

const baseline: AgentMessage = { role: "system", content: "current baseline", timestamp: 0 }
function user(text = "Question"): AgentMessage {
  return { role: "user", content: text, timestamp: 1 }
}
function assistant(
  text = "Answer",
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "test",
    timestamp: 2,
    content: [{ type: "text", text, textSignature: "signed answer" }],
    stopReason,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
}
function calls(...ids: string[]): AssistantMessage {
  return {
    ...assistant("", "toolUse"),
    content: ids.map((id) => ({ type: "toolCall", id, name: "inspect", arguments: { id } })),
  }
}
function result(id: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "inspect",
    timestamp: 3,
    isError: false,
    content: [{ type: "text", text: "Done" }],
    details: { source: "page" },
  }
}
function nodeId(tree: SessionTree, index: number): string {
  const node = tree.nodes[index]
  if (!node) throw new Error("Missing test node")
  return node.id
}
function expectBoundaries(messages: AgentMessage[], expected: boolean[]): SessionTree {
  const tree = createSessionTree(messages)
  expect(getTreeItems(tree).map((item) => item.selectable)).toEqual(expected)
  tree.nodes.forEach((node, index) => {
    if (!expected[index]) expect(() => selectTreeNode(tree, node.id)).toThrow("boundary")
  })
  return tree
}

describe("session tree", () => {
  test.each([
    { toolsAdded: {} },
    { toolsAdded: [null] },
    { toolsAdded: [{ name: "bad", description: "Bad", parameters: null }] },
    { toolsRemoved: {} },
    { toolsRemoved: [{ name: 7 }] },
    { sections: { instructions: 7 } },
  ])("rejects malformed system metadata in baselines and tree nodes: %j", (metadata) => {
    const invalid = { ...baseline, ...metadata } as unknown as AgentMessage
    expect(() => createSessionTree([invalid])).toThrow("system message")
    expect(() => createSessionTree([baseline, invalid])).toThrow("tree message")
  })

  test("creates an empty implicit root and excludes only the leading system baseline", () => {
    expect(createSessionTree([])).toEqual({ version: 1, nodes: [], activeLeafId: null })
    expect(createSessionTree([baseline])).toEqual(createSessionTree([]))
    const update: AgentMessage = { role: "system", content: "later update", timestamp: 3 }
    const tree = createSessionTree([baseline, user(), update, assistant()])
    expect(getTreePath(tree).map((node) => node.message)).toEqual([user(), update, assistant()])
    expect(getTreeItems(tree).map((item) => item.role)).toEqual(["user", "system", "assistant"])
    expect(getTreeItems(tree)[1]?.selectable).toBe(false)
    expect(() => selectTreeNode(tree, nodeId(tree, 1))).toThrow("boundary")
  })

  test("sync appends only new active suffix nodes with stable IDs and no mutation", () => {
    const messages = [baseline, user(), assistant()]
    const tree = createSessionTree(messages)
    const snapshot = structuredClone(tree)
    const next = syncSessionTree(tree, [...messages, user("Next"), assistant("Next answer")])
    expect(tree).toEqual(snapshot)
    expect(next.nodes.slice(0, 2)).toEqual(tree.nodes)
    expect(next.nodes[2]?.parentId).toBe(nodeId(tree, 1))
    expect(new Set(next.nodes.map((node) => node.id)).size).toBe(4)
    expect(syncSessionTree(tree, messages)).toEqual(tree)
    messages[1] = user("Changed outside")
    expect(tree).toEqual(snapshot)
    const clonedNode = next.nodes[0]
    if (!clonedNode) throw new Error("Missing cloned node")
    clonedNode.message.content = "Changed clone"
    expect(tree).toEqual(snapshot)
  })

  test("rejects a changed or removed active prefix including metadata changes", () => {
    const tree = createSessionTree([user(), assistant()])
    expect(() => syncSessionTree(tree, [user("Different"), assistant()])).toThrow("diverge")
    expect(() => syncSessionTree(tree, [user()])).toThrow("diverge")
    const changed = assistant()
    changed.content = [{ type: "text", text: "Answer", textSignature: "different" }]
    expect(() => syncSessionTree(tree, [user(), changed])).toThrow("diverge")
    const reordered = { timestamp: 1, content: "Question", role: "user" as const }
    expect(syncSessionTree(tree, [reordered, assistant()])).toEqual(tree)
  })

  test("preserves branches and nested edits with active-path-only projection and preorder", () => {
    const original = createSessionTree([
      baseline,
      user("Original"),
      assistant("Old answer"),
      user("Follow-up"),
      assistant("Old follow-up"),
    ])
    const edit = selectTreeNode(original, nodeId(original, 2))
    expect(edit.draft).toEqual({ text: "Follow-up", images: [] })
    expect(edit.messages).toEqual([user("Original"), assistant("Old answer")])
    const branch = syncSessionTree(edit.tree, [
      baseline,
      ...edit.messages,
      user("New follow-up"),
      assistant("New answer"),
    ])
    expect(branch.nodes.slice(0, 4)).toEqual(original.nodes)
    expect(getTreePath(branch).map((node) => node.message)).toEqual([
      user("Original"),
      assistant("Old answer"),
      user("New follow-up"),
      assistant("New answer"),
    ])
    const nestedEdit = selectTreeNode(branch, nodeId(branch, 4))
    const nested = syncSessionTree(nestedEdit.tree, [
      baseline,
      ...nestedEdit.messages,
      user("Nested edit"),
      assistant("Nested answer"),
    ])
    const items = getTreeItems(nested)
    expect(items.map((item) => item.id)).toEqual(nested.nodes.map((node) => node.id))
    expect(items.map((item) => item.depth)).toEqual([0, 1, 2, 3, 2, 3, 2, 3])
    expect(items.map((item) => item.onActivePath)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      true,
      true,
    ])
    expect(items.filter((item) => item.active).map((item) => item.id)).toEqual([
      nested.activeLeafId,
    ])
    const restored = selectTreeNode(nested, nodeId(original, 3))
    expect(restored.messages).toEqual(original.nodes.map((node) => node.message))
    expect(restored.draft).toEqual({ text: "", images: [] })
    expect(restored.tree.nodes).toEqual(nested.nodes)
  })

  test("preorder follows parents rather than append order", () => {
    const original = createSessionTree([user("First"), assistant("A")])
    const rootBranch = syncSessionTree(selectTreeNode(original, null).tree, [
      user("Second"),
      assistant("B"),
    ])
    const revisit = selectTreeNode(rootBranch, nodeId(original, 1))
    const continued = syncSessionTree(revisit.tree, [
      ...revisit.messages,
      user("Nested"),
      assistant("C"),
    ])
    expect(getTreeItems(continued).map((item) => item.id)).toEqual(
      [0, 1, 4, 5, 2, 3].map((index) => nodeId(continued, index)),
    )
  })

  test("user selection restores text and images without sharing message or draft objects", () => {
    const request: AgentMessage = {
      role: "user",
      timestamp: 1,
      content: [
        { type: "text", text: "One" },
        { type: "image", data: "cG5n", mimeType: "image/png" },
        { type: "text", text: "Two" },
      ],
    }
    const tree = createSessionTree([baseline, request, assistant()])
    const selected = selectTreeNode(tree, nodeId(tree, 0))
    expect(selected.tree.activeLeafId).toBeNull()
    expect(selected.messages).toEqual([])
    expect(selected.draft).toEqual({
      text: "One\nTwo",
      images: [{ type: "image", data: "cG5n", mimeType: "image/png" }],
    })
    const image = selected.draft.images[0]
    const selectedNode = selected.tree.nodes[0]
    if (!image || !selectedNode) throw new Error("Missing restored content")
    image.data = "changed"
    selectedNode.message.content = "changed"
    expect(tree.nodes[0]?.message).toEqual(request)
    const root = selectTreeNode(tree, null)
    expect(root.messages).toEqual([])
    expect(root.draft).toEqual({ text: "", images: [] })
    expect(root.tree.nodes).toEqual(tree.nodes)
    expect(getTreePath(tree, null)).toEqual([])
    const path = getTreePath(tree)
    const pathNode = path[0]
    if (!pathNode) throw new Error("Missing path node")
    pathNode.message.content = "changed"
    expect(tree.nodes[0]?.message).toEqual(request)
    expect(() => getTreePath(tree, "missing")).toThrow("not found")
    expect(() => selectTreeNode(tree, "missing")).toThrow("not found")
  })

  test("tool-call prefixes become selectable only after every matching result", () => {
    const tree = expectBoundaries(
      [user(), calls("a", "b"), result("b"), result("a"), assistant()],
      [true, false, false, true, true],
    )
    const selected = selectTreeNode(tree, nodeId(tree, 3))
    expect(selected.messages).toEqual([user(), calls("a", "b"), result("b"), result("a")])
    expect(selected.draft).toEqual({ text: "", images: [] })
    expectBoundaries(
      [user(), calls("a"), user("Cannot edit from incomplete prefix"), result("a"), assistant()],
      [true, false, false, false, false],
    )
  })

  test.each(["pending", "aborted", "error", "deferred"] as const)(
    "retains %s history but rejects it and later continuation boundaries",
    (reason) => {
      const tree = expectBoundaries(
        [
          user(),
          assistant("Complete"),
          assistant("Interrupted", reason),
          user("Later"),
          assistant("Not safe"),
        ],
        [true, true, false, false, false],
      )
      expect(validateSessionTree(tree)).toBe(true)
      expect(selectTreeNode(tree, nodeId(tree, 1)).messages).toEqual([
        user(),
        assistant("Complete"),
      ])
      expect(selectTreeNode(tree, nodeId(tree, 0)).messages).toEqual([])
      expect(selectTreeNode(tree, null).messages).toEqual([])
    },
  )

  test("rejects duplicate calls, duplicate/orphan results, tool-name mismatches and invalid call endings", () => {
    expectBoundaries(
      [user(), calls("a", "a"), result("a"), assistant()],
      [true, false, false, false],
    )
    expectBoundaries(
      [user(), calls("a"), result("a"), result("a"), assistant()],
      [true, false, true, false, false],
    )
    expectBoundaries([user(), result("orphan"), assistant()], [true, false, false])
    expectBoundaries(
      [user(), calls("a"), { ...result("a"), toolName: "wrong" }, assistant()],
      [true, false, false, false],
    )
    expectBoundaries(
      [user(), calls("a"), result("a"), calls("a"), result("a")],
      [true, false, true, false, false],
    )
    expectBoundaries(
      [user(), { ...calls("a"), stopReason: "aborted" }, result("a"), assistant()],
      [true, false, false, false],
    )
    expectBoundaries(
      [user(), { ...calls("a"), stopReason: "stop" }, result("a")],
      [true, false, false],
    )
    expectBoundaries([user(), assistant("No calls", "toolUse")], [true, false])
    expectBoundaries([user(), assistant("Length boundary", "length")], [true, true])
  })

  test("a bad branch does not poison valid sibling tool-call boundaries", () => {
    const original = createSessionTree([
      user(),
      calls("a", "b"),
      result("a"),
      result("b"),
      assistant(),
    ])
    const bad = syncSessionTree(selectTreeNode(original, null).tree, [
      user("bad"),
      result("a"),
      assistant("invalid"),
    ])
    const good = syncSessionTree(selectTreeNode(bad, null).tree, [
      user("good"),
      calls("a"),
      result("a"),
      assistant("valid"),
    ])
    expect(getTreeItems(good).map((item) => item.selectable)).toEqual([
      true,
      false,
      false,
      true,
      true,
      true,
      false,
      false,
      true,
      false,
      true,
      true,
    ])
    expect(selectTreeNode(good, nodeId(original, 3)).messages).toHaveLength(4)
  })

  test("labels are bounded text without control characters or image/signature payloads", () => {
    const message = assistant()
    message.content.push({
      type: "thinking",
      thinking: "private reasoning",
      thinkingSignature: "opaque",
    })
    const tree = createSessionTree([user(`<script>\n\u0000\u202e${"x".repeat(500)}`), message])
    const items = getTreeItems(tree)
    expect(items.every((item) => item.label.length <= 160)).toBe(true)
    expect(items[0]?.label).toMatch(/^<script> x+$/)
    expect(items[1]?.label).toBe("Answer [thinking]")
    expect(JSON.stringify(items)).not.toContain("private reasoning")
    expect(JSON.stringify(items)).not.toContain("opaque")
  })

  test("strict graph validation rejects missing fields, duplicate IDs, cycles, forward parents and bad roles", () => {
    const tree = createSessionTree([user(), assistant()])
    const first = nodeId(tree, 0)
    const second = nodeId(tree, 1)
    const invalid: unknown[] = [
      null,
      {},
      { ...tree, version: 2 },
      { ...tree, activeLeafId: "missing" },
      { ...tree, activeLeafId: undefined },
      { ...tree, nodes: [...tree.nodes, tree.nodes[0]] },
      { ...tree, nodes: [{ ...tree.nodes[0], parentId: first }] },
      { ...tree, nodes: [{ ...tree.nodes[0], parentId: second }, tree.nodes[1]] },
      { ...tree, nodes: [{ ...tree.nodes[0], parentId: "missing" }] },
      { ...tree, nodes: [{ ...tree.nodes[0], id: "" }] },
      {
        ...tree,
        nodes: [{ ...tree.nodes[0], message: { role: "custom", content: "text", timestamp: 0 } }],
      },
      {
        ...tree,
        nodes: [{ ...tree.nodes[0], message: { role: "user", content: 123, timestamp: 0 } }],
      },
      {
        ...tree,
        nodes: [
          {
            ...tree.nodes[0],
            message: { role: "user", content: [{ type: "image", data: "x" }], timestamp: 0 },
          },
        ],
      },
      { ...tree, nodes: [{ ...tree.nodes[0], message: { ...assistant(), usage: {} } }] },
      {
        ...tree,
        nodes: [{ ...tree.nodes[0], message: { ...assistant(), stopReason: "unknown" } }],
      },
      { ...tree, nodes: [{ ...tree.nodes[0], message: { ...user(), timestamp: Number.NaN } }] },
    ]
    expect(validateSessionTree(tree)).toBe(true)
    for (const value of invalid) expect(validateSessionTree(value)).toBe(false)
    expect(() => getTreeItems(invalid[0] as SessionTree)).toThrow("Invalid session tree")
  })

  test("bounds nodes and traverses a maximum-depth tree without recursion", () => {
    const nodes = Array.from({ length: MAX_TREE_NODES }, (_, index) => ({
      id: String(index),
      parentId: index === 0 ? null : String(index - 1),
      message: user(),
    }))
    const tree: SessionTree = { version: 1, nodes, activeLeafId: String(MAX_TREE_NODES - 1) }
    expect(validateSessionTree(tree)).toBe(true)
    expect(getTreePath(tree)).toHaveLength(MAX_TREE_NODES)
    expect(getTreeItems(tree).at(-1)?.depth).toBe(MAX_TREE_NODES - 1)
    expect(selectTreeNode(tree, tree.activeLeafId).messages).toHaveLength(MAX_TREE_NODES - 1)
    expect(() => syncSessionTree(tree, [...nodes.map((node) => node.message), user()])).toThrow(
      "node limit",
    )
    expect(
      validateSessionTree({
        ...tree,
        nodes: [...nodes, { id: "overflow", parentId: null, message: user() }],
      }),
    ).toBe(false)
    expect(() =>
      createSessionTree(Array.from({ length: MAX_TREE_NODES + 1 }, () => user())),
    ).toThrow("node limit")
  })
})
