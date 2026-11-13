import { mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { digest } from "../reader/cache.js"
import { buildDocument } from "../reader/document.js"

vi.mock("node:fs/promises", async (original) => {
  const actual = await original()
  return { ...actual, open: vi.fn(actual.open) }
})

let base
let root
let file
let cache
let renderers
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"></svg>'
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
)
const job = "document-job-1234"
const flatten = (blocks) => blocks.flatMap((block) => [block, ...flatten(block.children || [])])
const htmlOf = (document) =>
  flatten(document.blocks)
    .filter((block) => block.type === "html")
    .map((block) => block.html)
    .join("\n")

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "markdown-document-")))
  root = join(base, "workspace")
  await mkdir(root)
  file = join(root, "notes.md")
  await writeFile(file, "fixture")
  const stored = new Map()
  cache = {
    put: vi.fn(
      async (value, extension) =>
        `data/better-files/assets/${digest(Buffer.from(value))}.${extension}`,
    ),
    key: vi.fn((kind, source, options) => digest(JSON.stringify([kind, source, options]))),
    rendered: vi.fn(async (key) => stored.get(key) || null),
    remember: vi.fn(async (key, result) => {
      stored.set(key, result)
    }),
    lease: vi.fn(async () => {}),
  }
  renderers = { render: vi.fn(async () => ({ svg, width: 20, height: 10 })) }
  vi.mocked(open).mockClear()
})
afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})
const build = (source, extra = {}) =>
  buildDocument({ source, root, file, cache, renderers, job, ...extra })

it("limits native pixel area for each graphic and the whole document", async () => {
  renderers.render.mockResolvedValueOnce({ svg, width: 5000, height: 5000 })
  const oversized = await build("```mermaid\nflowchart TD; A-->B\n```")
  expect(oversized.blocks[0]).toMatchObject({
    type: "error",
    error: "Native graphic pixel budget exceeded",
  })
  renderers.render.mockResolvedValue({ svg, width: 4000, height: 4000 })
  const source = Array.from({ length: 5 }, (_, i) =>
    ["```mermaid", `flowchart TD; A-->B${i}`, "```"].join("\n"),
  ).join("\n\n")
  const document = await build(source)
  expect(document.blocks.filter((block) => block.type === "graphic")).toHaveLength(4)
  expect(document.blocks.at(-1)).toMatchObject({
    type: "error",
    error: "Native graphic pixel budget exceeded",
  })
})

it("returns source and canonical dependency inputs without losing ordinary Markdown structure", async () => {
  const source = `# Heading\n\n> Quote\n>\n> - parent\n>   - child **strong**\n\n3. three\n4. four\n\n- [x] done\n- [ ] todo\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n~~deleted~~ and [reference][guide].\n\n[guide]: https://example.test/guide\n\nNote[^n].\n\n[^n]: Footnote *body*.\n`
  const result = await build(source)
  const html = htmlOf(result)
  expect(result).toMatchObject({ version: 1, file, root, source, dependencies: [file], assets: [] })
  const blocks = flatten(result.blocks)
  expect(blocks.filter((block) => block.type === "container").map((block) => block.kind)).toEqual(
    expect.arrayContaining(["blockquote", "ul", "ol", "li"]),
  )
  expect(blocks.filter((block) => block.kind === "li").map((block) => block.prefix)).toEqual(
    expect.arrayContaining(["3.", "4.", "•"]),
  )
  for (const tag of [
    "<strong>strong</strong>",
    "<table>",
    "<del>deleted</del>",
    "Footnote <em>body</em>",
  ]) {
    expect(html).toContain(tag)
  }
  expect(html).toContain("☑ ")
  expect(html).toContain("☐ ")
  expect(html).not.toContain("<input")
  expect(Object.values(result.links)).toContainEqual({
    kind: "external",
    url: "https://example.test/guide",
  })
  expect(Object.values(result.links).some((target) => target.kind === "fragment")).toBe(true)
  expect(renderers.render).not.toHaveBeenCalled()
  expect(cache.key).not.toHaveBeenCalled()
  expect(cache.put).not.toHaveBeenCalled()
})

