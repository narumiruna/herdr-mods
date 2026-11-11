import { defaultSchema, sanitize } from "hast-util-sanitize"
import { toHtml } from "hast-util-to-html"
import { imageSize } from "image-size"
import { toHast } from "mdast-util-to-hast"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import remarkParse from "remark-parse"
import { unified } from "unified"
import { classifyURL, MAX_IMAGE_BYTES, workspaceFile, workspaceRead } from "./files.js"

const MAX_NODES = 12000
const MAX_DEPTH = 40
const MAX_BLOCKS = 600
const MAX_GRAPHICS = 40
const MAX_HTML = 4 * 1024 * 1024
const IMAGE_TYPES = new Set(["png", "jpg", "gif", "webp"])
const INLINE_MATH_WARNING =
  "Inline math is shown as TeX source. Herdr 0.1.15 does not provide verified inline formula layout."
const schema = {
  ...defaultSchema,
  clobber: [],
  tagNames: defaultSchema.tagNames.filter((tag) => tag !== "img"),
}

function walk(node, visit, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error("Markdown nesting exceeds 40 levels")
  visit(node)
  for (const child of node.children || []) walk(child, visit, depth + 1)
}

function textContent(node) {
  if (node.type === "text" || node.type === "inlineMath" || node.type === "inlineCode")
    return node.value || ""
  return (node.children || []).map(textContent).join("")
}

function rasterType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png"
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpg"
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString("ascii"))) return "gif"
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "webp"
  return null
}

