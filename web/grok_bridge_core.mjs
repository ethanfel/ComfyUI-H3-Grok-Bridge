export const BRIDGE_NODE_TYPE = "MiniMaxH3GrokBridge";
export const EDITOR_NODE_TYPES = Object.freeze([
    "MiniMaxH3ChainScenePromptEditor",
    "MiniMaxH3ChainRichScenePromptEditor",
]);

const REFERENCE_TYPES = new Map([
    ["MiniMaxH3TaggedPictureReference", {kind:"picture", tag:"tag", semantic:true}],
    ["MiniMaxH3SemanticPictureAnchor", {kind:"picture", tag:"tag", semanticOnly:true}],
    ["MiniMaxH3TaggedVideoReference", {kind:"video", tag:"tag"}],
    ["MiniMaxH3TaggedMotionReference", {kind:"motion", tag:"tag"}],
    ["MiniMaxH3TaggedMotionReferencePath", {kind:"motion", tag:"tag"}],
    ["MiniMaxH3TaggedMotionReferenceTimeline", {kind:"motion", tag:"tag"}],
    ["MiniMaxH3TaggedAudioReference", {kind:"audio", tag:"tag"}],
    ["MiniMaxH3ScheduledPictureReference", {kind:"picture", tag:"tag", scheduled:true}],
    ["MiniMaxH3ScheduledVideoReference", {kind:"video", tag:"tag", scheduled:true}],
    ["MiniMaxH3ScheduledAudioReference", {kind:"audio", tag:"tag", scheduled:true}],
]);

export function nodeType(node) {
    return node?.comfyClass ?? node?.type ?? null;
}

function graphLink(graph, linkId) {
    return graph?.links?.get?.(linkId) ?? graph?.links?.[linkId] ?? null;
}

function inputSource(node, name) {
    const input = node?.inputs?.find((item) => item.name === name);
    const link = graphLink(node?.graph, input?.link);
    return link ? node.graph?.getNodeById?.(link.origin_id) ?? null : null;
}

export function upstreamBridge(start) {
    const queue = [start];
    const seen = new Set();
    while (queue.length) {
        const node = queue.shift();
        if (!node || seen.has(node)) continue;
        seen.add(node);
        if (node !== start && nodeType(node) === BRIDGE_NODE_TYPE) return node;
        for (const input of node.inputs ?? []) {
            const link = graphLink(node.graph, input.link);
            const parent = link ? node.graph?.getNodeById?.(link.origin_id) : null;
            if (parent) queue.push(parent);
        }
    }
    return null;
}

function allNodes(graph, result = [], seen = new Set()) {
    if (!graph || seen.has(graph)) return result;
    seen.add(graph);
    for (const node of graph._nodes ?? []) {
        result.push(node);
        if (node.subgraph) allNodes(node.subgraph, result, seen);
    }
    return result;
}

function widgetValue(node, name, fallback = "") {
    return node?.widgets?.find((item) => item.name === name)?.value ?? fallback;
}