it("preserves nested lists and blockquotes when a special fence occurs inside a list item", async () => {
  const result = await build(
    "> 3. before\n>\n>    ```mermaid\n>    graph TD; A-->B\n>    ```\n>\n>    - nested child\n>\n> 4. after\n",
  )
  const blocks = flatten(result.blocks)
  expect(blocks.find((block) => block.kind === "blockquote")).toMatchObject({ type: "container" })
  expect(blocks.find((block) => block.kind === "ol")).toMatchObject({ type: "container" })
  expect(blocks.filter((block) => block.kind === "li").map((block) => block.prefix)).toContain("3.")
  expect(blocks.find((block) => block.type === "graphic")).toMatchObject({
    kind: "mermaid",
    source: "graph TD; A-->B",
  })
  expect(htmlOf(result)).toContain("nested child")
  expect(htmlOf(result)).toContain("after")
  expect(renderers.render).toHaveBeenCalledExactlyOnceWith("mermaid", "graph TD; A-->B", {
    display: true,
  })
})

it("indexes duplicate and Unicode heading anchors without removing reference definitions", async () => {
  const result = await build("# Hello\n\n# Hello\n\n# 中文\n\n[ref][id]\n\n[id]: #hello-1\n")
  expect(result.anchors).toMatchObject({ hello: 0, "hello-1": 1, 中文: 2 })
  expect(Object.values(result.links)).toContainEqual({ kind: "fragment", fragment: "hello-1" })
})

it.each([
  {
    name: "generated suffixes",
    headings: ["Hello", "Hello", "Hello-1"],
    ids: ["hello", "hello-1", "hello-1-1"],
  },
  {
    name: "mixed explicit suffixes and case",
    headings: ["Hello-1", "Hello", "HELLO", "hello-2", "Hello", "Hello-1"],
    ids: ["hello-1", "hello", "hello-2", "hello-2-1", "hello-3", "hello-1-1"],
  },
  {
    name: "repeated headings",
    headings: ["Hello", "Hello", "Hello", "Hello"],
    ids: ["hello", "hello-1", "hello-2", "hello-3"],
  },
  {
    name: "CJK headings and suffixes",
    headings: ["中文", "中文", "中文-1", "中文", "中文-1"],
    ids: ["中文", "中文-1", "中文-1-1", "中文-2", "中文-1-2"],
  },
  {
    name: "empty heading slugs",
    headings: ["!!!", "???", "section-1", "!!!"],
    ids: ["section", "section-1", "section-1-1", "section-2"],
  },
])("reserves every generated heading ID for $name", async ({ headings, ids }) => {
  const result = await build(headings.map((heading) => `# ${heading}`).join("\n\n"))
  expect(flatten(result.blocks).flatMap((block) => block.anchors || [])).toEqual(ids)
  expect(result.anchors).toEqual(Object.fromEntries(ids.map((id, index) => [id, index])))
})

it("shows inline math as literal TeX with an explicit limitation warning, not a typeset graphic", async () => {
  const result = await build("Before $x^2 + y$ after and $z$.\n")
  expect(htmlOf(result)).toContain("<code>$x^2 + y$</code>")
  expect(result.warnings).toHaveLength(1)
  expect(result.warnings[0]).toMatch(/Inline math is shown as TeX source.*not.*verified/i)
  expect(flatten(result.blocks).some((block) => block.type === "graphic")).toBe(false)
  expect(renderers.render).not.toHaveBeenCalled()
  expect(cache.key).not.toHaveBeenCalled()
})

