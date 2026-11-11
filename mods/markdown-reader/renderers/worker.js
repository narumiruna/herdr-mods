import { parentPort } from "node:worker_threads"
import { checkSource, sanitizeSvg } from "./svg.js"
import { renderVega } from "./vega.js"

let mathModules

async function math(source, options, display) {
  if (Buffer.byteLength(source) > 16384) throw new Error("Math source limit exceeded")
  if (/\\(?:require|autoload|href|url|html\w*|style|class|cssId|includegraphics)\b/i.test(source)) {
    throw new Error("Unsafe TeX command")
  }
  mathModules ||= Promise.all([
    import("mathjax-full/js/mathjax.js"),
    import("mathjax-full/js/input/tex.js"),
    import("mathjax-full/js/output/svg.js"),
    import("mathjax-full/js/adaptors/liteAdaptor.js"),
    import("mathjax-full/js/handlers/html.js"),
    import("mathjax-full/js/input/tex/ams/AmsConfiguration.js"),
    import("mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js"),
  ])
  const [{ mathjax }, { TeX }, { SVG }, { liteAdaptor }, { RegisterHTMLHandler }] =
    await mathModules
  const adaptor = liteAdaptor()
  const handler = RegisterHTMLHandler(adaptor)
  try {
    const input = new TeX({
      packages: ["base", "ams", "newcommand"],
      maxBuffer: 16384,
      maxMacros: 1000,
      formatError: (_jax, error) => {
        throw new Error(`Invalid TeX: ${error.message}`)
      },
    })
    const document = mathjax.document("", {
      InputJax: input,
      OutputJax: new SVG({ fontCache: "none" }),
    })
    const node = document.convert(source, { display, em: 16, ex: 8, containerWidth: options.width })
    const svg = adaptor.firstChild(node)
    const pixels = (value) => {
      const match = /^([\d.]+)(ex|em|px)?$/.exec(value || "")
      if (!match) throw new Error("Invalid MathJax dimensions")
      return Number(match[1]) * (match[2] === "ex" ? 8 : match[2] === "em" ? 16 : 1)
    }
    return sanitizeSvg(adaptor.outerHTML(svg), {
      ...options,
      width: pixels(adaptor.getAttribute(svg, "width")),
      height: pixels(adaptor.getAttribute(svg, "height")),
    })
  } finally {
    mathjax.handlers.unregister(handler)
  }
}

parentPort.on("message", async ({ kind, source, options, display }) => {
  try {
    checkSource(source)
    const result =
      kind === "math" ? await math(source, options, display) : await renderVega(source, options)
    parentPort.postMessage({ result })
  } catch (error) {
    parentPort.postMessage({ error: String(error.message).slice(0, 1000) })
  }
})