function cleanTag(value) {
    return String(value ?? "").trim().replace(/^[@#]+/, "");
}

function promptText(value) {
    return Array.isArray(value) ? value.join("\n") : String(value ?? "");
}

function activeSelector(selector, scene) {
    const text = String(selector ?? "").trim().toLowerCase();
    if (!text || text === "all" || text === "*") return true;
    return text.split(",").some((part) => {
        const match = part.trim().match(/^(\d+)(?::(\d+))?$/);
        if (!match) return false;
        return Number(match[1]) <= scene && scene <= Number(match[2] ?? match[1]);
    });
}

function usedByPrompt(prompt, tag, semanticOnly = false) {
    const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const native = new RegExp(`(^|[^A-Za-z0-9_])@${escaped}(?![A-Za-z0-9_-])`, "i");
    const semantic = new RegExp(
        `(^|[^A-Za-z0-9_])#${escaped}\\[[0-9]+(?:\\.[0-9]+)?s?\\]`, "i",
    );
    return semanticOnly ? semantic.test(prompt) : native.test(prompt) || semantic.test(prompt);
}

function mediaExtension(kind) {
    if (kind === "picture") return /\.(?:avif|bmp|gif|jpe?g|png|webp)$/i;
    if (kind === "audio") return /\.(?:aac|flac|m4a|mp3|ogg|opus|wav)$/i;
    return /\.(?:m4v|mkv|mov|mp4|webm)$/i;
}

function widgetAsset(value, kind) {
    let filename = "";
    let subfolder = "";
    let type = "input";
    if (value && typeof value === "object" && value.filename) {
        filename = String(value.filename).trim();
        subfolder = String(value.subfolder ?? "").trim();
        type = String(value.type ?? "input").toLowerCase();
    } else if (typeof value === "string") {
        let text = value.trim();
        if (!text || /^(?:blob:|data:)/i.test(text)) return null;
        if (/^(?:https?:|\/)/i.test(text)) {
            try {
                const url = new URL(text, "http://comfy.invalid");
                if (!/(?:^|\/)view$/i.test(url.pathname)) return null;
                filename = url.searchParams.get("filename") ?? "";
                subfolder = url.searchParams.get("subfolder") ?? "";
                type = (url.searchParams.get("type") ?? "input").toLowerCase();
            } catch (_error) {
                return null;
            }
        } else {
            const annotated = text.match(/\s+\[(input|output|temp)\]\s*$/i);
            if (annotated) {
                type = annotated[1].toLowerCase();
                text = text.slice(0, annotated.index).trim();
            }
            text = text.replaceAll("\\", "/").replace(/^\/+/, "");
            const slash = text.lastIndexOf("/");
            filename = slash >= 0 ? text.slice(slash + 1) : text;
            subfolder = slash >= 0 ? text.slice(0, slash) : "";
        }
    }
    if (!filename || !mediaExtension(kind).test(filename)) return null;
    if (!["input", "output", "temp"].includes(type)) type = "input";
    return {filename, subfolder:subfolder.replaceAll("\\", "/"), type};
}

function mediaAsset(start, kind) {
    const queue = [start];
    const seen = new Set();
    while (queue.length) {
        const node = queue.shift();
        if (!node || seen.has(node)) continue;
        seen.add(node);
        if (kind === "picture") {
            const rendered = node.imgs?.[0];
            const asset = widgetAsset(
                typeof rendered === "string" ? rendered : rendered?.src, kind);
            if (asset) return asset;
        }
        for (const widget of node.widgets ?? []) {
            const asset = widgetAsset(widget.value, kind);
            if (asset) return asset;
        }
        for (const input of node.inputs ?? []) {
            const parent = inputSource(node, input.name);
            if (parent) queue.push(parent);
        }
    }
    return null;
}

function mediaLabel(asset) {
    return asset
        ? [asset.subfolder, asset.filename].filter(Boolean).join("/")
        : "";
}

function promptUsesToken(plan, token) {
    const escaped = String(token).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(^|[^A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i");
    return (plan?.shots ?? []).flatMap((shot, offset) =>
        pattern.test(promptText(shot?.prompt)) ? [offset + 1] : []);
}

function coreReferenceRecords(node, plan) {
    const type = nodeType(node);
    const result = [];
    const add = (kind, token, source, availableScenes = null) => {
        const asset = mediaAsset(source, kind);
        result.push({
            kind,
            tag:"",
            native_token:token,
            semantic_token:null,
            semantic_only:false,
            selector:"connected native input",
            active_scenes:promptUsesToken(plan, token),
            available_scenes:availableScenes,
            source:mediaLabel(asset),
            asset,
            node_type:type,
            semantics:{},
        });
    };
    if (type === "MiniMaxH3ReferenceToVideo") {
        let audioOrdinal = 0;
        for (const input of node.inputs ?? []) {
            let match = String(input.name ?? "").match(/^ref_images\.ref_image_(\d+)$/);
            if (match) add("picture", `<Picture ${Number(match[1]) + 1}>`, inputSource(node, input.name));
            match = String(input.name ?? "").match(/^ref_videos\.ref_video_(\d+)$/);
            if (match) add("video", `<Video ${Number(match[1]) + 1}>`, inputSource(node, input.name));
            if (/^ref_video_audios\.ref_video_audio_\d+$/.test(String(input.name ?? ""))
                    || /^ref_audios\.ref_audio_\d+$/.test(String(input.name ?? ""))) {
                add("audio", `<Audio ${++audioOrdinal}>`, inputSource(node, input.name));
            }
        }
    } else if (type === "MiniMaxH3ImageToVideo") {
        const first = inputSource(node, "first_frame");
        const last = inputSource(node, "last_frame");
        const firstScenes = nodeType(first) === "MiniMaxH3ChainFirstSceneImage" ? [1] : null;
        if (first) add("picture", "<Picture 1>", first, firstScenes);
        if (last) add("picture", `<Picture ${first && !firstScenes ? 2 : 1}>`, last);
    }
    return result;
}

function semanticFields(node) {
    const wanted = new Set([
        "target_subject", "motion_description", "semantic_anchor_mode",
        "semantic_anchor_size", "timeline_mode", "paired_audio", "audio_tag",
    ]);
    return Object.fromEntries((node?.widgets ?? [])
        .filter((widget) => wanted.has(String(widget.name ?? "")))
        .map((widget) => [widget.name, widget.value]));
}

export function collectProjectReferences(editorNode, plan) {
    const root = editorNode?.graph?.rootGraph ?? editorNode?.graph;
    const shots = plan?.shots ?? [];
    const shared = promptText(plan?.prompt_prefix ?? plan?.global_prompt);
    const records = [];
    for (const node of allNodes(root)) {
        if (["MiniMaxH3ReferenceToVideo", "MiniMaxH3ImageToVideo"].includes(nodeType(node))) {
            records.push(...coreReferenceRecords(node, plan));
            continue;
        }
        const descriptor = REFERENCE_TYPES.get(nodeType(node));
        if (!descriptor) continue;
        const tag = cleanTag(widgetValue(node, descriptor.tag, ""));
        if (!tag) continue;
        const selector = descriptor.scheduled
            ? String(widgetValue(node, "scenes", "all") || "all") : "prompt tag";
        const activeScenes = [];
        for (let offset = 0; offset < shots.length; offset += 1) {
            const prompt = [shared, promptText(shots[offset]?.prompt)]
                .filter(Boolean).join("\n\n");
            const active = descriptor.scheduled
                ? activeSelector(selector, offset + 1)
                : usedByPrompt(prompt, tag, descriptor.semanticOnly);
            if (active) activeScenes.push(offset + 1);
        }
        const asset = mediaAsset(node, descriptor.kind);
        records.push({
            kind:descriptor.kind,
            tag,
            native_token:descriptor.semanticOnly ? null : `@${tag}`,
            semantic_token:(descriptor.semantic || descriptor.semanticOnly)
                ? `#${tag}[0.00s]` : null,
            semantic_only:Boolean(descriptor.semanticOnly),
            selector,
            active_scenes:activeScenes,
            source:mediaLabel(asset),
            asset,
            node_type:nodeType(node),
            semantics:semanticFields(node),
        });
    }
    return records;
}

export function bridgeProjectId(bridgeNode, planNode) {
    return String(widgetValue(bridgeNode, "project_id", "")).trim()
        || String(widgetValue(planNode, "run_name", "")).trim();
}

export function buildProjectPayload(editorNode, state, bridgeNode) {
    const plan = state?.plan;
    const shared = plan?.prompt_prefix ?? plan?.global_prompt;
    return {
        project_id:bridgeProjectId(bridgeNode, state?.planNode),
        shared_prompt:promptText(shared),
        scenes:(plan?.shots ?? []).map((shot, offset) => ({
            id:String(shot?.id || `clip_${String(offset + 1).padStart(4, "0")}`),
            prompt:promptText(shot?.prompt),
            metadata:Object.fromEntries(Object.entries(shot ?? {}).filter(
                ([key]) => key !== "prompt",
            )),
        })),
        references:collectProjectReferences(editorNode, plan),
    };
}

export function applyPromptChanges(plan, changes) {
    if (!Array.isArray(plan?.shots) || !Array.isArray(changes)) {
        throw new Error("The live H3 Plan or Grok change set is invalid.");
    }
    const byId = new Map(plan.shots.map((shot, index) => [
        String(shot?.id || `clip_${String(index + 1).padStart(4, "0")}`),
        shot,
    ]));
    let applied = 0;
    for (const change of changes) {
        const shot = byId.get(String(change?.scene_id ?? ""));
        if (!shot) throw new Error(`Scene ${change?.scene_id ?? "?"} no longer exists.`);
        const prompt = String(change?.prompt ?? "").replace(/\r\n?/g, "\n");
        const current = promptText(shot.prompt);
        if (current === prompt) continue;
        shot.prompt = prompt.split("\n");
        applied += 1;
    }
    return applied;
}
