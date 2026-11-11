# Personal Files integration

## Scope

The preparation tool reads an explicitly selected installed profile. It writes a
personal Files clone and a personal layout into a new, separate directory. It does
not call Herdr, install files, switch layouts, download packages, or change source
documents. It does not edit shipped Files or the active profile.

The default names are `files-markdown` and `markdown-reader`. The reader is a
separate mod named `markdown-reader`; its `mod.json` must specify `"place": "none"`.
The preparation tool does not copy the reader runtime.

## Prepare offline

Run from the `mods/markdown-reader/` directory with Node.js 26 or later:

```sh
node scripts/prepare-files.mjs \
  --profile "/absolute/herdr-profile" \
  --output "/absolute/new-prepared-output"
```

The output directory must not exist. Its parent must exist. Both paths must be
absolute and must not contain parent traversal (`..`). Do not put output inside
the selected profile or the active profile.
Do not select an ancestor of either profile as output. The active profile is
`HERDR_APP_HOME`, or `~/.config/herdr-app` if unset. Symbolic links in source paths,
output paths, or their parents are refused. Use canonical paths when a system
folder, such as `/tmp` on macOS, is a symbolic link.

Optional names use `--clone-name` and `--layout-name`. Names must start with a
lowercase ASCII letter and contain only lowercase letters, digits, or hyphens,
with at most 64 characters. Shipped layout names and names already installed in
the selected profile are refused. The clone cannot use `files` or
`markdown-reader`.

The tool accepts only the reviewed shipped `mods/files/main.js` and
`layouts/main.json` snapshots. It checks SHA-256 versions and each patch target's
unique occurrence before creating output. A source update produces an
`Unsupported source version` or `Unsupported Files source` error, with no partial
output. Review a new upstream version before updating the supported hashes. Do
not bypass these checks with broad text replacement.

Supported SHA-256 values:

- Files: `33a7f26f03b9b3579d30fc97498b9f3cbbdcb59b983c91ce6bea3cc2eabe273b`
- Main layout: `b4438dafcf1aa379b0d08b62a97af37b31bb63b9ff9e5537d1848a8f221bea7f`

The output contains:

```text
mods/files-markdown/main.js
mods/files-markdown/mod.json
mods/files-markdown/chevron-down.svg
mods/files-markdown/chevron-right.svg
mods/files-markdown/file.svg
mods/files-markdown/folder.svg
layouts/markdown-reader.json
preparation.json
```

Only the four required installed icons are copied. Installed declarations,
configuration, and unrelated assets are not copied. Installed Files source is
generated locally, not distributed in this repository. Keep preparation output
outside the repository. `preparation.json` records the source hashes and names.

## Click contract

A `.md` or `.markdown` file, with any letter case, opens a new reader tab:

```js
run("tab.new", {
  space: capturedSpaceId,
  name: basename,
  mod: "markdown-reader",
  props: { file: absoluteFilePath, on: machineOrNull, root: workspaceFolder },
})
```

The file-list row captures its context when it is built. Opening the reader does
not re-read the current focus. `file` uses the captured pane directory; `root`
uses the captured space's workspace folder, not the pane directory. The original
Editor preview remains unchanged for non-Markdown files. Directory clicks still
expand or collapse directories. The personal layout changes only `content.mod`
references to `files`; node IDs, stack selection, props, and unrelated references
remain unchanged.

Machine identity is mandatory: local is `null`; remote is the machine identifier.
The first reader version must reject every non-null `on` before any local file
read. It must not open a matching local path for a remote click.

The frontend cannot establish canonical filesystem containment. Before reading a
local file, the reader helper must canonicalize the selected file and workspace
root, resolve symbolic links, and require the canonical file to be inside the
canonical workspace directory. Relative resources require the same containment
check. A missing root, an outside path, or a symbolic-link escape is an error,
not a reason to use the current directory as a fallback. No root expansion or
remote-to-local fallback is allowed.

## Check and manually install

Preparation and unit tests do not prove native rendering or live integration.
Run the generated clone through an isolated native check before installation.
Use the separate prepared output as the app home, not the active profile:

```sh
HERDR_APP_HOME="/absolute/prepared-output" herdr-app check "/absolute/prepared-output/mods/files-markdown"
```

1. Stop Herdr before manual installation, copying files, or making links. Check
   that `files-markdown`, `markdown-reader`, and `layouts/markdown-reader.json`
   do not already exist in the destination profile. Do not overwrite them.
2. Copy or link the generated `mods/files-markdown` directory and
   `layouts/markdown-reader.json` into the destination profile. Copy or link the
   separately checked reader mod as `mods/markdown-reader`. Check that both mod
   manifests use `"place": "none"`. Do not replace `mods/files` or
   `layouts/main.json`.
3. Start Herdr. Activate the personal layout with:

   ```sh
   herdr-app do layout.switch '{"name":"markdown-reader"}'
   ```

4. Show the Files panel. Test a local Markdown file, a nested file with spaces or
   Unicode, and a non-Markdown file.
   - If a remote space is available, confirm that a remote Markdown click shows an
     unsupported-location error rather than local contents.

The shipped layout's runtime panel state is not copied. Open the Files panel if
it is initially hidden. Do not edit `layouts/.state/`.

## Recovery

Switch to the original layout:

```sh
herdr-app do layout.switch '{"name":"main"}'
```

Close reader tabs. Stop Herdr before removing only the personal clone, personal
layout, and reader links or copies. Keep shipped Files, shipped layouts, and
source Markdown unchanged. Personal clones do not receive upstream updates;
prepare into a different new output directory after a supported-source review.

## Test API

`integration.js` exports `markdownTab(path, context)`, `replaceOnce`,
`transformFilesSource`, `cloneLayout`, and name validation. These transforms do
not access the filesystem. `scripts/prepare-files.mjs` exports
`prepareFilesIntegration({ profile, output, cloneName?, layoutName? })`. It returns
source hashes, replacement count, output path, generated mod path (`filesMod`),
and layout path (`layout`). Importing the script does not execute its CLI.
