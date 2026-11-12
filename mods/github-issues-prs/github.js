// GitHub CLI transport and read-only queries. No host calls at module scope.
export const LIMIT = 100

export function repositoryName(value) {
  let name = String(value ?? "").trim()
  name = name
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\/$/, "")
    .replace(/\.git$/, "")
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(name) ||
    /\/(?:\.|\.\.)$/.test(name)
  ) {
    throw new Error("Enter a GitHub repository as owner/repo or https://github.com/owner/repo.")
  }
  return name
}

export function repositoryFromRemote(remote) {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^\s]+)$/i.exec(
      remote.trim(),
    )
  if (!match) throw new Error("The origin remote is not on github.com.")
  return repositoryName(match[1])
}

const listFields = "number,title,url,state,author,updatedAt,labels"
const prFields = "isDraft,headRefName,baseRefName,reviewDecision"

export function listArgs(repo, kind, state, search = "") {
  return [
    kind,
    "list",
    "--repo",
    repositoryName(repo),
    "--state",
    state,
    "--limit",
    String(LIMIT),
    "--json",
    listFields + (kind === "pr" ? `,${prFields}` : ""),
    ...(search.trim() ? ["--search", search.trim()] : []),
  ]
}

export function detailArgs(repo, kind, number) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Invalid issue or PR number.")
  return [
    kind,
    "view",
    String(number),
    "--repo",
    repositoryName(repo),
    "--json",
    listFields +
      ",body" +
      (kind === "pr" ? `,${prFields},mergeable,additions,deletions,changedFiles` : ""),
  ]
}

export function stateLabel(item) {
  if (item.state === "MERGED") return "Merged"
  if (item.state === "CLOSED") return "Closed"
  return item.isDraft ? "Draft" : "Open"
}

export function age(date, now = Date.now()) {
  const time = Date.parse(date)
  if (!Number.isFinite(time)) return ""
  const minutes = Math.max(0, Math.floor((now - time) / 60000))
  return minutes < 1
    ? "now"
    : minutes < 60
      ? `${minutes}m`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / 1440)}d`
}

// CLI and host diagnostics can contain credentials. Apply this to git errors too.
export function safeDiagnostic(message) {
  return String(message)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "[redacted]")
    .replace(
      /\b(?:authorization|(?:github|gh)_token|(?:access[_ -]?)?token)\b[^\r\n]*/gi,
      "[redacted credentials]",
    )
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[redacted]@")
    .slice(0, 1600)
}

// Reject malformed CLI data before it reaches native rendering or URL dispatch.
export function checkedItem(value, number = null) {
  const valid =
    value &&
    !Array.isArray(value) &&
    Number.isSafeInteger(value.number) &&
    value.number > 0 &&
    (number === null || value.number === number) &&
    typeof value.title === "string" &&
    ["OPEN", "CLOSED", "MERGED"].includes(value.state) &&
    typeof value.url === "string" &&
    /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/[1-9]\d*$/i.test(
      value.url,
    ) &&
    value.url.endsWith(`/${value.number}`) &&
    (value.body == null || typeof value.body === "string") &&
    (value.updatedAt == null || typeof value.updatedAt === "string") &&
    (value.author == null || typeof value.author.login === "string") &&
    (value.labels == null ||
      (Array.isArray(value.labels) &&
        value.labels.every((label) => label && typeof label.name === "string"))) &&
    ["headRefName", "baseRefName", "reviewDecision"].every(
      (field) => value[field] == null || typeof value[field] === "string",
    )
  if (!valid) throw new Error("GitHub CLI returned invalid item data. Update gh and retry.")
  return value
}

export function checkedList(value) {
  if (!Array.isArray(value) || value.length > LIMIT)
    throw new Error("GitHub CLI returned an invalid list. Update gh and retry.")
  const numbers = new Set()
  for (const item of value) {
    checkedItem(item)
    if (numbers.has(item.number)) throw new Error("GitHub CLI returned duplicate items. Retry.")
    numbers.add(item.number)
  }
  return value
}

// A host deadline bounds child execution; this also bounds unsettled transport promises.
export async function withDeadline(timer, ms, start, message, cancellations = null) {
  let watchdog
  let cancel
  try {
    return await Promise.race([
      new Promise((_resolve, reject) => {
        cancel = () => reject(new Error("Request cancelled."))
        cancellations?.add(cancel)
        watchdog = timer.after(ms, () => reject(new Error(message)))
      }),
      Promise.resolve().then(start),
    ])
  } finally {
    cancellations?.delete(cancel)
    watchdog?.cancel()
  }
}

export function createGitHub(exec, platform, machine = null) {
  if (
    machine !== null &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in machine names.
    (typeof machine !== "string" || !machine.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(machine))
  ) {
    throw new Error(
      "The GitHub CLI machine must be null or a nonblank name without control characters.",
    )
  }
  const location = machine === null ? "this machine" : `machine ${JSON.stringify(machine)}`
  let runner
  let discovery = 0

  function requestError(message, transport = "gh") {
    const safe = safeDiagnostic(message)
    const login = transport === "WSL gh" ? "wsl.exe --exec gh auth login" : "gh auth login"
    return new Error(
      `${safe.slice(0, 1600)}\nGitHub CLI: ${transport} on ${location}.\nFor authentication, run: ${login} on ${location}.`,
    )
  }

  async function detect(execute) {
    let failure
    try {
      const result = await execute("gh", ["--version"], { on: machine, timeout: 10000 })
      if (result.code !== 0) throw new Error(result.stderr || "gh --version failed")
      return { command: "gh", prefix: [], transport: "gh" }
    } catch (error) {
      failure = String(error.message || error)
      if (machine === null && platform === "windows") {
        try {
          const result = await execute("wsl.exe", ["--exec", "gh", "--version"], {
            on: machine,
            timeout: 15000,
          })
          if (result.code === 0)
            return { command: "wsl.exe", prefix: ["--exec", "gh"], transport: "WSL gh" }
          failure += `\nWSL: ${result.stderr || result.stdout || "gh --version failed"}`
        } catch (error) {
          failure += `\nWSL: ${String(error.message || error)}`
        }
      }
      throw requestError(
        `GitHub CLI was not found or did not respond on ${location}. Install gh on ${location}.` +
          (machine === null && platform === "windows"
            ? " You can also use gh in your default WSL distribution."
            : "") +
          "\n" +
          failure,
      )
    }
  }

  return {
    get machine() {
      return machine
    },
    get transport() {
      return runner?.transport || "gh"
    },
    async read(args, execute = exec) {
      // Cache only a completed probe. A previous view's pending probe must not
      // block a new request, and a late old probe must not replace a newer one.
      let selected = runner
      if (!selected) {
        const generation = ++discovery
        selected = await detect(execute)
        if (generation === discovery) runner = selected
      }
      const { command, prefix, transport } = selected
      let result
      try {
        result = await execute(command, [...prefix, ...args], { on: machine, timeout: 45000 })
      } catch (error) {
        throw requestError(error.message || error, transport)
      }
      if (result.code !== 0) {
        throw requestError(
          (result.stderr || result.stdout || "GitHub request failed.").trim(),
          transport,
        )
      }
      try {
        return JSON.parse(result.stdout)
      } catch {
        throw requestError("GitHub CLI returned invalid JSON. Update gh and retry.", transport)
      }
    },
  }
}
