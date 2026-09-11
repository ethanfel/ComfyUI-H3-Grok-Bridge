---
name: h3-grok-bridge
description: Edit MiniMax H3 scene Markdown files using project and reference context, then sync finished edits to the connected ComfyUI editor with h3-grok. Use for Grok Bridge workspaces or /h3-grok-bridge.
---

# H3 Grok Bridge

Use `h3-grok` for bridge transport. The `grok` command is the agent itself.

## Open or refresh

- For a new workspace, require the ComfyUI server URL and project ID, then run:

  ```bash
  h3-grok pull <server> <project> [directory]
  ```

- In an existing workspace, `h3-grok pull` remembers its server and project.
- `h3-grok edit <folder>` opens an interactive Grok session for the user. Do not
  launch another Grok session from inside an existing editing session.
- Never add `--force` unless the user explicitly accepts losing unsent local
  scene edits.

## Read and edit

1. Read `PROJECT.md`, `SHARED.md`, and `REFERENCES.md` before editing.
2. Inspect relevant images under `assets/`. Images from the H3 Project Asset
   Carousel and legacy reference nodes use their tag as the filename:
   `assets/hero.png` maps to `@hero`, and semantic tags are documented in
   `REFERENCES.md` as untimed `#tag` or timed `#tag[time]`.
3. Edit only the requested files under `scenes/`. A scene file contains prompt
   text only: do not add Markdown headings, metadata, or JSON.
4. Preserve valid reference tags unless the requested edit intentionally changes
   how a scene uses them. Treat `assets/` as read-only context.

## Finish an edit

After completing scene edits, run:

```bash
h3-grok sync
```

Sync applies changed scene prompts in the open, connected ComfyUI editor and
waits for its receipt. It refreshes the local baseline automatically, so another
edit can be synced immediately. Use `--scene <scene-id>` when the user wants
only one scene sent. If the user asks for a local draft or review before sending,
keep the edits local until they ask to apply them.

Report application only when sync confirms it. On a timeout, keep local files
and ask the user to keep the connected ComfyUI tab open; rerunning the same sync
is safe. On a Plan conflict, explain which work remains local and reconcile the
changes with the user. Do not force an overwrite or cancel someone else's
pending edits to make the error disappear.

`h3-grok cancel` discards a pending remote change set while keeping local scene
files; use it when the user requests that recovery. `h3-grok send` retains the
older staged-only workflow for users who want to apply edits manually using
**Grok Pull** in ComfyUI.
