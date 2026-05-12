/*\
title: $:/plugins/rimir/mindmap/producers/knowledge-tree.js
type: application/javascript
module-type: mindmap-producer

Producer for the rimir/knowledge-app data model. Builds an MDOM tree from
title-path segmentation of all notes under an area, enriched with type icons
and area colour from knowledge-app's metadata tiddlers.

Args:
  area        : (required) area id (e.g. "llm", "health"). Resolves to the
                area tiddler tagged $:/tags/rimir/knowledge-app/area whose
                "area-id" field matches. Determines the title prefix used as
                the tree root.
  delimiter   : path delimiter, default "/"
  include-areas-root : if "yes", build a tree of ALL areas; `area` is ignored.

Node IDs are prefixed "kt:". Tiddler-bearing nodes get attrs:
  core:tiddler  — the source title
  core:icon     — emoji from knowledge-app's type registry (when kn.type matches)
  core:color    — colour from the area's `color` field
  core:caption  — area caption for the root

\*/

"use strict";

var filterTree = require("$:/plugins/rimir/mindmap/producers/filter-tree.js");
var sanitizeLib = require("$:/plugins/rimir/mindmap/lib/sanitize-title.js");

var PRODUCER_NAME = "knowledge-tree";
var ID_PREFIX = "kt:";
var TYPES_TIDDLER = "$:/config/rimir/knowledge-app/types";
var AREA_TAG = "$:/tags/rimir/knowledge-app/area";
// IDs starting with __ are synthetic roots that don't correspond to any
// real tiddler (e.g. "__knowledge__" forest root, "__empty__", "__root__").
function isSyntheticId(id) {
    return !id || id.indexOf("__") === 0;
}
function titleFromId(id) {
    if (!id || id.indexOf(ID_PREFIX) !== 0) { return null; }
    var rest = id.substring(ID_PREFIX.length);
    if (isSyntheticId(rest)) { return null; }
    return rest;
}
function parentTitle(title) {
    if (!title) { return null; }
    var i = title.lastIndexOf("/");
    return i < 0 ? null : title.substring(0, i);
}
function leafSegment(title) {
    if (!title) { return null; }
    var i = title.lastIndexOf("/");
    return i < 0 ? title : title.substring(i + 1);
}

function trim(s) { return (s || "").replace(/^\s+|\s+$/g, ""); }

function readTypeIndex(wiki) {
    var text = wiki.getTiddlerText(TYPES_TIDDLER, "");
    if (!text) { return Object.create(null); }
    try {
        var arr = JSON.parse(text);
        var index = Object.create(null);
        for (var i = 0; i < arr.length; i++) {
            var entry = arr[i];
            if (entry && entry.id) { index[entry.id] = entry; }
        }
        return index;
    } catch (e) {
        return Object.create(null);
    }
}

function readAreas(wiki) {
    var titles = wiki.filterTiddlers("[all[shadows+tiddlers]tag[" + AREA_TAG + "]]");
    var areas = [];
    for (var i = 0; i < titles.length; i++) {
        var tiddler = wiki.getTiddler(titles[i]);
        if (!tiddler) { continue; }
        areas.push({
            title: titles[i],
            id: trim(tiddler.fields["area-id"] || ""),
            caption: trim(tiddler.fields.caption || ""),
            icon: trim(tiddler.fields.icon || ""),
            color: trim(tiddler.fields.color || ""),
            description: trim(tiddler.fields.description || "")
        });
    }
    return areas;
}

function findAreaById(areas, id) {
    for (var i = 0; i < areas.length; i++) {
        if (areas[i].id === id) { return areas[i]; }
    }
    return null;
}

