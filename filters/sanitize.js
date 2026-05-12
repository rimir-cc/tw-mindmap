/*\
title: $:/plugins/rimir/mindmap/filters/sanitize.js
type: application/javascript
module-type: filteroperator

Filter operator that converts each input title into a sanitised slug, using
the same rules as the structural-producer write-back path.

Usage:
    [[My Label]mindmap-slug[]]      → "my-label"
    [<label>mindmap-slug[]]          → slug of <label>

\*/

"use strict";

var sanitizeLib = require("$:/plugins/rimir/mindmap/lib/sanitize-title.js");

exports["mindmap-slug"] = function (source, operator, options) {
    var results = [];
    source(function (tiddler, title) {
        var slug = sanitizeLib.sanitize(title);
        if (slug !== null) { results.push(slug); }
    });
    return results;
};
