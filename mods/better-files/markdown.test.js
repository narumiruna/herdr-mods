import { describe, expect, it } from "vitest"
import { markdownEntry, markdownRoot } from "./markdown.js"

const context = {
  cwd: "/workspace/project/notes",
  root: "/workspace/project",
  space: "space-original",
  on: null,
}

describe("Markdown root selection", () => {
  it.each([
    ["/project/docs", "/project", "/project"],
    ["/project/docs", "/project/", "/project/"],
    ["/project", "/profile", "/project"],
    ["/project-other", "/project", "/project-other"],
    ["/work", "/Work", "/work"],
    ["/project", undefined, "/project"],
    ["C:\\work\\project", "C:\\profile\\herdr-app", "C:\\work\\project"],
    ["C:\\work\\project\\docs", "c:/WORK/project", "c:/WORK/project"],
    ["D:\\project", "C:\\project", "D:\\project"],
    ["C:\\project-other", "C:\\project", "C:\\project-other"],
  ])("selects a root containing the browsed folder: %s", (cwd, workspace, expected) => {
    expect(markdownRoot(cwd, workspace)).toBe(expected)
  })
})

describe("Markdown reader entry", () => {
  it.each([
    "notes.md",
    "notes.MD",
    "notes.mD",
    "notes.markdown",
    "notes.MARKDOWN",
    "notes.MarkDown",
  ])("routes %s to the reader", (path) => {
    expect(markdownEntry(path, context)).toEqual({
      file: `${context.cwd}/${path}`,
      root: context.root,
      on: null,
    })
  })

  it.each([
    null,
    undefined,
    42,
    {},
    "",
    "README",
    "notes.txt",
    "notes.md.txt",
    "notes.mdx",
    "notes.md/",
    "notes.md?raw",
  ])("leaves non-Markdown input %j on the original preview route", (path) => {
    expect(markdownEntry(path, undefined)).toBeNull()
  })

  it.each([
    [
      "/workspace/文書 folder/",
      "/workspace",
      "設計 notes/初めに.MD",
      "/workspace/文書 folder/設計 notes/初めに.MD",
    ],
    [
      "C:\\Work Space\\文書\\",
      "C:\\Work Space",
      "設計 notes\\初めに.Markdown",
      "C:\\Work Space\\文書/設計 notes\\初めに.Markdown",
    ],
    [
      "d:/Work Space/文書/",
      "d:/Work Space",
      "notes/Read Me.md",
      "d:/Work Space/文書/notes/Read Me.md",
    ],
    ["/", "/", "notes.md", "/notes.md"],
    ["C:\\", "C:\\", "notes.md", "C:/notes.md"],
  ])(
    "joins paths without changing spaces, Unicode, or workspace root: %s",
    (cwd, root, path, file) => {
      const captured = { ...context, cwd, root }
      expect(markdownEntry(path, captured)).toEqual({ file, root, on: null })
      expect(captured).toEqual({ ...context, cwd, root })
    },
  )

  it.each(["remote-server", "ssh:開発 machine"])(
    "preserves remote identity %s without a local fallback",
    (on) => {
      expect(markdownEntry("notes.md", { ...context, on })).toEqual({
        file: "/workspace/project/notes/notes.md",
        root: "/workspace/project",
        on,
      })
    },
  )

  it.each([
    undefined,
    null,
    {},
    { ...context, cwd: undefined },
    { ...context, cwd: "relative/path" },
    { ...context, cwd: "C:relative" },
    { ...context, cwd: "//server/share" },
    { ...context, cwd: "\\\\server\\share" },
    { ...context, cwd: "/workspace\nother" },
    { ...context, root: undefined },
    { ...context, root: "relative" },
    { ...context, root: "/workspace\0" },
    { ...context, space: undefined },
    { ...context, space: "" },
    { ...context, space: 1 },
    { ...context, on: undefined },
    { ...context, on: "" },
    { ...context, on: false },
  ])("rejects invalid or missing captured context: %j", (captured) => {
    expect(() => markdownEntry("notes.md", captured)).toThrow(
      /absolute file location and workspace folder/,
    )
  })

  it.each([
    "/notes.md",
    "\\notes.md",
    "C:\\notes.md",
    "c:notes.md",
    "../notes.md",
    "./notes.md",
    "a/../notes.md",
    "a\\..\\notes.md",
    "a//notes.md",
    "a\\\\notes.md",
    "a/./notes.md",
    "a\0.md",
    "a\n.md",
  ])("rejects unsafe relative Markdown path %j", (path) => {
    expect(() => markdownEntry(path, context)).toThrow(
      /absolute file location and workspace folder/,
    )
  })
})
