# H3 Grok Bridge

<p align="center">
  <img src="docs/node.svg" width="420" alt="H3 Grok Bridge node">
</p>

Edit MiniMax H3 scene prompts with terminal Grok as ordinary Markdown files.
Grok sends finished edits straight back to the open ComfyUI editor with
`h3-grok sync`. Only scene text comes back; Plan structure and generation
settings stay under your control.

## How it works

```text
H3 Plan → H3 Grok Bridge → H3 Scene Prompt Editor
                                  │
                       Edit with Grok
                                  │
                    local Markdown files ↔ Grok
                                  │
                             h3-grok sync
```

**Edit with Grok** is available on both the bridge node and the connected
**H3 Scene Prompt Editor**. The editor also keeps **Grok Pull** for manual imports.

## Install

```bash
cd /path/to/ComfyUI/custom_nodes
git clone https://github.com/ethanfel/ComfyUI-H3-Grok-Bridge.git
ln -s "$PWD/ComfyUI-H3-Grok-Bridge/h3-grok" ~/.local/bin/h3-grok
```

Restart ComfyUI. Add **H3 Grok Bridge** between the Plan and Scene Prompt
Editor. Leave **Project name** blank to use the Plan run name.

Install the `grok` terminal command on the machine where you edit prompts.
`h3-grok edit` supplies the editing instructions and adds the bundled Grok skill
to new workspaces automatically. An existing workspace skill is preserved.

## Use it

1. Click **Edit with Grok** on the bridge or Prompt Editor.
2. Copy its launch command and run it in a terminal:

   ```bash
   h3-grok edit http://127.0.0.1:8188 my_project
   ```

   This downloads the project and its reference images, opens Grok in the right
   folder, and tells it how to edit and sync the scenes.

3. Ask Grok for a change, such as “Tighten scene 2 and send it back.” Grok edits
   the scene files and runs:

   ```bash
   h3-grok sync
   ```

   The connected editor applies the edits. Sync confirms receipt and refreshes
   the local baseline, ready for your next request. You can also run this
   command yourself from the workspace or pass its folder as an argument.

Keep the connected ComfyUI tab open. Further edits in the same session need only
`h3-grok sync`; the editor also publishes subsequent live Plan changes while
connected. Changes are sent when sync runs, so Grok can save intermediate local
drafts without applying them. Sync updates the open Plan; save your ComfyUI
workflow to keep it across sessions. Sync does not start a render.

To reopen an existing workspace:

```bash
h3-grok edit my_project
```

It remembers the server and project. Existing local drafts are opened without
being overwritten. After refreshing or reopening the ComfyUI tab, click
**Edit with Grok** once to reconnect it; you can close the command dialog if
Grok is already running.

For a specific request at launch:

```bash
h3-grok edit my_project --prompt "Tighten scene 2 and sync it back."
```

## Use with Codex

The same skill and `h3-grok` transport work with Codex. Install the shared guide
in [Codex's user skills directory](https://learn.chatgpt.com/docs/customization/overview#skills):

```bash
mkdir -p ~/.agents/skills/h3-grok-bridge
cp ComfyUI-H3-Grok-Bridge/.grok/skills/h3-grok-bridge/SKILL.md \
  ~/.agents/skills/h3-grok-bridge/SKILL.md
```

Use the path to your checkout in the copy command. Keep `h3-grok` available on
PATH on the machine where Codex runs.

Click **Edit with Grok** in ComfyUI to connect the editor, then close its command
dialog. In your Codex session, ask:

```text
Use $h3-grok-bridge to tighten scene 2 in /path/to/my_project and sync it back.
```

Codex reads the context, edits the requested scene files, and runs
`h3-grok sync --scene <scene-id>` directly. It does not need to launch Grok.
For a new workspace, give Codex the ComfyUI URL and project ID so it can run
`h3-grok pull <server> <project> [directory]` first. An existing workspace already
stores those connection details. Keep the connected ComfyUI tab open.

## What Grok sees

```text
my_project/
├── PROJECT.md          scene list and settings
├── SHARED.md           shared prompt context
├── REFERENCES.md       @tags, #tags, roles and usage
├── assets/             reference images named by tag
│   ├── hero.png
│   └── location.webp
└── scenes/
    ├── 001-intro.md
    ├── 002-hallway.md
    └── 003-outro.md
```

Each scene file contains prompt text only—no JSON and no Markdown header.
Carousel images use their tag as the filename: `@hero` becomes
`assets/hero.png`. Video and audio references are described but not downloaded.

## Safety

- Pull refuses to overwrite unsent local scene edits.
- A first pull also protects existing scene files in the destination folder.
- Pulling again updates imported assets atomically.
- Only scene prompts can be sent back.
- Timing, seeds, policies, assets, and Plan structure remain unchanged.
- Concurrent Plan edits cause a conflict; they are not silently replaced.
- Repeating sync after a timeout or lost reply does not apply an edit twice.
- `--force` is available only for an intentional local replacement.

## Quick fixes

| Problem | Fix |
|---|---|
| Editor buttons are missing | Use **Edit with Grok** on the bridge node. If neither appears, refresh the UI after installing the update. |
| Project not found | Click **Edit with Grok** first and use the command it provides. |
| Sync says edits are waiting | Keep the connected editor open, then rerun `h3-grok sync` or click **Grok Pull**. |
| The live Plan changed | Keep your local drafts. Reconcile the conflicting changes before retrying; `h3-grok cancel` clears a pending remote edit when you choose to discard it. |
| New image is missing locally | Run `h3-grok pull` in the workspace after the connected editor publishes the change. |
| Pull protects a local file | Sync the edit first, or use `--force` only if you intend to discard it. |

<details>
<summary>Manual staging and refresh commands</summary>

`h3-grok pull` refreshes an existing workspace using its saved connection. For a
new workspace, use `h3-grok pull <server> <project> [directory]`.

`h3-grok send` retains the staged-only workflow: it uploads edits but waits for
**Grok Pull** in ComfyUI. Use it when you want a separate manual apply step.
`h3-grok sync --scene <scene-id>` sends only the selected scene.

`h3-grok cancel` discards the pending remote change set while preserving local
scene files and the live Plan. It does not resolve differences between them;
keep your draft and reconcile it before pulling fresh context. Run
`h3-grok --help` for all commands.

</details>

<details>
<summary>Remote ComfyUI and authentication</summary>

Use the reachable ComfyUI URL instead of `127.0.0.1`:

```bash
export COMFYUI_API_TOKEN='...'
h3-grok edit https://comfy.example my_project
h3-grok sync my_project
```

The token is never stored in the project folder or workflow. Do not expose an
unauthenticated ComfyUI server directly to the internet.

</details>

Requires [ComfyUI MiniMax H3 Contex Loop](https://github.com/ethanfel/ComfyUI-MiniMaxH3-Contex-Loop).
License: GPL-3.0.
