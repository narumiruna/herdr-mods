# Spaces Agent Status

Show agent activity in the Spaces sidebar without changing the shipped Spaces
controls or the separate Agents panel. Each space shows up to three overlapping
agent icons and a `+N` count for the rest. A working/total count and status ring
appear on the right. For example, `2/3` means two of three reported agents are
working. Hover the icons or the right-side summary to see the full agent list.
Spaces without reported agents keep their colored avatar and show no count.

![Spaces sidebar with agent icons, activity counts, and status rings](preview.png)

## Install with a coding agent

```text
Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/narumiruna/herdr-mods/tree/main/mods/spaces-agent-status
```

## Install in Herdr

No build or runtime npm packages are required. With Herdr stopped, copy or link
this directory to `~/.config/herdr-app/mods/spaces-agent-status/`. If you previously
installed or linked `agent-spaces`, replace that installation or link.

The repository's `layouts/narumi.json` already uses `spaces-agent-status`.
In a personal layout, set the Spaces block's `content.mod` to
`spaces-agent-status`. Keep the existing Agents block and keybindings. Reopen
Herdr after the change.

To revert to the shipped Spaces block, set its `content.mod` back to `spaces`
while Herdr is stopped, then reopen Herdr.

## Validation

From the repository root:

```sh
npm test --workspace herdr-spaces-agent-status
npm run check:mod --workspace herdr-spaces-agent-status
```

See the [recipe's acceptance checks](RECIPE.md#done-when) for native fixture and
preview checks. Live agent and platform interaction checks are still required
before sharing.
