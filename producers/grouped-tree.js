/*\
title: $:/plugins/rimir/mindmap/producers/grouped-tree.js
type: application/javascript
module-type: mindmap-producer

Producer that builds an MDOM by applying one or more ordered axis chains to a
flat leaf set. Designed for "entity + multi-grouping" workflows (e.g. meetings
grouped by year/month/state) where structural nodes are volatile — they have
no tiddler-of-origin and are derived purely from leaves' field values.

The shape of a view is declared by a **template tiddler**:

    mm.template-id            : stable id (defaults to title)
    mm.template-caption       : root label shown in the mindmap
    mm.leaf-filter            : (required) TW filter producing the leaf set
    mm.chains                 : ordered TW list of chain tiddler titles
    mm.initially-disabled-axes: TW list of axis-ids initially toggled off

A **chain tiddler** carries:

    mm.chain-id      : stable id (defaults to title)
    mm.chain-caption : label of the chain's synthetic root node
    mm.axes          : ordered TW list of axis tiddler titles

An **axis tiddler** carries:

    mm.axis-id              : stable id (REQUIRED — referenced from disabled lists)
    mm.axis-caption         : human-readable label for the axis (not yet rendered)
    mm.axis-field           : field on a leaf whose value is the group key
    mm.axis-derive          : optional filter; computes the key from the leaf
                              (currentTiddler = leaf title; first result wins)
    mm.axis-label-template  : optional label template; `<<key>>` is substituted
    mm.axis-create-defaults : JSON: field→value map applied on +child (Phase B)
    mm.axis-leaf-filter     : optional filter narrowing which leaves participate
                              in this axis level; non-matching leaves are dropped
                              from the chain at this depth.

Runtime override: when the state tiddler

    $:/state/rimir/mindmap/<canvas-id>/axes-disabled

is present, its body (TW list of axis-ids) FULLY replaces the template's
`initially-disabled-axes`. State is session-only ($:/state/ doesn't sync).

Producer args:
  template  : (required) template tiddler title
  canvas-id : (default "default") logical canvas key; used to scope runtime state

MDOM ids:
  gt:__root__              — synthetic root (multi-chain only; single-chain
                              collapses the chain root into the producer root)
  gt:chain:<chainId>       — chain synthetic root
  gt:axis:<chainId>:<axisId>:<key>
                           — axis group node (composite key keeps the id unique
                              when the same axis appears in multiple chains)
  gt:leaf:<title>@<chainId>
                           — leaf occurrence; same tiddler can appear once per
                              chain. `core:tiddler` attr carries the title.

This module exposes a read path only. Structural write-back (regroup-on-drag,
context-aware addNode) is wired up in Phase B.

\*/

"use strict";

var groupedTree = require("$:/plugins/rimir/mindmap/lib/grouped-tree.js");

var PRODUCER_NAME = "grouped-tree";
var ID_PREFIX = "gt:";
var STATE_PREFIX = "$:/state/rimir/mindmap/";
var STATE_SUFFIX = "/axes-disabled";

function trim(s) { return (s || "").replace(/^\s+|\s+$/g, ""); }

function parseList(value) {
    return $tw.utils.parseStringArray(value || "");
}

function parseJSON(text) {
    if (!text) { return {}; }
    try { return JSON.parse(text) || {}; } catch (e) { return {}; }
}

function readAxis(wiki, axisTitle) {
    var t = wiki.getTiddler(axisTitle);
    if (!t) { return null; }
    var f = t.fields;
    var id = trim(f["mm.axis-id"]) || axisTitle;
    var sort = trim(f["mm.axis-sort"]) || "first-seen";
    return {
        title: axisTitle,
        id: id,
        caption: trim(f["mm.axis-caption"]) || id,
        field: trim(f["mm.axis-field"]),
        derive: trim(f["mm.axis-derive"]),
        labelTemplate: trim(f["mm.axis-label-template"]),
        createDefaults: parseJSON(trim(f["mm.axis-create-defaults"])),
        leafFilter: trim(f["mm.axis-leaf-filter"]),
        // Sort mode for the group keys produced by this axis:
        //   first-seen (default) — order of first appearance in leaves
        //   asc / desc           — string-compare ascending / descending
        //   enum                 — explicit order from mm.axis-sort-keys; keys
        //                          not listed appear after the enum in alpha order
        sort: sort,
        sortKeys: parseList(f["mm.axis-sort-keys"])
    };
}