// Recursively rewrite node ids from the filter-tree ft: prefix to kt:, and
// enrich attrs from the type / area registries.
// `opts.isAreaRoot` is true only for the area's top-level node — colour is
// applied there and not propagated to descendants, so mind-elixir's per-branch
// palette can take over below.
function enrich(node, opts) {
    if (!node) { return; }
    if (node.id && node.id.indexOf(filterTree._idPrefix) === 0) {
        node.id = ID_PREFIX + node.id.substring(filterTree._idPrefix.length);
    }
    node.attrs = node.attrs || {};
    if (opts.isAreaRoot && opts.areaColor) { node.attrs["core:color"] = opts.areaColor; }
    var sourceTitle = node.attrs["core:tiddler"];
    if (sourceTitle) {
        var tiddler = opts.wiki.getTiddler(sourceTitle);
        if (tiddler) {
            var knType = trim(tiddler.fields["kn.type"] || "");
            var typeEntry = knType && opts.typeIndex[knType];
            if (typeEntry) {
                node.attrs["core:icon"] = typeEntry.icon;
                node.attrs["kn:type"] = knType;
            }
            var knTier = trim(tiddler.fields["kn.tier"] || "");
            if (knTier) { node.attrs["kn:tier"] = knTier; }
            // Tooltip surfaced via DOM title attribute by the engine adapter.
            // Format: "Note (note)" or "Note (note) — permanent". Falls back
            // to just the kn.type id when the type isn't in the registry.
            var tipParts = [];
            if (typeEntry) { tipParts.push(typeEntry.caption + " (" + knType + ")"); }
            else if (knType) { tipParts.push(knType); }
            if (knTier) { tipParts.push("— " + knTier); }
            tipParts.push("→ " + sourceTitle);
            node.attrs["core:tooltip"] = tipParts.join(" ");
        }
    }
    var children = node.children || [];
    if (children.length === 0) { return; }
    var childOpts = opts.isAreaRoot ? Object.assign({}, opts, { isAreaRoot: false }) : opts;
    for (var i = 0; i < children.length; i++) { enrich(children[i], childOpts); }
}

// Rewrite each tiddler-bearing node's `label` to the value of `labelField`.
// Fallback rules:
//   labelField === "caption" and field is empty → keep the title-segment
//     label (the natural identity) and stamp `mm:label-derived = "title"`
//     so UI can style it muted.
//   any other field empty → label becomes "UNDEFINED" + stamp
//     `mm:label-status = "undefined"`. Engines can render that distinctly.
function relabelTree(node, labelField, wiki) {
    if (!node) { return; }
    var sourceTitle = node.attrs && node.attrs["core:tiddler"];
    if (sourceTitle) {
        var tiddler = wiki.getTiddler(sourceTitle);
        var raw = tiddler ? trim(tiddler.fields[labelField] || "") : "";
        if (raw) {
            node.label = raw;
        } else if (labelField === "caption") {
            node.attrs = node.attrs || {};
            node.attrs["mm:label-derived"] = "title";
        } else {
            node.label = "UNDEFINED";
            node.attrs = node.attrs || {};
            node.attrs["mm:label-status"] = "undefined";
        }
    }
    var children = node.children || [];
    for (var i = 0; i < children.length; i++) { relabelTree(children[i], labelField, wiki); }
}

exports.name = PRODUCER_NAME;

exports.describe = function () {
    return {
        name: PRODUCER_NAME,
        args: [
            { key: "area",      required: true,  description: "Knowledge area id (e.g. 'llm'). Determines the title prefix used as the tree root." },
            { key: "delimiter", default: "/",    description: "Path delimiter (default '/')" },
            { key: "include-areas-root", default: "no", description: "If 'yes', render a forest of all areas. The `area` arg is ignored." },
            { key: "label-field", default: "title", description: "Tiddler field used as the visible node label. 'title' (default) uses the leaf path-segment; 'caption' (or any other field) decouples display from the structural identity — rename only edits the chosen field, title is preserved." }
        ]
    };
};

