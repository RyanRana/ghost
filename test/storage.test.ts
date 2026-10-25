import { createClient } from "@supabase/supabase-js"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ghostDatabaseWrite } from "../src/write.js"
import { MemoryGhostLog } from "../src/log/memory.js"
import { followGhostUploads, ghostUploadTarget, tokenObject } from "../src/browser.js"
import { deleteGhostObjects, ghostStorage, sessionStorage, storageOp } from "../src/storage.js"

const HOST = "https://test.supabase.co"
const STORAGE = `${HOST}/storage/v1`

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
const token = (object: string) => `${b64url({ alg: "HS256" })}.${b64url({ url: object })}.sig`

/** Just enough of Supabase Storage: objects by bucket/path, and a signed upload that only takes its token's object. */
function fakeStorage(seed: Record<string, string> = {}) {
  const objects = new Map(Object.entries(seed))
  const calls: string[] = []
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const path = decodeURIComponent(url.pathname.slice("/storage/v1".length))
    calls.push(`${request.method} ${path}`)
    const body = () => request.clone().json() as Promise<Record<string, any>>
    let m: RegExpExecArray | null
    if (request.method === "GET" && path === "/bucket") return Response.json([{ id: "qc-photos" }, { id: "documents" }])
    if ((m = /^\/object\/upload\/sign\/([^/]+)\/(.+)$/.exec(path))) {
      const object = `${m[1]}/${m[2]}`
      if (request.method === "POST") return Response.json({ url: `/object/upload/sign/${object}?token=${token(object)}` })
      if (tokenObject(url.searchParams.get("token") ?? "") !== object) return Response.json({ statusCode: "403", error: "InvalidSignature" }, { status: 400 })
      objects.set(object, await request.text())
      return Response.json({ Key: object })
    }
    if ((m = /^\/object\/sign\/([^/]+)\/(.+)$/.exec(path))) {
      const object = `${m[1]}/${m[2]}`
      return objects.has(object) ? Response.json({ signedURL: `/object/sign/${object}?token=t` }) : Response.json({ statusCode: "404" }, { status: 400 })
    }
    if ((m = /^\/object\/sign\/([^/]+)$/.exec(path))) {
      const { paths } = await body()
      return Response.json((paths as string[]).map((p) => objects.has(`${m![1]}/${p}`)
        ? { path: p, signedURL: `/object/sign/${m![1]}/${p}?token=t`, error: null } : { path: p, signedURL: null, error: "not found" }))
    }
    if ((m = /^\/object\/list\/([^/]+)$/.exec(path))) {
      const { prefix } = await body()
      const at = String(prefix).replace(/\/+$/, "")
      const names = new Map<string, { name: string; id: string | null }>()
      for (const key of objects.keys()) {
        if (!key.startsWith(`${m[1]}/`)) continue
        const rest = key.slice(m[1]!.length + 1)
        if (at && !rest.startsWith(`${at}/`)) continue
        const tail = at ? rest.slice(at.length + 1) : rest
        const [head, ...more] = tail.split("/")
        names.set(head!, { name: head!, id: more.length ? null : `id-${key}` })
      }
      return Response.json([...names.values()])
    }
    if (request.method === "POST" && path === "/object/copy") {
      const { bucketId, sourceKey, destinationKey, destinationBucket } = await body()
      const from = `${bucketId}/${sourceKey}`
      if (!objects.has(from)) return Response.json({ statusCode: "404" }, { status: 400 })
      objects.set(`${destinationBucket ?? bucketId}/${destinationKey}`, objects.get(from)!)
      return Response.json({ Key: `${destinationBucket ?? bucketId}/${destinationKey}` })
    }
    if (request.method === "DELETE" && (m = /^\/object\/([^/]+)$/.exec(path))) {
      const { prefixes } = await body()
      for (const p of prefixes as string[]) objects.delete(`${m[1]}/${p}`)
      return Response.json((prefixes as string[]).map((name) => ({ name })))
    }
    if ((m = /^\/object\/(?:authenticated\/)?([^/]+)\/(.+)$/.exec(path)) && request.method === "GET") {
      const object = `${m[1]}/${m[2]}`
      return objects.has(object) ? new Response(objects.get(object)) : Response.json({ statusCode: "404" }, { status: 400 })
    }
    if ((m = /^\/object\/([^/]+)\/(.+)$/.exec(path)) && request.method === "POST") {
      objects.set(`${m[1]}/${m[2]}`, await request.text())
      return Response.json({ Key: `${m[1]}/${m[2]}` })
    }
    return Response.json({ statusCode: "400", error: `unhandled ${request.method} ${path}` }, { status: 400 })
  }
  const send = vi.fn<typeof fetch>((input, init) => handle(new Request(input, init)))
  return { objects, calls, send, handle }
}

