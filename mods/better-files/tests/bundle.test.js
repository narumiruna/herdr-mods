import { lstat, readFile } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { imageSize } from "image-size"
import { describe, expect, it } from "vitest"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const runtime = [
  "main.js",
  "markdown.js",
  "reader/main.js",
  "reader/model.js",
  "reader/runtime.js",
  "reader/node.js",
  "reader/helper.mjs",
  "reader/document.js",
  "reader/files.js",
  "reader/cache.js",
  "reader/renderers/index.js",
  "reader/renderers/mermaid.js",
  "reader/renderers/svg.js",
  "reader/renderers/vega.js",
  "reader/renderers/worker.js",
  "reader/renderers/worker-renderer.js",
]
const host = new Set(["gpui-kit", "gpui-base", "herdr", "crypto", "fs/promises"])

// Validate the source bundle, not generated SDKs or installed dependencies.
describe("shareable mod source", () => {
  it("keeps the recipe, actual PNG preview, manifest, license, and runtime in the mod root", async () => {
    for (const name of [
      "RECIPE.md",
      "preview.png",
      "mod.json",
      "package.json",
      "LICENSE",
      "NOTICE",
      "THIRD-PARTY-NOTICES",
      "reader/LICENSE",
      "DEPENDENCIES.md",
      "chevron-down.svg",
      "chevron-right.svg",
      "file.svg",
      "folder.svg",
      ...runtime,
    ])
      expect((await lstat(resolve(root, name))).isFile(), name).toBe(true)
    const preview = await readFile(resolve(root, "preview.png"))
    expect(preview.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
    expect(imageSize(preview)).toMatchObject({ width: 600, height: 525, type: "png" })
    expect(JSON.parse(await readFile(resolve(root, "mod.json"), "utf8"))).toMatchObject({
      place: "none",
      focusable: true,
    })
    expect(await readFile(resolve(root, "LICENSE"), "utf8")).toContain("Apache License")
    expect(await readFile(resolve(root, "NOTICE"), "utf8")).toContain("Better Files")
    expect(await readFile(resolve(root, "reader/LICENSE"), "utf8")).toContain("MIT License")
    expect(await readFile(resolve(root, "THIRD-PARTY-NOTICES"), "utf8")).toContain("MIT License")
    await expect(lstat(resolve(root, "layouts"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(lstat(resolve(root, "keys.json"))).rejects.toMatchObject({ code: "ENOENT" })
  })
  it("gives a rebuild brief with local links and explicit acceptance limits", async () => {
    const recipe = await readFile(resolve(root, "RECIPE.md"), "utf8")
    for (const heading of [
      "# Better Files",
      "## What you see",
      "## How it behaves",
      "## Built from",
      "## Watch out",
      "## Done when",
    ])
      expect(recipe).toContain(heading)
    expect(recipe).toContain("![Better Files preview](preview.png)")
    expect(recipe).toContain("data/better-files/")
    expect(recipe).toContain("Back")
    expect(recipe).toContain("Escape")
    expect(recipe).toContain("remote rejection")
    expect(recipe).toContain("close/cancel")
    expect(recipe).toContain("normal app use")
    expect(recipe).not.toMatch(/\/Users\/|narumi\/\.herdr/)
    for (const match of recipe.matchAll(/\]\(([^)]+)\)/g)) {
      const path = resolve(root, match[1].split("#")[0])
      expect(path.startsWith(root + sep)).toBe(true)
      expect((await lstat(path)).isFile()).toBe(true)
    }
  })
  it("resolves relative runtime modules inside the bundle and declares npm dependencies", async () => {
    const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"))
    expect(pkg.overrides.katex).toBe("0.19.1")
    for (const file of runtime) {
      const source = await readFile(resolve(root, file), "utf8")
      for (const match of source.matchAll(/(?:from\s*|import\s*\()"([^"\n]+)"/g)) {
        const name = match[1]
        if (name.startsWith(".")) {
          const path = resolve(dirname(resolve(root, file)), name)
          expect(path.startsWith(root + sep)).toBe(true)
          expect((await lstat(path)).isFile()).toBe(true)
        } else if (!name.startsWith("node:") && !host.has(name)) {
          const dependency = name.startsWith("@")
            ? name.split("/").slice(0, 2).join("/")
            : name.split("/")[0]
          expect(pkg.dependencies[dependency], `${file}: ${name}`).toBeDefined()
        }
      }
    }
  })
})