export async function buildDocument({
  source,
  file,
  root,
  cache,
  renderers,
  options = {},
  signal,
  job,
}) {
  const warnings = new Set()
  const assets = new Set()
  const dependencies = new Set([file])
  const links = {}
  const tasks = new Map()
  let taskId = 0
  let graphics = 0
  let blocks = 0
  let htmlBytes = 0
  let nodes = 0
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
  const tree = processor.parse(source)
  walk(tree, () => {
    if (++nodes > MAX_NODES) throw new Error("Markdown exceeds the 12,000-node limit")
  })
  const slugs = new Map()
  walk(tree, (node) => {
    if (node.type !== "heading") return
    const base =
      textContent(node)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_\s-]/gu, "")
        .trim()
        .replace(/\s+/g, "-") || "section"
    const count = slugs.get(base) || 0
    slugs.set(base, count + 1)
    node.data = { hProperties: { id: count ? `${base}-${count}` : base } }
  })

  const marker = (kind, value, extra = {}) => {
    const id = `task-${++taskId}`
    tasks.set(id, { kind, source: value, ...extra })
    return { type: "element", tagName: "reader-block", properties: { task: id }, children: [] }
  }
  const hast = toHast(tree, {
    allowDangerousHtml: false,
    clobberPrefix: "reader-",
    handlers: {
      code: (_state, node) => {
        const language = String(node.lang || "text").toLowerCase()
        return marker(["mermaid", "vega-lite"].includes(language) ? language : "code", node.value, {
          language,
        })
      },
      math: (_state, node) => marker("math", node.value),
      inlineMath: (_state, node) => {
        warnings.add(INLINE_MATH_WARNING)
        return {
          type: "element",
          tagName: "code",
          properties: {},
          children: [{ type: "text", value: `$${node.value}$` }],
        }
      },
    },
  })

  async function saveAsset(value, extension) {
    const asset = await cache.put(value, extension, job)
    assets.add(asset)
    if (job) await cache.lease(job, [...assets])
    return asset
  }

  async function render(task) {
    if (signal?.aborted) throw new Error("Reading cancelled")
    if (++graphics > MAX_GRAPHICS) throw new Error("Document exceeds the 40 graphic block limit")
    const key = cache.key(task.kind, task.source, options)
    let result = await cache.rendered(key, job)
    if (!result) {
      result = await renderers.render(task.kind, task.source, { display: true })
      const asset = await saveAsset(result.svg, "svg")
      result = { asset, width: result.width, height: result.height }
      await cache.remember(key, result)
    } else {
      assets.add(result.asset)
      if (job) await cache.lease(job, [...assets])
    }
    return {
      type: "graphic",
      kind: task.kind,
      source: task.source,
      asset: result.asset,
      width: result.width,
      height: result.height,
    }
  }

  async function image(node) {
    const href = String(node.properties.src || "")
    const target = classifyURL(href, file)
    if (target.kind !== "local")
      throw new Error("Only local PNG, JPEG, GIF, and WebP images are loaded")
    const location = await workspaceFile(root, target.file)
    dependencies.add(location.file)
    const bytes = await workspaceRead(location, MAX_IMAGE_BYTES)
    const extension = rasterType(bytes)
    if (!IMAGE_TYPES.has(extension))
      throw new Error("Image format is not supported; authored SVG and remote images are disabled")
    const size = imageSize(bytes)
    if (
      !size.width ||
      !size.height ||
      size.width > 8192 ||
      size.height > 8192 ||
      size.width * size.height > 16000000
    )
      throw new Error("Image dimensions exceed the supported limit")
    if (++graphics > MAX_GRAPHICS) throw new Error("Document exceeds the 40 graphic block limit")
    return {
      type: "graphic",
      kind: "image",
      source: href,
      alt: String(node.properties.alt || ""),
      asset: await saveAsset(bytes, extension),
      width: size.width,
      height: size.height,
    }
  }

  async function rewrite(node) {
    if (signal?.aborted) throw new Error("Reading cancelled")
    if (node.type === "element" && node.tagName === "a") {
      const target = classifyURL(String(node.properties.href || ""), file)
      if (target.kind === "local") {
        try {
          const location = await workspaceFile(root, target.file)
          if (!/\.(?:md|markdown)$/i.test(location.file))
            throw new Error("Only Markdown file links can be opened")
          Object.assign(target, location)
        } catch (error) {
          warnings.add(`Link unavailable: ${error.message}`)
          delete node.properties.href
          return
        }
      }
      if (target.kind === "blocked") delete node.properties.href
      else {
        const href = `https://herdr-markdown.invalid/link/${Object.keys(links).length}`
        links[href] = target
        node.properties.href = href
      }
    }
    if (node.type === "element" && node.tagName === "input") {
      node.type = "text"
      node.value = node.properties.checked ? "☑ " : "☐ "
      delete node.children
      delete node.properties
      delete node.tagName
    }
    for (const child of node.children || []) await rewrite(child)
  }
  await rewrite(hast)

  function html(content) {
    const safe = sanitize({ type: "root", children: content }, schema)
    const value = toHtml(safe)
    htmlBytes += Buffer.byteLength(value)
    if (htmlBytes > MAX_HTML) throw new Error("Rendered document exceeds the HTML size limit")
    const anchors = []
    walk(safe, (node) => {
      if (node.properties?.id) anchors.push(String(node.properties.id))
    })
    return { type: "html", html: value, anchors }
  }

  function hasSpecial(node) {
    return (
      node.tagName === "reader-block" ||
      node.tagName === "img" ||
      (node.children || []).some(hasSpecial)
    )
  }

  async function convert(node) {
    if (++blocks > MAX_BLOCKS) throw new Error("Document exceeds the 600 native block limit")
    const id = `block-${blocks}`
    if (node.tagName === "reader-block") {
      const task = tasks.get(node.properties.task)
      if (task.kind === "code")
        return { id, type: "code", language: task.language, source: task.source }
      try {
        return { id, ...(await render(task)) }
      } catch (error) {
        if (signal?.aborted) throw error
        return {
          id,
          type: "error",
          kind: task.kind,
          source: task.source,
          error: String(error.message).slice(0, 1000),
        }
      }
    }
    if (node.tagName === "img") {
      try {
        return { id, ...(await image(node)) }
      } catch (error) {
        return {
          id,
          type: "error",
          kind: "image",
          source: String(node.properties.src || ""),
          error: String(error.message).slice(0, 1000),
        }
      }
    }
    if (!hasSpecial(node) && !["ul", "ol", "li", "blockquote"].includes(node.tagName))
      return { id, ...html([node]) }
    const children = []
    let pending = []
    const flush = () => {
      if (pending.length && !pending.every((node) => node.type === "text" && !node.value.trim())) {
        if (++blocks > MAX_BLOCKS) throw new Error("Document exceeds the 600 native block limit")
        children.push({ id: `block-${blocks}`, ...html(pending) })
      }
      pending = []
    }
    for (const child of node.children || []) {
      if (!hasSpecial(child) && !["li", "ol", "ul", "blockquote"].includes(child.tagName))
        pending.push(child)
      else {
        flush()
        children.push(await convert(child))
      }
    }
    flush()
    const kind = node.tagName || "group"
    if (kind === "ol" || kind === "ul") {
      let index = Number(node.properties?.start) || 1
      for (const child of children)
        if (child.kind === "li") child.prefix = kind === "ol" ? `${index++}.` : "•"
    }
    return {
      id,
      type: "container",
      kind,
      children,
      anchors: node.properties?.id ? [String(node.properties.id)] : [],
    }
  }

  const result = []
  for (const node of hast.children || []) {
    if (node.type === "text" && !node.value.trim()) continue
    result.push(await convert(node))
  }
  const anchors = {}
  function indexAnchors(block, index) {
    for (const anchor of block.anchors || []) anchors[anchor] = index
    for (const child of block.children || []) indexAnchors(child, index)
  }
  result.forEach(indexAnchors)
  return {
    version: 1,
    file,
    root,
    source,
    blocks: result,
    links,
    anchors,
    warnings: [...warnings],
    assets: [...assets],
    dependencies: [...dependencies],
  }
}
