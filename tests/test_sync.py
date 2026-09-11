"""Exercise repeated CLI edits through the real store with a simulated open editor."""

import contextlib
import copy
import io
import pathlib
import runpy
import tempfile
import unittest
import urllib.parse
from unittest.mock import patch


ROOT = pathlib.Path(__file__).resolve().parents[1]
backend = runpy.run_path(str(ROOT / "tests/test_bridge.py"))
client = runpy.run_path(str(ROOT / "tests/test_cli.py"))
bridge, cli = backend["bridge"], client["cli"]


def project(prompt="Original"):
    return {
        "project_id": "film", "shared_prompt": "Keep the cast", "editor_id": "editor-1",
        "scenes": [{"id": "opening", "prompt": prompt, "metadata": {"length": 124}},
                   {"id": "outro", "prompt": "Finish", "metadata": {"seed": "9007199254740993"}}],
        "references": [],
    }


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.directory = self.root / "workspace"
        self.store = bridge.BridgeStore(str(self.root / "server"))
        self.live = project()
        self.store.publish(self.live)
        self.requests = []
        self.auto_receive = True
        self.after_apply = lambda: None
        self.addCleanup(patch.stopall)
        patch.object(cli, "api_request", self.request).start()
        with contextlib.redirect_stdout(io.StringIO()):
            cli.pull_command(cli.parser().parse_args([
                "pull", "http://comfy:8188", "film", str(self.directory),
            ]))
        self.scene = self.directory / "scenes/001-opening.md"

    def receive(self):
        pending = self.store.pull(self.live)
        if pending.get("pending"):
            changes = {item["scene_id"]: item["prompt"] for item in pending["changes"]}
            for scene in self.live["scenes"]:
                scene["prompt"] = changes.get(scene["id"], scene["prompt"])
            result = self.store.acknowledge("film", pending["change_id"], self.live)
            self.after_apply()
            return result

    def request(self, server, path, token="", payload=None):
        self.requests.append((path, copy.deepcopy(payload)))
        url = urllib.parse.urlsplit(path)
        query = urllib.parse.parse_qs(url.query)
        if url.path == "/project":
            return self.store.get(query["project_id"][0])
        if url.path == "/changes":
            return self.store.stage(payload)
        if url.path == "/status":
            status = self.store.status(query["project_id"][0], query.get("change_id", [""])[0])
            if self.auto_receive and status.get("pending") and status.get("auto_apply"):
                try:
                    self.receive()
                except bridge.BridgeConflict as exc:
                    self.store.failed("film", status["change_id"], str(exc))
            return self.store.status(query["project_id"][0], query.get("change_id", [""])[0])
        if url.path == "/cancel":
            return self.store.cancel(payload["project_id"])
        raise AssertionError(path)

    def sync(self, *extra):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            cli.sync_command(cli.parser().parse_args(["sync", str(self.directory), *extra]))
        return output.getvalue()

    def test_two_edits_without_an_extra_pull(self):
        for prompt in ("First Grok edit", "Second Grok edit"):
            self.scene.write_text(prompt)
            self.assertIn("Applied 1 scene edit", self.sync())
            self.assertEqual(self.live["scenes"][0]["prompt"], prompt)
            config, scenes = cli.load_state(self.directory)
            self.assertEqual(scenes["opening"]["hash"], cli.text_hash(prompt))
            self.assertEqual(config["bridge"]["revision"], self.store.get("film")["revision"])
        self.assertIn("No changed", self.sync())
        self.assertEqual(self.live["scenes"][1]["metadata"]["seed"], "9007199254740993")
        self.assertEqual(len([path for path, _ in self.requests if path.startswith("/project?")]), 1)

    def test_sync_retries_a_lost_response(self):
        self.scene.write_text("Keep this edit")
        normal_request = self.request
        def lose_reply(server, path, token="", payload=None):
            result = normal_request(server, path, token, payload)
            if path == "/changes":
                self.receive()
                raise cli.CliError("Response lost")
            return result
        with patch.object(cli, "api_request", lose_reply):
            with self.assertRaises(cli.CliError):
                self.sync()
        self.assertIn("Applied 1 scene edit", self.sync())
        self.assertFalse(self.store.status("film")["pending"])

    def test_local_edits_while_waiting_are_preserved(self):
        self.scene.write_text("Send this version")
        self.after_apply = lambda: self.scene.write_text("New draft while waiting")
        self.sync()
        _, scenes = cli.load_state(self.directory)
        self.assertEqual(scenes["opening"]["hash"], cli.text_hash("Send this version"))
        self.assertEqual(self.scene.read_text(), "New draft while waiting")

    def test_conflict_is_reported_and_pending_can_be_cancelled(self):
        self.scene.write_text("Grok draft")
        self.live["scenes"][0]["prompt"] = "User changed the Plan"
        with self.assertRaisesRegex(cli.CliError, "live Plan changed"):
            self.sync()
        self.assertEqual(self.live["scenes"][0]["prompt"], "User changed the Plan")
        self.assertEqual(self.scene.read_text(), "Grok draft")
        with contextlib.redirect_stdout(io.StringIO()):
            cli.cancel_command(cli.parser().parse_args(["cancel", str(self.directory)]))
        self.assertFalse(self.store.status("film")["pending"])
        self.assertEqual(self.scene.read_text(), "Grok draft")

    def test_timeout_retains_pending_and_retries_same_change(self):
        self.auto_receive = False
        self.scene.write_text("Waiting edit")
        with self.assertRaisesRegex(cli.CliError, "Edits are waiting"):
            self.sync("--timeout", "0")
        original_id = self.store.status("film")["change_id"]
        with self.assertRaisesRegex(cli.CliError, "Edits are waiting"):
            self.sync("--timeout", "0")
        self.assertEqual(self.store.status("film")["change_id"], original_id)
        self.auto_receive = True
        self.assertIn("Applied", self.sync())

    def test_ack_retry_accepts_applied_prompts_but_rejects_metadata_changes(self):
        snapshot = self.store.get("film")
        pending = self.store.stage({"project_id":"film", "base_revision":snapshot["revision"],
            "changes":[{"scene_id":"opening", "base_prompt_hash":snapshot["scenes"][0]["prompt_hash"],
                        "prompt":"Applied"}]})
        changed = project("Applied")
        self.assertTrue(self.store.pull(changed)["already_applied"])
        changed["scenes"][0]["metadata"]["length"] = 999
        with self.assertRaises(bridge.BridgeConflict):
            self.store.acknowledge("film", pending["change_id"], changed)
        self.assertTrue(self.store.status("film")["pending"])
        result = self.store.acknowledge("film", pending["change_id"], project("Applied"))
        self.assertTrue(result["acknowledged"])
        self.assertTrue(self.store.acknowledge("film", pending["change_id"], project("Applied"))["acknowledged"])

    def test_manual_send_stays_manual(self):
        self.scene.write_text("Manual edit")
        with contextlib.redirect_stdout(io.StringIO()):
            cli.send_command(cli.parser().parse_args(["send", str(self.directory)]))
        self.assertFalse(self.store.status("film")["auto_apply"])
        self.assertEqual(self.live["scenes"][0]["prompt"], "Original")

    def test_first_pull_protects_existing_scene_and_send_rejects_escape(self):
        untracked = self.root / "untracked"
        scene = untracked / "scenes/001-opening.md"
        scene.parent.mkdir(parents=True)
        scene.write_text("Untracked draft")
        with self.assertRaisesRegex(cli.CliError, "would be overwritten"):
            cli.pull_command(cli.parser().parse_args(["pull", "http://comfy:8188", "film", str(untracked)]))
        self.assertEqual(scene.read_text(), "Untracked draft")
        outside = self.root / "outside.txt"
        outside.write_text("External sentinel")
        state = self.directory / cli.STATE_FILE
        state.write_text(state.read_text().replace("scenes/001-opening.md", "../outside.txt"))
        with self.assertRaisesRegex(cli.CliError, "unsafe path"):
            self.sync()

    def test_edit_opens_grok_in_workspace_and_keeps_existing_drafts(self):
        self.scene.write_text("My unsent draft")
        with patch.object(cli.shutil, "which", return_value="/usr/bin/grok"), \
                patch.object(cli.subprocess, "run") as launch, \
                contextlib.redirect_stdout(io.StringIO()):
            launch.return_value.returncode = 0
            cli.edit_command(cli.parser().parse_args(["edit", str(self.directory), "--prompt", "Tighten scene 1"]))
        args, kwargs = launch.call_args
        self.assertEqual(args[0][0], "/usr/bin/grok")
        self.assertIn("h3-grok sync", args[0][1])
        self.assertTrue(args[0][1].endswith("Tighten scene 1"))
        self.assertEqual(kwargs["cwd"], self.directory)
        self.assertEqual(self.scene.read_text(), "My unsent draft")
        self.assertTrue((self.directory / ".grok/skills/h3-grok-bridge/SKILL.md").is_file())

    def test_short_pull_remembers_connection(self):
        self.live = project("New live version")
        self.store.publish(self.live)
        with contextlib.redirect_stdout(io.StringIO()):
            cli.pull_command(cli.parser().parse_args(["pull", str(self.directory)]))
        self.assertEqual(self.scene.read_text(), "New live version")


if __name__ == "__main__":
    unittest.main()
