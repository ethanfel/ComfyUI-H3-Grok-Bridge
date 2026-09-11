---
name: h3-grok-bridge
description: Edit MiniMax H3 scene Markdown files from Codex or Grok using project and reference context, then sync finished edits to the connected ComfyUI editor with h3-grok. Use for H3 Grok Bridge workspaces containing .h3-grok-bridge.ini and scenes/.
---

# H3 Grok Bridge

Use this skill in the current Codex or Grok session. `h3-grok` is the shared
transport CLI; it does not need the Grok agent to pull or sync scene files.
In Codex, invoke `$h3-grok-bridge`; in Grok, invoke `/h3-grok-bridge`.

## Find the workspace

- Use the workspace folder named by the user, or the current folder when it
  contains `.h3-grok-bridge.ini`. Read that file for the saved server, project,
  scene IDs, and baseline; let the CLI maintain it.
- Run transport commands with the workspace as the working directory, or pass
  its path explicitly: `h3-grok sync /path/to/workspace --scene <scene-id>`.
- Use `h3-grok` from PATH. If it is unavailable and the bridge checkout is
  known, run its `h3-grok` script with Python instead.
- The ComfyUI connection is enabled by **Edit with Grok** on the bridge or
  Prompt Editor. This also works for Codex: the user can close the launch-command
  dialog and keep editing in the current Codex session. Keep that ComfyUI tab open.

## Open or refresh

- For a new workspace, use the ComfyUI server URL and project ID from the user's
  request or connection context. Ask only for missing values, then run:

  ```bash
  h3-grok pull <server> <project> [directory]
  ```

- In an existing workspace, `h3-grok pull` remembers its server and project.
- Keep existing local drafts before requesting a refresh. The pull command
  refuses conflicting overwrites; resolve them without editing the baseline file.
- `h3-grok edit <folder>` is a launcher for the human user's Grok terminal.
  Within an active Codex or Grok session, use `pull` and `sync` directly; do not
  launch a nested agent to do the editing.
- Never add `--force` unless the user explicitly accepts losing unsent local
  scene edits.

## Read and edit

1. Read `PROJECT.md`, `SHARED.md`, and `REFERENCES.md` before editing.
2. Inspect relevant images under `assets/`. Images from the H3 Project Asset
   Carousel and legacy reference nodes use their tag as the filename:
   `assets/hero.png` maps to `@hero`, and semantic tags are documented in
   `REFERENCES.md` as untimed `#tag` or timed `#tag[time]`.
3. Edit only the requested files under `scenes/`. A scene file contains prompt
   text only: do not add Markdown headings, metadata, or JSON. Preserve filenames
   and scene IDs. The other workspace documents describe context and settings;
   editing them does not change the live Plan.
4. Preserve valid reference tags unless the requested edit intentionally changes
   how a scene uses them. Treat `assets/` as read-only context.

## Finish an edit

After completing the requested scene edits, sync them. For a request scoped to
particular scenes, select their IDs so unrelated local drafts stay local:

```bash
h3-grok sync --scene <scene-id>
```

Repeat `--scene` for multiple scenes. When the user wants all changed scenes sent:

```bash
h3-grok sync
```

Sync applies changed scene prompts in the open, connected ComfyUI editor and
waits for its receipt. It refreshes the local baseline automatically, so another
edit can be synced immediately. If the user asks for a local draft or review
before sending, keep the edits local until they ask to apply them.

Report which scenes you edited and whether sync confirmed application. Sync
updates the open Plan; saving the ComfyUI workflow makes it persist across
sessions. It does not queue a render. On a timeout, keep local files and ask the
user to keep the connected ComfyUI tab open; rerunning the same sync
is safe. On a Plan conflict, explain which work remains local and reconcile the
changes with the user. Do not force an overwrite or cancel someone else's
pending edits to make the error disappear.

`h3-grok cancel` discards a pending remote change set while keeping local scene
files; use it when the user requests that recovery. `h3-grok send` retains the
older staged-only workflow for users who want to apply edits manually using
**Grok Pull** in ComfyUI.
