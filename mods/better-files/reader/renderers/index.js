import { checkSource } from "./svg.js"
import { WorkerRenderer } from "./worker-renderer.js"

const defaults = {
  dark: false,
  foreground: "#222222",
  background: "#ffffff",
  accent: "#4060bb",
  width: 800,
  fontFamily: "sans-serif",
}

function rendererOptions(options) {
  const result = { ...defaults }
  for (const key of Object.keys(defaults))
    if (options[key] !== undefined) result[key] = options[key]
  for (const name of ["foreground", "background", "accent"]) {
    if (typeof result[name] !== "string" || !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(result[name])) {
      throw new Error(`Invalid renderer ${name}`)
    }
  }
  if (
    typeof result.fontFamily !== "string" ||
    result.fontFamily.length > 200 ||
    !/^[\p{L}\p{N}\s,_-]+$/u.test(result.fontFamily)
  ) {
    throw new Error("Invalid renderer font family")
  }
  if (!Number.isFinite(result.width) || result.width < 64 || result.width > 2048)
    throw new Error("Invalid renderer width")
  result.dark = Boolean(result.dark)
  return result
}

// One instance is one document batch. Call close() in the batch's finally block,
// including when all render calls succeed. Cache hits do not start a worker/browser.
export class Renderers {
  constructor(options = {}) {
    this.options = rendererOptions(options)
    this.worker = new WorkerRenderer()
    this.mermaid = null
    this.tail = Promise.resolve()
    this.closed = false
    this.count = 0
    this.pending = 0
    this.onAbort = () => {
      void this.close().catch(() => {})
    }
    this.signal = options.signal
    this.signal?.addEventListener("abort", this.onAbort, { once: true })
    if (this.signal?.aborted) void this.close().catch(() => {})
  }

  async render(kind, source, { display = false } = {}) {
    if (this.closed) throw new Error("Renderers closed")
    if (!["math", "mermaid", "vega-lite"].includes(kind))
      throw new Error(`Unsupported renderer: ${kind}`)
    checkSource(source)
    if (this.pending >= 64 || this.count >= 256) throw new Error("Document render limit exceeded")
    this.count++
    this.pending++
    const task = this.tail.then(async () => {
      if (this.closed) throw new Error("Renderers closed")
      if (kind === "mermaid") {
        if (!this.mermaid) {
          const { MermaidRenderer } = await import("./mermaid.js")
          if (this.closed) throw new Error("Renderers closed")
          this.mermaid = new MermaidRenderer()
        }
        return this.mermaid.render(source, this.options)
      }
      return this.worker.render(kind, source, this.options, Boolean(display))
    })
    this.tail = task.catch(() => {})
    try {
      return await task
    } finally {
      this.pending--
    }
  }

  async close() {
    if (this.closing) return this.closing
    this.closed = true
    this.signal?.removeEventListener("abort", this.onAbort)
    this.closing = Promise.all([this.worker.close(), this.mermaid?.close()]).then(() => {})
    return this.closing
  }
}
