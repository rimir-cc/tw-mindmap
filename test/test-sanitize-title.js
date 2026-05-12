/*\
title: $:/plugins/rimir/mindmap/test/test-sanitize-title.js
type: application/javascript
tags: [[$:/tags/test-spec]]

Unit tests for lib/sanitize-title.js.

\*/

"use strict";

describe("mindmap-sanitize-title", function () {
    var lib = require("$:/plugins/rimir/mindmap/lib/sanitize-title.js");
    var sanitize = lib.sanitize;
    var uniquify = lib.uniquify;

    describe("sanitize", function () {
        it("lowercases and collapses whitespace", function () {
            expect(sanitize("API Endpoints")).toBe("api-endpoints");
            expect(sanitize("  spaced   out  ")).toBe("spaced-out");
            expect(sanitize("\ttab\nnewline")).toBe("tab-newline");
        });

        it("strips path-hostile characters", function () {
            expect(sanitize("a/b\\c|d")).toBe("abcd");
            expect(sanitize("[brackets]")).toBe("brackets");
            expect(sanitize("{braces}")).toBe("braces");
            expect(sanitize("<angles>")).toBe("angles");
            expect(sanitize("#hash?question\"quote'apost"))
                .toBe("hashquestionquoteapost");
        });

        it("collapses multiple hyphens and trims them", function () {
            expect(sanitize("--leading---internal--trailing--"))
                .toBe("leading-internal-trailing");
            expect(sanitize("a  --  b")).toBe("a-b");
        });

        it("returns null when nothing usable remains", function () {
            expect(sanitize("")).toBe(null);
            expect(sanitize("   ")).toBe(null);
            expect(sanitize("---")).toBe(null);
            expect(sanitize("///\\\\\\")).toBe(null);
            expect(sanitize(null)).toBe(null);
            expect(sanitize(undefined)).toBe(null);
        });

        it("preserves unicode letters and digits", function () {
            expect(sanitize("über Cool 42")).toBe("über-cool-42");
            expect(sanitize("café-au-lait")).toBe("café-au-lait");
        });

        it("coerces non-string input", function () {
            expect(sanitize(42)).toBe("42");
        });
    });

    describe("uniquify", function () {
        it("returns slug unchanged when not taken", function () {
            expect(uniquify("foo", new Set(["bar"]))).toBe("foo");
            expect(uniquify("foo", [])).toBe("foo");
            expect(uniquify("foo", {})).toBe("foo");
        });

        it("appends -2 on first collision", function () {
            expect(uniquify("foo", new Set(["foo"]))).toBe("foo-2");
            expect(uniquify("foo", ["foo"])).toBe("foo-2");
            expect(uniquify("foo", { foo: true })).toBe("foo-2");
        });

        it("walks the suffix sequence", function () {
            expect(uniquify("foo", new Set(["foo", "foo-2"]))).toBe("foo-3");
            expect(uniquify("foo", new Set(["foo", "foo-2", "foo-3"]))).toBe("foo-4");
        });

        it("skips suffix gaps", function () {
            // foo-2 is free even though foo-3 is taken; the function uses the
            // first free slot in sequence.
            expect(uniquify("foo", new Set(["foo", "foo-3"]))).toBe("foo-2");
        });

        it("handles empty/null slug input", function () {
            expect(uniquify("", new Set(["x"]))).toBe("");
            expect(uniquify(null, new Set(["x"]))).toBe(null);
        });
    });
});
