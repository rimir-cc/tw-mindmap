/*\
title: $:/plugins/rimir/mindmap/lib/grouped-tree.js
type: application/javascript
module-type: library

Pure-JS helpers for the grouped-tree producer. Group a flat list of items by
a key function; recursively apply an ordered list of axes to produce a nested
group/leaf structure. Exposed for unit-testing without a wiki instance.

\*/

"use strict";

var UNSET_KEY = "__unset__";

// Group `items` by the value returned from `keyFn(item)`. Preserves the order
// in which keys first appear. Items whose key is null/undefined/empty land in
// a single bucket keyed UNSET_KEY (caller decides how to label it).
function groupBy(items, keyFn) {
    var groups = [];
    var byKey = Object.create(null);
    for (var i = 0; i < items.length; i++) {
        var raw = keyFn(items[i]);
        var key = (raw === null || raw === undefined || raw === "") ? UNSET_KEY : raw;
        if (!byKey[key]) {
            byKey[key] = { key: key, items: [] };
            groups.push(byKey[key]);
        }
        byKey[key].items.push(items[i]);
    }
    return groups;
}

// Sort group entries per the axis's `sort` mode. Mutates and returns the
// array. Modes:
//   "first-seen" (default) — no-op; preserves groupBy() insertion order
//   "asc" / "desc"         — alpha (localeCompare) ascending / descending
//   "enum"                 — by position in axis.sortKeys; keys not listed
//                            sort after the enum, alpha-ascending
function sortGroups(entries, axis) {
    var mode = axis && axis.sort;
    if (!mode || mode === "first-seen") { return entries; }
    if (mode === "asc") {
        entries.sort(function (a, b) { return a.key.localeCompare(b.key); });
        return entries;
    }
    if (mode === "desc") {
        entries.sort(function (a, b) { return b.key.localeCompare(a.key); });
        return entries;
    }
    if (mode === "enum") {
        var order = Object.create(null);
        var keys = axis.sortKeys || [];
        for (var i = 0; i < keys.length; i++) { order[keys[i]] = i; }
        entries.sort(function (a, b) {
            var ai = (a.key in order) ? order[a.key] : Infinity;
            var bi = (b.key in order) ? order[b.key] : Infinity;
            if (ai !== bi) { return ai - bi; }
            return a.key.localeCompare(b.key);
        });
        return entries;
    }
    return entries;
}

// Recursively partition `leaves` through `axes`. Each axis:
//   { id, keyFn(leaf), labelFn(key), leafFilter?(leaf), sort?, sortKeys? }
// Returns an array of entries; each entry is either:
//   { kind: "leaf", leaf: <value> }
// or
//   { kind: "group", axisId, key, label, items, children }
// where `children` is the recursive result one axis deeper.
//
// When `axes` is empty, every leaf becomes a {kind:"leaf"} entry directly —
// callers get a flat list, which is the natural identity for "no grouping".
//
// Empty-branch pruning: a group whose recursive `children` ends up empty is
// dropped from the result — keeps the tree free of placeholder parents when
// downstream axis leaf-filters narrow the population to zero (e.g. a "notes"
// rrt-type bucket under a chain whose deeper axis is meetings/tasks-only).
function applyChain(leaves, axes) {
    function build(items, depth) {
        if (depth >= axes.length) {
            var out = [];
            for (var i = 0; i < items.length; i++) {
                out.push({ kind: "leaf", leaf: items[i] });
            }
            return out;
        }
        var axis = axes[depth];
        var filtered = items;
        if (typeof axis.leafFilter === "function") {
            filtered = [];
            for (var j = 0; j < items.length; j++) {
                if (axis.leafFilter(items[j])) { filtered.push(items[j]); }
            }
        }
        var groups = groupBy(filtered, axis.keyFn);
        var entries = [];
        for (var k = 0; k < groups.length; k++) {
            var g = groups[k];
            var children = build(g.items, depth + 1);
            if (children.length === 0) { continue; }
            var label = (typeof axis.labelFn === "function")
                ? axis.labelFn(g.key)
                : g.key;
            entries.push({
                kind: "group",
                axisId: axis.id,
                key: g.key,
                label: label,
                items: g.items,
                children: children
            });
        }
        return sortGroups(entries, axis);
    }
    return build(leaves, 0);
}

exports.UNSET_KEY = UNSET_KEY;
exports.groupBy = groupBy;
exports.applyChain = applyChain;
exports.sortGroups = sortGroups;
