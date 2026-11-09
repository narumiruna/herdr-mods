import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const appHome = process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app")
for (const name of ["gpui-kit.d.ts", "herdr.d.ts"]) {
  let source
  try {
    source = await readFile(join(appHome, name), "utf8")
  } catch {
    throw new Error(`Cannot read ${name} from ${appHome}. Start Herdr App before building.`)
  }
  const destination = new URL(`../${name}`, import.meta.url)
  const current = await readFile(destination, "utf8").catch(() => null)
  if (current !== source) await writeFile(destination, source)
}
