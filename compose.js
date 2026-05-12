/*\
title: $:/plugins/rimir/mindmap/compose.js
type: application/javascript
module-type: library

Pure composer: applies an ordered overlay op log to a base MDOM and returns
the composite MDOM plus a list of orphaned ops (those whose target id is no
longer present in the base after upstream changes).

  compose(base, ops) -> { mdom, orphans }

The composer is intentionally side-effect free. It does NOT read or write
tiddlers; the widget calls it whenever base or overlay change.

Op vocabulary (see ./doc/reference.tid for the spec):

  { op: "hide",       id }
  { op: "rename",     id, label }
  { op: "setAttr",    id, key, value }       // value=null removes the key
  { op: "reparent",   id, newParent, index? }
  { op: "reorder",    parent, order }        // sparse; missing ids keep relative order
  { op: "addNode",    parent, node, index? }
  { op: "removeNode", id }

\*/

"use strict";

// Deep-clone a JSON-shaped MDOM. We don't use structuredClone because TW
// modules may be evaluated in environments without it (server-side jasmine).
function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

// Walk the tree and build an id->{node, parent, index} index. Mutating the
// returned `node` mutates the tree because we never clone here.
function indexTree(root) {
    var index = Object.create(null);
    function visit(node, parent) {
        if (!node || !node.id) { return; }
        var siblings = parent ? parent.children : null;
        index[node.id] = {
            node: node,
            parent: parent,
            index: siblings ? siblings.indexOf(node) : -1
        };
        var children = node.children || [];
        for (var i = 0; i < children.length; i++) {
            visit(children[i], node);
        }
    }
    visit(root, null);
    return index;
}

// Detach a node from its parent. Returns the removed node or null.
function detach(entry) {
    if (!entry || !entry.parent) { return null; }
    var siblings = entry.parent.children;
    var idx = siblings.indexOf(entry.node);
    if (idx < 0) { return null; }
    siblings.splice(idx, 1);
    return entry.node;
}

// Insert `node` into `parent.children` at `index` (or append if index is
// missing/out-of-range).
function insertAt(parent, node, index) {
    parent.children = parent.children || [];
    if (typeof index !== "number" || index < 0 || index > parent.children.length) {
        parent.children.push(node);
    } else {
        parent.children.splice(index, 0, node);
    }
}

// Check whether `candidate` is a (transitive) descendant of `node` in the
// current tree. Used to prevent reparent cycles.
function isDescendant(node, candidate) {
    var children = node.children || [];
    for (var i = 0; i < children.length; i++) {
        if (children[i] === candidate) { return true; }
        if (isDescendant(children[i], candidate)) { return true; }
    }
    return false;
}

function applyHide(index, op) {
    var entry = index[op.id];
    if (!entry) { return false; }
    entry.node.attrs = entry.node.attrs || {};
    entry.node.attrs["core:hidden"] = true;
    return true;
}

function applyRename(index, op) {
    var entry = index[op.id];
    if (!entry) { return false; }
    entry.node.label = String(op.label);
    return true;
}

function applySetAttr(index, op) {
    var entry = index[op.id];
    if (!entry) { return false; }
    entry.node.attrs = entry.node.attrs || {};
    if (op.value === null) {
        delete entry.node.attrs[op.key];
    } else {
        entry.node.attrs[op.key] = op.value;
    }
    return true;
}

function applyReparent(index, op) {
    var entry = index[op.id];
    var target = index[op.newParent];
    if (!entry || !target) { return false; }
    if (entry.node === target.node) { return false; }
    if (isDescendant(entry.node, target.node)) { return false; }
    detach(entry);
    insertAt(target.node, entry.node, op.index);
    return true;
}

function applyReorder(index, op) {
    var entry = index[op.parent];
    if (!entry) { return false; }
    var children = entry.node.children || [];
    if (children.length === 0) { return true; }
    var byId = Object.create(null);
    for (var i = 0; i < children.length; i++) {
        if (children[i].id) { byId[children[i].id] = children[i]; }
    }
    var picked = [];
    var seen = Object.create(null);
    var orderArr = op.order || [];
    for (var j = 0; j < orderArr.length; j++) {
        var id = orderArr[j];
        if (byId[id] && !seen[id]) { picked.push(byId[id]); seen[id] = true; }
    }
    // Append any children not mentioned in `order`, preserving their relative order.
    for (var k = 0; k < children.length; k++) {
        if (children[k].id && !seen[children[k].id]) { picked.push(children[k]); }
    }
    entry.node.children = picked;
    return true;
}

function applyAddNode(index, op) {
    var parentEntry = index[op.parent];
    if (!parentEntry || !op.node || !op.node.id) { return false; }
    if (index[op.node.id]) { return false; } // id collision
    var node = clone(op.node);
    node.children = node.children || [];
    insertAt(parentEntry.node, node, op.index);
    // Update index incrementally so subsequent ops can reference it.
    index[node.id] = { node: node, parent: parentEntry.node, index: -1 };
    return true;
}

function applyRemoveNode(index, op) {
    var entry = index[op.id];
    if (!entry || !entry.parent) { return false; }
    // Recursively unregister descendants from the index.
    function unregister(n) {
        if (!n || !n.id) { return; }
        delete index[n.id];
        var children = n.children || [];
        for (var i = 0; i < children.length; i++) { unregister(children[i]); }
    }
    detach(entry);
    unregister(entry.node);
    return true;
}

var DISPATCH = {
    hide: applyHide,
    rename: applyRename,
    setAttr: applySetAttr,
    reparent: applyReparent,
    reorder: applyReorder,
    addNode: applyAddNode,
    removeNode: applyRemoveNode
};

/*
 * Public: compose(base, ops) → { mdom, orphans }
 *
 * base    : an MDOM document ({ version, root, crossLinks?, meta? })
 * ops     : an array of Op objects (may be empty or undefined)
 *
 * Returns a new MDOM (does not mutate the inputs) and the list of ops that
 * could not be applied because their target id was absent or invalid.
 * Orphans are reported with their original index so callers can offer a
 * "prune orphans" action without losing positional info.
 */
exports.compose = function(base, ops) {
    if (!base || !base.root) {
        return { mdom: base || null, orphans: [] };
    }
    var working = clone(base);
    var index = indexTree(working.root);
    var orphans = [];
    var safeOps = Array.isArray(ops) ? ops : [];
    for (var i = 0; i < safeOps.length; i++) {
        var op = safeOps[i];
        if (!op || !op.op) { continue; }
        var handler = DISPATCH[op.op];
        if (!handler) {
            orphans.push({ index: i, op: op, reason: "unknown-op" });
            continue;
        }
        var ok = false;
        try {
            ok = handler(index, op);
        } catch (e) {
            orphans.push({ index: i, op: op, reason: "exception", error: e && e.message });
            continue;
        }
        if (!ok) {
            orphans.push({ index: i, op: op, reason: "target-missing" });
        }
    }
    return { mdom: working, orphans: orphans };
};

// Exposed for tests
exports._internal = {
    clone: clone,
    indexTree: indexTree,
    isDescendant: isDescendant
};
