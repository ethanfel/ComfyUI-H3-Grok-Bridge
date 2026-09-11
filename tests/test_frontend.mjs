import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {webcrypto} from "node:crypto";
import * as core from "../web/grok_bridge_core.mjs";

// Execute the extension itself, substituting only ComfyUI and browser services.
const source = fs.readFileSync(new URL("../web/grok_bridge.js", import.meta.url), "utf8")
    .replace(/import\s+[\s\S]*?\s+from\s+"[^"]+";\n/g, "");

function fixture(rich = false) {
    const controls = [];
    const toolbar = {append:(...items) => controls.push(...items)};
    const root = {querySelector:() => toolbar, querySelectorAll:() => controls};
    const plan = {shots:[{id:"intro", prompt:["Original"], length:124},
        {id:"outro", prompt:["Final scene"], seed:"9007199254740993"}]};
    const planWidget = {name:"plan_json", value:JSON.stringify(plan)};
    const planNode = {id:1, type:"MiniMaxH3ChainPlan", inputs:[], widgets:[
        {name:"run_name", value:"film"}, planWidget,
    ]};
    const bridge = {id:2, type:core.BRIDGE_NODE_TYPE, widgets:[], inputs:[{name:"plan", link:1}],
        addWidget(type, name, value, callback) {
            const widget = {type, name, value, callback};
            this.widgets.push(widget);
            return widget;
        }};
    const editor = {id:3, type:core.EDITOR_NODE_TYPES[rich ? 1 : 0], inputs:[{name:"plan", link:2}]};
    const nodes = [planNode, bridge, editor];
    const graph = {_nodes:nodes, links:{1:{origin_id:1}, 2:{origin_id:2}},
        getNodeById:id => nodes.find(node => node.id === id)};
    nodes.forEach(node => { node.graph = graph; });
    const status = {textContent:"", classList:{toggle(){}}};
    const state = {plan, planNode, planWidget, lastValue:planWidget.value, history:{status}};
    const input = {closest:() => root};
    if (rich) {
        state.editor = input;
        editor._h3RichPromptState = state;
    } else {
        state.promptTextarea = input;
        editor._h3ScenePromptEditorState = state;
    }
    let extension;
    let handler = async (_url, payload) => ({ok:true, project_id:payload?.project_id});
    const intervals = new Map();
    const requests = [];
    const alerts = [];
    const elements = [];
    let timer = 0;
    const document = {
        createElement(tag) {
            const element = {tag, listeners:{}, style:{}, children:[],
                addEventListener(event, fn) { this.listeners[event] = fn; },
                append(...children) { this.children.push(...children); },
                remove() { const index = controls.indexOf(this); if (index >= 0) controls.splice(index, 1); },
                select(){}, showModal(){}, close(){ this.listeners.close?.(); },
            };
            elements.push(element);
            return element;
        },
        body:{append(){}},
    };
    const context = vm.createContext({...core, AbortController, URL, URLSearchParams, crypto:webcrypto,
        app:{graph, registerExtension:value => { extension = value; }},
        api:{fetchApi:async (url, options) => {
            const payload = options.body ? JSON.parse(options.body) : undefined;
            requests.push({url, payload});
            const body = await handler(url, payload);
            return {ok:true, json:async () => body};
        }}, document,
        window:{location:{href:"http://comfy:8188/"}, alert:value => alerts.push(value),
            setInterval:fn => { const id = ++timer; intervals.set(id, fn); return id; },
            clearInterval:id => intervals.delete(id)},
        setTimeout(){ return ++timer; }, clearTimeout(){},
    });
    vm.runInContext(source, context);
    return {context, editor, bridge, state, planWidget, controls, extension, intervals,
        requests, alerts, elements, status, handle:fn => { handler = fn; }};
}

const changes = {pending:true, change_id:"change-1", changes:[{scene_id:"intro", prompt:"Grok draft"}]};

for (const rich of [false, true]) {
    const f = fixture(rich);
    f.context.ensureControls(f.editor);
    assert.deepEqual(f.controls.map(button => button.textContent), ["Edit with Grok", "Grok Pull"]);
    f.context.ensureControls(f.editor);
    assert.equal(f.controls.length, 2);
    f.editor.inputs = [];
    f.context.ensureControls(f.editor);
    assert.equal(f.controls.length, 0);
}

