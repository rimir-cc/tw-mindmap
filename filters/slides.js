/*\
title: $:/plugins/rimir/mindmap/filters/slides.js
type: application/javascript
module-type: filteroperator

Filter operators exposing the slides field convention to wikitext.

The INPUT to each operator is the raw `slides` field text. Read it from the
backing tiddler via `get[slides]` first:

    [<currentTiddler>get[slides]mm-slide-count[]]
    [<currentTiddler>get[slides]mm-slide-parse[]]                  -> JSON array
    [<currentTiddler>get[slides]mm-slide-get<idx>,[content]]       -> field value
    [<currentTiddler>get[slides]mm-slide-update<idx>,<content>,<layout>,<notes>]
    [<currentTiddler>get[slides]mm-slide-insert<idx>]              -> blank inserted
    [<currentTiddler>get[slides]mm-slide-remove<idx>]              -> idx removed
    [<currentTiddler>get[slides]mm-slide-move<idx>,<delta>]        -> idx +/- delta

The mutator ops return the new serialized text — pipe it into an
$action-setfield to persist back to the tiddler's `slides` field.

\*/

"use strict";

var slides = require("$:/plugins/rimir/mindmap/lib/parse-slides.js");

function opAt(operator, i, fallback) {
    if (operator.operands && operator.operands.length > i && operator.operands[i] !== undefined) {
        return operator.operands[i];
    }
    if (i === 0) { return operator.operand !== undefined ? operator.operand : (fallback || ""); }
    return fallback === undefined ? "" : fallback;
}

function intAt(operator, i, fallback) {
    var raw = opAt(operator, i, "");
    if (raw === "") { return fallback === undefined ? 0 : fallback; }
    var n = parseInt(raw, 10);
    return isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}

exports["mm-slide-count"] = function (source, operator, options) {
    var results = [];
    source(function (tiddler, title) {
        results.push(String(slides.parse(title || "").length));
    });
    return results;
};

exports["mm-slide-parse"] = function (source, operator, options) {
    var results = [];
    source(function (tiddler, title) {
        results.push(JSON.stringify(slides.parse(title || "")));
    });
    return results;
};

exports["mm-slide-get"] = function (source, operator, options) {
    var idx = intAt(operator, 0, 0);
    var field = opAt(operator, 1, "content");
    var results = [];
    source(function (tiddler, title) {
        var s = slides.parse(title || "")[idx];
        results.push(s ? (s[field] === undefined ? "" : String(s[field])) : "");
    });
    return results;
};

exports["mm-slide-update"] = function (source, operator, options) {
    var idx = intAt(operator, 0, 0);
    var patch = {};
    if (operator.operands && operator.operands.length > 1) { patch.content = operator.operands[1]; }
    if (operator.operands && operator.operands.length > 2) { patch.layout = operator.operands[2]; }
    if (operator.operands && operator.operands.length > 3) { patch.notes = operator.operands[3]; }
    var results = [];
    source(function (tiddler, title) {
        results.push(slides.update(title || "", idx, patch));
    });
    return results;
};

exports["mm-slide-insert"] = function (source, operator, options) {
    var idx = intAt(operator, 0, 0);
    var results = [];
    source(function (tiddler, title) {
        results.push(slides.insert(title || "", idx, { layout: "default", notes: "", content: "" }));
    });
    return results;
};

exports["mm-slide-remove"] = function (source, operator, options) {
    var idx = intAt(operator, 0, 0);
    var results = [];
    source(function (tiddler, title) {
        results.push(slides.remove(title || "", idx));
    });
    return results;
};

exports["mm-slide-move"] = function (source, operator, options) {
    var idx = intAt(operator, 0, 0);
    var delta = intAt(operator, 1, 1);
    var results = [];
    source(function (tiddler, title) {
        results.push(slides.move(title || "", idx, delta));
    });
    return results;
};
