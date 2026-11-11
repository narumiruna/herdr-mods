import { Worker } from "node:worker_threads"

const TIMEOUT_MS = 8000

// One active job. A terminated worker is never reused. The caller serializes jobs.
export class WorkerRenderer {
  constructor({
    createWorker = () =>
      new Worker(new URL("./worker.js", import.meta.url), {
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
        execArgv: [],
      }),
    timeoutMs = TIMEOUT_MS,
  } = {}) {
    this.createWorker = createWorker
    this.timeoutMs = timeoutMs
    this.worker = null
    this.active = null
    this.closed = false
  }

  async render(kind, source, options, display) {
    await this.stopping
    if (this.closed) throw new Error("Renderers closed")
    if (this.active) throw new Error("Worker is busy")
    const worker = this.worker || this.createWorker()
    this.worker = worker
    return new Promise((resolve, reject) => {
      const finish = (error, result, terminate = false) => {
        if (this.active?.finish !== finish) return
        clearTimeout(timer)
        worker.off("message", onMessage)
        worker.off("error", onError)
        worker.off("exit", onExit)
        this.active = null
        if (terminate) {
          this.worker = null
          // Keep an error listener until termination completes.
          worker.on("error", () => {})
          const stopped = worker.terminate()
          this.stopping = Promise.resolve(stopped).catch(() => {})
        }
        if (error) reject(error)
        else resolve(result)
      }
      const onMessage = (message) => {
        if (message.error) finish(new Error(message.error))
        else finish(null, message.result)
      }
      const onError = (error) => finish(error, null, true)
      const onExit = () => finish(new Error("Renderer worker exited"), null, true)
      const timer = setTimeout(
        () => finish(new Error("Renderer worker timeout"), null, true),
        this.timeoutMs,
      )
      this.active = { finish }
      worker.once("message", onMessage)
      worker.once("error", onError)
      worker.once("exit", onExit)
      try {
        worker.postMessage({ kind, source, options, display })
      } catch (error) {
        finish(error, null, true)
      }
    })
  }

  async close() {
    this.closed = true
    this.active?.finish(new Error("Renderers closed"), null, true)
    const worker = this.worker
    this.worker = null
    if (worker) await worker.terminate()
    await this.stopping
  }
}
