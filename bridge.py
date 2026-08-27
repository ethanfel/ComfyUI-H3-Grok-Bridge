"""Revision-safe ComfyUI API and pass-through node for Grok prompt editing."""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import uuid
from datetime import datetime, timezone
from typing import Any

import folder_paths

try:
    from aiohttp import web
    from server import PromptServer
except ImportError:  # Pure store tests do not need a running ComfyUI server.
    web = None
    PromptServer = None


PLAN_TYPE = "H3_CHAIN_PLAN"
PROJECT_FORMAT = "h3_grok_bridge_project_v1"
CHANGES_FORMAT = "h3_grok_bridge_changes_v1"
MAX_SCENES = 128
MAX_PROMPT_CHARS = 200_000
MAX_REFERENCES = 1024
MAX_PAYLOAD_CHARS = 4_000_000
PROJECT_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}\Z")
_LOCKS: dict[str, threading.RLock] = {}
_LOCKS_GUARD = threading.Lock()


class BridgeConflict(ValueError):
    pass


class BridgeNotFound(ValueError):
    pass


def _canonical(value: Any) -> str:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def prompt_hash(value: Any) -> str:
    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n")
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def project_id(value: Any) -> str:
    project = str(value or "").strip()
    if PROJECT_PATTERN.fullmatch(project) is None:
        raise ValueError(
            "project_id must be 1-96 filename-safe characters: letters, "
            "numbers, dot, underscore, or hyphen.")
    return project


def _text(value: Any, label: str) -> str:
    result = str(value or "").replace("\r\n", "\n").replace("\r", "\n")
    if len(result) > MAX_PROMPT_CHARS:
        raise ValueError("%s is too large." % label)
    return result


def _plain_json(value: Any, depth: int = 0) -> Any:
    if depth > 8:
        raise ValueError("Bridge metadata is nested too deeply.")
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, list):
        return [_plain_json(item, depth + 1) for item in value]
    if isinstance(value, dict):
        return {
            str(key): _plain_json(item, depth + 1)
            for key, item in value.items()
        }
    return str(value)


