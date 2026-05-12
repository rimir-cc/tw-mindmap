/*\
title: $:/plugins/rimir/mindmap/producers/filter-tree.js
type: application/javascript
module-type: mindmap-producer

Default producer for the <$mindmap filter="..."> quick form. Evaluates the
filter, splits each title on `delimiter` (default "/") and builds a tree by
nesting common prefixes. Each tree path becomes one MDOM node with id
"ft:<full-path>".

Args:
  filter      : (required) TW filter expression
  delimiter   : path separator, default "/"
  root-label  : label for the synthetic root, default "Mindmap"
  body-field  : tiddler field to attach as MDOM node.body (default "text")

\*/

"use strict";

var PRODUCER_NAME = "filter-tree";
var ID_PREFIX = "ft:";

function trim(s) { return (s || "").replace(/^\s+|\s+$/g, ""); }

function splitPath(title, delim) {
    if (!title) { return []; }
    var parts = title.split(delim);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
        if (parts[i] !== "") { out.push(parts[i]); }
    }
    return out;
}

function pathId(prefix, segments) {
    return ID_PREFIX + prefix.concat(segments).join("/");
}

// Build a tree by inserting each title's path segments.
function buildTree(titles, opts, wiki) {
    var delim = opts.delimiter || "/";
    var bodyField = opts["body-field"] || "text";
    var rootPrefix = opts._rootPrefix || []; // segments stripped from each title before insertion
    var root = {
        id: ID_PREFIX + (rootPrefix.length > 0 ? rootPrefix.join("/") : "__root__"),
        label: opts["root-label"] || "Mindmap",
        children: [],
        attrs: { "core:synthetic": true }
    };
    // Index by id for O(1) lookup during insertion.
    var index = Object.create(null);
    index[root.id] = root;

    titles.forEach(function (title) {
        var full = splitPath(title, delim);
        // Strip the root prefix if it matches; otherwise insert the title verbatim.
        var segments = full.slice();
        for (var i = 0; i < rootPrefix.length; i++) {
            if (segments[0] === rootPrefix[i]) { segments.shift(); } else { break; }
        }
        if (segments.length === 0) { return; }
        var parent = root;
        var pathSoFar = rootPrefix.slice();
        for (var j = 0; j < segments.length; j++) {
            pathSoFar.push(segments[j]);
            var nodeId = pathId([], pathSoFar);
            var node = index[nodeId];
            if (!node) {
                node = {
                    id: nodeId,
                    label: segments[j],
                    children: [],
                    attrs: {}
                };
                parent.children.push(node);
                index[nodeId] = node;
            }
            parent = node;
        }
        // The leaf corresponds to the actual tiddler.
        var leaf = parent;
        leaf.attrs = leaf.attrs || {};
        leaf.attrs["core:tiddler"] = title;
        if (bodyField) {
            var tiddler = wiki.getTiddler(title);
            if (tiddler && tiddler.fields[bodyField]) {
                leaf.body = tiddler.fields[bodyField];
            }
        }
    });
    return root;
}

exports.name = PRODUCER_NAME;

exports.describe = function () {
    return {
        name: PRODUCER_NAME,
        args: [
            { key: "filter",     required: true,  description: "Filter expression returning the tiddlers to include." },
            { key: "delimiter",  default: "/",    description: "Path delimiter used to derive the tree from titles." },
            { key: "root-label", default: "Mindmap", description: "Label for the synthetic root node." },
            { key: "body-field", default: "text", description: "Tiddler field shown as node body content." }
        ]
    };
};

exports.produce = function (args, wiki) {
    args = args || {};
    var filter = trim(args.filter || "");
    if (!filter) {
        return {
            version: 1,
            root: { id: ID_PREFIX + "__empty__", label: "(no filter)", children: [] },
            meta: { producer: PRODUCER_NAME, producedAt: Date.now() }
        };
    }
    var titles = wiki.filterTiddlers(filter);
    var root = buildTree(titles, args, wiki);
    return {
        version: 1,
        root: root,
        meta: {
            producer: PRODUCER_NAME,
            producedAt: Date.now(),
            source: filter
        }
    };
};

exports.refreshFilter = function (args) {
    return (args && args.filter) ? args.filter : null;
};

// Exposed for the knowledge-tree producer and tests.
exports._buildTree = buildTree;
exports._splitPath = splitPath;
exports._idPrefix = ID_PREFIX;
