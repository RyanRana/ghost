/** What a held send carried, by shape only: its type, size and, for JSON, its top-level keys. Never a value. */
export async function bodySummary(request: Request): Promise<string> {
  const type = request.headers.get("content-type")?.split(";")[0] ?? "no body"
  const text = await request.clone().text().catch(() => "")
  const size = text.length < 1024 ? `${text.length} B` : `${(text.length / 1024).toFixed(1)} KB`
  if (!type.includes("json")) return `${type} ${size}`
  try {
    const parsed = JSON.parse(text) as unknown
    const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed).slice(0, 12) : []
    return keys.length ? `json ${size}: ${keys.join(", ")}` : `json ${size}`
  } catch {
    return `${type} ${size}`
  }
}

export type HostRule = string | RegExp

// Error reporting keeps working in ghost: it says what broke, it doesn't change anything.
export const DEFAULT_ALLOWED_HOSTS: HostRule[] = [/(^|\.)ingest(\.[a-z]+)?\.sentry\.io$/]

const allowed = (host: string, rules: readonly HostRule[]) => rules.some((r) => (typeof r === "string" ? r === host : r.test(host)))

/** A write leaving the server for anything but the database or an allowed host: ghost holds it. */
export function isOutboundWrite(method: string, url: URL, databaseHost: string, allow: readonly HostRule[] = DEFAULT_ALLOWED_HOSTS): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false
  if (url.host === databaseHost) return false
  return !allowed(url.host, allow)
}