def normalize_project(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("Project payload must be an object.")
    if len(_canonical(payload)) > MAX_PAYLOAD_CHARS:
        raise ValueError("Project payload is too large.")
    project = project_id(payload.get("project_id"))
    raw_scenes = payload.get("scenes")
    if not isinstance(raw_scenes, list) or not raw_scenes:
        raise ValueError("Project needs at least one scene.")
    if len(raw_scenes) > MAX_SCENES:
        raise ValueError("Project supports at most %d scenes." % MAX_SCENES)
    scenes = []
    used_ids = set()
    for offset, raw in enumerate(raw_scenes):
        if not isinstance(raw, dict):
            raise ValueError("Scene %d must be an object." % (offset + 1))
        scene_id = str(raw.get("id") or "").strip()
        if not scene_id or len(scene_id) > 96 or scene_id in used_ids:
            raise ValueError("Scene ids must be non-empty, unique, and at most 96 characters.")
        used_ids.add(scene_id)
        prompt = _text(raw.get("prompt"), "Scene %s prompt" % scene_id)
        metadata = raw.get("metadata") or {}
        if not isinstance(metadata, dict):
            raise ValueError("Scene metadata must be an object.")
        scenes.append({
            "index": offset + 1,
            "id": scene_id,
            "prompt": prompt,
            "prompt_hash": prompt_hash(prompt),
            "metadata": _plain_json(metadata),
        })
    references = payload.get("references") or []
    if not isinstance(references, list) or len(references) > MAX_REFERENCES:
        raise ValueError(
            "references must be a list with at most %d entries." % MAX_REFERENCES)
    result = {
        "format": PROJECT_FORMAT,
        "project_id": project,
        "shared_prompt": _text(payload.get("shared_prompt"), "Shared prompt"),
        "scenes": scenes,
        "references": _plain_json(references),
    }
    result["revision"] = _digest(result)
    return result


def _atomic_json(path: str, value: Any) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = "%s.%s.tmp" % (path, uuid.uuid4().hex)
    try:
        with open(temporary, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _read_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


class BridgeStore:
    """Small disk store rooted strictly inside ComfyUI output."""

    def __init__(self, output_root: str):
        self.output_root = os.path.realpath(os.path.abspath(output_root))

    def _paths(self, value: Any) -> tuple[str, str, str]:
        project = project_id(value)
        directory = os.path.realpath(os.path.join(
            self.output_root, "h3_chains", project, "grok_bridge"))
        try:
            inside = os.path.commonpath((self.output_root, directory)) == self.output_root
        except ValueError:
            inside = False
        if not inside:
            raise ValueError("Project path escapes ComfyUI output.")
        return (
            directory,
            os.path.join(directory, "project.json"),
            os.path.join(directory, "pending.json"),
        )

    @staticmethod
    def _lock(project: str) -> threading.RLock:
        with _LOCKS_GUARD:
            return _LOCKS.setdefault(project, threading.RLock())

    def publish(self, payload: Any) -> dict[str, Any]:
        document = normalize_project(payload)
        directory, snapshot_path, pending_path = self._paths(document["project_id"])
        with self._lock(document["project_id"]):
            document["published_at"] = datetime.now(timezone.utc).isoformat()
            _atomic_json(snapshot_path, document)
            pending = os.path.isfile(pending_path)
        return {
            "ok": True,
            "project_id": document["project_id"],
            "revision": document["revision"],
            "scene_count": len(document["scenes"]),
            "reference_count": len(document["references"]),
            "pending": pending,
            "directory": directory,
        }

    def get(self, value: Any) -> dict[str, Any]:
        project = project_id(value)
        _directory, snapshot_path, pending_path = self._paths(project)
        with self._lock(project):
            if not os.path.isfile(snapshot_path):
                raise BridgeNotFound(
                    "No published project %s. Click Grok Send in ComfyUI first."
                    % project)
            document = _read_json(snapshot_path)
            document["pending"] = os.path.isfile(pending_path)
            return document

    def stage(self, payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ValueError("Changes payload must be an object.")
        project = project_id(payload.get("project_id"))
        _directory, snapshot_path, pending_path = self._paths(project)
        with self._lock(project):
            if not os.path.isfile(snapshot_path):
                raise BridgeNotFound("Publish the project from ComfyUI before sending edits.")
            snapshot = _read_json(snapshot_path)
            base = str(payload.get("base_revision") or "")
            if base != snapshot.get("revision"):
                raise BridgeConflict(
                    "ComfyUI changed after the local pull. Pull again before sending.")
            if os.path.isfile(pending_path):
                raise BridgeConflict(
                    "A change set is already waiting. Pull it in ComfyUI first.")
            raw_changes = payload.get("changes")
            if not isinstance(raw_changes, list) or not raw_changes:
                raise ValueError("Send needs at least one changed scene.")
            by_id = {scene["id"]: scene for scene in snapshot["scenes"]}
            changes = []
            seen = set()
            for raw in raw_changes:
                if not isinstance(raw, dict):
                    raise ValueError("Each change must be an object.")
                scene_id = str(raw.get("scene_id") or "").strip()
                scene = by_id.get(scene_id)
                if scene is None:
                    raise BridgeConflict("Scene %s no longer exists." % scene_id)
                if scene_id in seen:
                    raise ValueError("A scene appears twice in one change set.")
                seen.add(scene_id)
                if str(raw.get("base_prompt_hash") or "") != scene["prompt_hash"]:
                    raise BridgeConflict("Scene %s changed after the local pull." % scene_id)
                prompt = _text(raw.get("prompt"), "Scene %s prompt" % scene_id)
                if prompt_hash(prompt) == scene["prompt_hash"]:
                    continue
                changes.append({
                    "scene_id": scene_id,
                    "index": scene["index"],
                    "base_prompt_hash": scene["prompt_hash"],
                    "prompt": prompt,
                    "prompt_hash": prompt_hash(prompt),
                })
            if not changes:
                raise ValueError("No scene prompt changed since the last pull.")
            pending = {
                "format": CHANGES_FORMAT,
                "project_id": project,
                "change_id": uuid.uuid4().hex,
                "base_revision": base,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "changes": changes,
            }
            _atomic_json(pending_path, pending)
            return pending

    def pull(self, payload: Any) -> dict[str, Any]:
        current = normalize_project(payload)
        project = current["project_id"]
        _directory, _snapshot_path, pending_path = self._paths(project)
        with self._lock(project):
            if not os.path.isfile(pending_path):
                return {
                    "ok": True, "project_id": project, "pending": False,
                    "changes": [], "revision": current["revision"],
                }
            pending = _read_json(pending_path)
            if pending.get("base_revision") != current["revision"]:
                raise BridgeConflict(
                    "The live Plan changed after Grok pulled it. Publish and "
                    "pull a fresh local copy before importing.")
            return {"ok": True, "pending": True, **pending}

    def acknowledge(self, value: Any, change_id: Any) -> dict[str, Any]:
        project = project_id(value)
        _directory, _snapshot_path, pending_path = self._paths(project)
        with self._lock(project):
            if not os.path.isfile(pending_path):
                return {"ok": True, "project_id": project, "acknowledged": False}
            pending = _read_json(pending_path)
            if str(change_id or "") != str(pending.get("change_id") or ""):
                raise BridgeConflict("Pending change id no longer matches.")
            os.unlink(pending_path)
            return {"ok": True, "project_id": project, "acknowledged": True}


class MiniMaxH3GrokBridge:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "plan": (PLAN_TYPE, {
                    "tooltip": "Connect H3 Plan here and connect this output "
                               "to an H3 Scene Prompt Editor."}),
                "project_id": ("STRING", {
                    "default": "",
                    "tooltip": "Local bridge name; blank uses Plan run_name."}),
            }
        }

    RETURN_TYPES = (PLAN_TYPE,)
    RETURN_NAMES = ("plan",)
    FUNCTION = "passthrough"
    CATEGORY = "conditioning/minimax/contex_loop/authoring"
    DESCRIPTION = (
        "Opt-in Grok file bridge. The connected H3 Prompt Editor publishes "
        "plain-text scenes and imports explicitly staged edits; execution "
        "passes the Plan through unchanged.")

    def passthrough(self, plan, project_id=""):
        return (plan,)


NODE_CLASS_MAPPINGS = {"MiniMaxH3GrokBridge": MiniMaxH3GrokBridge}
NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3GrokBridge": "MiniMax H3 Grok Prompt Bridge",
}


