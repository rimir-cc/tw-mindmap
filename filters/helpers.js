/*\
title: $:/plugins/rimir/mindmap/filters/helpers.js
type: application/javascript
module-type: filteroperator

Filter operators exposing the registered engines and producers so the
settings/tools UI can list them without reflecting on $tw.modules from
wikitext.

  [[mindmap-engines[]]]      — names of all registered mindmapengine modules
  [[mindmap-producers[]]]    — names of all registered mindmap-producer modules

The input list is ignored; both operators emit a fresh list of names.

\*/

"use strict";

function listNames(moduleType) {
    var modules = $tw.modules.getModulesByTypeAsHashmap(moduleType);
    var names = [];
    for (var key in modules) {
        var mod = modules[key];
        if (mod && mod.name) { names.push(mod.name); }
    }
    names.sort();
    return names;
}

exports["mindmap-engines"] = function (source, operator, options) {
    return listNames("mindmapengine");
};

exports["mindmap-producers"] = function (source, operator, options) {
    return listNames("mindmap-producer");
};