function readChain(wiki, chainTitle, seen) {
    seen = seen || Object.create(null);
    if (seen[chainTitle]) { return null; } // cycle guard
    seen[chainTitle] = true;
    var t = wiki.getTiddler(chainTitle);
    if (!t) { return null; }
    var f = t.fields;
    var axisTitles = parseList(f["mm.axes"]);
    var axes = [];
    for (var i = 0; i < axisTitles.length; i++) {
        var ax = readAxis(wiki, axisTitles[i]);
        if (ax) { axes.push(ax); }
    }
    var subChainTitles = parseList(f["mm.sub-chains"]);
    var subChains = [];
    for (var j = 0; j < subChainTitles.length; j++) {
        var sc = readChain(wiki, subChainTitles[j], seen);
        if (sc) { subChains.push(sc); }
    }
    var id = trim(f["mm.chain-id"]) || chainTitle;
    return {
        title: chainTitle,
        id: id,
        caption: trim(f["mm.chain-caption"]) || id,
        // Chain-level leaf filter: narrows the template's leaf set to those
        // this chain cares about (e.g. only meetings). Applied before any
        // axis runs or sub-chain descent. Empty = pass everything through.
        leafFilter: trim(f["mm.leaf-filter"]),
        // Chain-level leaf sort: TW filter that takes the chain's filtered
        // leaves as input and returns them reordered. Applied AFTER leaf-
        // filter and BEFORE the axis pipeline — so within each bucket leaves
        // appear in the sort order (groupBy preserves first-seen). Empty =
        // keep title-alphabetic (whatever the template's leaf-filter
        // returned). Example: `+[nsort[datetime]reverse[]]` (newest first).
        leafSort: trim(f["mm.leaf-sort"]),
        // Either axes (leaf chain — applies them to its leaf set) OR
        // sub-chains (parent chain — recurses, each sub-chain gets the
        // parent's filtered leaf set). When both are set, sub-chains win.
        axes: axes,
        subChains: subChains,
        // "yes" → omit this chain entirely from the rendered tree when its
        // filtered leaf set is empty (and no sub-chain has any leaves). Lets
        // a template ship a chain that only makes sense for some entity
        // types without painting an empty "(0)" branch on the others.
        hideWhenEmpty: trim(f["mm.chain-hide-when-empty"]) === "yes"
    };
}

function readTemplate(wiki, templateTitle) {
    var t = wiki.getTiddler(templateTitle);
    if (!t) { return null; }
    var f = t.fields;
    var chainTitles = parseList(f["mm.chains"]);
    var chains = [];
    for (var i = 0; i < chainTitles.length; i++) {
        var c = readChain(wiki, chainTitles[i]);
        if (c) { chains.push(c); }
    }
    return {
        title: templateTitle,
        id: trim(f["mm.template-id"]) || templateTitle,
        caption: trim(f["mm.template-caption"]) || "Mindmap",
        leafFilter: trim(f["mm.leaf-filter"]),
        chains: chains,
        initiallyDisabled: parseList(f["mm.initially-disabled-axes"]),
        // Axis-ids whose group nodes render collapsed on first draw.
        initiallyCollapsedAxes: parseList(f["mm.initially-collapsed-axes"]),
        // Chain-ids whose chain-root node renders collapsed on first draw.
        initiallyCollapsedChains: parseList(f["mm.initially-collapsed-chains"]),
        // "yes"/"no" — append leaf-count "(N)" to synthetic node labels.
        // Default off (legacy behavior); orga template opts in.
        showCounts: trim(f["mm.show-counts"]) === "yes"
    };
}

// State tiddler, when present, is the authoritative disabled set; absence
// falls back to the template's initially-disabled list. Returning a fresh
// Object map keeps lookup O(1).
function readDisabledSet(wiki, canvasId, templateDisabled) {
    var disabled = Object.create(null);
    var stateTitle = STATE_PREFIX + canvasId + STATE_SUFFIX;
    var stateTid = wiki.getTiddler(stateTitle);
    var source = stateTid
        ? parseList(stateTid.fields.text)
        : templateDisabled;
    for (var i = 0; i < source.length; i++) {
        disabled[source[i]] = true;
    }
    return disabled;
}