{
    const f = fixture();
    await f.extension.nodeCreated(f.editor);
    assert.equal(f.intervals.size, 1);
    f.editor.onRemoved();
    assert.equal(f.intervals.size, 0);
    await f.extension.nodeCreated(f.editor);
    assert.equal(f.intervals.size, 1);
    await f.extension.nodeCreated(f.bridge);
    assert.equal(f.bridge.widgets.filter(widget => widget.type === "button").length, 1);
    f.context.attachBridge(f.bridge);
    assert.equal(f.bridge.widgets.length, 1);
    await f.bridge.widgets[0].callback();
    // Allow publication's promise chain to finish before checking the dialog.
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.elements.some(element => element.tag === "textarea"
        && element.value === "h3-grok edit 'http://comfy:8188' 'film'"));
}

{
    const f = fixture();
    let finish;
    const deferred = new Promise(resolve => { finish = resolve; });
    f.handle(async url => url.endsWith("/pull") ? deferred : {ok:true});
    const operation = f.context.pull(f.editor, f.state, f.bridge);
    f.state.plan.shots[0].prompt = ["Typed during request"];
    f.state.lastValue = f.planWidget.value = JSON.stringify(f.state.plan);
    finish(changes);
    await operation;
    assert.equal(JSON.parse(f.planWidget.value).shots[0].prompt[0], "Typed during request");
    assert.equal(f.requests.some(request => request.url.endsWith("/ack")), false);
    assert.ok(f.requests.some(request => request.url.endsWith("/failed")));
}

{
    const f = fixture();
    const before = JSON.stringify(f.state.plan);
    f.handle(async url => url.endsWith("/pull") ? {...changes, changes:[
        ...changes.changes, {scene_id:"missing", prompt:"Invalid"},
    ]} : {ok:true});
    await f.context.pull(f.editor, f.state, f.bridge);
    assert.equal(JSON.stringify(f.state.plan), before);
    assert.equal(f.planWidget.value, before);
    assert.equal(f.requests.some(request => request.url.endsWith("/ack")), false);
}

{
    const f = fixture();
    let ackCalls = 0;
    f.handle(async url => {
        if (url.endsWith("/pull")) return changes;
        if (url.endsWith("/ack") && ++ackCalls === 1) throw new Error("Connection lost");
        return {ok:true};
    });
    await f.context.pull(f.editor, f.state, f.bridge);
    assert.equal(JSON.parse(f.planWidget.value).shots[0].prompt[0], "Grok draft");
    assert.equal(JSON.parse(f.planWidget.value).shots[1].seed, "9007199254740993");
    assert.ok(f.editor._h3GrokBridgePendingAck);
    f.state.plan.shots[0].prompt = ["New edit after applying"];
    f.state.lastValue = f.planWidget.value = JSON.stringify(f.state.plan);
    await f.context.pull(f.editor, f.state, f.bridge);
    assert.equal(f.requests.filter(request => request.url.endsWith("/pull")).length, 1);
    assert.equal(f.requests.filter(request => request.url.endsWith("/ack")).length, 2);
    assert.equal(f.editor._h3GrokBridgePendingAck, null);
    assert.equal(JSON.parse(f.planWidget.value).shots[0].prompt[0], "New edit after applying");
}

for (const autoApply of [false, true]) {
    const f = fixture();
    f.editor._h3GrokBridgeConnected = true;
    f.editor._h3GrokBridgeEditorId = "editor-1";
    f.editor._h3GrokBridgeProject = "film";
    f.handle(async url => url.includes("/status?")
        ? {pending:true, auto_apply:autoApply, editor_id:"editor-1", change_id:changes.change_id}
        : url.endsWith("/pull") ? changes : {ok:true});
    await f.context.poll(f.editor);
    assert.equal(f.requests.some(request => request.url.endsWith("/ack")), autoApply);
    assert.equal(JSON.parse(f.planWidget.value).shots[0].prompt[0], autoApply ? "Grok draft" : "Original");
}

{
    const f = fixture();
    f.editor._h3GrokBridgeConnected = true;
    f.editor._h3GrokBridgeEditorId = "editor-1";
    f.editor._h3GrokBridgeProject = "film";
    f.handle(async () => ({pending:true, auto_apply:true, editor_id:"another-editor"}));
    await f.context.poll(f.editor);
    assert.equal(f.editor._h3GrokBridgeConnected, false);
    assert.equal(f.requests.some(request => request.url.endsWith("/pull")), false);
}

console.log("H3 Grok Bridge UI: mounting, launch, atomic imports, conflicts, receipts and sync pass");
