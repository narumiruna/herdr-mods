import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { filterMods, GALLERY_URL, parseRepository, validateManifest } from "../manager.js"

const mods = [
  {
    id: "notes",
    name: "Workspace Notes",
    description: "Project context",
    repository: "owner/notes",
    source: "github",
  },
  {
    id: "manager",
    name: "Mod Manager",
    description: "Local checkout",
    repository: "Development",
    source: "development",
  },
  { id: "files", name: "Files", description: "Local files", repository: "Local", source: "local" },
]

test("filters installed data, not a built-in sample library", () => {
  expect(filterMods([], "", "all")).toEqual([])
  expect(filterMods(mods, "", "all")).toEqual(mods)
  expect(filterMods(mods, "  WORKSPACE  ", "github")).toEqual([mods[0]])
  expect(filterMods(mods, "context", "all")).toEqual([mods[0]])
  expect(filterMods(mods, "owner/notes", "all")).toEqual([mods[0]])
  expect(filterMods(mods, "manager", "development")).toEqual([mods[1]])
  expect(filterMods(mods, "", "local")).toEqual([mods[2]])
  expect(filterMods(mods, "notes", "development")).toEqual([])
  expect(filterMods(mods, "missing", "all")).toEqual([])
})

test("normalizes a public GitHub repository without accepting a shell command", () => {
  expect(parseRepository("  https://github.com/Owner/Repo.git/  ")).toEqual({
    id: "repo",
    label: "owner/repo",
    url: "https://github.com/owner/repo.git",
  })
  expect(parseRepository("https://github.com/owner/repo-name_1.2").id).toBe("repo-name_1.2")
})

test("accepts the optional .git suffix at the GitHub repository-name length limit", () => {
  const name = "a".repeat(100)
  expect(parseRepository(`https://github.com/owner/${name}.git`).id).toBe(name)
  expect(() => parseRepository(`https://github.com/owner/${name}a`)).toThrow()
})

test.each([
  "http://github.com/owner/repo",
  "https://github.com.evil.test/owner/repo",
  "https://user:password@github.com/owner/repo",
  "https://github.com:443/owner/repo",
  "git@github.com:owner/repo.git",
  "file:///tmp/repo",
  "--upload-pack=evil",
  "https://github.com/owner/repo/tree/main",
  "https://github.com/owner/repo?x=y",
  "https://github.com/owner/repo#main",
  "https://github.com/owner/%2e%2e",
  "https://github.com/owner/..",
  "https://github.com/owner/repo.",
  "https://github.com/owner/repo;touch /tmp/unsafe",
  "https://github.com/owner/repo\necho bad",
  "https://github.com/-owner/repo",
  "https://github.com/owner-/repo",
])("refuses an unsupported URL: %s", (value) => {
  expect(() => parseRepository(value)).toThrow()
})

describe("structural validation", () => {
  test("accepts a direct-JavaScript mod and preserves unknown manifest fields", () => {
    const manifest = {
      title: "Notes",
      place: "none",
      overlay: { kind: "dialog", width: 500, height: 300 },
      future: true,
    }
    expect(validateManifest(JSON.stringify(manifest), "export default class Notes {} ")).toEqual(
      manifest,
    )
    expect(validateManifest("{}", "// a nonempty entry")).toEqual({})
  })

  test.each([
    "null",
    "[]",
    "false",
    '"mod"',
    "{broken",
    '{"place":"center"}',
    '{"place":["none"]}',
    '{"title":1}',
    '{"title":" "}',
    '{"size":0}',
    '{"size":"100"}',
    '{"overlay":[]}',
    '{"overlay":null}',
    '{"overlay":{"kind":"invalid"}}',
    '{"overlay":{"kind":["dialog"]}}',
    '{"overlay":{"width":-1}}',
    '{"overlay":{"height":"200"}}',
  ])("refuses an invalid manifest: %s", (json) => {
    expect(() => validateManifest(json, "export default class Mod {} ")).toThrow()
  })

  test.each([undefined, "none", "left", "right", "top", "bottom"])(
    "keeps main placement compatibility: %s",
    (place) => {
      const manifest = { title: "Docking mod", ...(place === undefined ? {} : { place }) }
      expect(validateManifest(JSON.stringify(manifest), "// entry")).toEqual(manifest)
    },
  )

  test.each([
    { size: -1 },
    { size: null },
    { title: "" },
    { title: false },
    { overlay: { width: 0 } },
    { overlay: { height: 0 } },
    { overlay: { width: "20" } },
    { overlay: { kind: null } },
  ])("retains main field validators: %j", (manifest) => {
    expect(() => validateManifest(JSON.stringify(manifest), "// entry")).toThrow()
  })

  test("refuses an empty entry", () => {
    expect(() => validateManifest("{}", " \n\t")).toThrow(/nonempty/)
  })
})

test("keeps the Gallery link on the mods page", () => {
  expect(GALLERY_URL).toBe("https://herdr.dev/gallery/?type=mods")
})

test("documents an installable mod from this repository", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
  const path = /2\. Enter `(mods\/[^`]+)` in \*\*Mod directory\*\*\./.exec(readme)?.[1]
  expect(path).toBeDefined()
  const directory = new URL(`../../../${path}/`, import.meta.url)
  const manifest = readFileSync(new URL("mod.json", directory), "utf8")
  const entry = readFileSync(new URL("main.js", directory), "utf8")
  expect(validateManifest(manifest, entry)).toHaveProperty("title")
  expect(readme).toContain(`such as \`${path}\``)
  expect(readme).toContain(`The installed folder is \`<app-home>/${path}\``)
  const recipe = readFileSync(new URL("../RECIPE.md", import.meta.url), "utf8")
  expect(recipe).toContain(`such as \`${path}\``)
})
