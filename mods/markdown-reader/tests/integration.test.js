import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cloneLayout,
  markdownTab,
  replaceOnce,
  safeName,
  transformFilesSource,
} from "../integration.js"
import { main, prepareFilesIntegration } from "../scripts/prepare-files.mjs"

// Independent scaffold: only the exact patch anchors mirror installed code.
const scaffold = `import { watchFolder, theme, settings, window } from "herdr";
function location() { const space = {}; return { space: space?.id }; }
const key = () => "test";
class Files {
  refresh() {
    const { cwd, on } = location(), next = key();
    this.context = { key: next, cwd, on };
  }
  show(path) { this.preview = path; }
  toggle(path) { this.toggled = path; }
  rows(prefix, depth, out, t) {
    const entry = { dir: false }, path = "notes.MD";
    out.push(chain
      .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx)));
    const a = \`mods/files/chevron-\${true}\`;
    const b = \`mods/files/\${entry.dir}\`;
    return out;
  }
}
return Files;`

const local = { cwd: "/work/sub folder", root: "/work", space: "space-1", on: null }

it.each(["guide.md", "guide.MD", "guide.MarkDown", "子 目录/it's a 文件.markdown"])(
  "passes an absolute path, basename and workspace for %s",
  (path) => {
    expect(markdownTab(path, local)).toEqual({
      space: "space-1",
      name: path.split("/").pop(),
      mod: "markdown-reader",
      props: { file: `/work/sub folder/${path}`, root: "/work", on: null },
    })
  },
)

it("preserves remote identity even when the same local path can exist", () => {
  expect(
    markdownTab("README.md", { ...local, on: "remote-host", space: "remote-host/s1" }),
  ).toMatchObject({ space: "remote-host/s1", props: { on: "remote-host", root: "/work" } })
  expect(
    markdownTab("说明.md", { ...local, cwd: "C:\\work space", root: "C:\\", on: "win" }),
  ).toMatchObject({ props: { file: "C:\\work space/说明.md", on: "win" } })
})

it.each(["file.txt", "file.md.txt", "file", "markdown", "file.json"])(
  "keeps the original preview route for %s",
  (path) => expect(markdownTab(path, null)).toBeNull(),
)

it.each([
  ["../escape.md", local],
  ["/absolute.md", local],
  ["a/./b.md", local],
  ["a//b.md", local],
  ["a\0.md", local],
  ["a.md", { ...local, root: undefined }],
  ["a.md", { ...local, cwd: "relative" }],
  ["a.md", { ...local, on: undefined }],
  ["a.md", { ...local, space: undefined }],
])("rejects incomplete or unsafe click props: %s", (path, context) => {
  expect(() => markdownTab(path, context)).toThrow("requires an absolute")
})

it("patches only unique targets, captures list context, and leaves Editor preview intact", () => {
  const source = transformFilesSource(scaffold)
  expect(source).toContain("show(path) { this.preview = path; }")
  expect(source).not.toContain("mods/files/")
  expect(source).toContain("mods/files-markdown/")
  const run = vi.fn()
  let click
  const chain = {
    on_click: (callback) => {
      click = callback
      return chain
    },
  }
  // Execute the generated independent scaffold, not the installed mod.
  const Files = new Function("run", "chain", source.replace(/^import .*;$/m, ""))(run, chain)
  const files = new Files()
  files.context = { ...local, on: "remote-machine" }
  files.rows("", 0, [], {})
  files.context = { cwd: "/different", root: "/different", space: "other", on: null }
  click(null, {})
  expect(run).toHaveBeenCalledExactlyOnceWith("tab.new", {
    space: "space-1",
    name: "notes.MD",
    mod: "markdown-reader",
    props: { file: "/work/sub folder/notes.MD", root: "/work", on: "remote-machine" },
  })
  files.openFile("script.js", {}, local)
  expect(files.preview).toBe("script.js")
  expect(run).toHaveBeenCalledTimes(1)
})

it("rejects missing and duplicate targets without a fallback replacement", () => {
  expect(() => replaceOnce("none", "needle", "x")).toThrow("found 0")
  expect(() => replaceOnce("needle needle", "needle", "x")).toThrow("found 2")
  expect(() => transformFilesSource(scaffold.replace("watchFolder,", "changed,"))).toThrow(
    "found 0",
  )
  expect(() =>
    transformFilesSource(`${scaffold}\n// watchFolder, theme, settings, window }`),
  ).toThrow("found 2")
  expect(replaceOnce("target", "target", "$&")).toBe("$&")
})

it("changes recursive content.mod references, not props, IDs, strings, or other mods", () => {
  const layout = {
    id: "root",
    type: "row",
    preview: "files.svg",
    children: [
      {
        id: "files",
        type: "stack",
        active: "files",
        children: [
          { id: "files", content: { mod: "files", props: { mod: "files", text: "files" } } },
          { id: "files-other", content: { mod: "files-other" } },
          { content: { tab: "active", pane: { header: { content: { mod: "files" } } } } },
        ],
      },
    ],
  }
  const original = structuredClone(layout)
  const result = cloneLayout(layout)
  expect(result.replacements).toBe(2)
  expect(result.layout.children[0].children[0]).toEqual({
    id: "files",
    content: { mod: "files-markdown", props: { mod: "files", text: "files" } },
  })
  expect(result.layout.children[0].active).toBe("files")
  expect(result.layout.children[0].children[1].content.mod).toBe("files-other")
  expect(result.layout.children[0].children[2].content.pane.header.content.mod).toBe(
    "files-markdown",
  )
  expect(layout).toEqual(original)
  expect(() => cloneLayout({ id: "root", children: [] })).toThrow("no content.mod")
})