def _store() -> BridgeStore:
    return BridgeStore(folder_paths.get_output_directory())


def _error(exc: Exception):
    status = 404 if isinstance(exc, BridgeNotFound) else (
        409 if isinstance(exc, BridgeConflict) else 400)
    return web.json_response({"error": str(exc)}, status=status)


async def _publish(request):
    try:
        return web.json_response(_store().publish(await request.json()))
    except (ValueError, OSError, TypeError, json.JSONDecodeError) as exc:
        return _error(exc)


async def _project(request):
    try:
        return web.json_response(_store().get(request.rel_url.query.get("project_id")))
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        return _error(exc)


async def _changes(request):
    try:
        return web.json_response(_store().stage(await request.json()), status=201)
    except (ValueError, OSError, TypeError, json.JSONDecodeError) as exc:
        return _error(exc)


async def _pull(request):
    try:
        return web.json_response(_store().pull(await request.json()))
    except (ValueError, OSError, TypeError, json.JSONDecodeError) as exc:
        return _error(exc)


async def _ack(request):
    try:
        body = await request.json()
        return web.json_response(_store().acknowledge(
            body.get("project_id"), body.get("change_id")))
    except (ValueError, OSError, TypeError, json.JSONDecodeError) as exc:
        return _error(exc)


if (PromptServer is not None and web is not None and
        getattr(PromptServer, "instance", None) is not None):
    PREFIX = "/minimax_h3_grok_bridge"
    PromptServer.instance.routes.get(PREFIX + "/project")(_project)
    PromptServer.instance.routes.post(PREFIX + "/publish")(_publish)
    PromptServer.instance.routes.post(PREFIX + "/changes")(_changes)
    PromptServer.instance.routes.post(PREFIX + "/pull")(_pull)
    PromptServer.instance.routes.post(PREFIX + "/ack")(_ack)