// Build the key/label/filter callbacks an axis needs, bound to a wiki +
// widget context. The widget provides the variable scope filters run in —
// so an axis-derive like `[get[datetime]split[-]first[]]` works, AND so
// does a leaf-filter that references caller-set vars like `<entity>`.
function compileAxis(axis, wiki, widget) {
    var deriveFilter = axis.derive;
    var fieldName = axis.field;
    var labelTemplate = axis.labelTemplate;
    var leafFilterExpr = axis.leafFilter;
    var filterWidget = widget || $tw.rootWidget;
    // Filter-style label template: starts with `[`. Evaluated with the key
    // bound as the `key` variable. First result wins. Falls back to the raw
    // key when the filter yields nothing.
    var labelIsFilter = labelTemplate && labelTemplate.charAt(0) === "[";
    return {
        id: axis.id,
        sort: axis.sort,
        sortKeys: axis.sortKeys,
        keyFn: function (leafTitle) {
            if (deriveFilter) {
                var results = wiki.filterTiddlers(
                    deriveFilter,
                    filterWidget,
                    wiki.makeTiddlerIterator([leafTitle])
                );
                return (results && results.length > 0) ? trim(results[0]) : "";
            }
            if (fieldName) {
                var t = wiki.getTiddler(leafTitle);
                return t ? trim(t.fields[fieldName] || "") : "";
            }
            return "";
        },
        labelFn: function (key) {
            if (key === groupedTree.UNSET_KEY) {
                return "(unset)";
            }
            if (!labelTemplate) { return key; }
            if (labelIsFilter) {
                var labelWidget = filterWidget.makeFakeWidgetWithVariables
                    ? filterWidget.makeFakeWidgetWithVariables({ key: key })
                    : filterWidget;
                var out = wiki.filterTiddlers(labelTemplate, labelWidget);
                return (out && out.length > 0) ? out[0] : key;
            }
            return labelTemplate.replace(/<<key>>/g, key);
        },
        leafFilter: leafFilterExpr ? function (leafTitle) {
            var results = wiki.filterTiddlers(
                leafFilterExpr,
                filterWidget,
                wiki.makeTiddlerIterator([leafTitle])
            );
            return results.length > 0;
        } : null
    };
}

// Count the number of leaf descendants under a groupedTree entry.
function countLeaves(entry) {
    if (entry.kind === "leaf") { return 1; }
    var n = 0;
    for (var i = 0; i < entry.children.length; i++) {
        n += countLeaves(entry.children[i]);
    }
    return n;
}

// Recursive walk from groupedTree entries → MDOM nodes. `keyPath` is the
// cumulative list of axis-keys leading to this entry from the chain root —
// embedded in the id so the same key under different ancestors (e.g. "Jan"
// under year 2026 vs 2025) yields distinct node ids.
// `opts`: { collapsedAxes (Set), showCounts (bool) }.
function entryToNode(entry, chainId, wiki, keyPath, opts) {
    if (entry.kind === "leaf") {
        var title = entry.leaf;
        var t = wiki.getTiddler(title);
        var caption = t ? trim(t.fields.caption || "") : "";
        var label = caption || title.split("/").pop();
        return {
            id: ID_PREFIX + "leaf:" + title + "@" + chainId,
            label: label,
            attrs: {
                "core:tiddler": title,
                "gt:chain-id": chainId
            },
            children: []
        };
    }
    // entry.kind === "group"
    var nextPath = keyPath.concat([entry.key]);
    var pathToken = nextPath.join("|");
    var children = [];
    for (var i = 0; i < entry.children.length; i++) {
        children.push(entryToNode(entry.children[i], chainId, wiki, nextPath, opts));
    }
    var count = countLeaves(entry);
    var attrs = {
        "core:synthetic": true,
        "gt:chain-id": chainId,
        "gt:axis-id": entry.axisId,
        "gt:axis-key": entry.key,
        "gt:key-path": pathToken
    };
    if (opts && opts.showCounts) {
        attrs["gt:leaf-count"] = count;
    }
    if (opts && opts.collapsedAxes && opts.collapsedAxes[entry.axisId]) {
        attrs["core:collapsed"] = true;
    }
    return {
        id: ID_PREFIX + "axis:" + chainId + ":" + pathToken,
        label: entry.label,
        attrs: attrs,
        children: children
    };
}

