import assert from "node:assert/strict";
import fs from "node:fs";
import {
    applyPromptChanges,
    buildProjectPayload,
    collectProjectReferences,
    upstreamBridge,
} from "../web/grok_bridge_core.mjs";

function node(id, type, widgets = []) {
    return {
        id, type, widgets:widgets.map(([name, value]) => ({name, value})),
        inputs:[], outputs:[], graph:null,
    };
}

const planNode = node(1, "MiniMaxH3ChainPlan", [["run_name", "nightly"]]);
const bridge = node(2, "MiniMaxH3GrokBridge", [["project_id", ""]]);
const editor = node(3, "MiniMaxH3ChainScenePromptEditor");
const picture = node(4, "MiniMaxH3TaggedPictureReference", [["tag", "hero"]]);
const semantic = node(5, "MiniMaxH3SemanticPictureAnchor", [["tag", "location"]]);
const motion = node(6, "MiniMaxH3TaggedMotionReference", [
    ["tag", "walk"], ["target_subject", "<Subject 1>"],
    ["motion_description", "a measured walk"],
]);
const nodes = [planNode, bridge, editor, picture, semantic, motion];
const links = {
    10:{origin_id:1, target_id:2},
    11:{origin_id:2, target_id:3},
};
const graph = {links, _nodes:nodes, getNodeById:(id) => nodes.find((item) => item.id === id)};
nodes.forEach((item) => { item.graph = graph; });
bridge.inputs = [{name:"plan", link:10}];
editor.inputs = [{name:"plan", link:11}];

assert.equal(upstreamBridge(editor), bridge);
const plan = {
    prompt_prefix:["Same performer."],
    shots:[
        {id:"intro", prompt:["Use @hero and @walk."], length:124},
        {id:"outro", prompt:["Resolve at #location[2.50s]."]},
    ],
};
const refs = collectProjectReferences(editor, plan);
assert.equal(refs.find((item) => item.tag === "hero").semantic_token, "#hero[0.00s]");
assert.deepEqual(refs.find((item) => item.tag === "location").active_scenes, [2]);
assert.equal(refs.find((item) => item.tag === "walk").semantics.target_subject, "<Subject 1>");

const payload = buildProjectPayload(editor, {plan, planNode}, bridge);
assert.equal(payload.project_id, "nightly");
assert.equal(payload.scenes[0].prompt, "Use @hero and @walk.");
assert.equal(payload.scenes[0].metadata.length, 124);
assert.equal(payload.references.length, 3);
assert.equal(applyPromptChanges(plan, [{scene_id:"intro", prompt:"Changed."}]), 1);
assert.deepEqual(plan.shots[0].prompt, ["Changed."]);

const frontend = fs.readFileSync(new URL("../web/grok_bridge.js", import.meta.url), "utf8");
assert.match(frontend, /Grok Send/);
assert.match(frontend, /Grok Pull/);
assert.match(frontend, /upstreamBridge\(node\)/);
assert.match(frontend, /_h3ScenePromptEditorState/);
assert.match(frontend, /_h3RichPromptState/);
assert.match(frontend, /state\.planWidget\.value = value/);
assert.match(frontend, /await request\("ack"/);
console.log("H3 Grok Bridge frontend: conditional controls, semantics and scene edits pass");

