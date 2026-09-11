import assert from "node:assert/strict";
import {
    applyPromptChanges,
    buildProjectPayload,
    collectProjectReferences,
    projectAssetReferenceRecords,
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
const imageLoader = node(7, "LoadImage", [["image", "portraits/hero.png [input]"]]);
const generatedImage = node(8, "PreviewImage");
generatedImage.imgs = [{
    src:"http://comfy:8188/view?filename=location.webp&subfolder=refs&type=output&rand=1",
}];
const catalog = {
    format:"h3_project_assets_v1", version:1, project:"nightly",
    assets:[
        {id:"pa-hero", kind:"image", role:"picture", tag:"hero", enabled:true,
            original_name:"hero-source.png", mime_type:"image/png", sha256:"abc"},
        {id:"pa-location", kind:"image", role:"semantic_anchor", tag:"location",
            enabled:true, original_name:"set.webp", mime_type:"image/webp"},
        {id:"pa-disabled", kind:"image", role:"picture", tag:"unused", enabled:false,
            original_name:"unused.png"},
        {id:"pa-source", kind:"video", role:"source_track", tag:"source", enabled:true,
            original_name:"episode.mp4"},
    ],
};
const assetManager = node(9, "MiniMaxH3ProjectAssetManager", [
    ["run_name", "nightly"], ["catalog_json", JSON.stringify(catalog)],
    ["semantic_anchor_size", "512"], ["semantic_anchor_mode", "timestamped_video"],
]);
const nodes = [
    planNode, bridge, editor, picture, semantic, motion, imageLoader, generatedImage,
    assetManager,
];
const links = {
    10:{origin_id:1, target_id:2},
    11:{origin_id:2, target_id:3},
    12:{origin_id:7, target_id:4},
    13:{origin_id:8, target_id:5},
    14:{origin_id:9, target_id:1},
};
const graph = {links, _nodes:nodes, getNodeById:(id) => nodes.find((item) => item.id === id)};
nodes.forEach((item) => { item.graph = graph; });
planNode.inputs = [{name:"project_assets", link:14}];
bridge.inputs = [{name:"plan", link:10}];
editor.inputs = [{name:"plan", link:11}];
picture.inputs = [{name:"image", link:12}];
semantic.inputs = [{name:"image", link:13}];

assert.equal(upstreamBridge(editor), bridge);
const plan = {
    prompt_prefix:["Same performer."],
    shots:[
        {id:"intro", prompt:["Use @hero and @walk."], length:124},
        {id:"outro", prompt:["Resolve at #location and frame #hero[2.50s]."]},
    ],
};
const refs = collectProjectReferences(editor, plan);
assert.equal(projectAssetReferenceRecords(assetManager, plan).length, 3);
assert.equal(refs.find((item) => item.tag === "hero").semantic_token, "#hero");
assert.deepEqual(refs.find((item) => item.tag === "hero").active_scenes, [1, 2]);
assert.deepEqual(refs.find((item) => item.tag === "hero").asset, {
    provider:"h3_project_assets", project:"nightly", asset_id:"pa-hero",
    filename:"hero-source.png", mime_type:"image/png", sha256:"abc",
});
assert.match(refs.find((item) => item.tag === "hero").source, /H3 Project Assets/);
assert.deepEqual(refs.find((item) => item.tag === "location").active_scenes, [2]);
assert.deepEqual(refs.find((item) => item.tag === "location").asset, {
    provider:"h3_project_assets", project:"nightly", asset_id:"pa-location",
    filename:"set.webp", mime_type:"image/webp", sha256:"",
});
assert.equal(refs.find((item) => item.tag === "location").semantic_only, true);
assert.equal(refs.find((item) => item.tag === "source").native_token, null);
assert.deepEqual(refs.find((item) => item.tag === "source").active_scenes, [1, 2]);
assert.equal(refs.find((item) => item.tag === "walk").semantics.target_subject, "<Subject 1>");

const payload = buildProjectPayload(editor, {plan, planNode}, bridge);
assert.equal(payload.project_id, "nightly");
assert.equal(payload.scenes[0].prompt, "Use @hero and @walk.");
assert.equal(payload.scenes[0].metadata.length, 124);
assert.equal(payload.references.length, 4);
assert.equal(applyPromptChanges(plan, [{scene_id:"intro", prompt:"Changed."}]), 1);
assert.deepEqual(plan.shots[0].prompt, ["Changed."]);

const atomicPlan = {shots:[{id:"intro", prompt:["Keep this"]}]};
assert.throws(() => applyPromptChanges(atomicPlan, [
    {scene_id:"intro", prompt:"Uncommitted"}, {scene_id:"missing", prompt:"Invalid"},
]));
assert.deepEqual(atomicPlan.shots[0].prompt, ["Keep this"]);
assert.throws(() => applyPromptChanges(atomicPlan, [
    {scene_id:"intro", prompt:"One"}, {scene_id:"intro", prompt:"Two"},
]));
assert.deepEqual(atomicPlan.shots[0].prompt, ["Keep this"]);

const bridgeThroughSet = node(20, "MiniMaxH3GrokBridge");
const setter = node(21, "SetNode", [["name", "scene-plan"]]);
const getter = node(22, "GetNode", [["name", "scene-plan"]]);
const setEditor = node(23, "MiniMaxH3ChainScenePromptEditor");
const setNodes = [bridgeThroughSet, setter, getter, setEditor];
const setGraph = {
    links:{
        30:{origin_id:20, target_id:21},
        31:{origin_id:22, target_id:23},
    },
    _nodes:setNodes,
    getNodeById:(id) => setNodes.find((item) => item.id === id),
};
setNodes.forEach((item) => { item.graph = setGraph; });
setter.inputs = [{name:"value", link:30}];
setEditor.inputs = [{name:"plan", link:31}];
assert.equal(upstreamBridge(setEditor), bridgeThroughSet);

const outerBridge = node(40, "MiniMaxH3GrokBridge");
const subgraphHost = node(41, "Subgraph");
const innerEditor = node(42, "MiniMaxH3ChainScenePromptEditor");
const rootNodes = [outerBridge, subgraphHost];
const rootGraph = {
    links:{40:{origin_id:40, target_id:41, target_slot:0}},
    _nodes:rootNodes,
    getNodeById:(id) => rootNodes.find((item) => item.id === id),
};
const innerGraph = {
    rootGraph,
    links:{41:{origin_id:-10, origin_slot:0, target_id:42}},
    _nodes:[innerEditor],
    getNodeById:(id) => id === 42 ? innerEditor : null,
};
rootNodes.forEach((item) => { item.graph = rootGraph; });
subgraphHost.inputs = [{name:"plan", link:40}];
subgraphHost.subgraph = innerGraph;
innerEditor.graph = innerGraph;
innerEditor.inputs = [{name:"plan", link:41}];
assert.equal(upstreamBridge(innerEditor), outerBridge);
console.log("H3 Grok Bridge frontend: conditional controls, semantics and scene edits pass");
