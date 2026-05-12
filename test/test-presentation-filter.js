/*\
title: $:/plugins/rimir/mindmap/test/test-presentation-filter.js
type: application/javascript
tags: [[$:/tags/test-spec]]

Unit tests for the `mm-presentations` filter operator.

\*/

"use strict";

describe("mindmap-presentations-filter", function () {
    var op = require("$:/plugins/rimir/mindmap/filters/presentation.js")["mm-presentations"];

    function setupWiki(tiddlers) {
        var wiki = new $tw.Wiki();
        wiki.addTiddlers(tiddlers || []);
        return wiki;
    }

    function runOp(wiki, viewTitle) {
        // Filter ops ignore the input list — pass an empty no-op source.
        var source = function () { /* no inputs */ };
        return op(source, { operand: viewTitle }, { wiki: wiki });
    }

    it("returns presentations tagged for the given view", function () {
        var wiki = setupWiki([
            { title: "views/main", text: "" },
            { title: "presentations/intro",
              tags: "$:/tags/rimir/mindmap/presentation",
              "mm.view": "views/main",
              "mm.slides-order": "" },
            { title: "presentations/deep-dive",
              tags: "$:/tags/rimir/mindmap/presentation",
              "mm.view": "views/main",
              "mm.slides-order": "" }
        ]);
        var out = runOp(wiki, "views/main");
        expect(out).toEqual(["presentations/deep-dive", "presentations/intro"]);
    });

    it("excludes presentations belonging to other views", function () {
        var wiki = setupWiki([
            { title: "views/a", text: "" },
            { title: "views/b", text: "" },
            { title: "p1", tags: "$:/tags/rimir/mindmap/presentation", "mm.view": "views/a" },
            { title: "p2", tags: "$:/tags/rimir/mindmap/presentation", "mm.view": "views/b" }
        ]);
        expect(runOp(wiki, "views/a")).toEqual(["p1"]);
        expect(runOp(wiki, "views/b")).toEqual(["p2"]);
    });

    it("excludes tiddlers without the presentation tag", function () {
        var wiki = setupWiki([
            { title: "presentations/wannabe",
              "mm.view": "views/main",
              "mm.slides-order": "" }
        ]);
        expect(runOp(wiki, "views/main")).toEqual([]);
    });

    it("returns empty list for blank view title", function () {
        var wiki = setupWiki([
            { title: "p1", tags: "$:/tags/rimir/mindmap/presentation", "mm.view": "views/main" }
        ]);
        expect(runOp(wiki, "")).toEqual([]);
    });

    it("ignores whitespace around the mm.view value", function () {
        var wiki = setupWiki([
            { title: "p1",
              tags: "$:/tags/rimir/mindmap/presentation",
              "mm.view": "  views/main  " }
        ]);
        expect(runOp(wiki, "views/main")).toEqual(["p1"]);
    });
});