exports.produce = function (args, wiki) {
    args = args || {};
    var typeIndex = readTypeIndex(wiki);
    var areas = readAreas(wiki);
    var delimiter = args.delimiter || "/";

    // Forest mode: all areas under a synthetic "Knowledge" root.
    if (args["include-areas-root"] === "yes" || args["include-areas-root"] === true) {
        var rootChildren = [];
        for (var i = 0; i < areas.length; i++) {
            var area = areas[i];
            if (!area.id) { continue; }
            var areaPrefix = "knowledge" + delimiter + area.id + delimiter;
            var titles = wiki.filterTiddlers("[all[shadows+tiddlers]prefix[" + areaPrefix + "]]");
            var areaRoot = filterTree._buildTree(titles, {
                delimiter: delimiter,
                _rootPrefix: ["knowledge", area.id],
                "root-label": area.caption || area.id,
                "body-field": "text"
            }, wiki);
            enrich(areaRoot, { wiki: wiki, typeIndex: typeIndex, areaColor: area.color, isAreaRoot: true });
            areaRoot.attrs = areaRoot.attrs || {};
            if (area.icon) { areaRoot.attrs["core:icon"] = area.icon; }
            rootChildren.push(areaRoot);
        }
        var forestLabelField = trim(args["label-field"] || "");
        if (forestLabelField && forestLabelField !== "title") {
            for (var fri = 0; fri < rootChildren.length; fri++) {
                relabelTree(rootChildren[fri], forestLabelField, wiki);
            }
        }
        return {
            version: 1,
            root: {
                id: ID_PREFIX + "__knowledge__",
                label: "Knowledge",
                children: rootChildren,
                attrs: { "core:synthetic": true }
            },
            meta: { producer: PRODUCER_NAME, producedAt: Date.now() }
        };
    }

    // Single-area mode.
    var areaId = trim(args.area || "");
    if (!areaId) {
        throw new Error("knowledge-tree: 'area' argument is required");
    }
    var areaMeta = findAreaById(areas, areaId);
    var areaPrefix = "knowledge" + delimiter + areaId;

    // Focus mode: re-root the MDOM at a deeper title under the area. The
    // focus-title arg is the full tiddler title (e.g. "knowledge/llm/agents")
    // and must be the area itself OR a descendant of it; anything else is
    // ignored (back to area-level view). When focused, the focused tiddler
    // becomes the new root and only its descendants are included.
    var focusTitle = trim(args["focus-title"] || "");
    var rootTitle;
    var rootPrefixSegments;
    var prefix;
    if (focusTitle && (focusTitle === areaPrefix || focusTitle.indexOf(areaPrefix + delimiter) === 0)
            && wiki.getTiddler(focusTitle)) {
        rootTitle = focusTitle;
        rootPrefixSegments = focusTitle.split(delimiter);
        prefix = focusTitle + delimiter;
    } else {
        rootTitle = areaPrefix;
        rootPrefixSegments = ["knowledge", areaId];
        prefix = areaPrefix + delimiter;
    }

    var titles = wiki.filterTiddlers("[all[shadows+tiddlers]prefix[" + prefix + "]]");

    // For the focused-subtree case we pick a label from the focus tiddler's
    // caption (or its leaf segment if no caption). For area-level view we
    // use the area's caption (existing behaviour).
    var rootLabel;
    if (focusTitle && rootTitle !== areaPrefix) {
        var focusTid = wiki.getTiddler(focusTitle);
        rootLabel = (focusTid && trim(focusTid.fields.caption || "")) || focusTitle.split(delimiter).pop();
    } else {
        rootLabel = (areaMeta && areaMeta.caption) || areaId;
    }

    var root = filterTree._buildTree(titles, {
        delimiter: delimiter,
        _rootPrefix: rootPrefixSegments,
        "root-label": rootLabel,
        "body-field": "text"
    }, wiki);
    // filter-tree skips the root tiddler itself (zero-segment path after the
    // prefix strip), so its metadata isn't attached automatically. Stamp
    // core:tiddler manually so enrich picks up the focused tiddler's icon /
    // kn.type / tooltip.
    if (wiki.getTiddler(rootTitle)) {
        root.attrs = root.attrs || {};
        root.attrs["core:tiddler"] = rootTitle;
    }
    enrich(root, { wiki: wiki, typeIndex: typeIndex, areaColor: areaMeta && areaMeta.color, isAreaRoot: true });
    root.attrs = root.attrs || {};
    if (areaMeta && areaMeta.icon) { root.attrs["core:icon"] = areaMeta.icon; }
    if (areaMeta && areaMeta.description) { root.attrs["core:description"] = areaMeta.description; }
    if (focusTitle && rootTitle !== areaPrefix) {
        root.attrs["mm:focused"] = focusTitle;
    }
    // Optional re-labeling: when the view picks a non-title field (e.g.
    // caption) as the visible label, rewrite each tiddler-bearing node's
    // label from that field. Title stays the structural identity.
    var labelField = trim(args["label-field"] || "");
    if (labelField && labelField !== "title") {
        relabelTree(root, labelField, wiki);
    }

    return {
        version: 1,
        root: root,
        meta: {
            producer: PRODUCER_NAME,
            producedAt: Date.now(),
            source: "area=" + areaId
        }
    };
};

