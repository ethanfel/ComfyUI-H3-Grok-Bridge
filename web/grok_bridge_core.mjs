export const BRIDGE_NODE_TYPE = "MiniMaxH3GrokBridge";
export const PROJECT_ASSET_MANAGER_TYPE = "MiniMaxH3ProjectAssetManager";
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
    if (linkId == null) return null;
    return graph?.links?.get?.(linkId) ?? graph?.links?.[linkId] ?? null;
}

function graphLinks(graph) {
    if (graph?.links?.values) return [...graph.links.values()];
    return Object.values(graph?.links ?? {});
}

const TRANSPARENT_REROUTE_TYPES = new Set(["Reroute", "Reroute (rgthree)"]);
const SUBGRAPH_INPUT_ID = "-10";
const SUBGRAPH_OUTPUT_ID = "-20";

function isGraphIoNode(id, expected) {
    return String(id) === expected;
}

function rootGraph(graph) {
    return graph?.rootGraph ?? graph ?? null;
}

function graphDescendants(graph, seen = new Set()) {
    if (!graph?._nodes || seen.has(graph)) return [];
    seen.add(graph);
    const result = [];
    for (const node of graph._nodes) {
        if (!node?.subgraph || seen.has(node.subgraph)) continue;
        result.push(node.subgraph);
        result.push(...graphDescendants(node.subgraph, seen));
    }
    return result;
}

function subgraphHostNode(graph) {
    if (!graph) return null;
    const root = rootGraph(graph);
    if (!root || graph === root) return null;
    for (const candidate of [root, ...graphDescendants(root)]) {
        const host = candidate?._nodes?.find((node) => node?.subgraph === graph);
        if (host) return host;
    }
    return null;
}

function connectionFromLink(graph, link) {
    if (!graph || !link) return null;
    if (isGraphIoNode(link.origin_id, SUBGRAPH_INPUT_ID)) {
        const host = subgraphHostNode(graph);
        const input = host?.inputs?.[Number(link.origin_slot ?? 0)];
        return connectionFromLink(host?.graph, graphLink(host?.graph, input?.link));
    }
    const source = graph.getNodeById?.(link.origin_id) ?? null;
    return source ? {source, originSlot:Number(link.origin_slot ?? 0)} : null;
}

function subgraphOutputConnection(node, originSlot) {
    const graph = node?.subgraph;
    if (!graph) return null;
    const slotIndex = Number(originSlot ?? 0);
    const slot = graph.outputs?.[slotIndex] ?? graph.outputNode?.slots?.[slotIndex];
    const linked = (slot?.linkIds ?? [])
        .map((linkId) => graphLink(graph, linkId)).filter(Boolean);
    const candidates = linked.length ? linked : graphLinks(graph).filter(
        (link) => isGraphIoNode(link?.target_id, SUBGRAPH_OUTPUT_ID)
            && Number(link?.target_slot ?? -1) === slotIndex,
    );
    const link = candidates.find(
        (item) => isGraphIoNode(item?.target_id, SUBGRAPH_OUTPUT_ID)
            && Number(item?.target_slot ?? -1) === slotIndex,
    ) ?? candidates[0];
    return connectionFromLink(graph, link);
}

function directInputConnection(node, name = null) {
    const input = name === null
        ? node?.inputs?.find((item) => item.link != null)
        : node?.inputs?.find((item) => item.name === name);
    return connectionFromLink(node?.graph, graphLink(node?.graph, input?.link));
}

function graphAncestors(graph) {
    if (!graph) return [];
    const result = [];
    const seen = new Set();
    let current = graph;
    while (current && !seen.has(current)) {
        result.push(current);
        seen.add(current);
        const host = subgraphHostNode(current);
        current = host?.graph ?? null;
    }
    return result;
}

function setGetName(node) {
    return String(node?.widgets?.[0]?.value ?? "");
}

function setNodeFor(getNode) {
    const name = setGetName(getNode);
    if (!name) return null;
    for (const graph of graphAncestors(getNode?.graph)) {
        const setter = graph?._nodes?.find(
            (node) => nodeType(node) === "SetNode" && setGetName(node) === name,
        );
        if (setter) return setter;
    }
    return null;
}

function transparentInputConnection(node, originSlot = 0) {
    if (node?.subgraph) return subgraphOutputConnection(node, originSlot);
    const type = nodeType(node);
    if (type === "GetNode") {
        const setter = setNodeFor(node);
        return setter ? directInputConnection(setter) : null;
    }
    if (type === "SetNode" || TRANSPARENT_REROUTE_TYPES.has(type)) {
        return directInputConnection(node);
    }
    return null;
}

function inputConnection(node, name) {
    let current = directInputConnection(node, name);
    const seen = new Set();
    while (current?.source && !seen.has(current.source)) {
        seen.add(current.source);
        const next = transparentInputConnection(current.source, current.originSlot);
        if (!next) break;
        current = next;
    }
    return current;
}

function inputSource(node, name) {
    return inputConnection(node, name)?.source ?? null;
}

