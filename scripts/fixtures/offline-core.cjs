// Generation-1 method names from hc 0.1.20's OpenRPC schema. Advertising the
// complete list prevents Herdr 0.1.15 from trying to install/update a real core.
function offlineCore() {
  const fs = require("node:fs")
  const path = require("node:path")
  const log = (value) =>
    fs.appendFileSync(
      path.join(__dirname, "offline-core.jsonl"),
      `${JSON.stringify({ pid: process.pid, ...value })}\n`,
    )
  log({ args: process.argv.slice(2) })
  if (process.argv.includes("--version") || process.argv.includes("-V")) {
    console.log("hc 0.1.20")
    return
  }
  if (!process.argv.includes("connect")) {
    process.exitCode = 1
    return
  }
  const core = { id: "isolated-native-preview", name: "offline-fixture" }
  const methods =
    "hello server.status server.stop server.restart terminal.run templates.list terminal.list terminal.get terminal.kill terminal.rm terminal.keep terminal.label terminal.read terminal.attach terminal.send terminal.wait terminal.keys terminal.interrupt terminal.put machine.exec file.read file.write file.edit doc.get doc.set events.subscribe machine.add machine.list machine.connect machine.rename machine.rm rpc.discover".split(
      " ",
    )
  let pending = Buffer.alloc(0)
  let hello = false
  const framed = (message) => {
    const body = Buffer.from(JSON.stringify(message))
    const header = Buffer.alloc(9)
    header.writeUInt32LE(body.length, 5)
    process.stdout.write(Buffer.concat([header, body]))
  }
  const reply = (request) => {
    log({ request })
    let result
    switch (request.method) {
      case "server.status":
        result = {
          core,
          version: "0.1.20",
          pid: process.pid,
          uptime_ms: 0,
          holders: [],
          live: 0,
          finished: 0,
          installed_by: "offline-fixture",
        }
        break
      case "events.subscribe":
        result = { channel: 1, seq: 0, terminals: [] }
        break
      case "terminal.list":
        result = { terminals: [], hidden_finished: 0, machines: [] }
        break
      case "machine.list":
        result = { machines: [] }
        break
      case "doc.get":
        result = { value: null, version: 0 }
        break
      default:
        framed({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32000,
            message: "Offline fixture denies this method",
            data: { kind: "fixture_denied" },
          },
        })
        return
    }
    framed({ jsonrpc: "2.0", id: request.id, result })
  }
  process.stdin.on("data", (data) => {
    pending = Buffer.concat([pending, data])
    if (pending.length > 2 * 1048576) throw new Error("Oversized core input")
    if (!hello) {
      const end = pending.indexOf(10)
      if (end < 0) return
      const request = JSON.parse(pending.subarray(0, end).toString())
      if (request.method !== "hello") throw new Error("Expected core hello")
      pending = pending.subarray(end + 1)
      hello = true
      log({ hello: request })
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { generation: 1, version: "0.1.20", core, framed: true, methods, features: [] } })}\n`,
      )
    }
    while (pending.length >= 9) {
      const length = pending.readUInt32LE(5)
      if (length > 1048576) throw new Error("Oversized core frame")
      if (pending.length < 9 + length) return
      const kind = pending[0]
      const body = pending.subarray(9, 9 + length)
      pending = pending.subarray(9 + length)
      if (kind === 0) reply(JSON.parse(body.toString()))
    }
  })
  process.stdin.on("end", () => process.exit(0))
}

offlineCore()
