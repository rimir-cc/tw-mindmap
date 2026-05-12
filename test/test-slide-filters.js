/*\
title: $:/plugins/rimir/mindmap/test/test-slide-filters.js
type: application/javascript
tags: [[$:/tags/test-spec]]

Unit tests for filters/slides.js — exercises the operator functions directly
(no wiki harness needed) by feeding them a fake `source` iterator. The
operators take the slides-field text as input and return either a derived
value (count / JSON / one field) or a new serialized slides text (mutators).

\*/

"use strict";

describe("mindmap-slide-filters", function () {
    var ops = require("$:/plugins/rimir/mindmap/filters/slides.js");
    var lib = require("$:/plugins/rimir/mindmap/lib/parse-slides.js");

    // Build a source iterator that yields one or more title strings — that's
    // what filter operators receive as input.
    function source(titles) {
        return function (callback) {
            for (var i = 0; i < titles.length; i++) {
                callback(null, titles[i]);
            }
        };
    }

    function operator(operands) {
        return { operand: operands[0] || "", operands: operands.slice() };
    }

    describe("mm-slide-count", function () {
        it("returns 0 for empty input", function () {
            expect(ops["mm-slide-count"](source([""]), operator([]))).toEqual(["0"]);
        });
        it("counts slides separated by ===", function () {
            expect(ops["mm-slide-count"](source(["a\n===\nb\n===\nc"]), operator([]))).toEqual(["3"]);
        });
        it("processes each input title independently", function () {
            var out = ops["mm-slide-count"](source(["a", "a\n===\nb"]), operator([]));
            expect(out).toEqual(["1", "2"]);
        });
    });

    describe("mm-slide-parse", function () {
        it("emits JSON-encoded array of slide objects", function () {
            var out = ops["mm-slide-parse"](source(["!! layout: title\n\nhead"]), operator([]));
            var parsed = JSON.parse(out[0]);
            expect(parsed.length).toBe(1);
            expect(parsed[0].layout).toBe("title");
            expect(parsed[0].content).toBe("head");
        });
    });

    describe("mm-slide-get", function () {
        var text = "!! layout: title\n!! notes: speaker\n\nhead\n\n===\n\nbody two";

        it("returns the content of slide at index", function () {
            expect(ops["mm-slide-get"](source([text]), operator(["0", "content"]))).toEqual(["head"]);
            expect(ops["mm-slide-get"](source([text]), operator(["1", "content"]))).toEqual(["body two"]);
        });
        it("returns the layout field", function () {
            expect(ops["mm-slide-get"](source([text]), operator(["0", "layout"]))).toEqual(["title"]);
            expect(ops["mm-slide-get"](source([text]), operator(["1", "layout"]))).toEqual(["default"]);
        });
        it("returns the notes field", function () {
            expect(ops["mm-slide-get"](source([text]), operator(["0", "notes"]))).toEqual(["speaker"]);
        });
        it("defaults the field operand to content", function () {
            expect(ops["mm-slide-get"](source([text]), operator(["0"]))).toEqual(["head"]);
        });
        it("returns empty string for out-of-range index", function () {
            expect(ops["mm-slide-get"](source([text]), operator(["99", "content"]))).toEqual([""]);
        });
    });

    describe("mm-slide-update", function () {
        it("writes content+layout+notes at the given index", function () {
            var text = "a\n\n===\n\nb";
            var out = ops["mm-slide-update"](source([text]),
                operator(["1", "B!", "title", "shout"]));
            var parsed = lib.parse(out[0]);
            expect(parsed[1]).toEqual({ layout: "title", notes: "shout", content: "B!" });
            // Slide 0 untouched
            expect(parsed[0].content).toBe("a");
        });
        it("is a no-op for out-of-range index (returns input unchanged)", function () {
            var text = "a";
            var out = ops["mm-slide-update"](source([text]),
                operator(["5", "x", "default", ""]));
            expect(out[0]).toBe(text);
        });
    });

    describe("mm-slide-insert", function () {
        it("inserts a blank slide at the supplied index", function () {
            var text = "a\n\n===\n\nb";
            var out = ops["mm-slide-insert"](source([text]), operator(["1"]));
            var parsed = lib.parse(out[0]);
            expect(parsed.length).toBe(3);
            expect(parsed[0].content).toBe("a");
            expect(parsed[1].content).toBe("");
            expect(parsed[2].content).toBe("b");
        });
        it("inserts at end when idx equals slide count", function () {
            var out = ops["mm-slide-insert"](source(["a"]), operator(["1"]));
            expect(lib.parse(out[0]).length).toBe(2);
        });
        it("survives a round-trip from empty (no slides → 1 slide)", function () {
            // This is the bug that bit the live + Add slide button: empty
            // input → insert blank → serialize → must NOT be empty.
            var out = ops["mm-slide-insert"](source([""]), operator(["0"]));
            expect(out[0]).not.toBe("");
            expect(lib.parse(out[0]).length).toBe(1);
        });
    });

    describe("mm-slide-remove", function () {
        it("removes the slide at index", function () {
            var text = "a\n\n===\n\nb\n\n===\n\nc";
            var out = ops["mm-slide-remove"](source([text]), operator(["1"]));
            expect(lib.parse(out[0]).map(function (s) { return s.content; }))
                .toEqual(["a", "c"]);
        });
    });

    describe("mm-slide-move", function () {
        it("moves a slide by the supplied delta", function () {
            var text = "a\n\n===\n\nb\n\n===\n\nc";
            var out = ops["mm-slide-move"](source([text]), operator(["2", "-1"]));
            expect(lib.parse(out[0]).map(function (s) { return s.content; }))
                .toEqual(["a", "c", "b"]);
        });
        it("defaults delta to +1 when omitted", function () {
            var text = "a\n\n===\n\nb";
            var out = ops["mm-slide-move"](source([text]), operator(["0"]));
            expect(lib.parse(out[0]).map(function (s) { return s.content; }))
                .toEqual(["b", "a"]);
        });
    });
});
