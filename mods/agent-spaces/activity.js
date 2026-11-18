// Group the same live agents that Herdr exposes to the Agents list.
// Space IDs and terminal addresses already include their remote machine prefix.
export function groupAgents(agents) {
  const groups = new Map()
  const seen = new Set()
  for (const agent of agents) {
    if (seen.has(agent.address)) continue
    seen.add(agent.address)
    if (!groups.has(agent.space)) groups.set(agent.space, [])
    groups.get(agent.space).push(agent)
  }
  return new Map(
    [...groups].map(([space, members]) => {
      const working = members.filter((a) => a.status === "working").length
      const status = working
        ? "working"
        : members.some((a) => a.status === "blocked")
          ? "blocked"
          : members.some((a) => a.status === "done")
            ? "done"
            : "idle"
      return [
        space,
        {
          members,
          working,
          total: members.length,
          status,
          tooltip: [
            `${working}/${members.length} agents working`,
            ...members.map((a) => `${a.program?.name || a.app || "Agent"}: ${a.status}`),
          ].join("\n"),
        },
      ]
    }),
  )
}
