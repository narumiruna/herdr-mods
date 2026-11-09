import { expect, test } from "vitest"
import { filterMods, GALLERY_URL, PREVIEW_MODS } from "../preview.js"

test("shows every sample when no filter is set", () => {
  expect(filterMods("", "all")).toEqual(PREVIEW_MODS)
})

test("searches names, descriptions, and repositories without case sensitivity", () => {
  expect(filterMods("  FOCUS  ", "all").map((mod) => mod.id)).toEqual(["focus-mode"])
  expect(filterMods("context", "all").map((mod) => mod.id)).toEqual(["workspace-notes"])
  expect(filterMods("example/terminal", "all").map((mod) => mod.id)).toEqual(["terminal-tools"])
})

test("combines the source filter with the search", () => {
  expect(filterMods("", "github")).toHaveLength(3)
  expect(filterMods("", "development").map((mod) => mod.id)).toEqual(["mod-manager"])
  expect(filterMods("focus", "development")).toEqual([])
})

test("returns an empty list for an unknown sample", () => {
  expect(filterMods("not-a-mod", "all")).toEqual([])
})

test("uses distinct sample IDs and the mods Gallery URL", () => {
  expect(new Set(PREVIEW_MODS.map((mod) => mod.id)).size).toBe(PREVIEW_MODS.length)
  expect(GALLERY_URL).toBe("https://herdr.dev/gallery/?type=mods")
})