// -------------------------------------------------------------------------
// Structural write-back path
// -------------------------------------------------------------------------
//
// The widget routes selected ops here (per structural-ops.routeOp) so the
// mindmap acts as an authoring surface for real knowledge tiddlers.
// Drag-reparent → rename tiddler title; rename → rename tiddler leaf
// segment; removeNode → delete tiddler subtree. addNode is wired up by
// Landing B (popup-edit-modal integration).

exports.capabilities = {
    structural: true,
    structuralOps: ["rename", "reparent", "removeNode", "addNode"]
};

// Config tiddler titles read by applyOps. Defaults shipped as plugin
// tiddlers; users can override in the wiki.
var CONFIG_NEW_NODE_STRATEGY = "$:/config/rimir/mindmap/structural/new-node-type-strategy";
var CONFIG_NEW_NODE_TYPE_DEFAULT = "$:/config/rimir/mindmap/structural/new-node-type-default";

// Pick the kn.type for a newly-created node.
// Strategy "fixed:<type>" → always use that type.
// Strategy "derive-from-parent" → read parent tiddler's kn.type; fallback to
//   the configured default; ultimate fallback to "note".
function chooseNewNodeType(wiki, parentTitle) {
    var strategy = trim(wiki.getTiddlerText(CONFIG_NEW_NODE_STRATEGY, "fixed:note"));
    var defaultType = trim(wiki.getTiddlerText(CONFIG_NEW_NODE_TYPE_DEFAULT, "note")) || "note";
    if (strategy.indexOf("fixed:") === 0) {
        return strategy.substring("fixed:".length) || defaultType;
    }
    if (strategy === "derive-from-parent" && parentTitle) {
        var parent = wiki.getTiddler(parentTitle);
        if (parent) {
            var parentType = trim(parent.fields["kn.type"] || "");
            if (parentType) { return parentType; }
        }
    }
    return defaultType;
}

// Return the "root" title for the given args — the title that would be the
// MDOM root with NO focus applied. Used by widget step-out-one to detect
// whether the parent of the current focus is at or above the natural root.
exports.rootTitle = function (args) {
    args = args || {};
    if (args["include-areas-root"] === "yes" || args["include-areas-root"] === true) {
        return null;
    }
    var delimiter = args.delimiter || "/";
    var areaId = trim(args.area || "");
    return areaId ? ("knowledge" + delimiter + areaId) : null;
};

// Used by structural-ops.routeOp to count cascade victims before applying.
exports.titleForOp = function (op) {
    if (!op) { return null; }
    if (op.op === "addNode") {
        // addNode targets the (about-to-be-created) child of `parent`; no
        // pre-existing descendants to cascade.
        return null;
    }
    return titleFromId(op.id);
};

// Gather the set of direct-child leaf slugs under `parentPath` so we can
// uniquify a fresh slug without colliding. Returns an Object map.
function siblingSlugs(wiki, parentPath, excludeLeaf) {
    if (!parentPath) { return Object.create(null); }
    var filter = "[all[shadows+tiddlers]prefix[" + parentPath + "/]" +
        "removeprefix[" + parentPath + "/]splitbefore[/]]";
    var slugs = wiki.filterTiddlers(filter);
    var set = Object.create(null);
    for (var i = 0; i < slugs.length; i++) {
        var s = slugs[i];
        // splitbefore[/] returns the segment up to and including the slash for
        // intermediate paths, or the full string for leaves. Strip a trailing
        // "/" to normalise.
        if (s.charAt(s.length - 1) === "/") { s = s.substring(0, s.length - 1); }
        if (s && s !== excludeLeaf) { set[s] = true; }
    }
    return set;
}

