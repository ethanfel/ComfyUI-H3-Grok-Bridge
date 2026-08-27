import {app} from "/scripts/app.js";
import {api} from "/scripts/api.js";
import {
    EDITOR_NODE_TYPES,
    applyPromptChanges,
    buildProjectPayload,
    nodeType,
    upstreamBridge,
} from "./grok_bridge_core.mjs?v=0.1.0";

const PREFIX = "/minimax_h3_grok_bridge";

function editorState(node) {
    return node?._h3ScenePromptEditorState ?? node?._h3RichPromptState ?? null;
}

function editorRoot(state) {
    return state?.promptTextarea?.closest?.(".h3sp-root")
        ?? state?.richEditor?.closest?.(".h3sp-root")
        ?? state?.editor?.closest?.(".h3rp-root")
        ?? null;
}

function editorToolbar(root) {
    return root?.querySelector?.(".h3sp-tools, .h3rp-toolbar") ?? null;
}

function editorStatus(state) {
    return state?.history?.status ?? state?.status ?? null;
}

function setStatus(state, message, error = false) {
    const status = editorStatus(state);
    if (!status) return;
    status.textContent = message;
    status.title = message;
    status.classList.toggle("h3-grok-error", error);
}

async function request(path, payload) {
    const response = await api.fetchApi(`${PREFIX}/${path}`, {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify(payload),
    });
    let body = {};
    try { body = await response.json(); } catch (_error) { /* proxy error */ }
    if (!response.ok) {
        throw new Error(body.error || `Grok Bridge request failed (HTTP ${response.status}).`);
    }
    return body;
}

function setBusy(node, busy) {
    node._h3GrokBridgeBusy = busy;
    for (const control of editorRoot(editorState(node))?.querySelectorAll(
        ".h3-grok-control",
    ) ?? []) control.disabled = busy;
}

async function publish(node, state, bridge) {
    if (node._h3GrokBridgeBusy) return;
    setBusy(node, true);
    try {
        const result = await request("publish", buildProjectPayload(node, state, bridge));
        setStatus(
            state,
            `Grok project “${result.project_id}” sent · ${result.scene_count} scenes · run local h3-grok pull`,
        );
    } catch (error) {
        setStatus(state, error?.message || String(error), true);
    } finally {
        setBusy(node, false);
    }
}

function commitPlan(node, state, applied) {
    if (String(state.planWidget?.value ?? "") !== String(state.lastValue ?? "")) {
        node._h3ScenePromptEditorRefresh?.();
        node._h3RichPromptRefresh?.();
        throw new Error("The Plan changed while Grok Pull was open. Click Grok Pull again.");
    }
    const value = JSON.stringify(state.plan, null, 2);
    state.lastValue = value;
    state.planWidget.value = value;
    state.planWidget.callback?.(value);
    state.planNode?._h3ChainEditorRefresh?.();
    state.planNode?.graph?.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    setStatus(state, `Grok Pull applied ${applied} scene${applied === 1 ? "" : "s"}.`);
    setTimeout(() => {
        node._h3ScenePromptEditorRefresh?.();
        node._h3RichPromptRefresh?.();
    }, 0);
}

async function pull(node, state, bridge) {
    if (node._h3GrokBridgeBusy) return;
    setBusy(node, true);
    try {
        const current = buildProjectPayload(node, state, bridge);
        const pending = await request("pull", current);
        if (!pending.pending || !pending.changes?.length) {
            setStatus(state, "No local Grok scene edits are waiting.");
            return;
        }
        const applied = applyPromptChanges(state.plan, pending.changes);
        commitPlan(node, state, applied);
        await request("ack", {
            project_id:current.project_id,
            change_id:pending.change_id,
        });
        await request("publish", buildProjectPayload(node, state, bridge));
    } catch (error) {
        setStatus(state, error?.message || String(error), true);
    } finally {
        setBusy(node, false);
    }
}

function makeButton(label, title, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "h3-grok-control";
    button.textContent = label;
    button.title = title;
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", action);
    return button;
}

function ensureControls(node) {
    const state = editorState(node);
    const root = editorRoot(state);
    const toolbar = editorToolbar(root);
    if (!state?.plan || !state.planNode || !toolbar) return;
    const bridge = upstreamBridge(node);
    const existing = [...root.querySelectorAll(".h3-grok-control")];
    if (!bridge) {
        existing.forEach((control) => control.remove());
        return;
    }
    if (existing.length === 2) return;
    existing.forEach((control) => control.remove());
    const send = makeButton(
        "Grok Send",
        "Publish the live Plan, one scene per local Markdown file, plus reference and semantic context.",
        () => void publish(node, editorState(node), upstreamBridge(node)),
    );
    const receive = makeButton(
        "Grok Pull",
        "Import revision-matched scene edits staged by the local h3-grok send command.",
        () => void pull(node, editorState(node), upstreamBridge(node)),
    );
    toolbar.append(send, receive);
}

function attach(node) {
    if (node._h3GrokBridgeControlsAttached) return;
    node._h3GrokBridgeControlsAttached = true;
    const timer = window.setInterval(() => ensureControls(node), 350);
    const removed = node.onRemoved;
    node.onRemoved = function () {
        window.clearInterval(timer);
        return removed?.apply(this, arguments);
    };
    setTimeout(() => ensureControls(node), 0);
}

app.registerExtension({
    name:"h3.grok.prompt.bridge",
    async beforeRegisterNodeDef(nodeTypeDefinition, nodeData) {
        if (!EDITOR_NODE_TYPES.includes(nodeData.name)) return;
        const created = nodeTypeDefinition.prototype.onNodeCreated;
        nodeTypeDefinition.prototype.onNodeCreated = function () {
            const result = created?.apply(this, arguments);
            setTimeout(() => attach(this), 0);
            return result;
        };
    },
    async nodeCreated(node) {
        if (EDITOR_NODE_TYPES.includes(nodeType(node))) attach(node);
    },
    async afterConfigureGraph() {
        for (const node of app.graph?._nodes ?? []) {
            if (EDITOR_NODE_TYPES.includes(nodeType(node))) attach(node);
        }
    },
});
