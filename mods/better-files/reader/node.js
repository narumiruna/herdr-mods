// Resolve Node only when the Windows app cannot find it in its own PATH.
const windowsProbe = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
$fnmDir = [Environment]::GetEnvironmentVariable('FNM_DIR', 'User')
if ($fnmDir) { $env:FNM_DIR = $fnmDir }
$probe = 'JSON.stringify({path:process.execPath,major:parseInt(process.versions.node)})'
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if ($node) {
  $candidate = & $node.Source -p $probe
  if ($LASTEXITCODE -eq 0 -and ($candidate | ConvertFrom-Json).major -ge 26) {
    $candidate
    exit 0
  }
}
$fnm = Get-Command fnm.exe -ErrorAction SilentlyContinue
if ($fnm) {
  & $fnm.Source exec --using=26 -- node -p $probe
  exit $LASTEXITCODE
}
throw 'Node.js 26 or later is not available to Herdr. Install it or make it available through fnm.'
`

export function createNodeRunner(exec, platform) {
  let program = "node"
  let resolving = null

  async function resolveWindowsNode() {
    const result = await exec(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", windowsProbe],
      { timeout: 10000 },
    )
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || "Could not find Node.js 26 for Herdr")
    }
    const found = JSON.parse(result.stdout.trim())
    if (
      typeof found.path !== "string" ||
      !/^[a-z]:[\\/]/i.test(found.path) ||
      !/[\\/]node\.exe$/i.test(found.path) ||
      !Number.isInteger(found.major) ||
      found.major < 26
    ) {
      throw new Error("Markdown Reader requires an absolute Node.js 26 or later executable")
    }
    return found.path
  }

  return async (args, options) => {
    if (resolving) await resolving
    const attempted = program
    try {
      return await exec(attempted, args, options)
    } catch (error) {
      if (
        platform !== "windows" ||
        attempted !== "node" ||
        !/cannot (?:run|start) node: program not found/i.test(String(error))
      ) {
        throw error
      }
      if (program === "node") {
        resolving ??= resolveWindowsNode().then((path) => {
          program = path
        })
        try {
          await resolving
        } finally {
          resolving = null
        }
      }
      return exec(program, args, options)
    }
  }
}
