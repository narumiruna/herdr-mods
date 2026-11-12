import { lstat, readdir, readFile, realpath } from "node:fs/promises"
import { dirname, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { inflateSync } from "node:zlib"

const repository = fileURLToPath(new URL("..", import.meta.url))
const hostModules = new Set([
  "gpui-kit",
  "gpui-base",
  "gpui-shell",
  "herdr",
  "crypto",
  "fs/promises",
])
const excluded = new Set(["node_modules", "__pycache__", ".git", ".cache", "coverage"])
const inside = (root, path) => path.startsWith(root + sep)

// Check chunk framing, dimensions, and bounded IDAT inflation, not pixel decoding.
// This is not a full PNG decoder: inspect readability, appearance, and private
// content in an image viewer before accepting any preview.
export function checkPNG(bytes) {
  if (bytes.length < 45 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
    throw new Error("not a PNG")
  let offset = 8
  const data = []
  let ended = false
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    if (length > bytes.length - offset - 12) throw new Error("truncated PNG chunk")
    const kind = bytes.toString("ascii", offset + 4, offset + 8)
    if (offset === 8) {
      if (kind !== "IHDR" || length !== 13) throw new Error("missing PNG header")
      const width = bytes.readUInt32BE(offset + 8)
      const height = bytes.readUInt32BE(offset + 12)
      if (!width || !height || width * height > 32_000_000)
        throw new Error("invalid or excessive PNG dimensions")
    }
    if (kind === "IDAT") data.push(bytes.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
    if (kind === "IEND") {
      ended = length === 0 && offset === bytes.length
      break
    }
  }
  if (!ended || !data.length) throw new Error("incomplete PNG")
  if (!inflateSync(Buffer.concat(data), { maxOutputLength: 256 * 1024 * 1024 }).length)
    throw new Error("empty PNG image stream")
}

export async function inspectBundle(directory) {
  const root = await realpath(directory)
  const errors = []
  const files = []
  const report = (file, message) => errors.push(`${file}: ${message}`)
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (excluded.has(entry.name) || entry.name.endsWith(".d.ts")) continue
      const target = resolve(path, entry.name)
      const name = relative(root, target)
      if (entry.isSymbolicLink()) report(name, "source bundles must not contain symbolic links")
      else if (entry.isDirectory()) {
        if (entry.name === "layouts" || (path === root && entry.name === "mods"))
          report(name, "do not package layouts or nested mod roots")
        await walk(target)
      } else if (entry.isFile()) files.push(name)
    }
  }
  await walk(root)
  for (const name of ["main.js", "mod.json", "package.json", "RECIPE.md", "preview.png", "LICENSE"])
    if (!files.includes(name)) report(name, "required file is missing")

  const parsed = new Map()
  for (const name of files.filter((name) => name.endsWith(".json"))) {
    try {
      parsed.set(name, JSON.parse(await readFile(resolve(root, name), "utf8")))
    } catch (error) {
      report(name, `invalid JSON: ${error.message}`)
    }
  }
  const pkg = parsed.get("package.json")
  for (const script of ["test", "check:mod", "check:views", "check:types"])
    if (typeof pkg?.scripts?.[script] !== "string" || !pkg.scripts[script].trim())
      report("package.json", `missing ${script} script; root workspace checks would skip this mod`)

  async function localFile(source, name) {
    const target = resolve(dirname(resolve(root, source)), name)
    if (!inside(root, target)) return report(source, `path escapes bundle: ${name}`)
    try {
      if (!(await lstat(target)).isFile() || !inside(root, await realpath(target)))
        report(source, `not a local regular file: ${name}`)
    } catch {
      report(source, `missing local file: ${name}`)
    }
  }
  if (files.includes("RECIPE.md")) {
    const recipe = await readFile(resolve(root, "RECIPE.md"), "utf8")
    for (const heading of [
      "What you see",
      "How it behaves",
      "Built from",
      "Watch out",
      "Done when",
    ])
      if (!recipe.includes(`## ${heading}`)) report("RECIPE.md", `missing section: ${heading}`)
    if (!/!\[[^\]]+\]\(preview\.png\)/.test(recipe))
      report("RECIPE.md", "missing adjacent preview.png image reference")
    for (const match of recipe.matchAll(/\]\(([^)]+)\)/g)) {
      const link = match[1].split("#")[0]
      if (!link || /^https?:\/\//.test(link)) continue
      await localFile("RECIPE.md", link)
    }
  }
  if (files.includes("preview.png")) {
    try {
      const path = resolve(root, "preview.png")
      if ((await lstat(path)).size > 20 * 1024 * 1024) throw new Error("PNG exceeds 20 MiB")
      checkPNG(await readFile(path))
    } catch (error) {
      report("preview.png", error.message)
    }
  }
  // Check shipped runtime sources, not development scripts, tests, or fixtures.
  for (const name of files.filter(
    (name) =>
      /\.(?:js|mjs)$/.test(name) &&
      !name.endsWith(".test.js") &&
      !name.includes(".config.") &&
      !/^(?:scripts|tests|fixtures)\//.test(name),
  )) {
    const source = await readFile(resolve(root, name), "utf8")
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"'\n]+)["']/g)) {
      const specifier = match[1]
      if (specifier.startsWith(".")) await localFile(name, specifier)
      else if (!specifier.startsWith("node:") && !hostModules.has(specifier)) {
        const dependency = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0]
        if (!pkg?.dependencies?.[dependency])
          report(name, `undeclared runtime dependency: ${dependency}`)
      }
    }
  }
  return { name: relative(resolve(root, ".."), root), errors, files }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mods = resolve(repository, "mods")
  let failed = false
  for (const entry of await readdir(mods, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const result = await inspectBundle(resolve(mods, entry.name))
    console.log(
      `${result.errors.length ? "INCOMPLETE" : "PASS"} mods/${result.name}: ${result.files.length} source files`,
    )
    for (const error of result.errors) console.error(`  ${error}`)
    failed ||= result.errors.length > 0
  }
  console.log(
    "Source checks exclude development artifacts. PNG structure is not full image decoding. Inspect previews and test native interaction before sharing.",
  )
  process.exitCode = failed ? 1 : 0
}
