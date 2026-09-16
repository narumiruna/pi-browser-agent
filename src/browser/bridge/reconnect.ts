export const HEARTBEAT_INTERVAL_MS = 20_000
export const RECONNECT_ALARM = "pi-chrome-reconnect"

const MAX_RECONNECT_DELAY_MS = 30_000
const BASE_RECONNECT_DELAY_MS = 500

export function reconnectDelay(attempt: number, random = Math.random): number {
  const exponential = Math.min(MAX_RECONNECT_DELAY_MS, BASE_RECONNECT_DELAY_MS * 2 ** attempt)
  const jitter = 0.75 + random() * 0.5
  return Math.min(MAX_RECONNECT_DELAY_MS, Math.round(exponential * jitter))
}
