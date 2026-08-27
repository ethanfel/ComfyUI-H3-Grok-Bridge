# ComfyUI H3 Grok Prompt Bridge

An optional, standalone ComfyUI custom node that mirrors a live MiniMax H3
prompt project into an ordinary local folder for Grok—or any coding agent—to
edit.

It is designed for
[ComfyUI MiniMax H3 Contex Loop](https://github.com/ethanfel/ComfyUI-MiniMaxH3-Contex-Loop).
That node pack is not modified or vendored.

## What it does

- adds **MiniMax H3 Grok Prompt Bridge**, a no-op `H3_CHAIN_PLAN` pass-through;
- shows **Grok Send** and **Grok Pull** only in an H3 Scene Prompt Editor that
  is connected through that bridge node;
- exports every scene as a separate, header-free `scenes/*.md` prompt file;
- exports `SHARED.md`, a readable `PROJECT.md`, and `REFERENCES.md` containing
  native `@tag`, semantic `#tag[time]`, motion-role, subject, selector, source,
  and active-scene context;
- downloads file-backed picture references from the remote ComfyUI host into
  `assets/` and links them from `REFERENCES.md`;
- stages local edits instead of silently changing the workflow;
- rejects stale edits when either the ComfyUI Plan or a scene changed since
  the local pull.

Transport and server snapshots use JSON internally. The local authoring files
are plain Markdown; scene files contain only their prompt text.

## Install

Clone into the same `custom_nodes` directory as the H3 pack, then restart
ComfyUI:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/ethanfel/ComfyUI-H3-Grok-Bridge.git
```

The CLI has no third-party Python dependencies. On Linux/macOS, optionally put
it on your path:

```bash
ln -s "$PWD/ComfyUI-H3-Grok-Bridge/h3-grok" ~/.local/bin/h3-grok
```

You can always invoke it by its complete path instead.

## Workflow wiring

```text
H3 Chain Plan → H3 Grok Prompt Bridge → H3 Scene Prompt Editor → loop
```

Set the bridge `project_id` if you want a local name different from the Plan's
`run_name`. Blank uses `run_name`.

The buttons remain absent when the bridge is merely installed but not connected,
so ordinary H3 Prompt Editor workflows are unchanged.

## Round trip

1. Click **Grok Send** in the connected Prompt Editor. This publishes the
   current unsaved Plan and its reference semantics to the ComfyUI host.
2. On the machine where Grok works, pull it:

   ```bash
   h3-grok pull http://COMFYUI-HOST:8188 my_project ./my_project
   ```

   Connected image references are downloaded during this step. If this folder
   was pulled before image support was installed, click **Grok Send** again and
   repeat the command so the new media descriptors are published.

3. Ask Grok to read `PROJECT.md`, `SHARED.md`, and `REFERENCES.md`, then edit
   one or more files under `scenes/` directly. For the real Grok CLI:

   ```bash
   cd ./my_project
   grok
   ```

   `grok` remains xAI's CLI; this add-on deliberately uses the distinct
   `h3-grok` helper name.
4. Stage changed prompts:

   ```bash
   h3-grok send ./my_project
   # or one scene only
   h3-grok send ./my_project --scene intro
   ```

5. Click **Grok Pull** in ComfyUI. The editor verifies the base project
   revision, applies the changed scenes to the real Plan widget, acknowledges
   the change set, and republishes the new base.
6. Run `h3-grok pull ...` again when the local workspace needs the new base or
   newly added scenes.

`h3-grok pull` refuses to overwrite unsubmitted local edits. `--force` is
available for an intentional replacement.

## Remote authentication

The bridge uses the same HTTP origin and access controls as ComfyUI. Do not
expose an unauthenticated ComfyUI server directly to the public internet.

For a reverse proxy that accepts a bearer token:

```bash
export COMFYUI_API_TOKEN='...'
h3-grok pull https://comfy.example my_project
h3-grok send my_project
```

The token is never written into the workspace state or workflow JSON.

## Local folder

```text
my_project/
├── PROJECT.md
├── SHARED.md
├── REFERENCES.md
├── .h3-grok-bridge.ini
├── assets/
│   └── 001-hero-hero.png
└── scenes/
    ├── 001-intro.md
    ├── 002-hallway.md
    └── 003-outro.md
```

`.h3-grok-bridge.ini` contains only the server URL, project/revision ids,
scene-to-file mappings, and hashes needed for conflict checks. It contains no
prompt JSON and no credentials.

Picture references backed by ComfyUI `input`, `output`, or `temp` files are
copied automatically, up to 100 MiB per image. Video, motion, and audio sources
remain descriptive context only, avoiding unexpectedly large prompt-project
downloads.

## Scope

The first release intentionally edits scene prompts only. Shared prompt,
timing, seeds, steps, policies, and reference-node settings are exported as
context but are not imported from local files. This keeps an agent from
accidentally restructuring a render plan while rewriting prose.

License: GPL-3.0.