it("never calls a renderer or the render cache for ordinary code, including unknown languages", async () => {
  const result = await build(
    "```javascript\nconst x = '<script>';\n```\n\n```bash\n$(touch /tmp/never)\n```\n\n```unknown-language\ntext\n```\n\n    indented code\n",
  )
  const code = flatten(result.blocks).filter((block) => block.type === "code")
  expect(code.map((block) => block.language)).toEqual([
    "javascript",
    "bash",
    "unknown-language",
    "text",
  ])
  expect(code[0].source).toBe("const x = '<script>';")
  expect(renderers.render).not.toHaveBeenCalled()
  for (const method of ["key", "rendered", "remember", "put", "lease"])
    expect(cache[method]).not.toHaveBeenCalled()
})

it("renders display math and static chart blocks, deduplicates assets, and leases them", async () => {
  const result = await build('$$\nx^2\n$$\n\n```vega-lite\n{"mark":"bar"}\n```\n')
  expect(
    flatten(result.blocks)
      .filter((block) => block.type === "graphic")
      .map((block) => block.kind),
  ).toEqual(["math", "vega-lite"])
  expect(result.assets).toHaveLength(1)
  expect(cache.lease).toHaveBeenLastCalledWith(job, result.assets)
  expect(cache.remember).toHaveBeenCalledTimes(2)
})

it("uses cached render assets and establishes a new current job lease", async () => {
  const source = "```mermaid\ngraph TD; A-->B\n```"
  const first = await build(source)
  renderers.render.mockClear()
  cache.put.mockClear()
  cache.lease.mockClear()
  const next = await build(source, { job: "another-job-1234" })
  expect(next.assets).toEqual(first.assets)
  expect(renderers.render).not.toHaveBeenCalled()
  expect(cache.put).not.toHaveBeenCalled()
  expect(cache.lease).toHaveBeenCalledExactlyOnceWith("another-job-1234", first.assets)
})

it("retains source and surrounding prose when an individual render block fails", async () => {
  renderers.render.mockRejectedValueOnce(new Error("Invalid diagram"))
  const result = await build(
    "Before\n\n```mermaid\nbroken diagram\n```\n\nAfter\n\n```js\nconst ok = true\n```\n",
  )
  expect(flatten(result.blocks).find((block) => block.type === "error")).toMatchObject({
    kind: "mermaid",
    source: "broken diagram",
    error: "Invalid diagram",
  })
  expect(htmlOf(result)).toContain("Before")
  expect(htmlOf(result)).toContain("After")
  expect(flatten(result.blocks).find((block) => block.type === "code")).toMatchObject({
    source: "const ok = true",
  })
  expect(result.assets).toEqual([])
})

it("falls back to source when a renderer returns a malformed result", async () => {
  renderers.render.mockResolvedValueOnce({})
  const result = await build("```vega-lite\nnot json\n```")
  expect(result.blocks[0]).toMatchObject({ type: "error", kind: "vega-lite", source: "not json" })
  expect(cache.remember).not.toHaveBeenCalled()
})

it("sanitizes authored HTML and does not preserve executable link URLs", async () => {
  const result = await build(
    '<script>alert(1)</script>\n\n<img src="https://host/track" onerror="bad()">\n\n[bad](javascript:alert%281%29) and [data](data:text/html,test)\n',
  )
  expect(htmlOf(result)).not.toMatch(/<script|<img|onerror|javascript:|data:text/)
  expect(result.links).toEqual({})
  expect(cache.put).not.toHaveBeenCalled()
})

it("validates local links canonically and exposes external URLs only through explicit navigation tokens", async () => {
  await writeFile(join(root, "other.md"), "other")
  await writeFile(join(base, "outside.md"), "outside")
  await symlink(join(base, "outside.md"), join(root, "escape.md"))
  const result = await build(
    "[local](other.md#section) [outside](../outside.md) [symlink](escape.md) [web](https://example.test) [mail](mailto:a@example.test) [file](file:///etc/passwd)",
  )
  expect(Object.values(result.links)).toEqual([
    { kind: "local", file: join(root, "other.md"), root, fragment: "section" },
    { kind: "external", url: "https://example.test/" },
    { kind: "external", url: "mailto:a@example.test" },
  ])
  expect(result.warnings).toHaveLength(1)
  expect(htmlOf(result)).not.toContain('href="https://example.test')
})

