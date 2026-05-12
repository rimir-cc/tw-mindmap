/*\
title: $:/plugins/rimir/mindmap/structural-ops.js
type: application/javascript
module-type: library

Central per-op router for the $mindmap widget. Decides whether a user-emitted
Op should mutate real wiki tiddlers via `producer.applyOps` (structural path)
or be appended to the per-view overlay tiddler (visual-only path).

Routing is per-op, NOT per-producer:
- A producer declares `capabilities.structural: true` and a whitelist
  `capabilities.structuralOps: ["rename", "reparent", "addNode", "removeNode"]`.
- An op whose `op` field is in that whitelist runs through `producer.applyOps`.
- Anything else (notably `setAttr` and `reorder`) goes to the overlay store.
- Producers without `structural: true` route every op to overlay (v1 behaviour
  for `json`, `filter-tree`).

Cascade-confirm threshold checking (Landing C) lives here too — `routeOp`
counts affected tiddlers and returns "deferred" when over threshold so the
widget can pop a confirm modal before applying.

\*/

"use strict";

var DEFAULT_CASCADE_THRESHOLD = 10;

// Set of op kinds that NEVER mutate source data, only canvas chrome.
var OVERLAY_ONLY_OPS = Object.create(null);
["setAttr", "hide", "reorder"].forEach(function (k) { OVERLAY_ONLY_OPS[k] = true; });

function getStructuralWhitelist(producer) {
    var caps = producer && producer.capabilities;
    if (!caps || !caps.structural) { return null; }
    var ops = caps.structuralOps;
    if (!ops || !ops.length) { return null; }
    var set = Object.create(null);
    for (var i = 0; i < ops.length; i++) { set[ops[i]] = true; }
    return set;
}

// Count how many descendant tiddlers a rename/reparent/removeNode op would
// affect. Producers expose a per-op "title resolver" so the router can ask
// the wiki "what title would this op operate on?" without knowing the
// producer's id encoding.
function countAffectedDescendants(op, producer, wiki) {
    if (!producer || typeof producer.titleForOp !== "function") { return 0; }
    var title = null;
    try { title = producer.titleForOp(op); } catch (e) { return 0; }
    if (!title) { return 0; }
    // descendants only; the op's own tiddler isn't counted as a cascade target.
    var results = wiki.filterTiddlers("[all[tiddlers+shadows]prefix[" + title + "/]]");
    return results.length;
}

/*
 * routeOp — return { mode, reason?, count? }
 *
 *   mode === "structural" → caller invokes producer.applyOps([op], args, wiki)
 *   mode === "overlay"    → caller invokes store.append(op)
 *   mode === "deferred"   → caller stores op in pending-state + pops confirm modal
 *   mode === "drop"       → caller silently discards (e.g., op for unknown id)
 */
exports.routeOp = function (op, producer, options) {
    if (!op || !op.op) { return { mode: "drop", reason: "invalid op" }; }
    options = options || {};
    var threshold = typeof options.cascadeThreshold === "number" ?
        options.cascadeThreshold : DEFAULT_CASCADE_THRESHOLD;
    var wiki = options.wiki;

    var structural = getStructuralWhitelist(producer);
    var isStructuralOp = structural && structural[op.op];

    if (!isStructuralOp) {
        // setAttr/reorder/hide always live in overlay.
        // Unknown ops also fall through to overlay so unknown-namespace attrs
        // round-trip without loss.
        return { mode: "overlay" };
    }

    // Structural path. For ops with cascade potential, gate on threshold.
    // Rename in non-title label-field mode is a single-field write — no
    // cascade, no descendants touched — so the threshold check is skipped.
    var labelField = options.args && options.args["label-field"];
    var renameTouchesTitleOnly = (op.op === "rename" && labelField && labelField !== "title");
    if (wiki && !renameTouchesTitleOnly &&
            (op.op === "rename" || op.op === "reparent" || op.op === "removeNode")) {
        var n = countAffectedDescendants(op, producer, wiki);
        if (n > threshold) {
            return { mode: "deferred", reason: "cascade-threshold", count: n };
        }
    }
    return { mode: "structural" };
};

exports.OVERLAY_ONLY_OPS = OVERLAY_ONLY_OPS;
exports.DEFAULT_CASCADE_THRESHOLD = DEFAULT_CASCADE_THRESHOLD;
exports._getStructuralWhitelist = getStructuralWhitelist;     // exposed for tests
exports._countAffectedDescendants = countAffectedDescendants; // exposed for tests
