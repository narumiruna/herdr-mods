import { DOMParser, XMLSerializer } from "@xmldom/xmldom"

export const MAX_SVG_BYTES = 2 * 1024 * 1024
export const MAX_SOURCE_BYTES = 128 * 1024
export const MAX_DIMENSION = 16384

const elements = new Set([
  "svg",
  "g",
  "defs",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "textPath",
  "use",
  "clipPath",
  "mask",
  "marker",
  "linearGradient",
  "radialGradient",
  "stop",
  "title",
  "desc",
])
const attributes = new Set([
  "id",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "dx",
  "dy",
  "width",
  "height",
  "viewBox",
  "preserveAspectRatio",
  "d",
  "points",
  "transform",
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
  "clip-path",
  "clip-rule",
  "mask",
  "marker-start",
  "marker-mid",
  "marker-end",
  "markerWidth",
  "markerHeight",
  "markerUnits",
  "orient",
  "refX",
  "refY",
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
  "textLength",
  "lengthAdjust",
  "startOffset",
  "gradientUnits",
  "gradientTransform",
  "offset",
  "stop-color",
  "stop-opacity",
  "spreadMethod",
  "clipPathUnits",
  "maskUnits",
  "maskContentUnits",
  "vector-effect",
  "display",
  "visibility",
])
const styleProperties = new Set([
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
  "clip-path",
  "clip-rule",
  "mask",
  "marker-start",
  "marker-mid",
  "marker-end",
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
])

export function checkSource(source) {
  if (typeof source !== "string" || !source.trim()) throw new Error("Empty renderer source")
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES)
    throw new Error("Renderer source limit exceeded")
}

export function dimensions(width, height) {
  if (![width, height].every((n) => Number.isFinite(n) && n > 0 && n <= MAX_DIMENSION)) {
    throw new Error("Invalid or excessive SVG dimensions")
  }
  return { width, height }
}

// SVG is a data format here, not a document. Unknown elements and attributes are removed.
// Only same-SVG fragment references survive. No entity declarations or authored CSS survive.
export function sanitizeSvg(
  source,
  { width, height, foreground = "#222222", fontFamily = "sans-serif" },
) {
  dimensions(width, height)
  if (typeof source !== "string" || Buffer.byteLength(source) > MAX_SVG_BYTES) {
    throw new Error("SVG output limit exceeded")
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error("SVG declarations are not allowed")
  const document = new DOMParser({
    onError: (_level, message) => {
      throw new Error(`Invalid SVG: ${message}`)
    },
  }).parseFromString(source, "image/svg+xml")
  const root = document.documentElement
  if (root?.localName !== "svg" || root.namespaceURI !== "http://www.w3.org/2000/svg") {
    throw new Error("Expected an SVG root")
  }
  let count = 0
  const visit = (element, color, depth) => {
    if (++count > 30000 || depth > 100) throw new Error("SVG complexity limit exceeded")
    if (element.hasAttribute("color")) color = element.getAttribute("color")
    const style = element.getAttribute("style") || ""
    for (const declaration of style.split(";")) {
      const colon = declaration.indexOf(":")
      const name = declaration.slice(0, colon).trim().toLowerCase()
      const value = declaration.slice(colon + 1).trim()
      if (name === "color") color = value
      if (styleProperties.has(name)) element.setAttribute(name, value)
    }
    if (
      !/^(?:#[\da-f]{3,8}|rgba?\([\d.,%\s]+\)|[a-z]+)$/i.test(color) ||
      /^(?:currentColor|inherit|initial|unset)$/i.test(color)
    )
      color = foreground
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name
      let value = attribute.value.trim()
      if (name === "href" || name === "xlink:href") {
        if (/^#[\w.-]+$/.test(value) && ["use", "textPath"].includes(element.localName)) {
          element.removeAttribute(name)
          element.setAttribute("href", value)
          element.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", value)
        } else element.removeAttribute(name)
        continue
      }
      if (
        !attributes.has(name) ||
        attribute.namespaceURI ||
        /[<>\\]|(?:javascript|data|file|https?):|expression\s*\(|var\s*\(|@/i.test(value)
      ) {
        element.removeAttributeNode(attribute)
        continue
      }
      if (/url\s*\(/i.test(value) && !/^url\(\s*["']?#[\w.-]+["']?\s*\)$/i.test(value)) {
        element.removeAttributeNode(attribute)
        continue
      }
      value = value.replace(/currentColor/gi, color)
      if (value === "inherit") element.removeAttribute(name)
      else element.setAttribute(name, value)
    }
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === 1) {
        if (child.namespaceURI !== root.namespaceURI || !elements.has(child.localName)) {
          if (child.localName === "a" && child.namespaceURI === root.namespaceURI) {
            // Keep link labels, but never the link itself or any of its attributes.
            const group = document.createElementNS(root.namespaceURI, "g")
            while (child.firstChild) group.appendChild(child.firstChild)
            element.replaceChild(group, child)
            visit(group, color, depth + 1)
          } else element.removeChild(child)
        } else visit(child, color, depth + 1)
      } else if (child.nodeType !== 3) element.removeChild(child)
    }
  }
  visit(root, foreground, 0)
  // Keep exactly one root; XML processing instructions have no place in the asset.
  for (const child of Array.from(document.childNodes))
    if (child !== root) document.removeChild(child)
  root.setAttribute("xmlns", "http://www.w3.org/2000/svg")
  root.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink")
  root.setAttribute("width", String(width))
  root.setAttribute("height", String(height))
  if (!root.hasAttribute("viewBox")) root.setAttribute("viewBox", `0 0 ${width} ${height}`)
  if (!root.hasAttribute("fill")) root.setAttribute("fill", foreground)
  root.setAttribute("font-family", fontFamily)
  const svg = new XMLSerializer().serializeToString(document)
  if (Buffer.byteLength(svg) > MAX_SVG_BYTES) throw new Error("SVG output limit exceeded")
  return { svg, width, height }
}
