/*\
title: $:/plugins/rimir/mindmap/test/test-compose.js
type: application/javascript
tags: [[$:/tags/test-spec]]

Unit tests for compose.js. Loaded explicitly by the wiki-based test runner
in a test edition; ignored by the production wiki.

To exercise: TIDDLYWIKI_CLI_MODE=1 npx tiddlywiki test-edition --test spec="mindmap-compose"

\*/

"use strict";

describe("mindmap-compose", function () {
    var composer = require("$:/plugins/rimir/mindmap/compose.js");

    function baseTree() {
        return {
            version: 1,
            root: {
                id: "r", label: "Root",
                children: [
                    { id: "a", label: "A", children: [
                        { id: "a1", label: "A1" },
                        { id: "a2", label: "A2" }
                    ]},
                    { id: "b", label: "B", children: [] }
                ]
            }
        };
    }

    it("returns the base when ops are empty", function () {
        var r = composer.compose(baseTree(), []);
        expect(r.orphans.length).toBe(0);
        expect(r.mdom.root.label).toBe("Root");
        expect(r.mdom.root.children.length).toBe(2);
    });

    it("applies rename", function () {
        var r = composer.compose(baseTree(), [
            { op: "rename", id: "a", label: "Alpha" }
        ]);
        expect(r.mdom.root.children[0].label).toBe("Alpha");
    });

    it("hides a node via core:hidden attr", function () {
        var r = composer.compose(baseTree(), [
            { op: "hide", id: "a1" }
        ]);
        expect(r.mdom.root.children[0].children[0].attrs["core:hidden"]).toBe(true);
    });

    it("reparents and refuses cycles", function () {
        var ok = composer.compose(baseTree(), [
            { op: "reparent", id: "a2", newParent: "b" }
        ]);
        expect(ok.orphans.length).toBe(0);
        expect(ok.mdom.root.children[1].children[0].id).toBe("a2");

        var cycle = composer.compose(baseTree(), [
            { op: "reparent", id: "a", newParent: "a1" }
        ]);
        expect(cycle.orphans.length).toBe(1);
    });

    it("flags orphan ops", function () {
        var r = composer.compose(baseTree(), [
            { op: "rename", id: "ghost", label: "X" }
        ]);
        expect(r.orphans.length).toBe(1);
        expect(r.orphans[0].reason).toBe("target-missing");
    });

    it("addNode + subsequent rename works", function () {
        var r = composer.compose(baseTree(), [
            { op: "addNode", parent: "b", node: { id: "b1", label: "B1" } },
            { op: "rename", id: "b1", label: "Beta-1" }
        ]);
        expect(r.orphans.length).toBe(0);
        expect(r.mdom.root.children[1].children[0].label).toBe("Beta-1");
    });

    it("removeNode wipes its subtree from the index", function () {
        var r = composer.compose(baseTree(), [
            { op: "removeNode", id: "a" },
            { op: "rename", id: "a1", label: "Should-Be-Orphan" }
        ]);
        expect(r.mdom.root.children.length).toBe(1);
        expect(r.orphans.length).toBe(1);
    });

    it("setAttr writes and deletes attrs", function () {
        var r = composer.compose(baseTree(), [
            { op: "setAttr", id: "a", key: "core:color", value: "#ff0000" },
            { op: "setAttr", id: "a", key: "core:color", value: null }
        ]);
        expect(r.mdom.root.children[0].attrs["core:color"]).toBeUndefined();
    });

    it("reorder is sparse — un-named children keep relative order", function () {
        var r = composer.compose(baseTree(), [
            { op: "reorder", parent: "a", order: ["a2"] }
        ]);
        var orderedIds = r.mdom.root.children[0].children.map(function (n) { return n.id; });
        expect(orderedIds).toEqual(["a2", "a1"]);
    });

    it("does not mutate the input MDOM", function () {
        var base = baseTree();
        var beforeJson = JSON.stringify(base);
        composer.compose(base, [
            { op: "rename", id: "a", label: "Alpha" },
            { op: "addNode", parent: "b", node: { id: "b1", label: "B1" } }
        ]);
        expect(JSON.stringify(base)).toBe(beforeJson);
    });
});
