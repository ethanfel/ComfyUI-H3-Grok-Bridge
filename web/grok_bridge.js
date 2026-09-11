import {app} from "/scripts/app.js";
import {api} from "/scripts/api.js";
import {
    EDITOR_NODE_TYPES,
    BRIDGE_NODE_TYPE,
    applyPromptChanges,
    buildProjectPayload,
    nodeType,
    upstreamBridge,
} from "./grok_bridge_core.mjs?v=0.4.0";

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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
        const response = await api.fetchApi(`${PREFIX}/${path}`, {
            method:payload === undefined ? "GET" : "POST",
            headers:{"Content-Type":"application/json"},
            ...(payload === undefined ? {} : {body:JSON.stringify(payload)}),
            signal:controller.signal,
        });
        let body = {};
        try { body = await response.json(); } catch (_error) { /* proxy error */ }
        if (!response.ok) {
            throw new Error(body.error || `Grok Bridge request failed (HTTP ${response.status}).`);
        }
        return body;
    } finally {
        clearTimeout(timeout);
    }
}

function setBusy(node, busy) {
    node._h3GrokBridgeBusy = busy;
    for (const control of editorRoot(editorState(node))?.querySelectorAll(
        ".h3-grok-control",
    ) ?? []) control.disabled = busy;
}

function requireState(node, state, bridge) {
    if (!bridge || !state?.plan || !state.planNode || !state.planWidget) {
        throw new Error("Connect H3 Plan → Grok Bridge → Prompt Editor and wait for the scenes to load.");
    }
    if (String(state.planWidget.value ?? "") !== String(state.lastValue ?? "")) {
        throw new Error("The editor is refreshing. Try again once the scenes have loaded.");
    }
    if (node._h3GrokBridgeRemoved) throw new Error("The Prompt Editor was removed.");
}

