/*\
title: $:/plugins/rimir/mindmap/test/test-parse-slides.js
type: application/javascript
tags: [[$:/tags/test-spec]]

Unit tests for lib/parse-slides.js.

\*/

"use strict";

describe("mindmap-parse-slides", function () {
    var lib = require("$:/plugins/rimir/mindmap/lib/parse-slides.js");

    describe("parse", function () {
        it("returns [] for empty / null / undefined", function () {
            expect(lib.parse("")).toEqual([]);
            expect(lib.parse(null)).toEqual([]);
            expect(lib.parse(undefined)).toEqual([]);
        });

        it("parses a single slide with no metadata", function () {
            var out = lib.parse("hello world");
            expect(out.length).toBe(1);
            expect(out[0]).toEqual({ layout: "default", notes: "", content: "hello world" });
        });

        it("parses metadata directives at the head of a slide", function () {
            var out = lib.parse("!! layout: title\n!! notes: hi\n\n# Heading");
            expect(out.length).toBe(1);
            expect(out[0]).toEqual({ layout: "title", notes: "hi", content: "# Heading" });
        });

        it("splits on === lines", function () {
            var text = "first\n===\nsecond\n===\nthird";
            var out = lib.parse(text);
            expect(out.length).toBe(3);
            expect(out[0].content).toBe("first");
            expect(out[1].content).toBe("second");
            expect(out[2].content).toBe("third");
        });

        it("tolerates surrounding whitespace on separator lines", function () {
            var text = "first\n   ===   \nsecond";
            var out = lib.parse(text);
            expect(out.length).toBe(2);
            expect(out[1].content).toBe("second");
        });

        it("keeps trailing empty slides created by a final separator", function () {
            // A `===` separator with no body after it represents an empty
            // slide. Preserving it lets `insert()` of a blank slide survive a
            // round-trip through serialize / parse.
            var out = lib.parse("first\n===\n");
            expect(out.length).toBe(2);
            expect(out[0].content).toBe("first");
            expect(out[1].content).toBe("");
        });

        it("keeps unknown metadata keys out of the result", function () {
            var out = lib.parse("!! layout: title\n!! bogus: x\n\nbody");
            // bogus is parsed but only layout/notes surface — kept as a clean API
            expect(out[0].layout).toBe("title");
            expect(out[0].notes).toBe("");
            expect(out[0].content).toBe("body");
        });

        it("treats lines after a non-directive line as body", function () {
            var out = lib.parse("just text\n!! layout: bullets\n\nrest");
            expect(out[0].layout).toBe("default");
            expect(out[0].content).toBe("just text\n!! layout: bullets\n\nrest");
        });

        it("strips leading and trailing newlines from body", function () {
            var out = lib.parse("\n\nbody\n\n");
            expect(out[0].content).toBe("body");
        });
    });

    describe("serialize", function () {
        it("returns empty string for empty input", function () {
            expect(lib.serialize([])).toBe("");
            expect(lib.serialize(null)).toBe("");
        });

        it("omits the layout directive when layout is 'default'", function () {
            expect(lib.serialize([{ layout: "default", notes: "", content: "x" }])).toBe("x");
        });

        it("writes layout and notes directives when present", function () {
            var out = lib.serialize([{ layout: "title", notes: "n", content: "h" }]);
            expect(out).toBe("!! layout: title\n!! notes: n\n\nh");
        });

        it("joins multiple slides with === separators", function () {
            var out = lib.serialize([
                { layout: "default", notes: "", content: "a" },
                { layout: "default", notes: "", content: "b" }
            ]);
            expect(out).toBe("a\n\n===\n\nb");
        });

        it("is the inverse of parse for a clean round-trip", function () {
            var inputs = [
                "single body",
                "!! layout: title\n\nhead",
                "a\n\n===\n\nb\n\n===\n\nc",
                "!! layout: bullets\n!! notes: speaker says hi\n\n* one\n* two"
            ];
            for (var i = 0; i < inputs.length; i++) {
                var parsed = lib.parse(inputs[i]);
                var serialized = lib.serialize(parsed);
                expect(lib.parse(serialized)).toEqual(parsed);
            }
        });

        it("emits a sentinel for empty default slides so insert survives", function () {
            // serialize([blank]) must produce non-empty output, otherwise an
            // immediate insert+parse round-trip drops the new slide.
            var single = [{ layout: "default", notes: "", content: "" }];
            var out = lib.serialize(single);
            expect(out).not.toBe("");
            expect(lib.parse(out)).toEqual(single);
        });
    });

    describe("update", function () {
        it("returns input unchanged when index is out of range", function () {
            expect(lib.update("a\n\n===\n\nb", 5, { content: "x" })).toBe("a\n\n===\n\nb");
        });

        it("updates content at the given index", function () {
            var out = lib.update("a\n\n===\n\nb", 1, { content: "B" });
            expect(lib.parse(out)[1].content).toBe("B");
            expect(lib.parse(out)[0].content).toBe("a");
        });

        it("updates layout and preserves other fields", function () {
            var out = lib.update("x", 0, { layout: "title" });
            expect(lib.parse(out)).toEqual([{ layout: "title", notes: "", content: "x" }]);
        });
    });

    describe("insert", function () {
        it("appends when index >= length", function () {
            var out = lib.insert("a", 99, { content: "b" });
            expect(lib.parse(out).map(function (s) { return s.content; })).toEqual(["a", "b"]);
        });

        it("inserts at start", function () {
            var out = lib.insert("a", 0, { content: "first" });
            expect(lib.parse(out).map(function (s) { return s.content; })).toEqual(["first", "a"]);
        });

        it("inserts between slides", function () {
            var out = lib.insert("a\n\n===\n\nc", 1, { content: "b" });
            expect(lib.parse(out).map(function (s) { return s.content; })).toEqual(["a", "b", "c"]);
        });

        it("inserts a blank slide when slide argument is omitted", function () {
            var out = lib.insert("a", 1);
            var parsed = lib.parse(out);
            expect(parsed.length).toBe(2);
            expect(parsed[1].content).toBe("");
        });
    });

    describe("remove", function () {
        it("removes the slide at index", function () {
            var out = lib.remove("a\n\n===\n\nb\n\n===\n\nc", 1);
            expect(lib.parse(out).map(function (s) { return s.content; })).toEqual(["a", "c"]);
        });

        it("returns input unchanged on out-of-range index", function () {
            expect(lib.remove("a", 5)).toBe("a");
            expect(lib.remove("a", -1)).toBe("a");
        });
    });

    describe("move", function () {
        it("moves a slide up", function () {
            var out = lib.move("a\n\n===\n\nb\n\n===\n\nc", 2, -1);
            expect(lib.parse(out).map(function (s) { return s.content; })).toEqual(["a", "c", "b"]);
        });

        it("moves a slide down", function () {
            var out = lib.move("a\n\n===\n\nb\n\n===\n\nc", 0, 1);
            expect(lib.parse(out).map(function (s) { return s.content; })).toEqual(["b", "a", "c"]);
        });

        it("returns input unchanged when source or target is out of range", function () {
            expect(lib.move("a", 0, 1)).toBe("a");
            expect(lib.move("a\n\n===\n\nb", 0, -1)).toBe("a\n\n===\n\nb");
            expect(lib.move("a\n\n===\n\nb", 1, 1)).toBe("a\n\n===\n\nb");
        });
    });
});
