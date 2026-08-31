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
            "kind": "picture", "tag": "hero", "native_token": "@hero",
            "semantic_token": "#hero", "active_scenes": [1],
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
        old_asset = directory / "assets/001-hero-hero.png"
        cli.atomic_bytes(old_asset, b"old-copy")
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
        assert not old_asset.exists()
        references = cli.references_markdown(data, assets)
        assert "- Semantic token: #hero\n" in references
        assert "Semantic Anchor Size: 512" in references
        assert "](assets/hero.png)" in references


def test_project_carousel_image_download():
    asset = {
        "provider": "h3_project_assets",
        "project": "episode",
        "asset_id": "asset-123",
        "filename": "original hero.webp",
    }
    urls = []

    class Response:
        headers = {"Content-Length": "4"}

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        @staticmethod
        def read(_limit):
            return b"webp"

    original_urlopen = cli.urllib.request.urlopen
    try:
        cli.urllib.request.urlopen = lambda request, timeout=0: (
            urls.append((request.full_url, timeout)) or Response()
        )
        assert cli.api_download("http://comfy:8188", asset) == b"webp"
    finally:
        cli.urllib.request.urlopen = original_urlopen
    assert urls == [(
        "http://comfy:8188/minimax_h3_context_loop/project-assets/media?"
        "project=episode&asset=asset-123&variant=original",
        60,
    )]
    data = project()
    data["references"][0]["asset"] = asset
    original_download = cli.api_download
    try:
        cli.api_download = lambda *_args: b"carousel-image"
        with tempfile.TemporaryDirectory() as raw:
            paths = cli.download_picture_assets(
                pathlib.Path(raw), data, "http://comfy:8188")
            assert paths == {0: "assets/hero.webp"}
            assert (pathlib.Path(raw) / paths[0]).read_bytes() == b"carousel-image"
    finally:
        cli.api_download = original_download


if __name__ == "__main__":
    test_workspace_state_and_markdown()
    test_project_carousel_image_download()
    print("H3 Grok Bridge CLI: plain workspace state, context and overwrite guard pass")