function renameOrReparent(wiki, oldTitle, newTitle) {
    if (oldTitle === newTitle) { return { changed: false, oldTitle: oldTitle, newTitle: newTitle }; }
    // TW core's wiki.renameTiddler MOVES the tiddler AND calls relinkTiddler
    // internally for tag/list references. flibbles/relink monkey-patches it
    // to also rewrite wikitext refs and pragmas; flibbles/relink-titles adds
    // descendant cascade so `wiki.renameTiddler("a/b", "a/c")` also renames
    // `a/b/x` → `a/c/x`. Single call covers all three layers.
    if (typeof wiki.renameTiddler === "function") {
        if (!wiki.getTiddler(oldTitle)) { return { changed: false, error: "missing source" }; }
        wiki.renameTiddler(oldTitle, newTitle);
    } else {
        // Last-ditch fallback: vanilla TW always has renameTiddler so this is
        // unreachable in practice. Kept for robustness.
        var t = wiki.getTiddler(oldTitle);
        if (!t) { return { changed: false, error: "missing source" }; }
        var fields = Object.create(null);
        for (var k in t.fields) { fields[k] = t.fields[k]; }
        fields.title = newTitle;
        wiki.addTiddler(new $tw.Tiddler(fields));
        wiki.deleteTiddler(oldTitle);
    }
    return { changed: true, oldTitle: oldTitle, newTitle: newTitle };
}

function applyRename(op, wiki, args) {
    var oldTitle = titleFromId(op.id);
    if (!oldTitle) { return { skipped: "no-source-title", op: op }; }
    // Label-field mode: rename only mutates the chosen field. Title (=
    // structural identity) is left alone, so descendants don't cascade and
    // references stay intact. Used when `mm.label-field` is e.g. `caption`.
    var labelField = trim((args && args["label-field"]) || "");
    if (labelField && labelField !== "title") {
        var tiddler = wiki.getTiddler(oldTitle);
        if (!tiddler) { return { skipped: "tiddler-missing", op: op }; }
        var newValue = trim(op.label || "");
        var newFields = {};
        newFields[labelField] = newValue;
        wiki.addTiddler(new $tw.Tiddler(tiddler, newFields, wiki.getModificationFields()));
        return { changed: true, op: op, field: labelField, value: newValue };
    }
    // Title-mode (default): rewrite the leaf segment and cascade.
    var parent = parentTitle(oldTitle);
    if (!parent) { return { skipped: "no-parent-context", op: op }; }
    var slug = sanitizeLib.sanitize(op.label);
    if (!slug) { return { skipped: "empty-slug", op: op }; }
    var siblings = siblingSlugs(wiki, parent, leafSegment(oldTitle));
    var finalSlug = sanitizeLib.uniquify(slug, siblings);
    var newTitle = parent + "/" + finalSlug;
    var result = renameOrReparent(wiki, oldTitle, newTitle);
    result.collisionResolved = (finalSlug !== slug);
    result.wanted = slug;
    result.parent = parent;
    return result;
}

function applyReparent(op, wiki) {
    var oldTitle = titleFromId(op.id);
    var newParent = titleFromId(op.newParent);
    if (!oldTitle) { return { skipped: "no-source-title", op: op }; }
    if (!newParent) { return { skipped: "no-new-parent-title", op: op }; }
    var leaf = leafSegment(oldTitle);
    var currentParent = parentTitle(oldTitle);
    // Identity reparent: source already lives directly under newParent.
    if (currentParent === newParent) { return { changed: false, op: op }; }
    // siblings under newParent — DO NOT exclude `leaf` here: if a different
    // tiddler with the same leaf already lives under newParent (e.g. two
    // distinct `foo`s under different parents), we want uniquify to fire.
    // The source itself isn't in newParent's siblings since its current
    // parent differs (identity case above is the only exception, handled).
    var siblings = siblingSlugs(wiki, newParent, null);
    var finalLeaf = sanitizeLib.uniquify(leaf, siblings);
    var newTitle = newParent + "/" + finalLeaf;
    if (newTitle === oldTitle) { return { changed: false, op: op }; }
    var result = renameOrReparent(wiki, oldTitle, newTitle);
    result.collisionResolved = (finalLeaf !== leaf);
    result.wanted = leaf;
    result.parent = newParent;
    return result;
}

