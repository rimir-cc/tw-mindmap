/*\
title: $:/plugins/rimir/mindmap/test/test-slide-tiddlers.js
type: application/javascript
tags: [[$:/tags/test-spec]]

Unit tests for lib/slide-tiddlers.js. The module's wiki-aware operations
(getSlideTitles, addSlide, removeSlide, moveSlide) are exercised against a
fresh `new $tw.Wiki()` — same pattern as test-knowledge-tree-apply.

\*/

"use strict";

describe("mindmap-slide-tiddlers", function () {
    var lib = require("$:/plugins/rimir/mindmap/lib/slide-tiddlers.js");

    function setupWiki(tiddlers) {
        var wiki = new $tw.Wiki();
        wiki.addTiddlers(tiddlers || []);
        wiki.addIndexersToWiki();
        return wiki;
    }

    function ownerSeed() {
        return [
            { title: "knowledge/llm/foo", "kn.type": "note", text: "owner body" }
        ];
    }

    describe("slideTitleFor / ownerTitleFor", function () {
        it("composes a slide title from owner + slug", function () {
            expect(lib.slideTitleFor("knowledge/llm/foo", "slide-1"))
                .toBe("knowledge/llm/foo/slides/slide-1");
        });

        it("returns null when either arg is missing", function () {
            expect(lib.slideTitleFor("", "slide-1")).toBe(null);
            expect(lib.slideTitleFor("knowledge/llm/foo", "")).toBe(null);
        });

        it("ownerTitleFor inverts slideTitleFor", function () {
            expect(lib.ownerTitleFor("knowledge/llm/foo/slides/slide-1"))
                .toBe("knowledge/llm/foo");
        });

        it("ownerTitleFor returns null for non-slide titles", function () {
            expect(lib.ownerTitleFor("knowledge/llm/foo")).toBe(null);
            expect(lib.ownerTitleFor("")).toBe(null);
        });
    });

    describe("isSlideTiddler", function () {
        it("detects via kn.type=slide", function () {
            var t = new $tw.Tiddler({ title: "x", "kn.type": "slide" });
            expect(lib.isSlideTiddler(t)).toBe(true);
        });

        it("detects via slide tag", function () {
            var t = new $tw.Tiddler({ title: "x", tags: "$:/tags/rimir/mindmap/slide" });
            expect(lib.isSlideTiddler(t)).toBe(true);
        });

        it("returns false for ordinary tiddlers", function () {
            var t = new $tw.Tiddler({ title: "x", "kn.type": "note" });
            expect(lib.isSlideTiddler(t)).toBe(false);
            expect(lib.isSlideTiddler(null)).toBe(false);
        });
    });

    describe("freshSlideSlug", function () {
        it("returns slide-1 when no slides exist", function () {
            var wiki = setupWiki(ownerSeed());
            expect(lib.freshSlideSlug(wiki, "knowledge/llm/foo")).toBe("slide-1");
        });

        it("skips over existing slugs", function () {
            var wiki = setupWiki(ownerSeed().concat([
                { title: "knowledge/llm/foo/slides/slide-1",
                  "kn.type": "slide",
                  tags: "$:/tags/rimir/mindmap/slide",
                  "mm.slide-of": "knowledge/llm/foo" },
                { title: "knowledge/llm/foo/slides/slide-2",
                  "kn.type": "slide",
                  tags: "$:/tags/rimir/mindmap/slide",
                  "mm.slide-of": "knowledge/llm/foo" }
            ]));
            expect(lib.freshSlideSlug(wiki, "knowledge/llm/foo")).toBe("slide-3");
        });

        it("fills gaps (slide-2 missing while slide-1 + slide-3 exist)", function () {
            // freshSlideSlug picks the lowest-N slug that doesn't collide —
            // so a manually-deleted slide-2 gets reused.
            var wiki = setupWiki(ownerSeed().concat([
                { title: "knowledge/llm/foo/slides/slide-1",
                  "kn.type": "slide",
                  tags: "$:/tags/rimir/mindmap/slide" },
                { title: "knowledge/llm/foo/slides/slide-3",
                  "kn.type": "slide",
                  tags: "$:/tags/rimir/mindmap/slide" }
            ]));
            expect(lib.freshSlideSlug(wiki, "knowledge/llm/foo")).toBe("slide-2");
        });
    });

    describe("addSlide", function () {
        it("creates a slide tiddler with all expected fields", function () {
            var wiki = setupWiki(ownerSeed());
            var t = lib.addSlide(wiki, "knowledge/llm/foo");
            expect(t).toBe("knowledge/llm/foo/slides/slide-1");
            var slide = wiki.getTiddler(t);
            expect(slide).toBeTruthy();
            expect(slide.fields["kn.type"]).toBe("slide");
            expect(slide.fields["mm.slide-of"]).toBe("knowledge/llm/foo");
            expect(slide.fields["mm.slide-layout"]).toBe("default");
            // Tags should include the slide tag.
            var tags = $tw.utils.parseStringArray(slide.fields.tags || "");
            expect(tags.indexOf("$:/tags/rimir/mindmap/slide")).toBeGreaterThan(-1);
        });

        it("appends the slide title to the owner's mm.slide-order list", function () {
            var wiki = setupWiki(ownerSeed());
            lib.addSlide(wiki, "knowledge/llm/foo");
            lib.addSlide(wiki, "knowledge/llm/foo");
            var owner = wiki.getTiddler("knowledge/llm/foo");
            var order = $tw.utils.parseStringArray(owner.fields["mm.slide-order"] || "");
            expect(order).toEqual([
                "knowledge/llm/foo/slides/slide-1",
                "knowledge/llm/foo/slides/slide-2"
            ]);
        });

        it("honors opts.layout / opts.text / opts.caption", function () {
            var wiki = setupWiki(ownerSeed());
            var t = lib.addSlide(wiki, "knowledge/llm/foo", {
                layout: "title", text: "# Hello", caption: "intro"
            });
            var slide = wiki.getTiddler(t);
            expect(slide.fields["mm.slide-layout"]).toBe("title");
            expect(slide.fields.text).toBe("# Hello");
            expect(slide.fields.caption).toBe("intro");
        });

        it("returns null when the owner tiddler does not exist", function () {
            var wiki = setupWiki([]);
            expect(lib.addSlide(wiki, "does/not/exist")).toBe(null);
        });
    });

    describe("getSlideTitles", function () {
        it("returns slides in the order recorded by mm.slide-order", function () {
            var wiki = setupWiki(ownerSeed());
            lib.addSlide(wiki, "knowledge/llm/foo");
            lib.addSlide(wiki, "knowledge/llm/foo");
            lib.addSlide(wiki, "knowledge/llm/foo");
            expect(lib.getSlideTitles(wiki, "knowledge/llm/foo")).toEqual([
                "knowledge/llm/foo/slides/slide-1",
                "knowledge/llm/foo/slides/slide-2",
                "knowledge/llm/foo/slides/slide-3"
            ]);
        });

        it("filters out order entries that no longer resolve to tiddlers", function () {
            // Manually craft an order with a stale entry.
            var wiki = setupWiki(ownerSeed().concat([
                { title: "knowledge/llm/foo/slides/slide-1",
                  "kn.type": "slide",
                  tags: "$:/tags/rimir/mindmap/slide" }
            ]));
            wiki.addTiddler(new $tw.Tiddler(wiki.getTiddler("knowledge/llm/foo"), {
                "mm.slide-order": "knowledge/llm/foo/slides/slide-1 knowledge/llm/foo/slides/stale"
            }));
            expect(lib.getSlideTitles(wiki, "knowledge/llm/foo")).toEqual([
                "knowledge/llm/foo/slides/slide-1"
            ]);
        });

        it("returns [] for owners without any slides", function () {
            var wiki = setupWiki(ownerSeed());
            expect(lib.getSlideTitles(wiki, "knowledge/llm/foo")).toEqual([]);
        });
    });

    describe("removeSlide", function () {
        it("deletes the slide tiddler and scrubs the owner's order list", function () {
            var wiki = setupWiki(ownerSeed());
            var t1 = lib.addSlide(wiki, "knowledge/llm/foo");
            var t2 = lib.addSlide(wiki, "knowledge/llm/foo");
            expect(lib.removeSlide(wiki, t1)).toBe(true);
            expect(wiki.getTiddler(t1)).toBeUndefined();
            // t2 still present and remains in the order.
            expect(wiki.getTiddler(t2)).toBeTruthy();
            var order = $tw.utils.parseStringArray(
                wiki.getTiddler("knowledge/llm/foo").fields["mm.slide-order"] || "");
            expect(order).toEqual([t2]);
        });

        it("is a no-op when the slide title doesn't exist", function () {
            var wiki = setupWiki(ownerSeed());
            expect(lib.removeSlide(wiki, "knowledge/llm/foo/slides/nope")).toBe(false);
        });
    });

    describe("moveSlide", function () {
        it("moves a slide by the supplied delta", function () {
            var wiki = setupWiki(ownerSeed());
            var t1 = lib.addSlide(wiki, "knowledge/llm/foo");
            var t2 = lib.addSlide(wiki, "knowledge/llm/foo");
            var t3 = lib.addSlide(wiki, "knowledge/llm/foo");
            expect(lib.moveSlide(wiki, t3, -1)).toBe(true);
            expect(lib.getSlideTitles(wiki, "knowledge/llm/foo")).toEqual([t1, t3, t2]);
        });

        it("saturates at list bounds (moving the first slide up is a no-op)", function () {
            var wiki = setupWiki(ownerSeed());
            var t1 = lib.addSlide(wiki, "knowledge/llm/foo");
            lib.addSlide(wiki, "knowledge/llm/foo");
            expect(lib.moveSlide(wiki, t1, -1)).toBe(false);
        });

        it("returns false when the slide isn't in the order", function () {
            var wiki = setupWiki(ownerSeed());
            lib.addSlide(wiki, "knowledge/llm/foo");
            expect(lib.moveSlide(wiki, "knowledge/llm/foo/slides/foreign", 1, "knowledge/llm/foo")).toBe(false);
        });
    });
});
