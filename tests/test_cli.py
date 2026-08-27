import importlib.machinery
import pathlib
import tempfile


ROOT = pathlib.Path(__file__).resolve().parents[1]
loader = importlib.machinery.SourceFileLoader("h3_grok_cli", str(ROOT / "h3-grok"))
cli = loader.load_module()


def project():
    return {
        "project_id": "film",
        "revision": "a" * 64,
        "shared_prompt": "Shared identity.",
        "scenes": [{
            "index": 1, "id": "opening", "prompt": "Open wide.",
            "prompt_hash": cli.text_hash("Open wide."),
            "metadata": {"length": 124},
        }],
        "references": [{
            "kind": "picture", "native_token": "@hero",
            "semantic_token": "#hero[0.00s]", "active_scenes": [1],
            "available_scenes": [1], "selector": "prompt tag",
            "asset": {
                "filename": "hero.png", "subfolder": "cast", "type": "input",
            },
            "semantics": {"semantic_anchor_size": "512"},
        }],
    }


def test_workspace_state_and_markdown():
    data = project()
    with tempfile.TemporaryDirectory() as raw:
        directory = pathlib.Path(raw)
        scene = directory / "scenes/001-opening.md"
        cli.atomic_text(scene, "Open wide.")
        cli.save_state(directory, "http://comfy:8188", data)
        config, scenes = cli.load_state(directory)
        assert config["bridge"]["project"] == "film"
        assert scenes["opening"]["path"] == "scenes/001-opening.md"
        cli.guard_local_edits(directory, scenes, data, False)
        scene.write_text("Changed locally.", encoding="utf-8")
        try:
            cli.guard_local_edits(directory, scenes, data, False)
        except cli.CliError as exc:
            assert "would be overwritten" in str(exc)
        else:
            raise AssertionError("dirty local scene was not protected")
    assert "`scenes/001-opening.md`" in cli.project_markdown(data)
    with tempfile.TemporaryDirectory() as raw:
        directory = pathlib.Path(raw)
        original_download = cli.api_download
        calls = []
        try:
            cli.api_download = lambda server, asset, token="": (
                calls.append((server, asset, token)) or b"fake-png"
            )
            assets = cli.download_picture_assets(
                directory, data, "http://comfy:8188", "secret")
        finally:
            cli.api_download = original_download
        assert calls[0][1]["filename"] == "hero.png"
        assert (directory / assets[0]).read_bytes() == b"fake-png"
        references = cli.references_markdown(data, assets)
        assert "#hero[0.00s]" in references
        assert "Semantic Anchor Size: 512" in references
        assert "](assets/001-hero-hero.png)" in references


if __name__ == "__main__":
    test_workspace_state_and_markdown()
    print("H3 Grok Bridge CLI: plain workspace state, context and overwrite guard pass")