function shellQuote(value) {
    return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function showLaunchCommand(project) {
    const endpoint = new URL(api.apiURL?.(PREFIX) ?? PREFIX, window.location.href);
    const server = endpoint.href.slice(0, -PREFIX.length);
    const command = `h3-grok edit ${shellQuote(server)} ${shellQuote(project)}`;
    const dialog = document.createElement("dialog");
    dialog.style.cssText = "max-width:680px;width:85vw;padding:24px;border:1px solid #666;border-radius:10px;background:var(--comfy-menu-bg,#222);color:var(--fg-color,#eee)";
    const title = document.createElement("h3");
    title.textContent = "Edit with Grok";
    const instructions = document.createElement("p");
    instructions.textContent = "Run this once in a terminal on the machine where Grok is installed. Keep this ComfyUI tab open. Grok can send finished edits back with h3-grok sync.";
    const input = document.createElement("textarea");
    input.value = command;
    input.readOnly = true;
    input.rows = 3;
    input.style.cssText = "width:100%;box-sizing:border-box;margin:12px 0;font-family:monospace";
    const copy = makeButton("Copy command", "Copy the Grok launch command", async () => {
        input.select();
        try {
            if (globalThis.navigator?.clipboard) await navigator.clipboard.writeText(command);
            else if (!document.execCommand("copy")) throw new Error("Manual copy needed");
            copy.textContent = "Copied";
        } catch (_error) {
            copy.textContent = "Select the command and copy it";
        }
    });
    const close = makeButton("Close", "Close", () => dialog.close());
    close.style.marginLeft = "8px";
    dialog.append(title, instructions, input, copy, close);
    dialog.addEventListener("close", () => dialog.remove(), {once:true});
    document.body.append(dialog);
    dialog.showModal();
    input.select();
}

async function publish(node, state, bridge, launch = false) {
    if (node._h3GrokBridgeBusy) return;
    setBusy(node, true);
    try {
        requireState(node, state, bridge);
        node._h3GrokBridgeEditorId ??= [...crypto.getRandomValues(new Uint32Array(4))]
            .map((value) => value.toString(16).padStart(8, "0")).join("");
        const payload = buildProjectPayload(node, state, bridge);
        const result = await request("publish", {
            ...payload, editor_id:node._h3GrokBridgeEditorId,
        });
        node._h3GrokBridgeProject = result.project_id;
        node._h3GrokBridgePublished = JSON.stringify(payload);
        node._h3GrokBridgeConnected = true;
        setStatus(state, `“${result.project_id}” ready · Grok can send edits with h3-grok sync.`);
        if (launch) showLaunchCommand(result.project_id);
    } catch (error) {
        setStatus(state, error?.message || String(error), true);
        if (launch) window.alert(error?.message || String(error));
    } finally {
        setBusy(node, false);
    }
}

function commitPlan(node, state, plan, applied) {
    const value = JSON.stringify(plan, null, 2);
    state.plan = plan;
    state.lastValue = value;
    state.planWidget.value = value;
    state.planWidget.callback?.(value);
    state.planNode?._h3ChainEditorRefresh?.();
    state.planNode?.graph?.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    setStatus(state, `Applied ${applied} scene${applied === 1 ? "" : "s"} from Grok.`);
    setTimeout(() => {
        node._h3ScenePromptEditorRefresh?.();
        node._h3RichPromptRefresh?.();
    }, 0);
}

async function pull(node, state, bridge, expectedChange = null) {
    if (node._h3GrokBridgeBusy) return;
    setBusy(node, true);
    let pending;
    let current;
    try {
        requireState(node, state, bridge);
        if (node._h3GrokBridgePendingAck) {
            await request("ack", node._h3GrokBridgePendingAck);
            node._h3GrokBridgePendingAck = null;
            setStatus(state, "Grok edits received and confirmed.");
            return;
        }
        current = buildProjectPayload(node, state, bridge);
        const baseline = {
            value:String(state.planWidget.value), widget:state.planWidget,
            planNode:state.planNode, graph:node.graph, payload:JSON.stringify(current),
            plan:JSON.parse(JSON.stringify(state.plan)),
        };
        pending = await request("pull", current);
        if (!pending.pending || !pending.changes?.length) {
            setStatus(state, "No Grok edits are waiting.");
            return;
        }
        if (expectedChange && pending.change_id !== expectedChange) {
            throw new Error("The pending edits changed. Run h3-grok sync again.");
        }
        if (node._h3GrokBridgeRemoved || editorState(node) !== state
                || state.planNode !== baseline.planNode || state.planWidget !== baseline.widget
                || node.graph !== baseline.graph || upstreamBridge(node) !== bridge
                || String(state.planWidget.value) !== baseline.value
                || JSON.stringify(buildProjectPayload(node, state, bridge)) !== baseline.payload) {
            throw new Error("The Plan changed while Grok was sending edits. Your current text was kept.");
        }
        if (!pending.already_applied) {
            const applied = applyPromptChanges(baseline.plan, pending.changes);
            commitPlan(node, state, baseline.plan, applied);
        }
        node._h3GrokBridgePendingAck = {
            project_id:current.project_id,
            change_id:pending.change_id,
            current:buildProjectPayload(node, state, bridge),
        };
        await request("ack", node._h3GrokBridgePendingAck);
        node._h3GrokBridgePublished = JSON.stringify(node._h3GrokBridgePendingAck.current);
        node._h3GrokBridgePendingAck = null;
    } catch (error) {
        const message = error?.message || String(error);
        setStatus(state, message, true);
        if (!node._h3GrokBridgePendingAck && (pending?.change_id || expectedChange) && current) {
            try {
                await request("failed", {project_id:current.project_id,
                    change_id:pending?.change_id ?? expectedChange, error:message});
            } catch (_error) { /* A retry reports transport failures to the CLI. */ }
        }
    } finally {
        setBusy(node, false);
    }
}

async function poll(node) {
    if (!node._h3GrokBridgeConnected || node._h3GrokBridgeBusy || node._h3GrokBridgePolling
            || Date.now() - (node._h3GrokBridgeLastPoll ?? 0) < 1500) return;
    node._h3GrokBridgeLastPoll = Date.now();
    node._h3GrokBridgePolling = true;
    try {
        const state = editorState(node);
        const bridge = upstreamBridge(node);
        requireState(node, state, bridge);
        const current = buildProjectPayload(node, state, bridge);
        if (current.project_id !== node._h3GrokBridgeProject) {
            node._h3GrokBridgeConnected = false;
            setStatus(state, "Project changed. Click Edit with Grok to reconnect.");
            return;
        }
        const status = await request(`status?${new URLSearchParams({project_id:current.project_id})}`);
        if (!node._h3GrokBridgeConnected || node._h3GrokBridgeRemoved) return;
        if (buildProjectPayload(node, editorState(node), upstreamBridge(node)).project_id
                !== node._h3GrokBridgeProject) {
            node._h3GrokBridgeConnected = false;
            setStatus(editorState(node), "Project changed. Click Edit with Grok to reconnect.");
            return;
        }
        if (status.editor_id !== node._h3GrokBridgeEditorId) {
            node._h3GrokBridgeConnected = false;
            setStatus(state, "This project is connected to another editor. Click Edit with Grok to use this one.");
            return;
        }
        if (node._h3GrokBridgePendingAck || (status.pending && status.auto_apply && !status.error)) {
            await pull(node, editorState(node), upstreamBridge(node), status.change_id);
        } else if (!status.pending && JSON.stringify(current) !== node._h3GrokBridgePublished) {
            await publish(node, editorState(node), upstreamBridge(node));
        }
    } catch (error) {
        setStatus(editorState(node), error?.message || String(error), true);
    } finally {
        node._h3GrokBridgePolling = false;
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
    if (node._h3GrokBridgeRemoved) return;
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
        "Edit with Grok",
        "Open this project in Grok and receive finished edits with h3-grok sync.",
        () => void publish(node, editorState(node), upstreamBridge(node), true),
    );
    const receive = makeButton(
        "Grok Pull",
        "Apply scene edits staged by h3-grok send.",
        () => void pull(node, editorState(node), upstreamBridge(node)),
    );
    send.disabled = receive.disabled = Boolean(node._h3GrokBridgeBusy);
    toolbar.append(send, receive);
}

function attach(node) {
    if (node._h3GrokBridgeRemoved && !node.graph) return;
    if (node._h3GrokBridgeControlsAttached) return;
    node._h3GrokBridgeControlsAttached = true;
    node._h3GrokBridgeRemoved = false;
    const timer = window.setInterval(() => {
        ensureControls(node);
        void poll(node);
    }, 350);
    const removed = node.onRemoved;
    node.onRemoved = function () {
        window.clearInterval(timer);
        node._h3GrokBridgeControlsAttached = false;
        node._h3GrokBridgeRemoved = true;
        node._h3GrokBridgeConnected = false;
        node.onRemoved = removed;
        return removed?.apply(this, arguments);
    };
    setTimeout(() => ensureControls(node), 0);
}

function allNodes(graph, seen = new Set()) {
    if (!graph || seen.has(graph)) return [];
    seen.add(graph);
    return (graph._nodes ?? []).flatMap((node) => [node, ...allNodes(node.subgraph, seen)]);
}

function attachBridge(node) {
    if (node._h3GrokLaunchWidget || !node.addWidget) return;
    const widget = node.addWidget("button", "Edit with Grok", null, () => {
        const editors = allNodes(node.graph?.rootGraph ?? node.graph).filter(
            (candidate) => EDITOR_NODE_TYPES.includes(nodeType(candidate))
                && upstreamBridge(candidate) === node,
        );
        if (editors.length !== 1) {
            window.alert("Connect one H3 Scene Prompt Editor to this bridge first.");
            return;
        }
        const editor = editors[0];
        try { requireState(editor, editorState(editor), node); }
        catch (error) { window.alert(error.message); return; }
        attach(editor);
        void publish(editor, editorState(editor), node, true);
    }, {serialize:false});
    widget.serialize = false;
    node._h3GrokLaunchWidget = widget;
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
        if (nodeType(node) === BRIDGE_NODE_TYPE) attachBridge(node);
    },
    async afterConfigureGraph() {
        for (const node of allNodes(app.graph)) {
            if (EDITOR_NODE_TYPES.includes(nodeType(node))) attach(node);
            if (nodeType(node) === BRIDGE_NODE_TYPE) attachBridge(node);
        }
    },
    async setup() {
        for (const node of allNodes(app.graph)) {
            if (EDITOR_NODE_TYPES.includes(nodeType(node))) attach(node);
            if (nodeType(node) === BRIDGE_NODE_TYPE) attachBridge(node);
        }
    },
});
