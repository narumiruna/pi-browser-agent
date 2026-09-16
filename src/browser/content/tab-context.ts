import { RuntimeError, type TabContext } from "../runtime/types.js"

export function assertTabContext(expected: TabContext | undefined, actual: TabContext): void {
  if (!expected) return
  if (
    expected.tabId !== actual.tabId ||
    expected.url !== actual.url ||
    expected.epoch !== actual.epoch
  ) {
    throw new RuntimeError(
      "STALE_CONTEXT",
      "The bound tab navigated after this request was created",
      {
        expected,
        actual,
      },
    )
  }
}