function applyChainLeafFilter(leaves, chain, wiki, widget) {
    if (!chain.leafFilter) { return leaves; }
    var fw = widget || $tw.rootWidget;
    var out = [];
    for (var i = 0; i < leaves.length; i++) {
        var probe = wiki.filterTiddlers(
            chain.leafFilter,
            fw,
            wiki.makeTiddlerIterator([leaves[i]])
        );
        if (probe.length > 0) { out.push(leaves[i]); }
    }
    return out;
}

// Apply the chain's `mm.leaf-sort` filter to its filtered leaves. The filter
// is evaluated with the leaves as INPUT (so `nsort[field]` operates on them)
// rather than per-leaf. We post-filter to titles that exist in the input set
// so a buggy sort filter that synthesizes titles can't smuggle in new
// tiddlers — and we append any leaves the filter dropped (preserving their
// relative order from the input), so a partial sort doesn't silently lose
// data. Empty result with non-empty input is treated as "filter mistake,
// keep input order" to fail safe.
function applyChainLeafSort(leaves, chain, wiki, widget) {
    if (!chain.leafSort || leaves.length === 0) { return leaves; }
    var fw = widget || $tw.rootWidget;
    var inputSet = Object.create(null);
    for (var i = 0; i < leaves.length; i++) { inputSet[leaves[i]] = true; }
    var sorted;
    try {
        sorted = wiki.filterTiddlers(
            chain.leafSort,
            fw,
            wiki.makeTiddlerIterator(leaves)
        );
    } catch (e) {
        return leaves;
    }
    if (!sorted || sorted.length === 0) { return leaves; }
    var out = [];
    var seen = Object.create(null);
    for (var j = 0; j < sorted.length; j++) {
        var t = sorted[j];
        if (inputSet[t] && !seen[t]) { out.push(t); seen[t] = true; }
    }
    // Append any input leaves the sort filter dropped, preserving their
    // input-relative order. Keeps "buckets get all their items" invariant.
    for (var k = 0; k < leaves.length; k++) {
        if (!seen[leaves[k]]) { out.push(leaves[k]); seen[leaves[k]] = true; }
    }
    return out;
}

function buildChainNode(chain, leaves, disabled, wiki, widget, buildOpts) {
    // Chain-level leaf filter narrows the leaf set BEFORE any axis runs OR
    // sub-chain descent. Evaluated per-leaf so the user can write predicate-
    // style filters like `[get[rrt.type]match[meeting]]`.
    var chainLeaves = applyChainLeafFilter(leaves, chain, wiki, widget);
    // Chain-level leaf sort reorders the leaf set AFTER filtering so within
    // each axis bucket leaves appear in the sort order (groupBy preserves
    // first-seen). The sort cascades into sub-chains too (parent's filtered+
    // sorted leaves become the input for each sub-chain).
    chainLeaves = applyChainLeafSort(chainLeaves, chain, wiki, widget);
    var children = [];
    if (chain.subChains && chain.subChains.length > 0) {
        // Parent chain: render each sub-chain as a synthetic child node.
        // The parent's filtered leaf set cascades into every sub-chain.
        for (var s = 0; s < chain.subChains.length; s++) {
            var subNode = buildChainNode(
                chain.subChains[s], chainLeaves, disabled, wiki, widget, buildOpts
            );
            if (subNode) { children.push(subNode); }
        }
    } else {
        // Leaf chain: run the axis pipeline.
        var activeAxes = [];
        for (var i = 0; i < chain.axes.length; i++) {
            if (!disabled[chain.axes[i].id]) {
                activeAxes.push(compileAxis(chain.axes[i], wiki, widget));
            }
        }
        var entries = groupedTree.applyChain(chainLeaves, activeAxes);
        for (var j = 0; j < entries.length; j++) {
            children.push(entryToNode(entries[j], chain.id, wiki, [], buildOpts));
        }
    }
    var leafCount = chainLeaves.length;
    // hide-when-empty opt-in: drop the chain entirely when it would render
    // with zero leaves AND zero child-chain-nodes. Returns null; callers
    // must skip null entries when collecting children.
    if (chain.hideWhenEmpty && leafCount === 0 && children.length === 0) {
        return null;
    }
    var attrs = {
        "core:synthetic": true,
        "gt:chain-id": chain.id,
        "gt:chain": true
    };
    if (buildOpts && buildOpts.showCounts) {
        attrs["gt:leaf-count"] = leafCount;
    }
    if (buildOpts && buildOpts.collapsedChains && buildOpts.collapsedChains[chain.id]) {
        attrs["core:collapsed"] = true;
    }
    return {
        id: ID_PREFIX + "chain:" + chain.id,
        label: chain.caption,
        attrs: attrs,
        children: children
    };
}

