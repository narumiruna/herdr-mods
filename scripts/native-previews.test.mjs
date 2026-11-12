import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { captureGenerator, offlineProgram, pngInfo } from "./native-previews.mjs"

for (const name of ["github-issues-prs", "layout-manager", "mod-manager"]) {
  test(`${name}: saves trusted fixtures without starting the native app`, async () => {
    const source = await readFile(
      new URL(`../mods/${name}/scripts/check-views.mjs`, import.meta.url),
      "utf8",
    )
    const transformed = captureGenerator(
      source,
      name,
      "/tmp/owned-fixtures",
      "/tmp/owned-generator-temp",
    )
    assert.ok(transformed.includes('import { cpSync as saveFixture } from "node:fs"'))
    assert.ok(transformed.includes('const tmpdir = () => "/tmp/owned-generator-temp"'))
    assert.ok(transformed.includes('saveFixture(directory, "/tmp/owned-fixtures"'))
    assert.ok(transformed.includes("rmSync(directory, { recursive: true, force: true })"))
    assert.ok(!transformed.includes("spawnSync"))
    assert.throws(
      () => captureGenerator(source.replaceAll("spawnSync", "changed"), name, "/tmp/x", "/tmp/y"),
      /Fixture source changed/,
    )
  })
}

test("offline shim retains the reviewed handshake and fail-closed protocol", async () => {
  const source = await readFile(
    new URL("../mods/markdown-reader/scripts/native-evidence.mjs", import.meta.url),
    "utf8",
  )
  const program = offlineProgram(source)
  for (const value of [
    'request.method !== "hello"',
    "generation: 1",
    "framed: true",
    "rpc.discover",
    "Oversized core frame",
    "Offline fixture denies this method",
    'process.stdin.on("end"',
  ])
    assert.ok(program.includes(value), value)
  assert.ok(!program.includes("function alive("))
  assert.throws(() => offlineProgram("changed source"), /offline-core source changed/)
})

test("rejects invalid and zero-sized native PNG headers", () => {
  assert.throws(() => pngInfo(Buffer.from("not an image")), /not a PNG/)
  // Binary header only, never a preview image or appearance evidence.
  const header = Buffer.alloc(33)
  Buffer.from("89504e470d0a1a0a", "hex").copy(header)
  header.write("IHDR", 12)
  assert.throws(() => pngInfo(header), /Empty native capture/)
  header.writeUInt32BE(1200, 16)
  header.writeUInt32BE(950, 20)
  assert.deepEqual(
    Object.fromEntries(Object.entries(pngInfo(header)).filter(([key]) => key !== "sha256")),
    { width: 1200, height: 950, bytes: 33 },
  )
})
