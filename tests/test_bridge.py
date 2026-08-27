import importlib.util
import pathlib
import sys
import tempfile
import types


ROOT = pathlib.Path(__file__).resolve().parents[1]
folder_paths = types.ModuleType("folder_paths")
folder_paths.get_output_directory = lambda: ""
sys.modules.setdefault("folder_paths", folder_paths)

server = types.ModuleType("server")


class PromptServer:
    instance = None


server.PromptServer = PromptServer
sys.modules.setdefault("server", server)

spec = importlib.util.spec_from_file_location("h3_grok_bridge", ROOT / "bridge.py")
bridge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)


def project(prompt="Opening."):
    return {
        "project_id": "nightly_test",
        "shared_prompt": "Keep the same performer.",
        "scenes": [
            {"id": "intro", "prompt": prompt, "metadata": {"length": 124}},
            {"id": "outro", "prompt": "Finish wide.", "metadata": {}},
        ],
        "references": [{
            "kind": "picture", "tag": "hero", "native_token": "@hero",
            "semantic_token": "#hero[0.00s]", "active_scenes": [1],
            "asset": {"filename": "hero.png", "subfolder": "cast", "type": "input"},
        }],
    }


def test_publish_stage_pull_ack_and_conflict():
    with tempfile.TemporaryDirectory() as directory:
        store = bridge.BridgeStore(directory)
        published = store.publish(project())
        assert published["scene_count"] == 2
        assert published["reference_count"] == 1
        snapshot = store.get("nightly_test")
        assert snapshot["format"] == bridge.PROJECT_FORMAT
        assert snapshot["scenes"][0]["prompt_hash"] == bridge.prompt_hash("Opening.")
        assert snapshot["references"][0]["asset"]["filename"] == "hero.png"

        staged = store.stage({
            "project_id": "nightly_test",
            "base_revision": snapshot["revision"],
            "changes": [{
                "scene_id": "intro",
                "base_prompt_hash": snapshot["scenes"][0]["prompt_hash"],
                "prompt": "A more precise opening.",
            }],
        })
        assert staged["changes"][0]["prompt"] == "A more precise opening."
        pulled = store.pull(project())
        assert pulled["pending"] and pulled["change_id"] == staged["change_id"]

        try:
            store.pull(project("Comfy changed."))
        except bridge.BridgeConflict as exc:
            assert "live Plan changed" in str(exc)
        else:
            raise AssertionError("stale local change was accepted")

        acknowledged = store.acknowledge("nightly_test", staged["change_id"])
        assert acknowledged["acknowledged"]
        assert store.pull(project())["pending"] is False


def test_paths_and_node_contract():
    with tempfile.TemporaryDirectory() as directory:
        store = bridge.BridgeStore(directory)
        for unsafe in ("../escape", "/absolute", "spaces are unsafe"):
            try:
                store.get(unsafe)
            except ValueError:
                pass
            else:
                raise AssertionError("unsafe project id was accepted")
    plan = {"shots": []}
    assert bridge.MiniMaxH3GrokBridge().passthrough(plan, "x") == (plan,)
    assert bridge.NODE_CLASS_MAPPINGS["MiniMaxH3GrokBridge"] is bridge.MiniMaxH3GrokBridge


if __name__ == "__main__":
    test_publish_stage_pull_ack_and_conflict()
    test_paths_and_node_contract()
    print("H3 Grok Bridge backend: revision-safe publish, stage, pull and ack pass")
