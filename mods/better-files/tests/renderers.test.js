import { EventEmitter } from "node:events"
import { Worker } from "node:worker_threads"
import { afterAll, describe, expect, it, vi } from "vitest"
import { Renderers } from "../reader/renderers/index.js"
import { MermaidRenderer, validateMermaid } from "../reader/renderers/mermaid.js"
import { MAX_SOURCE_BYTES, MAX_SVG_BYTES, sanitizeSvg } from "../reader/renderers/svg.js"
import { WorkerRenderer } from "../reader/renderers/worker-renderer.js"

const options = {
  dark: false,
  foreground: "#222222",
  background: "#ffffff",
  accent: "#4060bb",
  width: 800,
  fontFamily: "sans-serif",
}
const data = [
  { x: "甲", y: 2 },
  { x: "乙", y: 5 },
]
const unit = {
  mark: "bar",
  encoding: { x: { field: "x", type: "nominal" }, y: { field: "y", type: "quantitative" } },
}
const chart = { data: { values: data }, ...unit }
const renderers = new Renderers()
afterAll(() => renderers.close())

function checkSvg(result) {
  expect(result.width).toBeGreaterThan(0)
  expect(result.height).toBeGreaterThan(0)
  expect(result.svg).toContain(`width="${result.width}"`)
  expect(result.svg).toContain(`height="${result.height}"`)
  expect(result.svg).toContain('xmlns="http://www.w3.org/2000/svg"')
  expect(result.svg).not.toMatch(
    /<(?:script|foreignObject|image|style|a)\b|\son\w+=|currentColor|\sclass=|\sstyle=/i,
  )
}

describe("MathJax worker", () => {
  it("renders inline math at 16px metrics without font cache references", async () => {
    const result = await renderers.render("math", "x")
    checkSvg(result)
    expect(result.width).toBeGreaterThan(7)
    expect(result.width).toBeLessThan(13)
    expect(result.height).toBeLessThan(20)
    expect(result.svg).toContain("<path")
    expect(result.svg).not.toContain("<use")
    expect(result.svg).toContain('fill="#222222"')
  })

  it("supports display fractions, AMS matrices and host colors", async () => {
    const themed = new Renderers({ dark: true, foreground: "#eeeeee", background: "#111111" })
    try {
      const result = await themed.render(
        "math",
        String.raw`\frac{1}{2}+\begin{pmatrix}a&b\\c&d\end{pmatrix}`,
        { display: true },
      )
      checkSvg(result)
      expect(result.svg).toContain("#eeeeee")
      expect(result.height).toBeGreaterThan(30)
    } finally {
      await themed.close()
    }
  })

  it.each([
    String.raw`\href{https://example.com}{x}`,
    String.raw`\require{html}`,
    String.raw`\includegraphics{file:///etc/passwd}`,
    String.raw`\style{color:red}{x}`,
    String.raw`\undefinedCommand`,
  ])("rejects unsafe or unsupported TeX %s", async (source) => {
    await expect(renderers.render("math", source)).rejects.toThrow(/TeX/)
  })

  it("rejects unbalanced math and does not poison the next block", async () => {
    await expect(renderers.render("math", "\\frac{")).rejects.toThrow()
    checkSvg(await renderers.render("math", "y+1"))
  })

  it("does not retain authored macros across blocks", async () => {
    await renderers.render("math", String.raw`\def\localonly{x}\localonly`)
    await expect(renderers.render("math", String.raw`\localonly`)).rejects.toThrow()
  })

  it("bounds TeX macro expansion and source length", async () => {
    await expect(renderers.render("math", String.raw`\def\a{\a}\a`)).rejects.toThrow()
    await expect(renderers.render("math", "x".repeat(16385))).rejects.toThrow(/limit/)
  })
})

