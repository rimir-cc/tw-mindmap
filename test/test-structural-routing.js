/*\
title: $:/plugins/rimir/mindmap/test/test-structural-routing.js
type: application/javascript
tags: [[$:/tags/test-spec]]

Unit tests for structural-ops.routeOp.

\*/

"use strict";

describe("mindmap-structural-routing", function () {
    var router = require("$:/plugins/rimir/mindmap/structural-ops.js");

    var STRUCTURAL_PRODUCER = {
        capabilities: {
            structural: true,
            structuralOps: ["rename", "reparent", "addNode", "removeNode"]
        },
        titleForOp: function (op) { return "knowledge/test/" + (op.id || ""); }
    };

    var OVERLAY_PRODUCER = {
        capabilities: {}
    };

    function fakeWiki(titles) {
        return {
            filterTiddlers: function (filter) {
                // Trivial filter executor sufficient for these tests: handles
                // the single shape used by countAffectedDescendants.
                var m = filter.match(/prefix\[([^\]]+)\]/);
                if (!m) { return []; }
                var prefix = m[1];
                return titles.filter(function (t) { return t.indexOf(prefix) === 0; });
            }
        };
    }

    it("routes structural-whitelisted ops to structural", function () {
        var result = router.routeOp(
            { op: "rename", id: "foo", label: "Bar" },
            STRUCTURAL_PRODUCER,
            { wiki: fakeWiki([]) }
        );
        expect(result.mode).toBe("structural");
    });

    it("routes setAttr to overlay even on structural producer", function () {
        var result = router.routeOp(
            { op: "setAttr", id: "foo", key: "core:collapsed", value: true },
            STRUCTURAL_PRODUCER,
            { wiki: fakeWiki([]) }
        );
        expect(result.mode).toBe("overlay");
    });

    it("routes reorder to overlay (sibling order not tracked for structural)", function () {
        var result = router.routeOp(
            { op: "reorder", parent: "p", order: ["a", "b"] },
            STRUCTURAL_PRODUCER,
            { wiki: fakeWiki([]) }
        );
        expect(result.mode).toBe("overlay");
    });

    it("routes every op to overlay for a non-structural producer", function () {
        ["rename", "reparent", "addNode", "removeNode", "setAttr"].forEach(function (k) {
            var result = router.routeOp(
                { op: k, id: "x" },
                OVERLAY_PRODUCER,
                { wiki: fakeWiki([]) }
            );
            expect(result.mode).toBe("overlay");
        });
    });

    it("drops malformed ops", function () {
        expect(router.routeOp(null, STRUCTURAL_PRODUCER, {}).mode).toBe("drop");
        expect(router.routeOp({}, STRUCTURAL_PRODUCER, {}).mode).toBe("drop");
    });

    it("falls through unknown ops to overlay (round-trip safety)", function () {
        var result = router.routeOp(
            { op: "unknownFutureOp", id: "x" },
            STRUCTURAL_PRODUCER,
            { wiki: fakeWiki([]) }
        );
        expect(result.mode).toBe("overlay");
    });

    it("defers structural ops whose cascade exceeds threshold", function () {
        var titles = [
            "knowledge/test/foo/a",
            "knowledge/test/foo/b",
            "knowledge/test/foo/c",
            "knowledge/test/foo/a/x",
            "knowledge/test/foo/a/y"
        ];
        var result = router.routeOp(
            { op: "rename", id: "foo", label: "bar" },
            STRUCTURAL_PRODUCER,
            { wiki: fakeWiki(titles), cascadeThreshold: 3 }
        );
        expect(result.mode).toBe("deferred");
        expect(result.count).toBe(5);
        expect(result.reason).toBe("cascade-threshold");
    });

    it("does not defer when cascade is at or below threshold", function () {
        var titles = ["knowledge/test/foo/a", "knowledge/test/foo/b"];
        var result = router.routeOp(
            { op: "rename", id: "foo", label: "bar" },
            STRUCTURAL_PRODUCER,
            { wiki: fakeWiki(titles), cascadeThreshold: 2 }
        );
        expect(result.mode).toBe("structural");
    });

    it("does not defer addNode (no descendants to cascade)", function () {
        var titles = ["knowledge/test/foo/a", "knowledge/test/foo/b"];
        // addNode op MUST still route as structural even when target prefix
        // matches lots of titles — those titles aren't cascade victims.
        var result = router.routeOp(
            { op: "addNode", parent: "foo", node: { id: "new", label: "X" } },
            STRUCTURAL_PRODUCER,
            { wiki: fakeWiki(titles), cascadeThreshold: 1 }
        );
        expect(result.mode).toBe("structural");
    });
});