function emptyMdom(label) {
    return {
        version: 1,
        root: {
            id: ID_PREFIX + "__empty__",
            label: label || "(empty)",
            attrs: { "core:synthetic": true },
            children: []
        },
        meta: { producer: PRODUCER_NAME, producedAt: Date.now() }
    };
}

// Construct the producer root from a fully-resolved template + disabled set.
// Single chain → root collapses to the chain (with template caption as label);
// multi-chain → root is a synthetic above the chain roots.
function buildRoot(template, leaves, disabled, wiki, widget) {
    if (template.chains.length === 0) {
        return {
            id: ID_PREFIX + "__root__",
            label: template.caption,
            attrs: { "core:synthetic": true },
            children: []
        };
    }
    // Build option bag once so all chain/axis builds share it.
    var collapsedAxes = Object.create(null);
    for (var ca = 0; ca < template.initiallyCollapsedAxes.length; ca++) {
        collapsedAxes[template.initiallyCollapsedAxes[ca]] = true;
    }
    var collapsedChains = Object.create(null);
    for (var cc = 0; cc < template.initiallyCollapsedChains.length; cc++) {
        collapsedChains[template.initiallyCollapsedChains[cc]] = true;
    }
    var buildOpts = {
        collapsedAxes: collapsedAxes,
        collapsedChains: collapsedChains,
        showCounts: template.showCounts
    };
    var chainNodes = [];
    for (var i = 0; i < template.chains.length; i++) {
        var node = buildChainNode(template.chains[i], leaves, disabled, wiki, widget, buildOpts);
        if (node) { chainNodes.push(node); }
    }
    if (template.chains.length === 1 && chainNodes.length === 1) {
        // Single-chain collapse: the chain root IS the producer root. Use the
        // template caption as the label; leaf-count is already on attrs.
        var only = chainNodes[0];
        only.label = template.caption;
        only.attrs["gt:single-chain"] = true;
        return only;
    }
    return {
        id: ID_PREFIX + "__root__",
        label: template.caption,
        attrs: { "core:synthetic": true },
        children: chainNodes
    };
}

exports.name = PRODUCER_NAME;

exports.describe = function () {
    return {
        name: PRODUCER_NAME,
        args: [
            { key: "template",  required: true, description: "Title of the axis-template tiddler that declares chains + leaf filter." },
            { key: "canvas-id", default: "default", description: "Logical canvas key; scopes the runtime axes-disabled state tiddler." }
        ]
    };
};

exports.produce = function (args, wiki, widget) {
    args = args || {};
    var templateTitle = trim(args.template || "");
    if (!templateTitle) {
        return emptyMdom("(no template)");
    }
    var template = readTemplate(wiki, templateTitle);
    if (!template) {
        return emptyMdom("(template missing: " + templateTitle + ")");
    }
    if (!template.leafFilter) {
        return emptyMdom("(template has no mm.leaf-filter: " + templateTitle + ")");
    }
    var canvasId = trim(args["canvas-id"] || "") || "default";
    var disabled = readDisabledSet(wiki, canvasId, template.initiallyDisabled);
    // Leaf-filter resolves in the widget's variable scope so per-entity views
    // (e.g. `[all[tiddlers]field:parent<entity>]`) work without a producer arg
    // for the entity title.
    var leaves = wiki.filterTiddlers(template.leafFilter, widget || $tw.rootWidget);
    var root = buildRoot(template, leaves, disabled, wiki, widget);
    // Widget-supplied root-label override (resolved from view.mm.root-label).
    // Overrides the producer's natural root label so per-entity views can
    // show e.g. the entity's caption without hard-coding it into the template.
    var rootLabel = trim(args["root-label"] || "");
    if (rootLabel) { root.label = rootLabel; }
    return {
        version: 1,
        root: root,
        meta: {
            producer: PRODUCER_NAME,
            producedAt: Date.now(),
            source: "template=" + templateTitle
        }
    };
};

