// biome-ignore lint/style/useNodejsImportProtocol: Herdr exposes this module without the Node prefix.
import { randomUUID } from "crypto"
// biome-ignore lint/style/useNodejsImportProtocol: Herdr exposes this module without the Node prefix.
import * as fs from "fs/promises"
import { appHome, exec, window } from "herdr"

export function createIO() {
  const home = appHome()
  const base = `${home}/data/markdown-reader`
  const helper = `${home}/mods/markdown-reader/helper.mjs`
  return {
    async request(entry, options) {
      await fs.mkdir(`${base}/requests`, { recursive: true })
      await fs.mkdir(`${base}/leases`, { recursive: true })
      const job = randomUUID()
      const path = `${base}/requests/${job}.json`
      await fs.writeFile(path, JSON.stringify({ ...entry, ...options, appHome: home }))
      return { job, path }
    },
    async render(request) {
      const result = await exec("node", ["--max-old-space-size=256", helper, request.path], {
        timeout: 90000,
      })
      if (result.code !== 0) throw new Error(result.stderr.trim() || "Markdown rendering failed")
      return JSON.parse(result.stdout)
    },
    async cancel(request) {
      const result = await exec("node", [helper, "--cancel", request.path], { timeout: 2000 })
      if (result.code !== 0) throw new Error("Could not cancel Markdown rendering")
    },
    async release(request) {
      for (const path of [
        request.path,
        `${request.path}.cancel`,
        `${base}/leases/${request.job}.json`,
      ]) {
        await fs.unlink(path).catch(() => {})
      }
    },
    async renew(request, assets) {
      await fs.writeFile(
        `${base}/leases/${request.job}.json`,
        JSON.stringify({
          expires: Date.now() + 60000,
          assets: assets.map((asset) => asset.split("/").pop()),
        }),
      )
    },
    async openExternal(url) {
      if (
        !/^(?:https?:\/\/|mailto:)/i.test(url) ||
        /["<>]/.test(url) ||
        [...url].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
      )
        throw new Error("Unsafe external URL")
      const platform = window()?.platform
      const [program, args] =
        platform === "windows"
          ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
          : platform === "macos"
            ? ["open", [url]]
            : ["xdg-open", [url]]
      const result = await exec(program, args)
      if (result.code !== 0) throw new Error("Could not open the external link")
    },
  }
}