describe("static Vega-Lite worker", () => {
  it("renders inline bars with Chinese labels and concrete theme", async () => {
    const result = await renderers.render("vega-lite", JSON.stringify(chart))
    checkSvg(result)
    expect(result.svg).toContain("甲")
    expect(result.svg).toContain("乙")
    expect(result.svg).toContain("#4060bb")
  })

  it.each([
    { data: { values: data }, layer: [unit, { ...unit, mark: "point" }] },
    { data: { values: data }, hconcat: [unit, unit] },
    { data: { values: data }, concat: [unit, unit], columns: 2 },
    { data: { values: data }, vconcat: [unit, unit] },
    { data: { values: data }, facet: { field: "x", type: "nominal" }, spec: unit },
    {
      data: { values: data },
      repeat: ["y"],
      spec: {
        mark: "point",
        encoding: { x: { field: { repeat: "repeat" }, type: "quantitative" } },
      },
    },
    { datasets: { local: data }, data: { name: "local" }, ...unit },
    {
      data: {
        values: [{ x: "counts", y: 1000, count: 1000, url: "https://example.com/not-a-resource" }],
      },
      ...unit,
    },
    { ...chart, transform: [{ calculate: "datum.y + 2", as: "sum" }] },
    { ...chart, config: { axis: { grid: false, labelFontSize: 12 }, bar: { cornerRadius: 2 } } },
    {
      ...chart,
      transform: [
        { calculate: "datum.y * 2", as: "doubled" },
        { filter: "datum.y >= 2 && isValid(datum.x)" },
      ],
    },
    { ...chart, transform: [{ aggregate: [{ op: "sum", field: "y", as: "y" }], groupby: ["x"] }] },
    { ...chart, transform: [{ bin: { maxbins: 10 }, field: "y", as: "binned" }] },
  ])("renders bounded compositions, datasets, transforms and config %#", async (spec) => {
    checkSvg(await renderers.render("vega-lite", JSON.stringify(spec)))
  })

  it.each([
    { ...chart, data: { url: "https://example.com/data.json" } },
    { ...chart, data: { url: "file:///etc/passwd" } },
    { ...chart, mark: "image" },
    { ...chart, encoding: { href: { value: "https://example.com" } } },
    { ...chart, params: [{ name: "x", bind: "scales" }] },
    { ...chart, transform: [{ calculate: "sequence(0, 1e12)", as: "boom" }] },
    { ...chart, transform: [{ calculate: "repeat('x', 1e12)", as: "boom" }] },
    { ...chart, transform: [{ calculate: "datum.x + datum.x", as: "boom" }] },
    {
      data: { values: data },
      transform: [{ calculate: "toString(datum.y)", as: "y" }],
      layer: [{ ...unit, transform: [{ calculate: "datum.y + datum.y", as: "boom" }] }],
    },
    { ...chart, transform: [{ calculate: "replace(datum.x, regexp('(a+)+$'), 'x')", as: "boom" }] },
    { ...chart, transform: [{ calculate: "datum['constructor']", as: "boom" }] },
    { ...chart, transform: [{ calculate: "datum[datum.x]", as: "boom" }] },
    { ...chart, transform: [{ filter: "test(/(a+)+$/, datum.x)" }] },
    { ...chart, encoding: { x: { field: "x", axis: { labelExpr: "repeat('x',1e12)" } } } },
    {
      ...chart,
      encoding: { color: { condition: { test: "data('secrets')", value: "red" }, value: "blue" } },
    },
    { ...chart, encoding: { x: { field: "y", bin: { step: 1e-100 } } } },
    { ...chart, encoding: { x: { field: "y", axis: { tickCount: 1e12 } } } },
    {
      ...chart,
      encoding: { x: { field: "y", type: "temporal", axis: { tickCount: "millisecond" } } },
    },
    {
      ...chart,
      encoding: {
        color: { field: "x", scale: { scheme: { name: "blues", count: "1000000000" } } },
      },
    },
    {
      ...chart,
      encoding: { color: { field: "x", scale: { scheme: { name: "blues", count: 1e12 } } } },
    },
    { ...chart, transform: [{ density: "y" }] },
    { ...chart, transform: [{ lookup: "x", from: { data: { url: "file:///secret" } } }] },
    { data: { sequence: { start: 0, stop: 1e12 } }, ...unit },
    {
      data: { values: data },
      repeat: { row: Array(8).fill("x"), column: Array(8).fill("y") },
      spec: unit,
    },
    { data: { values: data }, layer: Array(9).fill(unit) },
    {
      data: { values: Array.from({ length: 17 }, (_, x) => ({ x, y: x })) },
      facet: { field: "x" },
      spec: unit,
    },
    { data: { values: Array(5001).fill({ x: 1 }) }, ...unit },
    { ...chart, width: 1e9 },
  ])("rejects resources and expansive/executable specifications %#", async (spec) => {
    await expect(renderers.render("vega-lite", JSON.stringify(spec))).rejects.toThrow()
  })

  it("recovers after malformed JSON", async () => {
    await expect(renderers.render("vega-lite", "{")).rejects.toThrow()
    checkSvg(await renderers.render("vega-lite", JSON.stringify(chart)))
  })
})

