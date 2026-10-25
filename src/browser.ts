// In the browser: a ghost session's signed upload is minted for ghost/<session>/<path>, but storage-js PUTs to the path
// the app asked for, and storage refuses a token whose own object differs. Following the token fixes that, and is a
// no-op for every real upload (its token names the same path).
const SIGNED_UPLOAD = /^(.*\/storage\/v1\/object\/upload\/sign\/)([^/]+)\/(.+)$/

/** A signed-upload token's own object (bucket/path), read without checking the signature: storage checks it. */
export function tokenObject(token: string): string | null {
  const part = token.split(".")[1]
  if (!part) return null
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/")
    const bytes = Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0))
    const json = JSON.parse(new TextDecoder().decode(bytes)) as { url?: unknown }
    return typeof json.url === "string" ? json.url : null
  } catch {
    return null
  }
}

/** The ghost object a signed upload's token was minted for, when it isn't the URL's own; null otherwise. */
export function ghostUploadTarget(method: string, url: URL): string | null {
  if (method.toUpperCase() !== "PUT") return null
  const m = SIGNED_UPLOAD.exec(url.pathname)
  const token = url.searchParams.get("token")
  if (!m || !token) return null
  const bucket = decodeURIComponent(m[2]!)
  const object = tokenObject(token)
  if (!object?.startsWith(`${bucket}/ghost/`) || object === `${bucket}/${decodeURIComponent(m[3]!)}`) return null
  return object
}

const encodeObject = (object: string) => object.split("/").map(encodeURIComponent).join("/")

/** fetch for a browser Supabase client: a ghost session's signed upload goes where its token says. */
export const followGhostUploads: typeof fetch = (input, init) => {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET")
  let url: URL
  try {
    url = new URL(input instanceof Request ? input.url : String(input))
  } catch {
    return fetch(input, init)
  }
  const object = ghostUploadTarget(method, url)
  if (!object) return fetch(input, init)
  url.pathname = SIGNED_UPLOAD.exec(url.pathname)![1] + encodeObject(object)
  return input instanceof Request ? fetch(new Request(url, input), init) : fetch(url, init)
}