/** A server client in a ghost session: every storage call goes through ghost mode, as the guard sends it. */
function ghostClient(store: ReturnType<typeof fakeStorage>, log: MemoryGhostLog) {
  const real = (request: Request) => store.handle(request)
  return createClient(HOST, "service-key", {
    auth: { persistSession: false },
    global: {
      fetch: async (input, init) => {
        const request = new Request(input, init)
        if (request.method === "GET" || request.method === "HEAD") return (await ghostStorage(request, log, real)) ?? real(request)
        return ghostDatabaseWrite(request, log, { dispatch: vi.fn(), relations: vi.fn(), real, functions: {}, inSession: (run) => run() })
      },
    },
  })
}

const realClient = (store: ReturnType<typeof fakeStorage>) =>
  createClient(HOST, "service-key", { auth: { persistSession: false }, global: { fetch: (i, init) => store.handle(new Request(i, init)) } })

let store: ReturnType<typeof fakeStorage>
let log: MemoryGhostLog

beforeEach(() => {
  store = fakeStorage({ "qc-photos/op1/old.jpg": "real-old", "qc-photos/op1/keep.jpg": "real-keep" })
  log = new MemoryGhostLog("sess-aaaa")
})

describe("storage calls", () => {
  it("names each storage-js call from its method and path", () => {
    const op = (method: string, path: string) => storageOp(method, new URL(`${STORAGE}/object/${path}`))
    expect(op("POST", "upload/sign/qc-photos/op1/a.jpg")).toEqual({ kind: "upload-sign", bucket: "qc-photos", path: "op1/a.jpg" })
    expect(storageOp("PUT", new URL(`${STORAGE}/object/upload/sign/qc-photos/op1/a.jpg?token=t`))).toMatchObject({ kind: "upload-signed", token: "t" })
    expect(op("POST", "qc-photos/op1/a.jpg")).toEqual({ kind: "upload", bucket: "qc-photos", path: "op1/a.jpg" })
    expect(op("POST", "sign/qc-photos/op1/a.jpg")).toEqual({ kind: "sign", bucket: "qc-photos", path: "op1/a.jpg" })
    expect(op("POST", "sign/qc-photos")).toEqual({ kind: "sign-many", bucket: "qc-photos" })
    expect(op("POST", "list/qc-photos")).toEqual({ kind: "list", bucket: "qc-photos" })
    expect(op("GET", "info/qc-photos/op1/a.jpg")).toMatchObject({ kind: "info", path: "op1/a.jpg" })
    expect(op("GET", "authenticated/qc-photos/op1/a.jpg")).toMatchObject({ kind: "download", path: "op1/a.jpg" })
    expect(op("HEAD", "qc-photos/op1/a.jpg")).toMatchObject({ kind: "download", path: "op1/a.jpg" })
    expect(op("DELETE", "qc-photos")).toEqual({ kind: "remove", bucket: "qc-photos" })
    expect(op("POST", "move")).toEqual({ kind: "move" })
    expect(storageOp("GET", new URL(`${HOST}/rest/v1/qc_photos`))).toBeNull()
  })
})

