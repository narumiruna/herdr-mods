import { rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { AssetCache, digest, JOB_NAME } from "./cache.js"
import { buildDocument } from "./document.js"
import { boundedRead, loadDocument } from "./files.js"
import { Renderers } from "./renderers/index.js"

export function requestLocation(path) {
  if (!isAbsolute(path) || !JOB_NAME.test(basename(path, ".json")) || !path.endsWith(".json"))
    throw new Error("Invalid reader request path")
  const directory = dirname(path)
  if (
    basename(directory) !== "requests" ||
    basename(dirname(directory)) !== "markdown-reader" ||
    basename(dirname(dirname(directory))) !== "data"
  )
    throw new Error("Reader request is outside the app cache")
  return { job: basename(path, ".json"), directory, home: dirname(dirname(dirname(directory))) }
}

export async function cancelRequest(path) {
  const { job, directory } = requestLocation(path)
  await writeFile(`${path}.cancel`, "cancelled", { mode: 0o600 })
  await rm(join(dirname(directory), "leases", `${job}.json`), { force: true })
}

export async function runRequest(
  path,
  { rendererFactory = (options) => new Renderers(options) } = {},
) {
  const location = requestLocation(path)
  const request = JSON.parse((await boundedRead(path, 32768)).toString("utf8"))
  if (resolve(request.appHome) !== location.home)
    throw new Error("Request app home does not match its cache path")
  if (request.on !== null && request.on !== undefined)
    throw new Error("Remote Markdown is not supported. No local file was read.")
  const width = Number(request.width ?? 800)
  if (!Number.isFinite(width) || width < 160 || width > 2048)
    throw new Error("Invalid reader width")
  const color = (value, fallback) =>
    typeof value === "string" && /^#[a-f0-9]{6}(?:[a-f0-9]{2})?$/i.test(value)
      ? value.slice(0, 7)
      : fallback
  const options = {
    dark: request.dark === true,
    foreground: color(request.foreground, request.dark === true ? "#e4e4e7" : "#24242a"),
    background: color(request.background, request.dark === true ? "#202026" : "#ffffff"),
    accent: color(request.accent, "#526bce"),
    width: Math.round(width),
    fontFamily: "sans-serif",
  }
  const abort = new AbortController()
  let renderer
  let cancelled = false
  let completed = false
  const cancel = () => {
    if (cancelled) return
    cancelled = true
    abort.abort()
    void Promise.resolve(renderer?.close()).catch(() => {})
  }
  const deadline = setTimeout(cancel, 70000)
  const poll = setInterval(async () => {
    try {
      await stat(`${path}.cancel`)
      cancel()
    } catch {}
  }, 100)
  const onSignal = () => cancel()
  process.once("SIGTERM", onSignal)
  process.once("SIGINT", onSignal)
  try {
    try {
      await stat(`${path}.cancel`)
      cancel()
    } catch {}
    if (cancelled) throw new Error("Reading cancelled")
    const cache = await new AssetCache(location.home).init()
    const document = await loadDocument(request)
    renderer = rendererFactory({ ...options, signal: abort.signal })
    const result = await buildDocument({
      ...document,
      cache,
      renderers: renderer,
      options,
      signal: abort.signal,
      job: location.job,
    })
    if (cancelled) throw new Error("Reading cancelled or rendering timed out")
    await cache.lease(location.job, result.assets)
    const manifest = { ...result, job: location.job, signature: digest(JSON.stringify(result)) }
    completed = true
    return manifest
  } finally {
    clearTimeout(deadline)
    clearInterval(poll)
    process.removeListener("SIGTERM", onSignal)
    process.removeListener("SIGINT", onSignal)
    let closed = false
    try {
      await renderer?.close()
      closed = true
    } finally {
      if (cancelled || !completed || !closed)
        await rm(join(dirname(location.directory), "leases", `${location.job}.json`), {
          force: true,
        })
      if (cancelled) {
        await rm(path, { force: true })
        await rm(`${path}.cancel`, { force: true })
      }
    }
  }
}

async function main(args) {
  if (args.length === 2 && args[0] === "--cancel") {
    await cancelRequest(args[1])
    return
  }
  if (args.length !== 1)
    throw new Error("Usage: node helper.mjs <request.json> | --cancel <request.json>")
  const result = JSON.stringify(await runRequest(args[0]))
  if (Buffer.byteLength(result) > 6 * 1024 * 1024)
    throw new Error("Rendered manifest exceeds the 6 MiB limit")
  process.stdout.write(result)
}

// Node resolves junctions and symlinks before loading this entry module.
if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${String(error.message).slice(0, 2000)}\n`)
    process.exitCode = 1
  })
}
