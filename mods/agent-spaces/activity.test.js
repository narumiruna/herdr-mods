import { describe, expect, it } from "vitest"
import { groupAgents } from "./activity.js"

function agent(address, space, status = "idle", extra = {}) {
  return { address, space, status, program: { name: "Claude", icon: "claude.svg" }, ...extra }
}

describe("groupAgents", () => {
  it("returns an empty Map when there are no agents", () => {
    expect(groupAgents([])).toEqual(new Map())
  })

  it("keeps local and qualified remote space IDs separate despite matching names", () => {
    const local = agent("terminal-1", "space-1", "working", { spaceName: "Project" })
    const remote = agent("edge/terminal-1", "edge/space-1", "idle", { spaceName: "Project" })
    const other = agent("backup/terminal-1", "backup/space-1", "blocked", {
      spaceName: "Project",
    })
    const groups = groupAgents([local, remote, other])

    expect([...groups.keys()]).toEqual(["space-1", "edge/space-1", "backup/space-1"])
    expect(groups.get("space-1")).toMatchObject({ members: [local], working: 1, total: 1 })
    expect(groups.get("edge/space-1")).toMatchObject({ members: [remote], working: 0, total: 1 })
    expect(groups.get("backup/space-1")).toMatchObject({ members: [other], working: 0, total: 1 })
  })

  it("counts only working agents in the numerator and all states in the total", () => {
    const members = ["idle", "working", "blocked", "done", "working"].map((status, i) =>
      agent(`terminal-${i}`, "space-1", status),
    )
    expect(groupAgents(members).get("space-1")).toEqual({
      members,
      working: 2,
      total: 5,
      status: "working",
      tooltip:
        "2/5 agents working\nClaude: idle\nClaude: working\nClaude: blocked\nClaude: done\nClaude: working",
    })
  })

  it.each([
    [["idle"], "idle", 0],
    [["idle", "idle"], "idle", 0],
    [["done", "idle"], "done", 0],
    [["done", "blocked", "idle"], "blocked", 0],
    [["blocked", "working", "done", "idle"], "working", 1],
    [["working", "working"], "working", 2],
  ])("summarizes %j as %s with %i working", (statuses, status, working) => {
    const members = statuses.map((state, i) => agent(`terminal-${i}`, "space-1", state))
    expect(groupAgents(members).get("space-1")).toMatchObject({
      members,
      status,
      working,
      total: statuses.length,
    })
  })

  it("deduplicates by full address, retaining the first record even across spaces", () => {
    const first = agent("terminal-1", "space-1", "idle")
    const duplicate = agent("terminal-1", "space-1", "working")
    const movedDuplicate = agent("terminal-1", "space-2", "blocked")
    const remote = agent("edge/terminal-1", "space-1", "working")
    const groups = groupAgents([first, duplicate, movedDuplicate, remote])

    expect([...groups.keys()]).toEqual(["space-1"])
    expect(groups.get("space-1")).toEqual({
      members: [first, remote],
      working: 1,
      total: 2,
      status: "working",
      tooltip: "1/2 agents working\nClaude: idle\nClaude: working",
    })
  })

  it("retains repeated programs and icons when their terminal addresses differ", () => {
    const program = { name: "Codex", icon: "codex.svg", tint: true }
    const members = Array.from({ length: 5 }, (_, i) =>
      agent(`terminal-${i}`, "space-1", "working", { program }),
    )
    const activity = groupAgents(members).get("space-1")

    expect(activity.members).toEqual(members)
    expect(activity.members.map((member) => member.program.icon)).toEqual(
      Array(5).fill("codex.svg"),
    )
    expect(activity).toMatchObject({ working: 5, total: 5 })
  })

  it("does not change the input array, records, or shared program object", () => {
    const program = Object.freeze({ name: "Codex", icon: "codex.svg", tint: true })
    const first = Object.freeze(agent("terminal-2", "space-1", "idle", { program }))
    const second = Object.freeze(agent("terminal-1", "space-1", "working", { program }))
    const input = Object.freeze([first, second, first])
    const before = JSON.stringify(input)
    const groups = groupAgents(input)
    const members = groups.get("space-1").members

    expect(JSON.stringify(input)).toBe(before)
    expect(input).toEqual([first, second, first])
    expect(members).not.toBe(input)
    expect(members[0]).toBe(first)
    expect(members[1]).toBe(second)
    members.pop()
    expect(input).toHaveLength(3)
    expect(groupAgents(input).get("space-1")).toMatchObject({ working: 1, total: 2 })
  })

  it("recomputes additions, removals, space changes, and working transitions on each call", () => {
    const idle = agent("terminal-1", "space-1")
    const working = { ...idle, status: "working" }
    const done = { ...idle, status: "done" }
    const blocked = agent("edge/terminal-2", "space-1", "blocked")
    const snapshots = [
      { input: [], expected: [] },
      { input: [idle], expected: [["space-1", 0, 1, "idle"]] },
      { input: [idle, blocked], expected: [["space-1", 0, 2, "blocked"]] },
      { input: [working, blocked], expected: [["space-1", 1, 2, "working"]] },
      { input: [done, blocked], expected: [["space-1", 0, 2, "blocked"]] },
      { input: [done], expected: [["space-1", 0, 1, "done"]] },
      {
        input: [{ ...working, space: "edge/space-1" }],
        expected: [["edge/space-1", 1, 1, "working"]],
      },
      { input: [], expected: [] },
    ]
    const initial = groupAgents([idle])
    for (const { input, expected } of snapshots) {
      const actual = [...groupAgents(input)].map(([space, activity]) => [
        space,
        activity.working,
        activity.total,
        activity.status,
      ])
      expect(actual).toEqual(expected)
    }
    expect(initial.get("space-1")).toMatchObject({ working: 0, total: 1, status: "idle" })
  })

  it("uses program name, then app, then Agent in the tooltip", () => {
    const members = [
      agent("terminal-1", "space-1", "idle", { app: "ignored" }),
      agent("terminal-2", "space-1", "blocked", { program: { name: "" }, app: "Terminal" }),
      agent("terminal-3", "space-1", "done", { program: undefined }),
    ]
    expect(groupAgents(members).get("space-1").tooltip).toBe(
      "0/3 agents working\nClaude: idle\nTerminal: blocked\nAgent: done",
    )
  })
})