describe("SVG data sanitation", () => {
  const clean = (body) =>
    sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`, { width: 20, height: 10 })
  it("removes scripts, links, events, foreign HTML, resources and CSS", () => {
    const result = clean(
      `<style>path{fill:red}</style><script>alert(1)</script><foreignObject><div>bad</div></foreignObject><image href="file:///secret"/><a href="https://example.com" onclick="boom()"><text>safe label</text></a><path class="x" onclick="boom()" style="fill:currentColor;stroke:url(https://example.com/a)" d="M0 0L1 1"/>`,
    )
    checkSvg(result)
    expect(result.svg).toContain("safe label")
    expect(result.svg).not.toMatch(/file:|https:|boom|url\(/)
    expect(result.svg).toContain('fill="#222222"')
  })
  it("keeps local gradients, markers and glyph references only", () => {
    const result = clean(
      `<defs><path id="glyph" d="M0 0L1 1"/><marker id="arrow"/><linearGradient id="paint"><stop offset="0" stop-color="#123456"/></linearGradient></defs><use href="#glyph"/><use href="//example.com/g.svg#glyph"/><path fill="url(#paint)" marker-end="url(#arrow)"/>`,
    )
    expect(result.svg).toContain('href="#glyph"')
    expect(result.svg).toContain('marker-end="url(#arrow)"')
    expect(result.svg).toContain('fill="url(#paint)"')
    expect(result.svg).not.toContain("example.com")
  })
  it("resolves inherited currentColor and removes unknown namespaces", () => {
    const result = clean(
      `<g color="#abcdef"><path stroke="currentColor"/></g><evil:path xmlns:evil="https://example.com/"/>`,
    )
    expect(result.svg).toContain('stroke="#abcdef"')
    expect(result.svg).not.toContain("evil")
  })
  it("rejects declarations, malformed SVG, non-SVG, output and tree limits", () => {
    expect(() =>
      sanitizeSvg('<!DOCTYPE svg [<!ENTITY x "secret">]><svg/>', { width: 1, height: 1 }),
    ).toThrow(/declarations/)
    expect(() => clean("<path>")).toThrow(/Invalid SVG/)
    expect(() => sanitizeSvg("<html/>", { width: 1, height: 1 })).toThrow(/SVG/)
    expect(() => clean("x".repeat(MAX_SVG_BYTES))).toThrow(/limit/)
    expect(() => clean("<g>".repeat(101) + "</g>".repeat(101))).toThrow(/complexity/)
    expect(() =>
      sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"/>', { width: Infinity, height: 1 }),
    ).toThrow(/dimensions/)
    expect(() =>
      sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"/>', { width: 5000, height: 5000 }),
    ).toThrow(/dimensions/)
  })
})

describe("bounded work and disposal", () => {
  it("terminates a genuinely stalled worker and permits a fresh one", async () => {
    let stalled
    const worker = new WorkerRenderer({
      timeoutMs: 60,
      createWorker: () => {
        stalled = new Worker("while (true) {}", { eval: true })
        return stalled
      },
    })
    try {
      await expect(worker.render("math", "x", options)).rejects.toThrow(/timeout/)
      await worker.stopping
      expect(stalled.threadId).toBe(-1)
      worker.timeoutMs = 8000
      worker.createWorker = () =>
        new Worker(new URL("../reader/renderers/worker.js", import.meta.url))
      checkSvg(await worker.render("math", "x", options))
    } finally {
      await worker.close()
    }
  })
  it("terminates active worker work when closed", async () => {
    let child
    const worker = new WorkerRenderer({
      createWorker: () => {
        child = new Worker("while (true) {}", { eval: true })
        return child
      },
    })
    const work = worker.render("math", "x", options)
    const rejected = expect(work).rejects.toThrow(/closed/)
    await new Promise((resolve) => setImmediate(resolve))
    expect(worker.active).not.toBeNull()
    await worker.close()
    await rejected
    expect(child.threadId).toBe(-1)
  })
  it("rejects active and queued work on close; close is idempotent", async () => {
    const instance = new Renderers()
    const first = instance.render("math", "x")
    const second = instance.render("math", "y")
    const results = Promise.allSettled([first, second])
    await Promise.resolve()
    await instance.close()
    await instance.close()
    expect((await results).every((result) => result.status === "rejected")).toBe(true)
    await expect(instance.render("math", "z")).rejects.toThrow(/closed/)
  })
  it("closes on AbortSignal and starts nothing for unused batches", async () => {
    const controller = new AbortController()
    const instance = new Renderers({ signal: controller.signal })
    expect(instance.worker.worker).toBeNull()
    expect(instance.mermaid.browser).toBeNull()
    controller.abort()
    await expect(instance.render("math", "x")).rejects.toThrow(/closed/)
    await instance.close()
  })
  it("bounds sources and validates options before any renderer starts", async () => {
    expect(() => new Renderers({ foreground: "red;url(x)" })).toThrow()
    expect(() => new Renderers({ width: 1e9 })).toThrow()
    expect(() => new Renderers({ fontFamily: "x; color:red" })).toThrow()
    await expect(renderers.render("unknown", "x")).rejects.toThrow(/Unsupported/)
    await expect(renderers.render("math", "x".repeat(MAX_SOURCE_BYTES + 1))).rejects.toThrow(
      /limit/,
    )
    await expect(renderers.render("math", " ")).rejects.toThrow(/Empty/)
  })
})

describe("browser lifecycle test seams (no browser)", () => {
  function fakeBrowser() {
    const calls = []
    const page = new EventEmitter()
    for (const name of [
      "setRequestInterception",
      "setBypassServiceWorker",
      "setCacheEnabled",
      "setViewport",
      "setContent",
      "addScriptTag",
      "evaluate",
      "close",
    ]) {
      page[name] = vi.fn(async () => {
        calls.push(name)
      })
    }
    page.isClosed = () => false
    page.$eval = vi.fn(async () => ({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>中文</text></svg>',
      width: 20,
      height: 10,
    }))
    const browser = { newPage: vi.fn(async () => page), close: vi.fn(async () => {}) }
    return { browser, page, calls }
  }
  it("installs deny-all interception before authored render and reuses the owned browser", async () => {
    const { browser, page, calls } = fakeBrowser()
    const launch = vi.fn(async () => browser)
    const adapter = new MermaidRenderer({ launch })
    try {
      checkSvg(await adapter.render("flowchart TD\nA-->B", options))
      const request = { abort: vi.fn(async () => {}) }
      page.emit("request", request)
      expect(request.abort).toHaveBeenCalledWith("blockedbyclient")
      expect(calls.indexOf("setRequestInterception")).toBeLessThan(calls.indexOf("addScriptTag"))
      expect(calls.indexOf("setRequestInterception")).toBeLessThan(calls.indexOf("evaluate"))
      await adapter.render("flowchart TD\nB-->C", options)
      expect(launch).toHaveBeenCalledTimes(1)
      expect(launch.mock.calls[0][0].args.join(" ")).not.toMatch(
        /no-sandbox|disable-setuid-sandbox/,
      )
    } finally {
      await adapter.close()
    }
    expect(browser.close).toHaveBeenCalledTimes(1)
  })
  it("waits for the owned process exit event after browser.close resolves", async () => {
    const { browser } = fakeBrowser()
    const child = new EventEmitter()
    child.exitCode = null
    child.signalCode = null
    browser.process = () => child
    browser.close = vi.fn(async () => {
      setTimeout(() => {
        child.exitCode = 0
        child.emit("exit", 0)
      }, 20)
    })
    const adapter = new MermaidRenderer({ launch: async () => browser })
    await adapter.getBrowser()
    await adapter.close()
    expect(child.exitCode).toBe(0)
    expect(child.listenerCount("exit")).toBe(0)
  })

  it("kills a stuck owned browser after timeout, without hanging close", async () => {
    const { browser, page } = fakeBrowser()
    page.evaluate = () => new Promise(() => {})
    browser.close = () => new Promise(() => {})
    const kill = vi.fn()
    const adapter = new MermaidRenderer({
      launch: async () => browser,
      timeoutMs: 30,
      closeTimeoutMs: 10,
      kill,
    })
    await expect(adapter.render("flowchart TD\nA-->B", options)).rejects.toThrow(/timeout/)
    await adapter.close()
    await adapter.close()
    expect(kill).toHaveBeenCalledExactlyOnceWith(browser)
  })
  it("disposes a browser whose launch completes after cancellation", async () => {
    const { browser } = fakeBrowser()
    let launched
    let signal
    const adapter = new MermaidRenderer({
      launch: (options) => {
        signal = options.signal
        return new Promise((resolve) => {
          launched = resolve
        })
      },
    })
    const result = adapter.render("flowchart TD\nA-->B", options)
    const rejected = expect(result).rejects.toThrow(/closed/)
    await adapter.close()
    expect(signal.aborted).toBe(true)
    launched(browser)
    await rejected
    await Promise.resolve()
    expect(browser.close).toHaveBeenCalledTimes(1)
    expect(browser.newPage).not.toHaveBeenCalled()
  })
  it("rejects host-setting overrides and excessive edges before browser startup", () => {
    expect(() =>
      validateMermaid('%%{init: {"securityLevel":"loose"}}%%\nflowchart TD\nA-->B'),
    ).toThrow(/directives/)
    expect(() => validateMermaid("---\nconfig:\n  theme: dark\n---\nflowchart TD\nA-->B")).toThrow(
      /frontmatter/,
    )
    expect(() => validateMermaid(`flowchart TD\n${"A-->B\n".repeat(257)}`)).toThrow(/edge limit/)
  })
})
