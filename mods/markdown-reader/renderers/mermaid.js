import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import puppeteer from "puppeteer"
import { checkSource, dimensions, MAX_SVG_BYTES, sanitizeSvg } from "./svg.js"

const require = createRequire(import.meta.url)
let bundle
const loadBundle = () =>
  (bundle ||= readFile(
    join(dirname(require.resolve("mermaid/package.json")), "dist/mermaid.min.js"),
    "utf8",
  ))

export function validateMermaid(source) {
  checkSource(source)
  if (Buffer.byteLength(source) > 32768) throw new Error("Mermaid source limit exceeded")
  if (/%%\s*\{|^\s*---(?:\s|$)/m.test(source))
    throw new Error("Mermaid directives and frontmatter are disabled")
  if ((source.match(/(?:--|==|~~|\.\.)[->ox|]+|<\|?--/g) || []).length > 256) {
    throw new Error("Mermaid edge limit exceeded")
  }
}

// Puppeteer starts Chromium in its own process group on POSIX. Only this owned
// browser group is terminated; never search for or kill unrelated Chromium processes.
export function killOwnedBrowser(browser) {
  const child = browser.process()
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === "win32") {
      const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        timeout: 5000,
        windowsHide: true,
        stdio: "ignore",
      })
      if (result.status !== 0) child.kill("SIGKILL")
    } else process.kill(-child.pid, "SIGKILL")
  } catch (error) {
    if (error.code !== "ESRCH") child.kill("SIGKILL")
  }
}

function deadline(promise, ms, message) {
  let timer
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer))
}

// Runs in the trusted page. Convert CSS to SVG presentation attributes before
// removing stylesheets. Native image loaders do not implement browser CSS.
export function flattenSvg(svg, maxBytes = 2 * 1024 * 1024) {
  const properties = [
    "fill",
    "fill-opacity",
    "fill-rule",
    "stroke",
    "stroke-width",
    "stroke-opacity",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-dasharray",
    "stroke-dashoffset",
    "stroke-miterlimit",
    "opacity",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "text-anchor",
    "dominant-baseline",
    "alignment-baseline",
    "baseline-shift",
    "letter-spacing",
    "text-decoration",
    "stop-color",
    "stop-opacity",
    "display",
    "visibility",
  ]
  // Snapshot styles first. Changing attributes while collecting styles changes CSS inheritance.
  const elements = [svg, ...svg.querySelectorAll("*")]
  if (elements.length > 30000) throw new Error("SVG complexity limit exceeded")
  const snapshots = elements.map((element) => {
    const style = getComputedStyle(element)
    const values = properties.map((name) => [name, style.getPropertyValue(name)])
    const references = ["marker-start", "marker-mid", "marker-end", "clip-path"].map((name) => [
      name,
      style.getPropertyValue(name),
    ])
    return { element, values, references }
  })
  for (const { element, values, references } of snapshots) {
    for (const [name, value] of values) if (value) element.setAttribute(name, value)
    // Computed marker URLs can be absolute about:blank URLs. Keep only local fragments.
    for (const [name, value] of references) {
      const fragment = /#([\w.-]+)["']?\)$/.exec(value)
      if (fragment) element.setAttribute(name, `url(#${fragment[1]})`)
    }
    element.removeAttribute("style")
    element.removeAttribute("class")
  }
  for (const style of svg.querySelectorAll("style")) style.remove()
  svg.removeAttribute("style")
  const box = svg.viewBox.baseVal
  const width = box.width || svg.getBoundingClientRect().width
  const height = box.height || svg.getBoundingClientRect().height
  const source = svg.outerHTML
  if (new TextEncoder().encode(source).length > maxBytes)
    throw new Error("SVG output limit exceeded")
  return { svg: source, width, height }
}

export class MermaidRenderer {
  constructor({
    launch = (options) => puppeteer.launch(options),
    timeoutMs = 8000,
    closeTimeoutMs = 1000,
    kill = killOwnedBrowser,
  } = {}) {
    this.launch = launch
    this.timeoutMs = timeoutMs
    this.closeTimeoutMs = closeTimeoutMs
    this.kill = kill
    this.browser = null
    this.launching = null
    this.launchController = null
    this.closed = false
    this.cancel = null
    this.stopping = null
    this.generation = 0
  }

  async getBrowser() {
    if (this.closed) throw new Error("Renderers closed")
    if (this.browser) return this.browser
    if (!this.launching) {
      const generation = this.generation
      this.launchController = new AbortController()
      const launching = this.launch({
        signal: this.launchController.signal,
        headless: true,
        timeout: this.timeoutMs,
        protocolTimeout: this.timeoutMs,
        // Keep the Chromium sandbox. No authored files are passed to Chromium.
        args: ["--disable-background-networking", "--disable-component-update", "--disable-sync"],
      })
      this.launching = Promise.resolve(launching).then(async (browser) => {
        if (this.closed || generation !== this.generation) {
          await this.stopBrowser(browser)
          throw new Error("Renderers closed")
        }
        this.browser = browser
        return browser
      })
    }
    return this.launching
  }

