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
            previous = _read_json(snapshot_path) if os.path.isfile(snapshot_path) else {}
            if previous.get("last_sync"):
                document["last_sync"] = previous["last_sync"]
            document["editor_id"] = str(payload.get("editor_id") or "")[:200]
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
        if len(_canonical(payload)) > MAX_PAYLOAD_CHARS:
            raise ValueError("Changes payload is too large.")
        project = project_id(payload.get("project_id"))
        _directory, snapshot_path, pending_path = self._paths(project)
        with self._lock(project):
            if not os.path.isfile(snapshot_path):
                raise BridgeNotFound("Publish the project from ComfyUI before sending edits.")
            snapshot = _read_json(snapshot_path)
            base = str(payload.get("base_revision") or "")
            request_hash = _digest({
                "base_revision": base, "changes": payload.get("changes"),
            })
            receipt = snapshot.get("last_sync") or {}
            if receipt.get("request_hash") == request_hash:
                return {"applied": True, "pending": False, **receipt}
            if os.path.isfile(pending_path):
                pending = _read_json(pending_path)
                if pending.get("change_id") == receipt.get("change_id"):
                    os.unlink(pending_path)
                elif pending.get("request_hash") == request_hash:
                    if payload.get("auto_apply"):
                        pending["auto_apply"] = True
                    pending.pop("error", None)
                    _atomic_json(pending_path, pending)
                    return pending
                else:
                    raise BridgeConflict(
                        "Another edit is waiting. Apply it in ComfyUI or run "
                        "h3-grok cancel before sending a replacement.")
            if base != snapshot.get("revision"):
                raise BridgeConflict(
                    "ComfyUI changed after the local pull. Pull again before sending.")
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
                "request_hash": request_hash,
                "auto_apply": payload.get("auto_apply") is True,
                "base_project": normalize_project({
                    key: snapshot[key] for key in ("project_id", "shared_prompt", "scenes", "references")
                }),
            }
            _atomic_json(pending_path, pending)
            return pending

    def pull(self, payload: Any) -> dict[str, Any]:
        current = normalize_project(payload)
        project = current["project_id"]
        _directory, snapshot_path, pending_path = self._paths(project)
        with self._lock(project):
            if not os.path.isfile(pending_path):
                return {
                    "ok": True, "project_id": project, "pending": False,
                    "changes": [], "revision": current["revision"],
                }
            pending = _read_json(pending_path)
            if pending.get("base_revision") != current["revision"]:
                snapshot = _read_json(snapshot_path)
                receipt = snapshot.get("last_sync") or {}
                already_applied = (
                    receipt.get("change_id") == pending.get("change_id")
                    and receipt.get("project", {}).get("revision") == current["revision"]
                ) or self._matches_applied(snapshot, pending, current)
                if not already_applied:
                    raise BridgeConflict(
                        "The live Plan changed after Grok pulled it. Keep your local edits, "
                        "run h3-grok cancel, then reconcile with a fresh pull.")
                return {"ok": True, "pending": True, **pending, "already_applied": True}
            return {"ok": True, "pending": True, **pending}

    @staticmethod
    def _matches_applied(snapshot, pending, current) -> bool:
        """Only scene prompt text and derived reference usage may change."""
        snapshot = pending.get("base_project", snapshot)
        if snapshot.get("revision") != pending.get("base_revision"):
            return False
        changes = {item["scene_id"]: item["prompt"] for item in pending["changes"]}
        expected = normalize_project({
            "project_id": snapshot["project_id"],
            "shared_prompt": snapshot["shared_prompt"],
            "references": snapshot["references"],
            "scenes": [
                {**scene, "prompt": changes.get(scene["id"], scene["prompt"])}
                for scene in snapshot["scenes"]
            ],
        })
        def comparable(document):
            return {
                key: ([{k: v for k, v in ref.items() if k != "active_scenes"}
                       if isinstance(ref, dict) else ref for ref in value]
                      if key == "references" else value)
                for key, value in document.items() if key != "revision"
            }
        return comparable(expected) == comparable(current)

    def status(self, value: Any, change_id: str = "") -> dict[str, Any]:
        project = project_id(value)
        _directory, snapshot_path, pending_path = self._paths(project)
        with self._lock(project):
            if not os.path.isfile(snapshot_path):
                raise BridgeNotFound("Click Edit with Grok in the connected editor first.")
            snapshot = _read_json(snapshot_path)
            receipt = snapshot.get("last_sync") or {}
            if change_id and receipt.get("change_id") == change_id:
                return {"ok": True, "applied": True, "pending": False, **receipt}
            pending = _read_json(pending_path) if os.path.isfile(pending_path) else {}
            if pending.get("change_id") == receipt.get("change_id"):
                pending = {}
            return {
                "ok": True, "applied": False, "pending": bool(pending),
                "editor_id": snapshot.get("editor_id", ""),
                "change_id": pending.get("change_id"),
                "auto_apply": pending.get("auto_apply", False),
                "error": pending.get("error", ""),
            }

    def cancel(self, value: Any) -> dict[str, Any]:
        project = project_id(value)
        _directory, _snapshot_path, pending_path = self._paths(project)
        with self._lock(project):
            cancelled = os.path.isfile(pending_path)
            if cancelled:
                os.unlink(pending_path)
            return {"ok": True, "cancelled": cancelled}

    def failed(self, value: Any, change_id: Any, message: Any) -> dict[str, Any]:
        project = project_id(value)
        _directory, _snapshot_path, pending_path = self._paths(project)
        with self._lock(project):
            if os.path.isfile(pending_path):
                pending = _read_json(pending_path)
                if pending.get("change_id") == change_id:
                    pending["error"] = str(message)[:2000]
                    _atomic_json(pending_path, pending)
            return {"ok": True}

    def acknowledge(self, value: Any, change_id: Any, current: Any = None) -> dict[str, Any]:
        project = project_id(value)
        _directory, snapshot_path, pending_path = self._paths(project)
        with self._lock(project):
            snapshot = _read_json(snapshot_path) if os.path.isfile(snapshot_path) else {}
            receipt = snapshot.get("last_sync") or {}
            if change_id and receipt.get("change_id") == change_id:
                return {"ok": True, "acknowledged": True, "applied": True, **receipt}
            if not os.path.isfile(pending_path):
                return {"ok": True, "project_id": project, "acknowledged": False}
            pending = _read_json(pending_path)
            if str(change_id or "") != str(pending.get("change_id") or ""):
                raise BridgeConflict("Pending change id no longer matches.")
            if current is not None:
                document = normalize_project(current)
                if not self._matches_applied(snapshot, pending, document):
                    raise BridgeConflict("The applied Plan does not match the staged scene edits.")
                receipt = {
                    "change_id": pending["change_id"],
                    "request_hash": pending.get("request_hash"),
                    "project": document,
                }
                # Commit the receipt with the snapshot before removing pending.
                # A lost HTTP reply or crash can then be retried without reapplying.
                _atomic_json(snapshot_path, {
                    **document, "last_sync": receipt,
                    "editor_id": snapshot.get("editor_id", ""),
                    "published_at": datetime.now(timezone.utc).isoformat(),
                })
            os.unlink(pending_path)
            return {"ok": True, "project_id": project, "acknowledged": True,
                    "applied": current is not None, **receipt}