it.each(["../files", "a/b", "a\\b", "A", "x'", "", "é", "a".repeat(65)])(
  "rejects unsafe names: %s",
  (name) => expect(() => safeName(name)).toThrow(),
)

let base
let profile
let output
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "markdown-integration-")))
  profile = join(base, "profile with 空格 and 'quote'")
  output = join(base, "personal with 空格 and 'quote'")
  await mkdir(join(profile, "mods/files"), { recursive: true })
  await mkdir(join(profile, "layouts"))
  await writeFile(join(profile, "mods/files/main.js"), scaffold)
  await writeFile(join(profile, "mods/files/mod.json"), '{"place":"none"}')
  await writeFile(join(profile, "layouts/main.json"), '{"id":"root","content":{"mod":"files"}}')
})
afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

async function noOutput() {
  await expect(readFile(join(output, "preparation.json"))).rejects.toMatchObject({ code: "ENOENT" })
  const { lstat } = await import("node:fs/promises")
  await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" })
}

describe("offline preparation safety", () => {
  it("refuses an unsupported version without creating partial output or changing source", async () => {
    await expect(prepareFilesIntegration({ profile, output })).rejects.toThrow(
      "Unsupported source version",
    )
    await noOutput()
    expect(await readFile(join(profile, "mods/files/main.js"), "utf8")).toBe(scaffold)
  })
  it("reports a missing target before any output writes", async () => {
    await writeFile(join(profile, "mods/files/main.js"), "unsupported")
    await expect(prepareFilesIntegration({ profile, output })).rejects.toThrow("found 0")
    await noOutput()
  })
  it("never overwrites an existing output directory", async () => {
    await mkdir(output)
    await writeFile(join(output, "keep"), "unchanged")
    await expect(prepareFilesIntegration({ profile, output })).rejects.toThrow("already exists")
    expect(await readFile(join(output, "keep"), "utf8")).toBe("unchanged")
  })
  it("refuses source, source descendants and source ancestors as output", async () => {
    for (const destination of [profile, join(profile, "prepared"), base]) {
      await expect(prepareFilesIntegration({ profile, output: destination })).rejects.toThrow(
        "separate",
      )
    }
  })
  it("refuses active profile output even with a different source profile", async () => {
    vi.stubEnv("HERDR_APP_HOME", join(base, "active"))
    try {
      await expect(
        prepareFilesIntegration({ profile, output: join(base, "active/prepared") }),
      ).rejects.toThrow("separate")
    } finally {
      vi.unstubAllEnvs()
    }
  })
  it("refuses the canonical active profile even when its environment path is a symlink", async () => {
    const active = join(base, "active-real")
    await mkdir(active)
    const alias = join(base, "active-alias")
    await symlink(active, alias)
    vi.stubEnv("HERDR_APP_HOME", alias)
    try {
      await expect(
        prepareFilesIntegration({ profile, output: join(active, "prepared") }),
      ).rejects.toThrow("separate")
    } finally {
      vi.unstubAllEnvs()
    }
  })
  it("refuses output symlinks, including dangling links", async () => {
    await symlink(join(base, "missing"), output)
    await expect(prepareFilesIntegration({ profile, output })).rejects.toThrow("Symbolic links")
  })
  it("refuses symlinked output parents", async () => {
    await symlink(base, join(base, "alias"))
    await expect(
      prepareFilesIntegration({ profile, output: join(base, "alias/out") }),
    ).rejects.toThrow("Symbolic links")
  })
  it("refuses source symlinks at any ancestor", async () => {
    const source = join(profile, "mods/files/main.js")
    await rm(source)
    await writeFile(join(base, "real-main"), scaffold)
    await symlink(join(base, "real-main"), source)
    await expect(prepareFilesIntegration({ profile, output })).rejects.toThrow("Symbolic links")
    await noOutput()
    await symlink(profile, join(base, "source-alias"))
    await expect(
      prepareFilesIntegration({ profile: join(base, "source-alias"), output }),
    ).rejects.toThrow("Symbolic links")
  })
  it("refuses names already installed in the selected profile", async () => {
    await mkdir(join(profile, "mods/changes"))
    await expect(
      prepareFilesIntegration({ profile, output, cloneName: "changes" }),
    ).rejects.toThrow("already installed")
    await writeFile(join(profile, "layouts/personal.json"), "{}")
    await expect(
      prepareFilesIntegration({ profile, output, layoutName: "personal" }),
    ).rejects.toThrow("already installed")
    await noOutput()
  })
  it("refuses reserved names, relative paths, and parent traversal", async () => {
    for (const options of [
      { cloneName: "files" },
      { cloneName: "markdown-reader" },
      { layoutName: "main" },
      { cloneName: "../x" },
      { profile: "relative" },
      { output: "relative" },
      { output: `${base}/alias/../out` },
      { profile: `${profile}/alias/..` },
    ]) {
      await expect(prepareFilesIntegration({ profile, output, ...options })).rejects.toThrow()
    }
    await noOutput()
  })
  it("requires explicit CLI paths and refuses duplicate options", async () => {
    await expect(main([])).rejects.toThrow("profile must be")
    await expect(main(["--profile", profile, "--profile", profile])).rejects.toThrow("Usage:")
    await expect(main(["--unknown", "value"])).rejects.toThrow("Usage:")
    await noOutput()
  })
})
