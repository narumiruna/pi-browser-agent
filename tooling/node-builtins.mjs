export const NODE_BUILTIN_IMPORT =
  /\b(?:import|export)\s+(?:[^"'()\n;]*?\s+from\s+)?["']node:|\b(?:import|require)\s*\(\s*["']node:/

export function containsNodeBuiltinImport(source) {
  return NODE_BUILTIN_IMPORT.test(source)
}