class MiniMaxH3GrokBridge:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "plan": ("H3_CHAIN_PLAN", {
                    "display_name": "H3 Plan",
                    "tooltip": "Connect the Plan you want Grok to edit."}),
                "project_id": ("STRING", {
                    "default": "",
                    "display_name": "Project name (optional)",
                    "placeholder": "uses Plan run name",
                    "tooltip": "Leave blank to use the Plan run name."}),
            }
        }

    RETURN_TYPES = ("H3_CHAIN_PLAN",)
    RETURN_NAMES = ("plan",)
    FUNCTION = "passthrough"
    CATEGORY = "conditioning/minimax/contex_loop/authoring"
    DESCRIPTION = (
        "Edit H3 scene prompts with Grok. Connect this between the Plan and "
        "Scene Prompt Editor.")

    def passthrough(self, plan, project_id=""):
        return (plan,)


NODE_CLASS_MAPPINGS = {"MiniMaxH3GrokBridge": MiniMaxH3GrokBridge}
NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3GrokBridge": "H3 Grok Bridge",
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
            body.get("project_id"), body.get("change_id"), body.get("current")))
    except (ValueError, OSError, TypeError, AttributeError) as exc:
        return _error(exc)


async def _status(request):
    try:
        return web.json_response(_store().status(
            request.rel_url.query.get("project_id"),
            request.rel_url.query.get("change_id", "")))
    except (ValueError, OSError, TypeError) as exc:
        return _error(exc)


async def _cancel(request):
    try:
        body = await request.json()
        return web.json_response(_store().cancel(body.get("project_id")))
    except (ValueError, OSError, TypeError, AttributeError) as exc:
        return _error(exc)


async def _failed(request):
    try:
        body = await request.json()
        return web.json_response(_store().failed(
            body.get("project_id"), body.get("change_id"), body.get("error")))
    except (ValueError, OSError, TypeError, AttributeError) as exc:
        return _error(exc)


if (PromptServer is not None and web is not None and
        getattr(PromptServer, "instance", None) is not None):
    PREFIX = "/minimax_h3_grok_bridge"
    PromptServer.instance.routes.get(PREFIX + "/project")(_project)
    PromptServer.instance.routes.post(PREFIX + "/publish")(_publish)
    PromptServer.instance.routes.post(PREFIX + "/changes")(_changes)
    PromptServer.instance.routes.post(PREFIX + "/pull")(_pull)
    PromptServer.instance.routes.post(PREFIX + "/ack")(_ack)
    PromptServer.instance.routes.get(PREFIX + "/status")(_status)
    PromptServer.instance.routes.post(PREFIX + "/cancel")(_cancel)
    PromptServer.instance.routes.post(PREFIX + "/failed")(_failed)
