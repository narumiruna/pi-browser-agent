export const NODE_BUILTIN_IMPORT =
  /\b(?:import|export)\b(?:\s*["']node:|[^"'()\n;]*?\bfrom\s*["']node:)|\b(?:import|require)\b\s*\(\s*["']node:/

export function containsNodeBuiltinImport(source) {
  return NODE_BUILTIN_IMPORT.test(source)
}
