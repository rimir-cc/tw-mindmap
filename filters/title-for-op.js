/*\
title: $:/plugins/rimir/mindmap/filters/title-for-op.js
type: application/javascript
module-type: filteroperator

Filter operator that maps each input mindmap node ID to its underlying
tiddler title (or empty if the ID is synthetic / has no source). Dispatches
across all registered mindmap-producer modules that expose `titleForOp`,
returning the first non-null match per input.

Usage:
    [<nodeId>mindmap-title-for-op[]]    → tiddler title backing the node
    [enlist<idList>mindmap-title-for-op[]]

\*/

"use strict";

exports["mindmap-title-for-op"] = function (source, operator, options) {
    var producers = $tw.modules.getModulesByTypeAsHashmap("mindmap-producer");
    var resolvers = [];
    for (var key in producers) {
        var mod = producers[key];
        if (mod && typeof mod.titleForOp === "function") { resolvers.push(mod); }
    }
    var results = [];
    source(function (tiddler, title) {
        for (var i = 0; i < resolvers.length; i++) {
            var resolved;
            try { resolved = resolvers[i].titleForOp({ id: title }); }
            catch (e) { resolved = null; }
            if (resolved) { results.push(resolved); return; }
        }
    });
    return results;
};