describe("a ghost upload", () => {
  it("runs the QC photo flow: mint, browser upload, sign; the object lands only under ghost/<session>/", async () => {
    const sb = ghostClient(store, log)
    const minted = await sb.storage.from("qc-photos").createSignedUploadUrl("op1/new.jpg")
    expect(minted.error).toBeNull()
    expect(minted.data!.path).toBe("op1/new.jpg")
    expect(tokenObject(minted.data!.token)).toBe("qc-photos/ghost/sess-aaaa/op1/new.jpg")

    const browser = createClient(HOST, "anon", { auth: { persistSession: false }, global: { fetch: followGhostUploads } })
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => store.handle(new Request(input, init)))
    try {
      const uploaded = await browser.storage.from("qc-photos").uploadToSignedUrl(minted.data!.path, minted.data!.token, "jpeg", { upsert: true })
      expect(uploaded.error).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
    expect(store.objects.get("qc-photos/ghost/sess-aaaa/op1/new.jpg")).toBe("jpeg")
    expect(store.objects.has("qc-photos/op1/new.jpg")).toBe(false)

    const signed = await sb.storage.from("qc-photos").createSignedUrl("op1/new.jpg", 60)
    expect(signed.data?.signedUrl).toContain("/object/sign/qc-photos/ghost/sess-aaaa/op1/new.jpg")
    const many = await sb.storage.from("qc-photos").createSignedUrls(["op1/new.jpg", "op1/keep.jpg"], 60)
    expect(many.data?.map((r) => [r.path, r.signedUrl?.includes("ghost/sess-aaaa") ?? null])).toEqual([["op1/new.jpg", true], ["op1/keep.jpg", false]])

    expect(await sessionStorage(log)).toEqual(new Map([["qc-photos/op1/new.jpg",
      { bucket: "qc-photos", path: "op1/new.jpg", ghostPath: "ghost/sess-aaaa/op1/new.jpg" }]]))
  })

  it("is invisible to other sessions and to real users", async () => {
    await ghostClient(store, log).storage.from("qc-photos").upload("op1/new.jpg", "jpeg")
    const other = ghostClient(store, new MemoryGhostLog("sess-bbbb"))
    expect((await other.storage.from("qc-photos").createSignedUrl("op1/new.jpg", 60)).error).not.toBeNull()
    expect((await realClient(store).storage.from("qc-photos").createSignedUrl("op1/new.jpg", 60)).error).not.toBeNull()
    const realList = await other.storage.from("qc-photos").list("op1")
    expect(realList.data?.map((e) => e.name).sort()).toEqual(["keep.jpg", "old.jpg"])
    const root = await other.storage.from("qc-photos").list("")
    expect(root.data?.map((e) => e.name)).toEqual(["op1"])
  })

  it("lists and downloads the session's objects over the real ones", async () => {
    const sb = ghostClient(store, log)
    await sb.storage.from("qc-photos").upload("op1/new.jpg", "jpeg")
    await sb.storage.from("qc-photos").remove(["op1/old.jpg"])
    expect(store.objects.get("qc-photos/op1/old.jpg")).toBe("real-old")
    const listed = await sb.storage.from("qc-photos").list("op1")
    expect(listed.data?.map((e) => e.name)).toEqual(["keep.jpg", "new.jpg"])
    expect(await (await sb.storage.from("qc-photos").download("op1/new.jpg")).data?.text()).toBe("jpeg")
    expect((await sb.storage.from("qc-photos").download("op1/old.jpg")).error).not.toBeNull()
    expect(await (await sb.storage.from("qc-photos").download("op1/keep.jpg")).data?.text()).toBe("real-keep")
  })

  it("moves by copying into ghost/: the real source stays, only this session stops seeing it", async () => {
    const sb = ghostClient(store, log)
    expect((await sb.storage.from("qc-photos").move("op1/old.jpg", "op2/moved.jpg")).error).toBeNull()
    expect(store.objects.get("qc-photos/op1/old.jpg")).toBe("real-old")
    expect(store.objects.get("qc-photos/ghost/sess-aaaa/op2/moved.jpg")).toBe("real-old")
    expect((await sb.storage.from("qc-photos").createSignedUrl("op1/old.jpg", 60)).error).not.toBeNull()
    expect((await sb.storage.from("qc-photos").createSignedUrl("op2/moved.jpg", 60)).data?.signedUrl).toContain("ghost/sess-aaaa/op2/moved.jpg")
  })

  it("never deletes a real object, and only removes its own ghost copy for real", async () => {
    const sb = ghostClient(store, log)
    await sb.storage.from("qc-photos").upload("op1/new.jpg", "jpeg")
    await sb.storage.from("qc-photos").remove(["op1/new.jpg", "op1/keep.jpg"])
    expect(store.objects.has("qc-photos/ghost/sess-aaaa/op1/new.jpg")).toBe(false)
    expect(store.objects.get("qc-photos/op1/keep.jpg")).toBe("real-keep")
    expect(store.calls.filter((c) => c.startsWith("DELETE"))).toEqual(["DELETE /object/qc-photos"])
  })

  it("refuses a signed upload whose token isn't this session's ghost folder", async () => {
    const put = (object: string) => ghostStorage(new Request(`${STORAGE}/object/upload/sign/qc-photos/op1/a.jpg?token=${token(object)}`,
      { method: "PUT", body: "x" }), log, store.handle)
    expect((await put("qc-photos/op1/a.jpg"))!.status).toBe(400)
    expect((await put("qc-photos/ghost/sess-bbbb/op1/a.jpg"))!.status).toBe(400)
    expect((await put("qc-photos/ghost/sess-aaaa/op1/a.jpg"))!.ok).toBe(true)
    expect([...store.objects.keys()].filter((k) => k.includes("a.jpg"))).toEqual(["qc-photos/ghost/sess-aaaa/op1/a.jpg"])
  })

  it("leaves a call that touches none of the session's objects to go out as is", async () => {
    const sign = new Request(`${STORAGE}/object/sign/qc-photos/op1/keep.jpg`, { method: "POST", body: "{}" })
    expect(await ghostStorage(sign, log, store.handle)).toBeNull()
  })
})

