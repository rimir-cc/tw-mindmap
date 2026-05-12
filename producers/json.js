/*\
title: $:/plugins/rimir/mindmap/producers/json.js
type: application/javascript
module-type: mindmap-producer

Producer that reads MDOM verbatim from a tiddler's text field. Useful for
hand-authored or pre-computed mindmaps.

Args:
  tiddler : (required) title of the JSON-bearing tiddler

\*/

"use strict";

var PRODUCER_NAME = "json";

function trim(s) { return (s || "").replace(/^\s+|\s+$/g, ""); }

exports.name = PRODUCER_NAME;

exports.describe = function () {
    return {
        name: PRODUCER_NAME,
        args: [
            { key: "tiddler", required: true, description: "Title of a tiddler whose text field contains a valid MDOM JSON document." }
        ]
    };
};

exports.produce = function (args, wiki) {
    args = args || {};
    var title = trim(args.tiddler || "");
    if (!title) {
        throw new Error("json producer: 'tiddler' argument is required");
    }
    var text = wiki.getTiddlerText(title);
    if (!text) {
        throw new Error("json producer: tiddler '" + title + "' is empty or missing");
    }
    var mdom;
    try {
        mdom = JSON.parse(text);
    } catch (e) {
        throw new Error("json producer: invalid JSON in '" + title + "': " + e.message);
    }
    if (!mdom || !mdom.root) {
        throw new Error("json producer: '" + title + "' does not contain a root MDOM node");
    }
    // Stamp meta so downstream callers can tell where the document came from.
    mdom.meta = mdom.meta || {};
    mdom.meta.producer = PRODUCER_NAME;
    mdom.meta.producedAt = Date.now();
    mdom.meta.source = title;
    return mdom;
};

exports.refreshFilter = function (args) {
    var title = args && trim(args.tiddler || "");
    return title ? "[[" + title + "]]" : null;
};