describe("local link recovery", () => {
  it("tracks a missing target before creation and enables the link after creation", async () => {
    const target = join(root, "later/guide.md")
    const missing = await build("[Guide](later/guide.md#topic)")
    expect(missing.links).toEqual({})
    expect(missing.dependencies).toEqual([file, target])
    expect(missing.unresolvedLinks).toBe(true)
    expect(open).not.toHaveBeenCalled()
    await mkdir(dirname(target))
    await writeFile(target, "# Topic")
    const created = await build("[Guide](later/guide.md#topic)")
    expect(Object.values(created.links)).toEqual([
      { kind: "local", root, file: target, fragment: "topic" },
    ])
    expect(created.unresolvedLinks).toBe(false)
    // Link validation checks paths, not the linked document's contents.
    expect(open).not.toHaveBeenCalled()
  })
  it("tracks lexical and canonical link paths without permitting a root escape", async () => {
    const target = join(root, "guide.md")
    await symlink(target, join(root, "alias.md"))
    const missing = await build("[Guide](alias.md)")
    expect(missing.unresolvedLinks).toBe(true)
    expect(missing.dependencies).toEqual([file, join(root, "alias.md")])
    await writeFile(target, "# Guide")
    const ready = await build("[Guide](alias.md)")
    expect(ready.dependencies).toEqual([file, join(root, "alias.md"), target])
    expect(ready.unresolvedLinks).toBe(false)
    await writeFile(join(base, "outside.md"), "private")
    await rm(join(root, "alias.md"))
    await symlink(join(base, "outside.md"), join(root, "alias.md"))
    const escaped = await build("[Guide](alias.md) [Outside](../missing.md)")
    expect(escaped.links).toEqual({})
    expect(escaped.dependencies).toEqual([file, join(root, "alias.md")])
    expect(escaped.unresolvedLinks).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
  it("assigns sequential navigation tokens across many links", async () => {
    const result = await build(
      Array.from({ length: 1000 }, (_, i) => `[${i}](https://example.test/${i})`).join(" "),
    )
    expect(Object.keys(result.links)).toHaveLength(1000)
    expect(result.links["https://herdr-markdown.invalid/link/999"]).toEqual({
      kind: "external",
      url: "https://example.test/999",
    })
  })
})

describe("local raster images", () => {
  it("uses file signatures rather than extension and tracks image dependencies", async () => {
    const image = join(root, "picture.not-png")
    await writeFile(image, png)
    const result = await build("![description](picture.not-png)")
    expect(flatten(result.blocks).find((block) => block.kind === "image")).toMatchObject({
      type: "graphic",
      kind: "image",
      width: 1,
      height: 1,
      alt: "description",
      asset: `data/better-files/assets/${digest(png)}.png`,
    })
    expect(result.dependencies).toEqual([file, image])
    expect(renderers.render).not.toHaveBeenCalled()
  })

  it.each(["missing.png", "missing/parent/image.png"])(
    "tracks %s before creation and loads it after creation",
    async (href) => {
      const image = join(root, href)
      const source = `![later](${href})`
      const missing = await build(source)
      expect(flatten(missing.blocks).find((block) => block.kind === "image")).toMatchObject({
        type: "error",
      })
      expect(missing.dependencies).toEqual([file, image])
      expect(missing.unresolvedImages).toBe(true)
      expect(open).not.toHaveBeenCalled()
      expect(cache.put).not.toHaveBeenCalled()

      await mkdir(dirname(image), { recursive: true })
      await writeFile(image, png)
      const created = await build(source)
      expect(flatten(created.blocks).find((block) => block.kind === "image")).toMatchObject({
        type: "graphic",
      })
      expect(created.dependencies).toEqual([file, image])
      expect(created.unresolvedImages).toBe(false)
    },
  )

  it("marks missing images behind directory symlinks for periodic recovery", async () => {
    const images = join(root, "images")
    const alias = join(root, "alias")
    await mkdir(images)
    await symlink(images, alias)
    const source = "![later](alias/later.png)"
    const missing = await build(source)
    expect(missing.dependencies).toEqual([file, join(alias, "later.png")])
    expect(missing.unresolvedImages).toBe(true)
    expect(open).not.toHaveBeenCalled()
    await writeFile(join(images, "later.png"), png)
    const created = await build(source)
    expect(created.dependencies).toEqual([
      file,
      join(alias, "later.png"),
      join(images, "later.png"),
    ])
    expect(created.unresolvedImages).toBe(false)
    expect(flatten(created.blocks).find((block) => block.kind === "image").type).toBe("graphic")
  })

  it("tracks lexical and canonical paths for an internal image symlink and its replacement", async () => {
    const alias = join(root, "alias.png")
    const first = join(root, "first.png")
    const next = join(root, "next.png")
    await writeFile(first, png)
    await writeFile(next, png)
    await symlink(first, alias)
    const source = "![alias](alias.png)"
    const initial = await build(source)
    expect(flatten(initial.blocks).find((block) => block.kind === "image")).toMatchObject({
      type: "graphic",
    })
    expect(initial.dependencies).toEqual([file, alias, first])
    expect(open).toHaveBeenCalledWith(first, expect.any(Number))

    await rm(alias)
    await symlink(next, alias)
    const replaced = await build(source)
    expect(flatten(replaced.blocks).find((block) => block.kind === "image")).toMatchObject({
      type: "graphic",
    })
    expect(replaced.dependencies).toEqual([file, alias, next])
    expect(open).toHaveBeenLastCalledWith(next, expect.any(Number))
  })

  it("retains a dangling symlink dependency until its missing target parent is created", async () => {
    const alias = join(root, "alias.png")
    const image = join(root, "future/image.png")
    await symlink(image, alias)
    const source = "![alias](alias.png)"
    const missing = await build(source)
    expect(flatten(missing.blocks).find((block) => block.kind === "image")).toMatchObject({
      type: "error",
    })
    expect(missing.dependencies).toEqual([file, alias])
    expect(missing.unresolvedImages).toBe(true)
    expect(open).not.toHaveBeenCalled()

    await mkdir(dirname(image))
    await writeFile(image, png)
    const created = await build(source)
    expect(flatten(created.blocks).find((block) => block.kind === "image")).toMatchObject({
      type: "graphic",
    })
    expect(created.dependencies).toEqual([file, alias, image])
    expect(created.unresolvedImages).toBe(false)
  })

  it.each([
    ["SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ["spoofed extension", Buffer.from("not an image")],
    ["truncated signature", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
  ])("denies %s image bytes", async (_name, bytes) => {
    await writeFile(join(root, "bad.png"), bytes)
    const result = await build("![bad](bad.png)")
    expect(flatten(result.blocks).find((block) => block.kind === "image")).toMatchObject({
      type: "error",
    })
    expect(cache.put).not.toHaveBeenCalled()
  })

  it.each([
    [8193, 1],
    [1, 8193],
    [5000, 5000],
    [0, 1],
  ])("denies image dimensions %s × %s", async (width, height) => {
    const bytes = Buffer.from(png)
    bytes.writeUInt32BE(width, 16)
    bytes.writeUInt32BE(height, 20)
    await writeFile(join(root, "large.png"), bytes)
    const result = await build("![bad](large.png)")
    expect(flatten(result.blocks).find((block) => block.kind === "image")).toMatchObject({
      type: "error",
    })
    expect(cache.put).not.toHaveBeenCalled()
  })

  it("denies an image larger than the 4 MiB byte limit before saving it", async () => {
    await writeFile(join(root, "oversized.png"), Buffer.alloc(4 * 1024 * 1024 + 1))
    const result = await build("![large](oversized.png)")
    expect(flatten(result.blocks).find((block) => block.kind === "image")).toMatchObject({
      type: "error",
      error: expect.stringContaining("byte limit"),
    })
    expect(cache.put).not.toHaveBeenCalled()
  })

  it("denies unsafe image paths before reading and retains only safe lexical dependencies", async () => {
    const outside = join(base, "outside.png")
    const sibling = `${root}-other`
    await writeFile(outside, png)
    await mkdir(sibling)
    await writeFile(join(sibling, "outside.png"), png)
    await symlink(outside, join(root, "escape.png"))
    await symlink(base, join(root, "escape-dir"))
    for (const [href, dependency] of [
      ["https://host/tracking.png", null],
      ["//host/tracking.png", null],
      ["data:image/png;base64,AA", null],
      ["file:///etc/passwd", null],
      ["../outside.png", null],
      ["%2e%2e/outside.png", null],
      ["../workspace-other/outside.png", null],
      [outside, null],
      ["bad%zz.png", null],
      ["bad%00.png", null],
      ["bad%2f.png", null],
      ["picture.png?query=1", null],
      ["#bad%zz", null],
      ["escape.png", join(root, "escape.png")],
      ["escape-dir/outside.png", join(root, "escape-dir/outside.png")],
    ]) {
      const result = await build(`![bad](${href})`)
      expect(
        flatten(result.blocks).find((block) => block.kind === "image"),
        href,
      ).toMatchObject({ type: "error" })
      expect(result.dependencies, href).toEqual(dependency ? [file, dependency] : [file])
      expect(result.unresolvedImages, href).toBe(false)
    }
    expect(open).not.toHaveBeenCalled()
    expect(cache.put).not.toHaveBeenCalled()
    expect(renderers.render).not.toHaveBeenCalled()
  })
})

describe("bounded document work", () => {
  it("rejects deep nesting before rendering", async () => {
    await expect(build(`${"> ".repeat(45)}deep`)).rejects.toThrow("nesting")
    expect(renderers.render).not.toHaveBeenCalled()
  })

  it("rejects excessive AST nodes", async () => {
    await expect(build("- item\n".repeat(4500))).rejects.toThrow("node limit")
  })

  it("rejects excessive native blocks", async () => {
    await expect(build("paragraph\n\n".repeat(601))).rejects.toThrow("native block limit")
  })

  it("caps graphics at 40 and keeps later source as an error block", async () => {
    const result = await build(
      Array.from({ length: 41 }, (_, i) => `\`\`\`mermaid\ngraph TD; A${i}-->B\n\`\`\``).join(
        "\n\n",
      ),
    )
    expect(renderers.render).toHaveBeenCalledTimes(40)
    expect(result.blocks.at(-1)).toMatchObject({
      type: "error",
      error: expect.stringContaining("40 graphic block limit"),
    })
  })

  it("does no renderer or cache work for an already cancelled request", async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(
      build("```mermaid\ngraph TD; A-->B\n```", { signal: abort.signal }),
    ).rejects.toThrow("cancelled")
    expect(renderers.render).not.toHaveBeenCalled()
    expect(cache.key).not.toHaveBeenCalled()
  })

  it("propagates cancellation during a render instead of hiding it as a block error", async () => {
    const abort = new AbortController()
    renderers.render.mockImplementationOnce(async () => {
      abort.abort()
      throw new Error("worker cancelled")
    })
    await expect(
      build("```mermaid\ngraph TD; A-->B\n```", { signal: abort.signal }),
    ).rejects.toThrow("worker cancelled")
  })
})
