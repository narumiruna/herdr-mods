import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import puppeteer from "puppeteer"
import { describe, expect, it } from "vitest"
import { MermaidRenderer } from "../reader/renderers/mermaid.js"

const options = {
  dark: false,
  foreground: "#222222",
  background: "#ffffff",
  accent: "#4060bb",
  width: 800,
  fontFamily: "sans-serif",
}

function safe(result) {
  expect(result.width).toBeGreaterThan(0)
  expect(result.height).toBeGreaterThan(0)
  expect(result.svg).not.toMatch(
    /<(?:script|style|a|image|foreignObject)\b|\son\w+=|\sstyle=|\sclass=|currentColor|url\(["']?(?:https?:|file:|about:)/i,
  )
  expect(result.svg).toContain('xmlns="http://www.w3.org/2000/svg"')
}

function trackedLaunch() {
  const browsers = []
  const messages = []
  const labels = []
  const pages = []
  let bundles = 0
  const launch = async (settings) => {
    const browser = await puppeteer.launch(settings)
    browsers.push(browser)
    const newPage = browser.newPage.bind(browser)
    browser.newPage = async () => {
      const page = await newPage()
      page.on("console", (message) => messages.push(message.text()))
      pages.push(page)
      const addScriptTag = page.addScriptTag.bind(page)
      page.addScriptTag = (...args) => {
        bundles++
        return addScriptTag(...args)
      }
      const extract = page.$eval.bind(page)
      page.$eval = async (...args) => {
        labels.push(
          ...(await page.evaluate(() =>
            Array.from(document.querySelectorAll("svg text"), (node) => ({
              text: node.textContent,
              width: node.getBBox().width,
              height: node.getBBox().height,
            })),
          )),
        )
        return extract(...args)
      }
      return page
    }
    return browser
  }
  return {
    launch,
    browsers,
    messages,
    labels,
    pages,
    get bundles() {
      return bundles
    },
  }
}

function stopped(browser) {
  expect(browser.connected).toBe(false)
  const child = browser.process()
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
}

describe("official bundled Mermaid in sandboxed Chromium", () => {
  it("reuses one browser, preserves Chinese text, flattens CSS and closes the batch", async () => {
    const tracked = trackedLaunch()
    const renderer = new MermaidRenderer({ launch: tracked.launch })
    try {
      const start = performance.now()
      const first = await renderer.render(
        "flowchart TD\nA[中文标签] --> B[完成]\nclassDef custom fill:#123456,stroke:#abcdef,color:#fedcba\nclass A custom",
        options,
      )
      const coldMs = performance.now() - start
      safe(first)
      expect(first.svg).toContain("中文标签")
      expect(first.svg).toContain("完成")
      expect(first.svg).toContain('fill="rgb(18, 52, 86)"')
      expect(first.svg).toContain('stroke="rgb(171, 205, 239)"')
      expect(first.svg).toMatch(/marker-end="url\(#/)
      const warmStart = performance.now()
      const second = await renderer.render("sequenceDiagram\nAlice->>Bob: 你好，世界", options)
      safe(second)
      expect(second.svg).toContain("你好，世界")
      expect(second.svg).not.toContain("中文标签")
      const warmMs = performance.now() - warmStart
      const third = await renderer.render("flowchart TD\nA[Fresh] --> B[Clean]", {
        ...options,
        width: 600,
        foreground: "#eeeeee",
        background: "#111111",
        dark: true,
      })
      safe(third)
      expect(third.svg).toContain("Fresh")
      expect(third.svg).not.toMatch(/中文标签|Alice|18, 52, 86|171, 205, 239/)
      expect(third.svg).toContain("rgb(238, 238, 238)")
      expect(tracked.pages).toHaveLength(1)
      expect(tracked.bundles).toBe(1)
      expect(
        await tracked.pages[0].evaluate(() => ({
          children: document.body.childElementCount,
          styles: document.querySelectorAll("style").length,
          policy: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
        })),
      ).toMatchObject({
        children: 0,
        styles: 0,
        policy: expect.stringContaining("default-src 'none'"),
      })
      expect(tracked.browsers).toHaveLength(1)
      expect(tracked.browsers[0].connected).toBe(true)
      const chinese = tracked.labels.find((label) => label.text.includes("中文标签"))
      expect(chinese.width).toBeGreaterThan(0)
      expect(chinese.height).toBeGreaterThan(0)
      console.info(
        `Mermaid browser startup+first render: ${Math.round(coldMs)}ms; warm block: ${Math.round(warmMs)}ms`,
      )
    } finally {
      await renderer.close()
    }
    stopped(tracked.browsers[0])
    await renderer.close()
  })

  it("renders representative class, state, gantt and pie diagrams", async () => {
    const tracked = trackedLaunch()
    const renderer = new MermaidRenderer({ launch: tracked.launch })
    try {
      for (const source of [
        "classDiagram\nAnimal <|-- Duck\nAnimal: +int age\nDuck: +quack()",
        "stateDiagram-v2\n[*] --> Ready\nReady --> Done\nDone --> [*]",
        "gantt\ntitle Build\ndateFormat YYYY-MM-DD\nsection Work\nTask: 2026-11-11, 2d",
        'pie title 统计\n"甲" : 30\n"乙" : 70',
      ])
        safe(await renderer.render(source, options))
      expect(tracked.pages).toHaveLength(1)
      expect(tracked.bundles).toBe(1)
    } finally {
      await renderer.close()
    }
  })

  it("blocks document-controlled HTTP and file images before loading them", async () => {
    let requests = 0
    const server = createServer((_request, response) => {
      requests++
      response.end("not allowed")
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const directory = await mkdtemp(join(tmpdir(), "markdown-mermaid-test-"))
    const file = join(directory, "private.svg")
    await writeFile(
      file,
      '<svg xmlns="http://www.w3.org/2000/svg"><text>private-file-marker</text></svg>',
    )
    const tracked = trackedLaunch()
    const renderer = new MermaidRenderer({ launch: tracked.launch })
    try {
      const urls = [
        `http://127.0.0.1:${server.address().port}/private.svg`,
        pathToFileURL(file).href,
      ]
      for (const url of urls) {
        safe(await renderer.render("flowchart TD\nA[Warm] --> B[Page]", options))
        const page = tracked.pages.at(-1)
        await expect(
          renderer.render(`flowchart TD\nA@{ img: "${url}", label: "资源" } --> B[结束]`, options),
        ).rejects.toThrow()
        expect(page.isClosed()).toBe(true)
      }
      expect(requests).toBe(0)
      expect(
        tracked.messages.some((message) =>
          /Content Security Policy|Not allowed to load local resource/.test(message),
        ),
      ).toBe(true)
      for (const browser of tracked.browsers) stopped(browser)
      safe(await renderer.render("flowchart TD\nA[正常] --> B[完成]", options))
    } finally {
      await renderer.close()
      await new Promise((resolve) => server.close(resolve))
      await rm(directory, { recursive: true, force: true })
    }
    for (const browser of tracked.browsers) stopped(browser)
  })

  it("removes active links and authored HTML and keeps host theme settings", async () => {
    const renderer = new MermaidRenderer()
    try {
      const result = await renderer.render(
        'flowchart TD\nA[安全标签] --> B[完成]\nclick A "https://example.com/" "Link"',
        { ...options, dark: true, foreground: "#eeeeee", background: "#111111" },
      )
      safe(result)
      expect(result.svg).not.toContain("https://example.com")
      expect(result.svg).toContain("安全标签")
      expect(result.svg).toContain("rgb(238, 238, 238)")
      await expect(
        renderer.render(
          '%%{init: {"securityLevel":"loose","theme":"dark","flowchart":{"htmlLabels":true}}}%%\nflowchart TD\nA-->B',
          options,
        ),
      ).rejects.toThrow(/directives/)
    } finally {
      await renderer.close()
    }
  })

  it("disposes syntax failures and leaves the next block usable", async () => {
    const tracked = trackedLaunch()
    const renderer = new MermaidRenderer({ launch: tracked.launch })
    try {
      await expect(renderer.render("flowchart TD\nA[unterminated", options)).rejects.toThrow()
      stopped(tracked.browsers[0])
      safe(await renderer.render("flowchart TD\nA-->B", options))
      expect(tracked.pages).toHaveLength(2)
      expect(tracked.bundles).toBe(2)
    } finally {
      await renderer.close()
    }
    for (const browser of tracked.browsers) stopped(browser)
  })

  it("rejects active work and terminates the browser when closed", async () => {
    let browser
    let started
    const began = new Promise((resolve) => {
      started = resolve
    })
    const renderer = new MermaidRenderer({
      launch: async (settings) => {
        browser = await puppeteer.launch(settings)
        const newPage = browser.newPage.bind(browser)
        browser.newPage = async () => {
          const page = await newPage()
          const evaluate = page.evaluate.bind(page)
          page.evaluate = () => {
            started()
            return evaluate(() => new Promise(() => {}))
          }
          return page
        }
        return browser
      },
    })
    const work = renderer.render("flowchart TD\nA-->B", options)
    try {
      // Report startup failure directly instead of waiting for an event that cannot arrive.
      await Promise.race([
        began,
        work.then(() => {
          throw new Error("Render completed before cancellation")
        }),
      ])
      const rejected = expect(work).rejects.toThrow(/closed/)
      await renderer.close()
      await rejected
      stopped(browser)
    } finally {
      await renderer.close()
    }
  })

  it("terminates timed-out execution and can start a clean browser", async () => {
    const browsers = []
    let hang = false
    const renderer = new MermaidRenderer({
      launch: async (settings) => {
        const browser = await puppeteer.launch(settings)
        browsers.push(browser)
        const newPage = browser.newPage.bind(browser)
        browser.newPage = async () => {
          const page = await newPage()
          const evaluate = page.evaluate.bind(page)
          page.evaluate = (...args) =>
            hang ? evaluate(() => new Promise(() => {})) : evaluate(...args)
          return page
        }
        return browser
      },
    })
    try {
      safe(await renderer.render("flowchart TD\nA-->B", options))
      hang = true
      renderer.timeoutMs = 500
      await expect(renderer.render("flowchart TD\nB-->C", options)).rejects.toThrow(/timeout/)
      stopped(browsers[0])
      hang = false
      renderer.timeoutMs = 8000
      safe(await renderer.render("flowchart TD\nC-->D", options))
    } finally {
      await renderer.close()
    }
    for (const browser of browsers) stopped(browser)
  })
})
