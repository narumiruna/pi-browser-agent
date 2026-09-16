interface TabContextLike {
  url?: unknown
}

function contextUrl(context: unknown): string | undefined {
  if (typeof context !== "object" || context === null || Array.isArray(context)) return undefined
  const { url } = context as TabContextLike
  return typeof url === "string" ? url : undefined
}

export class BoundTabState {
  private revision = 0
  private currentUrl?: string

  get url(): string | undefined {
    return this.currentUrl
  }

  beginRefresh(): number {
    this.revision += 1
    return this.revision
  }

  applyRefresh(revision: number, context: unknown): boolean {
    if (revision !== this.revision) return false
    this.currentUrl = contextUrl(context)
    return true
  }

  applyEvent(context: unknown): void {
    this.revision += 1
    this.currentUrl = contextUrl(context)
  }
}