describe("the browser's signed upload", () => {
  it("follows a ghost token to its object and leaves every real upload alone", () => {
    const at = (object: string) => new URL(`${STORAGE}/object/upload/sign/qc-photos/op1/a.jpg?token=${token(object)}`)
    expect(ghostUploadTarget("PUT", at("qc-photos/ghost/s1/op1/a.jpg"))).toBe("qc-photos/ghost/s1/op1/a.jpg")
    expect(ghostUploadTarget("PUT", at("qc-photos/op1/a.jpg"))).toBeNull()
    expect(ghostUploadTarget("PUT", at("documents/ghost/s1/op1/a.jpg"))).toBeNull()
    expect(ghostUploadTarget("POST", at("qc-photos/ghost/s1/op1/a.jpg"))).toBeNull()
  })
})

describe("cleanup", () => {
  it("deletes the session's ghost/ folder in every bucket, and nothing else", async () => {
    const sb = ghostClient(store, log)
    await sb.storage.from("qc-photos").upload("op1/new.jpg", "jpeg")
    await sb.storage.from("documents").upload("a/b/c.pdf", "pdf")
    store.objects.set("qc-photos/ghost/sess-bbbb/op1/x.jpg", "other session")
    const deleted = await deleteGhostObjects("sess-aaaa", [], STORAGE.replace("/storage/v1", ""), {}, store.send)
    expect(deleted).toBe(2)
    expect([...store.objects.keys()].sort()).toEqual(["qc-photos/ghost/sess-bbbb/op1/x.jpg", "qc-photos/op1/keep.jpg", "qc-photos/op1/old.jpg"])
  })

  it("refuses a session id that could reach outside its folder", async () => {
    await expect(deleteGhostObjects("../op1", ["qc-photos"], HOST, {}, store.send)).rejects.toThrow(/refusing/)
    await expect(deleteGhostObjects("", ["qc-photos"], HOST, {}, store.send)).rejects.toThrow(/refusing/)
  })
})