// Coarse-grained watcher: changes to the template tiddler, its referenced
// chains/axes, or the runtime state override trigger a reproduce. Leaf-set
// changes piggy-back on the widget's broader change-detection — refining
// this with the actual leaf filter is deferred to a later phase (would
// require wiki access from refreshFilter, which the current producer
// interface doesn't provide).
exports.refreshFilter = function (args) {
    args = args || {};
    var templateTitle = trim(args.template || "");
    if (!templateTitle) { return null; }
    var canvasId = trim(args["canvas-id"] || "") || "default";
    var stateTitle = STATE_PREFIX + canvasId + STATE_SUFFIX;
    return [
        "[[" + templateTitle + "]]",
        "[[" + stateTitle + "]]",
        "[[" + templateTitle + "]get[mm.chains]enlist-input[]]",
        "[[" + templateTitle + "]get[mm.chains]enlist-input[]get[mm.axes]enlist-input[]]"
    ].join(" ");
};

// Resolve a node id back to a tiddler title. Synthetic group/chain/root ids
// have no backing tiddler. Leaf ids look like `gt:leaf:<title>@<chainId>`;
// strip the prefix and the chain-suffix to recover the title. Used by the
// widget's preview pane to detect "has selection" and decide whether to
// open the right pane.
function titleFromId(id) {
    if (!id || id.indexOf(ID_PREFIX + "leaf:") !== 0) { return null; }
    var rest = id.substring((ID_PREFIX + "leaf:").length);
    var at = rest.lastIndexOf("@");
    if (at < 0) { return rest; }
    return rest.substring(0, at);
}

exports.titleForOp = function (op) {
    if (!op) { return null; }
    return titleFromId(op.id);
};

// Synthetic-node preview hook. Maps a node id to a "preview kind" descriptor
// so the host can show kind-specific UI in the preview pane (e.g. a list of
// the chain's leaves with an inline "+ new" affordance). Returns null for
// non-synthetic ids and for the producer root (which has no associated
// chain). Shape:
//   { kind: "chain" | "axis", chainId, axisId?, axisKey?, keyPath? }
// The widget surfaces these as `previewKind*` variables on the preview pane
// wikitext, where view-specific templates branch on chainId to render the
// matching kind-view (e.g. orga-apps' Notes / Tasks / Meetings tab body).
function previewKindForId(id) {
    if (!id || typeof id !== "string") { return null; }
    if (id.indexOf(ID_PREFIX) !== 0) { return null; }
    var rest = id.substring(ID_PREFIX.length);
    if (rest.indexOf("chain:") === 0) {
        return { kind: "chain", chainId: rest.substring("chain:".length) };
    }
    if (rest.indexOf("axis:") === 0) {
        // gt:axis:<chainId>:<keyPath>  — split on FIRST ":" only, since
        // keyPath can contain ":" if axis-keys ever did (today they don't,
        // but the format reserves the separator).
        var afterAxis = rest.substring("axis:".length);
        var colon = afterAxis.indexOf(":");
        if (colon < 0) { return null; }
        var chainId = afterAxis.substring(0, colon);
        var keyPath = afterAxis.substring(colon + 1);
        // Axis-id isn't recoverable from the id alone (the chain/axis/key
        // tuple compressed at compose time). The chainId is enough for the
        // host to look it up if needed; axisKey is the final segment.
        var segs = keyPath.split("|");
        return {
            kind: "axis",
            chainId: chainId,
            keyPath: keyPath,
            axisKey: segs[segs.length - 1]
        };
    }
    return null;
}

exports.previewKindForId = previewKindForId;

exports.idForTitle = function (title) {
    if (!title) { return null; }
    // Without a chain context we can't reconstruct a canonical occurrence id;
    // return null and let callers fall back. Selection-driven flows always
    // use titleForOp (id → title), not the reverse.
    return null;
};

// Exposed for tests.
exports._readAxis = readAxis;
exports._readChain = readChain;
exports._readTemplate = readTemplate;
exports._readDisabledSet = readDisabledSet;
exports._buildRoot = buildRoot;
exports._titleFromId = titleFromId;
exports._idPrefix = ID_PREFIX;
