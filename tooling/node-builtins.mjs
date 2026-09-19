import { parse } from "acorn"

export const NODE_BUILTIN_IMPORT =
  /\b(?:import|export)\s+(?:[^"'()\n;]*?\s+from\s+)?["']node:|\b(?:import|require)\s*\(\s*["']node:/

function literalNodeBuiltin(node) {
  return typeof node?.value === "string" && node.value.startsWith("node:")
}

export function containsNodeBuiltinImport(source) {
  if (!NODE_BUILTIN_IMPORT.test(source)) return false

  let root
  try {
    root = parse(source, { ecmaVersion: "latest", sourceType: "module" })
  } catch {
    // Invalid emitted JavaScript is already unsafe to ship; retain the conservative match.
    return true
  }

  const pending = [root]
  while (pending.length > 0) {
    const node = pending.pop()
    if (!node || typeof node !== "object") continue
    if (
      ((node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
        literalNodeBuiltin(node.source)) ||
      (node.type === "ImportExpression" && literalNodeBuiltin(node.source)) ||
      (node.type === "CallExpression" &&
        node.callee?.type === "Identifier" &&
        node.callee.name === "require" &&
        literalNodeBuiltin(node.arguments?.[0]))
    ) {
      return true
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) pending.push(...value)
      else if (value && typeof value === "object") pending.push(value)
    }
  }
  return false
}