  async waitForExit(browser) {
    const child = browser.process?.()
    if (!child?.once || child.exitCode !== null || child.signalCode !== null) return
    let exited
    const exit = new Promise((done) => {
      exited = done
      child.once("exit", done)
    })
    try {
      await deadline(exit, this.closeTimeoutMs, "Browser process exit timeout")
    } finally {
      child.removeListener("exit", exited)
    }
  }

  async stopBrowser(browser) {
    try {
      await deadline(
        Promise.resolve().then(() => browser.close()),
        this.closeTimeoutMs,
        "Browser close timeout",
      )
    } catch {
      this.kill(browser)
    }
    try {
      await this.waitForExit(browser)
    } catch {
      this.kill(browser)
      await this.waitForExit(browser)
    }
  }

  async reset() {
    this.generation++
    const browser = this.browser
    this.browser = null
    this.launching = null
    // Puppeteer forwards this signal to its owned launch process. This also
    // cancels startup before a Browser handle is available.
    if (!browser) this.launchController?.abort()
    this.launchController = null
    if (browser) {
      this.stopping = this.stopBrowser(browser)
      await this.stopping
      this.stopping = null
    } else await this.stopping
  }

  async render(source, options) {
    if (this.closed) throw new Error("Renderers closed")
    validateMermaid(source)
    let page
    let active = true
    const assertActive = () => {
      if (!active || this.closed) throw new Error("Renderers closed")
    }
    let cancelled
    const cancellation = new Promise((_, reject) => {
      cancelled = reject
    })
    this.cancel = cancelled
    const job = (async () => {
      const browser = await this.getBrowser()
      if (this.closed) throw new Error("Renderers closed")
      page = await browser.newPage()
      assertActive()
      // Install interception BEFORE injecting the library or processing authored source.
      await page.setRequestInterception(true)
      page.on("request", (request) => {
        void request.abort("blockedbyclient").catch(() => {})
      })
      await page.setBypassServiceWorker(true)
      await page.setCacheEnabled(false)
      await page.setViewport({ width: Math.ceil(options.width), height: 800, deviceScaleFactor: 1 })
      await page.setContent(
        `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"></head><body><div id="host"></div></body></html>`,
      )
      const content = await loadBundle()
      assertActive()
      await page.addScriptTag({ content })
      assertActive()
      await page.evaluate(
        async (text, theme, maxBytes) => {
          document.body.style.margin = "0"
          document.body.style.color = theme.foreground
          document.body.style.background = theme.background
          document.body.style.fontFamily = theme.fontFamily
          const host = document.getElementById("host")
          host.style.width = `${theme.width}px`
          globalThis.mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            htmlLabels: false,
            theme: "base",
            fontFamily: theme.fontFamily,
            maxTextSize: 32768,
            maxEdges: 256,
            suppressErrorRendering: true,
            deterministicIds: true,
            deterministicIDSeed: "markdown-reader",
            secure: [
              "secure",
              "securityLevel",
              "startOnLoad",
              "htmlLabels",
              "theme",
              "themeVariables",
              "fontFamily",
              "maxTextSize",
              "maxEdges",
            ],
            flowchart: { htmlLabels: false, useMaxWidth: false },
            themeVariables: {
              darkMode: theme.dark,
              background: theme.background,
              primaryColor: theme.background,
              primaryTextColor: theme.foreground,
              primaryBorderColor: theme.accent,
              secondaryColor: theme.background,
              secondaryTextColor: theme.foreground,
              tertiaryColor: theme.background,
              tertiaryTextColor: theme.foreground,
              lineColor: theme.foreground,
              textColor: theme.foreground,
              mainBkg: theme.background,
              nodeTextColor: theme.foreground,
              edgeLabelBackground: theme.background,
              fontFamily: theme.fontFamily,
            },
          })
          const { svg } = await globalThis.mermaid.render("markdown-diagram", text, host)
          if (new TextEncoder().encode(svg).length > maxBytes)
            throw new Error("SVG output limit exceeded")
          host.innerHTML = svg
          await document.fonts.ready
        },
        source,
        options,
        MAX_SVG_BYTES,
      )
      // The first evaluation inserts SVG. The second reads the actual computed styles.
      assertActive()
      const svg = await page.$eval("#host > svg", flattenSvg, MAX_SVG_BYTES)
      dimensions(svg.width, svg.height)
      return sanitizeSvg(svg.svg, { ...options, width: svg.width, height: svg.height })
    })()
    try {
      return await deadline(
        Promise.race([job, cancellation]),
        this.timeoutMs,
        "Mermaid render timeout",
      )
    } catch (error) {
      active = false
      // A failed render cannot leave script execution running for the next block.
      await this.reset()
      throw error
    } finally {
      active = false
      if (this.cancel === cancelled) this.cancel = null
      if (page && !page.isClosed()) {
        try {
          await deadline(page.close(), this.closeTimeoutMs, "Page close timeout")
        } catch {
          await this.reset()
        }
      }
    }
  }

  async close() {
    this.closed = true
    this.cancel?.(new Error("Renderers closed"))
    await this.reset()
    await this.stopping
  }
}