function upstreamNode(start, wantedType) {
    const queue = [start];
    const seen = new Set();
    while (queue.length) {
        const node = queue.shift();
        if (!node || seen.has(node)) continue;
        seen.add(node);
        if (node !== start && nodeType(node) === wantedType) return node;
        for (const input of node.inputs ?? []) {
            const parent = inputSource(node, input.name);
            if (parent) queue.push(parent);
        }
    }
    return null;
}

export function upstreamBridge(start) {
    return upstreamNode(start, BRIDGE_NODE_TYPE);
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
        `(^|[^A-Za-z0-9_])#${escaped}`
        + `(?:\\[[0-9]+(?:\\.[0-9]+)?s?\\]|(?!\\[))(?![A-Za-z0-9_-])`,
        "i",
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

function projectCatalog(node) {
    if (nodeType(node) !== PROJECT_ASSET_MANAGER_TYPE) return null;
    try {
        const value = JSON.parse(String(widgetValue(node, "catalog_json", "")));
        return value && Array.isArray(value.assets) ? value : null;
    } catch (_error) {
        return null;
    }
}

function projectAssetKind(asset) {
    if (["picture", "semantic_anchor"].includes(asset?.role)) return "picture";
    if (asset?.role === "motion") return "motion";
    if (asset?.role === "video") return "video";
    if (asset?.role === "audio_reference") return "audio";
    if (asset?.role === "source_track" && asset?.kind === "video") return "video";
    if (asset?.role === "source_track" && asset?.kind === "audio") return "audio";
    return null;
}

function projectAssetDescriptor(catalog, asset) {
    const relative = String(asset?.relative_path ?? "").replaceAll("\\", "/");
    const filename = String(asset?.original_name || relative.split("/").pop() || "");
    return {
        provider:"h3_project_assets",
        project:String(catalog?.project ?? ""),
        asset_id:String(asset?.id ?? ""),
        filename,
        mime_type:String(asset?.mime_type ?? ""),
        sha256:String(asset?.sha256 ?? ""),
    };
}

export function projectAssetReferenceRecords(manager, plan) {
    const catalog = projectCatalog(manager);
    if (!catalog) return [];
    const shots = plan?.shots ?? [];
    const shared = promptText(plan?.prompt_prefix ?? plan?.global_prompt);
    const managerSemantics = semanticFields(manager);
    const result = [];
    for (const entry of catalog.assets) {
        if (!entry?.enabled) continue;
        const kind = projectAssetKind(entry);
        const tag = cleanTag(entry.tag);
        if (!kind || !tag) continue;
        const semanticOnly = entry.role === "semantic_anchor";
        const sourceTrack = entry.role === "source_track";
        const activeScenes = sourceTrack
            ? shots.map((_shot, offset) => offset + 1)
            : shots.flatMap((shot, offset) => {
                const prompt = [shared, promptText(shot?.prompt)]
                    .filter(Boolean).join("\n\n");
                return usedByPrompt(prompt, tag, semanticOnly) ? [offset + 1] : [];
            });
        result.push({
            kind,
            tag,
            native_token:semanticOnly || sourceTrack ? null : `@${tag}`,
            semantic_token:kind === "picture" && !sourceTrack ? `#${tag}` : null,
            semantic_only:semanticOnly,
            selector:sourceTrack ? "project source track"
                : semanticOnly ? "semantic prompt tag" : "prompt tag",
            active_scenes:activeScenes,
            source:`H3 Project Assets “${catalog.project}” / ${entry.original_name || tag}`,
            asset:projectAssetDescriptor(catalog, entry),
            node_type:PROJECT_ASSET_MANAGER_TYPE,
            semantics:{
                project_asset_role:String(entry.role ?? ""),
                ...managerSemantics,
                ...(entry.options && typeof entry.options === "object" ? entry.options : {}),
            },
        });
    }
    return result;
}

export function collectProjectReferences(editorNode, plan) {
    const root = editorNode?.graph?.rootGraph ?? editorNode?.graph;
    const shots = plan?.shots ?? [];
    const shared = promptText(plan?.prompt_prefix ?? plan?.global_prompt);
    const manager = upstreamNode(editorNode, PROJECT_ASSET_MANAGER_TYPE);
    const managed = projectAssetReferenceRecords(manager, plan);
    const managedTags = new Set(managed.map((record) => record.tag.toLowerCase()));
    const records = [...managed];
    for (const node of allNodes(root)) {
        if (["MiniMaxH3ReferenceToVideo", "MiniMaxH3ImageToVideo"].includes(nodeType(node))) {
            records.push(...coreReferenceRecords(node, plan));
            continue;
        }
        const descriptor = REFERENCE_TYPES.get(nodeType(node));
        if (!descriptor) continue;
        const tag = cleanTag(widgetValue(node, descriptor.tag, ""));
        if (!tag) continue;
        if (managedTags.has(tag.toLowerCase())) continue;
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
                ? `#${tag}` : null,
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
