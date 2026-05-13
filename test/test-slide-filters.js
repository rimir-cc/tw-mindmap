/*\
title: $:/plugins/rimir/mindmap/test/test-slide-filters.js
type: application/javascript
tags: [[$:/tags/test-spec]]

Unit tests for filters/slides.js. Operators take owner-tiddler titles as input
and consult mm.slide-order on each — exercise against a fresh wiki so the
look-ups go through the real getTiddler / parseStringArray paths.

\*/

"use strict";

describe("mindmap-slide-filters", function () {
    var ops = require("$:/plugins/rimir/mindmap/filters/slides.js");
    var lib = require("$:/plugins/rimir/mindmap/lib/slide-tiddlers.js");

    function setupWiki(tiddlers) {
        var wiki = new $tw.Wiki();
        wiki.addTiddlers(tiddlers || []);
        wiki.addIndexersToWiki();
        return wiki;
    }

    function ownerSeed() {
        return [{ title: "knowledge/llm/foo", "kn.type": "note", text: "" }];
    }

    function source(titles) {
        return function (callback) {
            for (var i = 0; i < titles.length; i++) { callback(null, titles[i]); }
        };
    }

    describe("mm-slides", function () {
        it("returns slides in mm.slide-order order", function () {
            var wiki = setupWiki(ownerSeed());
            var t1 = lib.addSlide(wiki, "knowledge/llm/foo");
            var t2 = lib.addSlide(wiki, "knowledge/llm/foo");
            var out = ops["mm-slides"](source(["knowledge/llm/foo"]), {}, { wiki: wiki });
            expect(out).toEqual([t1, t2]);
        });

        it("returns nothing for owners with no slides", function () {
            var wiki = setupWiki(ownerSeed());
            expect(ops["mm-slides"](source(["knowledge/llm/foo"]), {}, { wiki: wiki })).toEqual([]);
        });

        it("concatenates results across multiple input owners", function () {
            var wiki = setupWiki(ownerSeed().concat([
                { title: "knowledge/llm/bar", "kn.type": "note", text: "" }
            ]));
            var t1 = lib.addSlide(wiki, "knowledge/llm/foo");
            var t2 = lib.addSlide(wiki, "knowledge/llm/bar");
            var out = ops["mm-slides"](source(["knowledge/llm/foo", "knowledge/llm/bar"]), {}, { wiki: wiki });
            expect(out).toEqual([t1, t2]);
        });
    });

    describe("mm-slide-count", function () {
        it("returns 0 for owners with no slides", function () {
            var wiki = setupWiki(ownerSeed());
            expect(ops["mm-slide-count"](source(["knowledge/llm/foo"]), {}, { wiki: wiki }))
                .toEqual(["0"]);
        });

        it("returns the slide count per input title", function () {
            var wiki = setupWiki(ownerSeed());
            lib.addSlide(wiki, "knowledge/llm/foo");
            lib.addSlide(wiki, "knowledge/llm/foo");
            expect(ops["mm-slide-count"](source(["knowledge/llm/foo"]), {}, { wiki: wiki }))
                .toEqual(["2"]);
        });
    });

    describe("mm-has-slides", function () {
        it("returns 'no' for owners with no slides", function () {
            var wiki = setupWiki(ownerSeed());
            expect(ops["mm-has-slides"](source(["knowledge/llm/foo"]), {}, { wiki: wiki }))
                .toEqual(["no"]);
        });

        it("returns 'yes' once at least one slide exists", function () {
            var wiki = setupWiki(ownerSeed());
            lib.addSlide(wiki, "knowledge/llm/foo");
            expect(ops["mm-has-slides"](source(["knowledge/llm/foo"]), {}, { wiki: wiki }))
                .toEqual(["yes"]);
        });
    });

    describe("mm-presentation-slides", function () {
        function presentationWith(slidesOrder) {
            return {
                title: "presentations/p1",
                tags: "$:/tags/rimir/mindmap/presentation",
                "mm.view": "view/x",
                "mm.slides-order": slidesOrder
            };
        }

        it("flat-maps the presentation's slides-order through each owner's mm-slides", function () {
            var wiki = setupWiki(ownerSeed().concat([
                { title: "knowledge/llm/bar", "kn.type": "note", text: "" }
            ]));
            var fooSlide1 = lib.addSlide(wiki, "knowledge/llm/foo");
            var fooSlide2 = lib.addSlide(wiki, "knowledge/llm/foo");
            var barSlide = lib.addSlide(wiki, "knowledge/llm/bar");
            wiki.addTiddler(presentationWith("[[knowledge/llm/foo]] [[knowledge/llm/bar]]"));
            var out = ops["mm-presentation-slides"](
                source(["presentations/p1"]), {}, { wiki: wiki }
            );
            expect(out).toEqual([fooSlide1, fooSlide2, barSlide]);
        });

        it("preserves slide-order order within each owner", function () {
            var wiki = setupWiki(ownerSeed());
            var a = lib.addSlide(wiki, "knowledge/llm/foo");
            var b = lib.addSlide(wiki, "knowledge/llm/foo");
            // Move b before a in the owner's slide-order
            lib.moveSlide(wiki, b, -1);
            wiki.addTiddler(presentationWith("[[knowledge/llm/foo]]"));
            var out = ops["mm-presentation-slides"](
                source(["presentations/p1"]), {}, { wiki: wiki }
            );
            expect(out).toEqual([b, a]);
        });

        it("skips owners that don't exist", function () {
            var wiki = setupWiki(ownerSeed());
            var t = lib.addSlide(wiki, "knowledge/llm/foo");
            wiki.addTiddler(presentationWith("[[knowledge/llm/foo]] [[knowledge/missing]]"));
            var out = ops["mm-presentation-slides"](
                source(["presentations/p1"]), {}, { wiki: wiki }
            );
            expect(out).toEqual([t]);
        });

        it("returns an empty array when the presentation has no slides-order", function () {
            var wiki = setupWiki(ownerSeed());
            wiki.addTiddler(presentationWith(""));
            var out = ops["mm-presentation-slides"](
                source(["presentations/p1"]), {}, { wiki: wiki }
            );
            expect(out).toEqual([]);
        });

        it("returns an empty array when the presentation tiddler doesn't exist", function () {
            var wiki = setupWiki(ownerSeed());
            var out = ops["mm-presentation-slides"](
                source(["presentations/missing"]), {}, { wiki: wiki }
            );
            expect(out).toEqual([]);
        });
    });
});