function applyAddNode(op, wiki, args) {
    var parentTitle = titleFromId(op.parent);
    if (!parentTitle) { return { skipped: "no-parent-title", op: op }; }
    var rawLabel = op.node && op.node.label;
    var slug = sanitizeLib.sanitize(rawLabel);
    if (!slug) { return { skipped: "empty-slug", op: op }; }
    var siblings = siblingSlugs(wiki, parentTitle, null);
    var finalSlug = sanitizeLib.uniquify(slug, siblings);
    var newTitle = parentTitle + "/" + finalSlug;
    if (wiki.getTiddler(newTitle)) {
        // Should not happen given uniquify, but defensive: refuse to overwrite.
        return { skipped: "title-already-exists", op: op };
    }
    var knType = chooseNewNodeType(wiki, parentTitle);
    var fields = {
        title: newTitle,
        "kn.type": knType,
        "kn.tier": "fleeting",
        tags: "$:/tags/rimir/knowledge-app/note",
        text: ""
    };
    // Label-field mode: also stash the typed (unsanitized) label on the
    // chosen field so the node's visible name matches what the user typed,
    // not the sanitized title-segment.
    var labelField = trim((args && args["label-field"]) || "");
    if (labelField && labelField !== "title") {
        fields[labelField] = trim(rawLabel || "");
    }
    wiki.addTiddler(new $tw.Tiddler(wiki.getCreationFields(), fields, wiki.getModificationFields()));
    return {
        changed: true,
        op: op,
        newTitle: newTitle,
        knType: knType,
        collisionResolved: (finalSlug !== slug),
        wanted: slug,
        parent: parentTitle
    };
}

function applyRemoveNode(op, wiki) {
    var title = titleFromId(op.id);
    if (!title) { return { skipped: "no-source-title", op: op }; }
    // Enumerate descendants first; relink-titles handles RENAME cascade but
    // not delete cascade, so we walk bottom-up explicitly. Sort by length
    // descending = deepest first.
    var descendants = wiki.filterTiddlers("[all[tiddlers]prefix[" + title + "/]]");
    descendants.sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < descendants.length; i++) {
        wiki.deleteTiddler(descendants[i]);
    }
    wiki.deleteTiddler(title);
    return { changed: true, deleted: descendants.length + 1, op: op };
}

exports.applyOps = function (ops, args, wiki) {
    if (!ops || !ops.length) { return []; }
    var results = [];
    for (var i = 0; i < ops.length; i++) {
        var op = ops[i];
        try {
            switch (op.op) {
                case "rename":     results.push(applyRename(op, wiki, args)); break;
                case "reparent":   results.push(applyReparent(op, wiki)); break;
                case "removeNode": results.push(applyRemoveNode(op, wiki)); break;
                case "addNode":    results.push(applyAddNode(op, wiki, args)); break;
                default: results.push({ skipped: "unsupported-op", op: op });
            }
        } catch (e) {
            console.error("[knowledge-tree.applyOps]", op, e);
            results.push({ error: e.message || String(e), op: op });
        }
    }
    return results;
};

// Exposed for tests.
exports._titleFromId = titleFromId;
exports._parentTitle = parentTitle;
exports._leafSegment = leafSegment;
exports._siblingSlugs = siblingSlugs;

exports.refreshFilter = function (args) {
    args = args || {};
    var delimiter = args.delimiter || "/";
    if (args["include-areas-root"] === "yes" || args["include-areas-root"] === true) {
        // Any tiddler under knowledge/<area>/ AND area-tagged tiddlers.
        return "[all[shadows+tiddlers]prefix[knowledge" + delimiter + "]] [all[shadows+tiddlers]tag[" + AREA_TAG + "]] [[" + TYPES_TIDDLER + "]]";
    }
    var areaId = trim(args.area || "");
    if (!areaId) { return null; }
    var areaPrefix = "knowledge" + delimiter + areaId;
    var focusTitle = trim(args["focus-title"] || "");
    // When focused on a deeper subtree, narrow the watched set to that
    // subtree (+ the focus tiddler itself + types registry).
    if (focusTitle && (focusTitle === areaPrefix || focusTitle.indexOf(areaPrefix + delimiter) === 0)) {
        return "[all[shadows+tiddlers]prefix[" + focusTitle + delimiter + "]] [[" + focusTitle + "]] [[" + TYPES_TIDDLER + "]]";
    }
    return "[all[shadows+tiddlers]prefix[" + areaPrefix + delimiter + "]] [[" + TYPES_TIDDLER + "]]";
};
