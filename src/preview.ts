export const GALLERY_URL = "https://herdr.dev/gallery/?type=mods"

export type Source = "all" | "github" | "development"

export interface PreviewMod {
  id: string
  name: string
  description: string
  repository: string
  version: string
  source: Exclude<Source, "all">
  icon: string
}

export const PREVIEW_MODS: readonly PreviewMod[] = [
  {
    id: "focus-mode",
    name: "Focus Mode",
    description: "A quieter workspace. Keep the terminal, hide the distractions.",
    repository: "example/focus-mode",
    version: "0.4.2",
    source: "github",
    icon: "focus",
  },
  {
    id: "workspace-notes",
    name: "Workspace Notes",
    description: "Keep a little context beside every project.",
    repository: "example/workspace-notes",
    version: "1.2.0",
    source: "github",
    icon: "notes",
  },
  {
    id: "terminal-tools",
    name: "Terminal Tools",
    description: "Small shortcuts for the things you do every day.",
    repository: "example/terminal-tools",
    version: "0.8.1",
    source: "github",
    icon: "terminal",
  },
  {
    id: "mod-manager",
    name: "Mod Manager",
    description: "A home for your Herdr extensions. This is the UI preview.",
    repository: "Local development checkout",
    version: "0.0.0",
    source: "development",
    icon: "package",
  },
]

export function filterMods(query: string, source: Source): readonly PreviewMod[] {
  const term = query.trim().toLowerCase()
  return PREVIEW_MODS.filter(
    (mod) =>
      (source === "all" || mod.source === source) &&
      `${mod.name} ${mod.description} ${mod.repository}`.toLowerCase().includes(term),
  )
}
