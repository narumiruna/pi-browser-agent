export function getSourceIdentity(text, protectedFragments) {
  return JSON.stringify([text, protectedFragments || []])
}
