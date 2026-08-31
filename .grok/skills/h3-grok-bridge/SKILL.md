---
name: h3-grok-bridge
description: Pull, inspect, edit, and send MiniMax H3 prompt workspaces with h3-grok. Use for H3 Grok Bridge projects, scene Markdown files, reference assets, or /h3-grok-bridge.
---

# H3 Grok Bridge

Use `h3-grok` for bridge transport. The `grok` command is the agent itself.

## Pull

- For a new workspace, require the ComfyUI server URL and project ID, then run:

  ```bash
  h3-grok pull <server> <project> [directory]
  ```

- For an existing workspace, read `server` and `project` from
  `.h3-grok-bridge.ini`, then pull into the current directory.
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

## Send

After completing scene edits, run:

```bash
h3-grok send .
```

For one requested scene, `h3-grok send . --scene <scene-id>` is also valid.
Report which scenes were staged and remind the user to click **Grok Pull** in
the connected ComfyUI Prompt Editor. Do not claim the live Plan changed before
that button is clicked.
