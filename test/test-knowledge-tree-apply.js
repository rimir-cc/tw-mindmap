/*\
title: $:/plugins/rimir/mindmap/test/test-knowledge-tree-apply.js
type: application/javascript
tags: [[$:/tags/test-spec]]

Unit tests for knowledge-tree.applyOps. Exercises rename / reparent /
removeNode in a fresh wiki — flibbles/relink is not loaded in the test
edition, so the producer's fallback delete+add path is what runs here.
The actual reference-relinking path is verified by flibbles' own test
suite plus the manual smoke test for Landing A.

\*/

"use strict";

describe("mindmap-knowledge-tree-apply", function () {
    var producer = require("$:/plugins/rimir/mindmap/producers/knowledge-tree.js");

    function setupWiki(tiddlers) {
        var wiki = new $tw.Wiki();
        wiki.addTiddlers(tiddlers || []);
        wiki.addIndexersToWiki();
        return wiki;
    }

    // Stubs an "llm" area so the producer's enrichment path doesn't NPE if
    // called. Not strictly required for applyOps tests.
    function areaSeed() {
        return [
            { title: "knowledge/llm",
              tags: "$:/tags/rimir/knowledge-app/area",
              "area-id": "llm", caption: "LLM" }
        ];
    }

    describe("titleForOp", function () {
        it("returns the tiddler title for a non-synthetic id", function () {
            expect(producer.titleForOp({ op: "rename", id: "kt:knowledge/llm/foo" }))
                .toBe("knowledge/llm/foo");
        });

        it("returns null for synthetic root ids", function () {
            expect(producer.titleForOp({ op: "rename", id: "kt:__knowledge__" })).toBe(null);
            expect(producer.titleForOp({ op: "rename", id: "kt:__empty__" })).toBe(null);
        });

        it("returns null for addNode ops (no pre-existing target)", function () {
            expect(producer.titleForOp({ op: "addNode", parent: "kt:knowledge/llm" })).toBe(null);
        });
    });

    describe("idForTitle", function () {
        it("prefixes a non-empty title with the producer's namespace", function () {
            expect(producer.idForTitle("knowledge/llm/foo")).toBe("kt:knowledge/llm/foo");
            expect(producer.idForTitle("anything")).toBe("kt:anything");
        });

        it("returns null for blank input", function () {
            expect(producer.idForTitle("")).toBe(null);
            expect(producer.idForTitle(null)).toBe(null);
            expect(producer.idForTitle(undefined)).toBe(null);
        });

        it("round-trips with titleForOp for real titles", function () {
            var id = producer.idForTitle("knowledge/llm/foo");
            expect(producer.titleForOp({ op: "rename", id: id })).toBe("knowledge/llm/foo");
        });
    });

    describe("produce — slide exclusion", function () {
        it("excludes slide tiddlers from the area tree (v0.2.7+)", function () {
            var wiki = setupWiki(areaSeed().concat([
                { title: "knowledge/llm/foo", "kn.type": "note", text: "owner body" },
                { title: "knowledge/llm/foo/slides/slide-1",
                  "kn.type": "slide",
                  tags: "$:/tags/rimir/mindmap/slide",
                  "mm.slide-of": "knowledge/llm/foo",
                  text: "slide body" }
            ]));
            var mdom = producer.produce({ area: "llm" }, wiki);
            // Walk the MDOM and collect tiddler-bearing node titles.
            var titles = [];
            function walk(node) {
                if (node.attrs && node.attrs["core:tiddler"]) {
                    titles.push(node.attrs["core:tiddler"]);
                }
                (node.children || []).forEach(walk);
            }
            walk(mdom.root);
            expect(titles).toContain("knowledge/llm/foo");
            // Slide tiddler must NOT appear as its own node.
            expect(titles).not.toContain("knowledge/llm/foo/slides/slide-1");
        });
    });

    describe("refreshFilter — slide exclusion", function () {
        // Slides change frequently (every keystroke in the body $edit-text).
        // The producer's refreshFilter must NOT include slide-tagged tiddlers,
        // or we'd trigger a wasteful tree-reproduce on every slide-body
        // character.
        it("excludes slide-tagged tiddlers from the watched set (area mode)", function () {
            var wiki = setupWiki(areaSeed().concat([
                { title: "knowledge/llm/foo", "kn.type": "note" },
                { title: "knowledge/llm/foo/slides/slide-1",
                  "kn.type": "slide",
                  tags: "$:/tags/rimir/mindmap/slide" }
            ]));
            var filter = producer.refreshFilter({ area: "llm" });
            expect(filter).toBeTruthy();
            var watched = wiki.filterTiddlers(filter);
            expect(watched).toContain("knowledge/llm/foo");
            expect(watched).not.toContain("knowledge/llm/foo/slides/slide-1");
        });

        it("excludes slide-tagged tiddlers in forest mode (include-areas-root)", function () {
            var wiki = setupWiki(areaSeed().concat([
                { title: "knowledge/llm/foo", "kn.type": "note" },
                { title: "knowledge/llm/foo/slides/slide-1",
                  "kn.type": "slide",
                  tags: "$:/tags/rimir/mindmap/slide" }
            ]));
            var filter = producer.refreshFilter({ "include-areas-root": "yes" });
            expect(filter).toBeTruthy();
            var watched = wiki.filterTiddlers(filter);
            expect(watched).toContain("knowledge/llm/foo");
            expect(watched).not.toContain("knowledge/llm/foo/slides/slide-1");
        });

        it("excludes slide-tagged tiddlers when focused on a subtree", function () {
            var wiki = setupWiki(areaSeed().concat([
                { title: "knowledge/llm/foo", "kn.type": "note" },
                { title: "knowledge/llm/foo/bar", "kn.type": "note" },
                { title: "knowledge/llm/foo/bar/slides/slide-1",
                  "kn.type": "slide",
                  tags: "$:/tags/rimir/mindmap/slide" }
            ]));
            var filter = producer.refreshFilter({
                area: "llm",
                "focus-title": "knowledge/llm/foo"
            });
            var watched = wiki.filterTiddlers(filter);
            expect(watched).toContain("knowledge/llm/foo/bar");
            expect(watched).not.toContain("knowledge/llm/foo/bar/slides/slide-1");
        });
    });

    describe("produce — slides-only pruning (v0.2.8+)", function () {
        // Collect all tiddler-bearing node titles in an MDOM for assertions.
        function tiddlerTitles(mdom) {
            var titles = [];
            function walk(node) {
                if (node.attrs && node.attrs["core:tiddler"]) {
                    titles.push(node.attrs["core:tiddler"]);
                }
                (node.children || []).forEach(walk);
            }
            walk(mdom.root);
            return titles;
        }

        it("does nothing without the slides-only arg (regression guard)", function () {
            var wiki = setupWiki(areaSeed().concat([
                { title: "knowledge/llm/foo", "kn.type": "note" },
                { title: "knowledge/llm/bar", "kn.type": "note" }
            ]));
            // Neither foo nor bar has slides — they should still appear without
            // the arg.
            var mdom = producer.produce({ area: "llm" }, wiki);
            var titles = tiddlerTitles(mdom);
            expect(titles).toContain("knowledge/llm/foo");
            expect(titles).toContain("knowledge/llm/bar");
        });

        it("prunes branches whose entire subtree has no slides", function () {
            var wiki = setupWiki(areaSeed().concat([
                { title: "knowledge/llm/foo", "kn.type": "note" },
                { title: "knowledge/llm/foo/slides/slide-1",
                  "kn.type": "slide",
                  tags: "$:/tags/rimir/mindmap/slide" },
                { title: "knowledge/llm/bar", "kn.type": "note" },
                { title: "knowledge/llm/baz", "kn.type": "note" }
            ]));
            // Wire foo's mm.slide-order so getSlideTitles sees the slide.
            wiki.addTiddler(new $tw.Tiddler(
                wiki.getTiddler("knowledge/llm/foo"),
                { "mm.slide-order": "knowledge/llm/foo/slides/slide-1" }
            ));
            var mdom = producer.produce({ area: "llm", "slides-only": "yes" }, wiki);
            var titles = tiddlerTitles(mdom);
            expect(titles).toContain("knowledge/llm/foo");
            expect(titles).not.toContain("knowledge/llm/bar");
            expect(titles).not.toContain("knowledge/llm/baz");
            expect(mdom.root.attrs["mm:slides-only"]).toBe(true);
        });

        it("keeps a node when only a descendant has slides", function () {
            var wiki = setupWiki(areaSeed().concat([
                { title: "knowledge/llm/foo", "kn.type": "note" },
                { title: "knowledge/llm/foo/bar", "kn.type": "note" },
                { title: "knowledge/llm/foo/bar/slides/slide-1",
                  "kn.type": "slide",
                  tags: "$:/tags/rimir/mindmap/slide" }
            ]));
            wiki.addTiddler(new $tw.Tiddler(
                wiki.getTiddler("knowledge/llm/foo/bar"),
                { "mm.slide-order": "knowledge/llm/foo/bar/slides/slide-1" }
            ));
            var titles = tiddlerTitles(producer.produce(
                { area: "llm", "slides-only": "yes" }, wiki));
            // Both ancestor and descendant must survive the prune.
            expect(titles).toContain("knowledge/llm/foo");
            expect(titles).toContain("knowledge/llm/foo/bar");
        });

        it("stamps mm:has-slides on nodes that own slides directly", function () {
            var wiki = setupWiki(areaSeed().concat([
                { title: "knowledge/llm/foo", "kn.type": "note" },
                { title: "knowledge/llm/foo/slides/slide-1",
                  "kn.type": "slide",
                  tags: "$:/tags/rimir/mindmap/slide" }
            ]));
            wiki.addTiddler(new $tw.Tiddler(
                wiki.getTiddler("knowledge/llm/foo"),
                { "mm.slide-order": "knowledge/llm/foo/slides/slide-1" }
            ));
            var mdom = producer.produce(
                { area: "llm", "slides-only": "yes" }, wiki);
            // Find the foo node.
            var fooNode = null;
            function walk(node) {
                if (node.attrs && node.attrs["core:tiddler"] === "knowledge/llm/foo") {
                    fooNode = node;
                }
                (node.children || []).forEach(walk);
            }
            walk(mdom.root);
            expect(fooNode).toBeTruthy();
            expect(fooNode.attrs["mm:has-slides"]).toBe(true);
        });

        it("preserves the root even when no slides exist anywhere", function () {
            var wiki = setupWiki(areaSeed().concat([
                { title: "knowledge/llm/foo", "kn.type": "note" }
            ]));
            var mdom = producer.produce(
                { area: "llm", "slides-only": "yes" }, wiki);
            // Root survives; foo is pruned away (no slides anywhere).
            expect(mdom.root).toBeTruthy();
            expect(tiddlerTitles(mdom)).not.toContain("knowledge/llm/foo");
        });
    });

    describe("rename", function () {
        it("renames a leaf tiddler with the sanitised slug", function () {
            var wiki = setupWiki(areaSeed().concat([
                { title: "knowledge/llm/foo", text: "body" }
            ]));
            var results = producer.applyOps([
                { op: "rename", id: "kt:knowledge/llm/foo", label: "API Endpoints" }
            ], {}, wiki);
            expect(results[0].changed).toBe(true);
            expect(results[0].newTitle).toBe("knowledge/llm/api-endpoints");
            expect(wiki.getTiddler("knowledge/llm/foo")).toBeFalsy();
            expect(wiki.getTiddler("knowledge/llm/api-endpoints")).toBeTruthy();
            expect(wiki.getTiddlerText("knowledge/llm/api-endpoints")).toBe("body");
        });

        it("collision-suffixes when the slug already exists", function () {
            var wiki = setupWiki(areaSeed().concat([
                { title: "knowledge/llm/foo", text: "f" },
                { title: "knowledge/llm/bar", text: "b" }
            ]));
            var results = producer.applyOps([
                { op: "rename", id: "kt:knowledge/llm/foo", label: "bar" }
            ], {}, wiki);
            expect(results[0].newTitle).toBe("knowledge/llm/bar-2");
            expect(results[0].collisionResolved).toBe(true);
            expect(wiki.getTiddler("knowledge/llm/bar").fields.text).toBe("b");
            expect(wiki.getTiddler("knowledge/llm/bar-2").fields.text).toBe("f");
        });

        it("skips when the new label sanitises to empty", function () {
            var wiki = setupWiki(areaSeed().concat([
                { title: "knowledge/llm/foo", text: "x" }
            ]));
            var results = producer.applyOps([
                { op: "rename", id: "kt:knowledge/llm/foo", label: "///---" }
            ], {}, wiki);
            expect(results[0].skipped).toBe("empty-slug");
            // Original untouched.
            expect(wiki.getTiddler("knowledge/llm/foo")).toBeTruthy();
        });

        it("skips synthetic ids", function () {
            var wiki = setupWiki(areaSeed());
            var results = producer.applyOps([
                { op: "rename", id: "kt:__knowledge__", label: "x" }
            ], {}, wiki);
            expect(results[0].skipped).toBe("no-source-title");
        });
    });

    describe("reparent", function () {
        it("moves a leaf under a new parent path", function () {
            var wiki = setupWiki(areaSeed().concat([
                { title: "knowledge/llm/foo", text: "f" },
                { title: "knowledge/llm/agents", text: "a" }
            ]));
            var results = producer.applyOps([
                { op: "reparent", id: "kt:knowledge/llm/foo",
                  newParent: "kt:knowledge/llm/agents" }
            ], {}, wiki);
            expect(results[0].changed).toBe(true);
            expect(results[0].newTitle).toBe("knowledge/llm/agents/foo");
            expect(wiki.getTiddler("knowledge/llm/foo")).toBeFalsy();
            expect(wiki.getTiddler("knowledge/llm/agents/foo").fields.text).toBe("f");
        });

        it("collision-suffixes if a sibling of the target already has that leaf", function () {
            var wiki = setupWiki(areaSeed().concat([
                { title: "knowledge/llm/foo", text: "src" },
                { title: "knowledge/llm/agents", text: "a" },
                { title: "knowledge/llm/agents/foo", text: "existing" }
            ]));
            var results = producer.applyOps([
                { op: "reparent", id: "kt:knowledge/llm/foo",
                  newParent: "kt:knowledge/llm/agents" }
            ], {}, wiki);
            expect(results[0].newTitle).toBe("knowledge/llm/agents/foo-2");
            expect(wiki.getTiddler("knowledge/llm/agents/foo").fields.text).toBe("existing");
            expect(wiki.getTiddler("knowledge/llm/agents/foo-2").fields.text).toBe("src");
        });

        it("no-ops when source already lives under newParent with same leaf", function () {
            var wiki = setupWiki(areaSeed().concat([
                { title: "knowledge/llm/agents/foo", text: "x" },
                { title: "knowledge/llm/agents", text: "a" }
            ]));
            var results = producer.applyOps([
                { op: "reparent", id: "kt:knowledge/llm/agents/foo",
                  newParent: "kt:knowledge/llm/agents" }
            ], {}, wiki);
            expect(results[0].changed).toBe(false);
            expect(wiki.getTiddler("knowledge/llm/agents/foo").fields.text).toBe("x");
        });
    });

    describe("removeNode", function () {
        it("deletes the target tiddler", function () {
            var wiki = setupWiki(areaSeed().concat([
                { title: "knowledge/llm/foo", text: "x" }
            ]));
            var results = producer.applyOps([
                { op: "removeNode", id: "kt:knowledge/llm/foo" }
            ], {}, wiki);
            expect(results[0].deleted).toBe(1);
            expect(wiki.getTiddler("knowledge/llm/foo")).toBeFalsy();
        });

        it("cascades to descendants (bottom-up)", function () {
            var wiki = setupWiki(areaSeed().concat([
                { title: "knowledge/llm/foo", text: "f" },
                { title: "knowledge/llm/foo/a", text: "a" },
                { title: "knowledge/llm/foo/a/x", text: "x" },
                { title: "knowledge/llm/foo/b", text: "b" },
                { title: "knowledge/llm/other", text: "o" }
            ]));
            var results = producer.applyOps([
                { op: "removeNode", id: "kt:knowledge/llm/foo" }
            ], {}, wiki);
            expect(results[0].deleted).toBe(4);  // foo + a + a/x + b
            expect(wiki.getTiddler("knowledge/llm/foo")).toBeFalsy();
            expect(wiki.getTiddler("knowledge/llm/foo/a")).toBeFalsy();
            expect(wiki.getTiddler("knowledge/llm/foo/a/x")).toBeFalsy();
            expect(wiki.getTiddler("knowledge/llm/foo/b")).toBeFalsy();
            // Unrelated tiddler untouched.
            expect(wiki.getTiddler("knowledge/llm/other").fields.text).toBe("o");
        });
    });

    describe("capabilities", function () {
        it("declares the structural op whitelist", function () {
            expect(producer.capabilities.structural).toBe(true);
            expect(producer.capabilities.structuralOps).toContain("rename");
            expect(producer.capabilities.structuralOps).toContain("reparent");
            expect(producer.capabilities.structuralOps).toContain("removeNode");
            expect(producer.capabilities.structuralOps).toContain("addNode");
        });
    });

    describe("addNode", function () {
        it("creates a new tiddler under the parent with sanitised slug", function () {
            var wiki = setupWiki(areaSeed().concat([
                { title: "knowledge/llm/training", text: "training branch" }
            ]));
            var results = producer.applyOps([
                { op: "addNode",
                  parent: "kt:knowledge/llm/training",
                  node: { id: "kt:placeholder", label: "RAG Patterns" } }
            ], {}, wiki);
            expect(results[0].changed).toBe(true);
            expect(results[0].newTitle).toBe("knowledge/llm/training/rag-patterns");
            var t = wiki.getTiddler("knowledge/llm/training/rag-patterns");
            expect(t).toBeTruthy();
            expect(t.fields["kn.type"]).toBe("note");      // fixed:note default
            expect(t.fields["kn.tier"]).toBe("fleeting");
            expect(t.fields.tags).toContain("$:/tags/rimir/knowledge-app/note");
        });

        it("uniquifies the slug on collision", function () {
            var wiki = setupWiki(areaSeed().concat([
                { title: "knowledge/llm/training", text: "" },
                { title: "knowledge/llm/training/rlhf", text: "x" }
            ]));
            var results = producer.applyOps([
                { op: "addNode",
                  parent: "kt:knowledge/llm/training",
                  node: { id: "kt:placeholder", label: "rlhf" } }
            ], {}, wiki);
            expect(results[0].newTitle).toBe("knowledge/llm/training/rlhf-2");
            expect(results[0].collisionResolved).toBe(true);
        });

        it("respects derive-from-parent strategy when configured", function () {
            var wiki = setupWiki(areaSeed().concat([
                { title: "knowledge/llm/training",
                  "kn.type": "idea", text: "" },
                { title: "$:/config/rimir/mindmap/structural/new-node-type-strategy",
                  text: "derive-from-parent" }
            ]));
            var results = producer.applyOps([
                { op: "addNode",
                  parent: "kt:knowledge/llm/training",
                  node: { id: "kt:placeholder", label: "Sub branch" } }
            ], {}, wiki);
            var t = wiki.getTiddler("knowledge/llm/training/sub-branch");
            expect(t.fields["kn.type"]).toBe("idea");
        });

        it("skips when the label sanitises to empty", function () {
            var wiki = setupWiki(areaSeed().concat([
                { title: "knowledge/llm/training", text: "" }
            ]));
            var results = producer.applyOps([
                { op: "addNode",
                  parent: "kt:knowledge/llm/training",
                  node: { id: "kt:placeholder", label: "///" } }
            ], {}, wiki);
            expect(results[0].skipped).toBe("empty-slug");
        });

        it("skips when parent is synthetic", function () {
            var wiki = setupWiki(areaSeed());
            var results = producer.applyOps([
                { op: "addNode",
                  parent: "kt:__knowledge__",
                  node: { id: "kt:placeholder", label: "foo" } }
            ], {}, wiki);
            expect(results[0].skipped).toBe("no-parent-title");
        });
    });

    // Landing C-prime — configurable visible-label field. In non-title mode
    // rename writes only to the chosen field; addNode also stamps it.
    describe("label-field mode", function () {
        it("rename writes to the chosen field, leaving the title alone", function () {
            var wiki = setupWiki(areaSeed().concat([
                { title: "knowledge/llm/foo", text: "body", caption: "Old" }
            ]));
            var results = producer.applyOps([
                { op: "rename", id: "kt:knowledge/llm/foo", label: "Brand new label" }
            ], { "label-field": "caption" }, wiki);
            expect(results[0].changed).toBe(true);
            expect(results[0].field).toBe("caption");
            expect(results[0].value).toBe("Brand new label");
            // Title unchanged — structural identity preserved.
            expect(wiki.getTiddler("knowledge/llm/foo")).toBeTruthy();
            expect(wiki.getTiddler("knowledge/llm/foo").fields.caption).toBe("Brand new label");
            expect(wiki.getTiddlerText("knowledge/llm/foo")).toBe("body");
        });

        it("rename in caption-mode does not invoke the title sanitiser (free-form text allowed)", function () {
            var wiki = setupWiki(areaSeed().concat([
                { title: "knowledge/llm/foo", text: "" }
            ]));
            // A label with characters the title sanitiser would strip:
            // slashes, brackets, etc. They survive as the caption value.
            var results = producer.applyOps([
                { op: "rename", id: "kt:knowledge/llm/foo", label: "What/about | this [stuff]?" }
            ], { "label-field": "caption" }, wiki);
            expect(results[0].changed).toBe(true);
            expect(wiki.getTiddler("knowledge/llm/foo").fields.caption)
                .toBe("What/about | this [stuff]?");
        });

        it("addNode stamps the chosen field with the unsanitised label", function () {
            var wiki = setupWiki(areaSeed().concat([
                { title: "knowledge/llm/training", text: "" }
            ]));
            var results = producer.applyOps([
                { op: "addNode",
                  parent: "kt:knowledge/llm/training",
                  node: { id: "kt:placeholder", label: "Fancy Mixed/Case" } }
            ], { "label-field": "caption" }, wiki);
            expect(results[0].changed).toBe(true);
            // Title slug still sanitised (structural identity stays clean) —
            // slash is among the stripped chars.
            expect(results[0].newTitle).toBe("knowledge/llm/training/fancy-mixedcase");
            var t = wiki.getTiddler(results[0].newTitle);
            // Caption field carries the typed-but-trimmed value (slash kept).
            expect(t.fields.caption).toBe("Fancy Mixed/Case");
        });

        it("title-mode (default) does NOT stamp a caption field", function () {
            var wiki = setupWiki(areaSeed().concat([
                { title: "knowledge/llm/training", text: "" }
            ]));
            var results = producer.applyOps([
                { op: "addNode",
                  parent: "kt:knowledge/llm/training",
                  node: { id: "kt:placeholder", label: "RAG Patterns" } }
            ], {}, wiki);
            var t = wiki.getTiddler(results[0].newTitle);
            expect(t.fields.caption).toBeUndefined();
        });

        it("returns wanted + parent on collision so the toast has context", function () {
            var wiki = setupWiki(areaSeed().concat([
                { title: "knowledge/llm/foo", text: "" },
                { title: "knowledge/llm/bar", text: "" }
            ]));
            var results = producer.applyOps([
                { op: "rename", id: "kt:knowledge/llm/foo", label: "bar" }
            ], {}, wiki);
            expect(results[0].collisionResolved).toBe(true);
            expect(results[0].wanted).toBe("bar");
            expect(results[0].parent).toBe("knowledge/llm");
            expect(results[0].newTitle).toBe("knowledge/llm/bar-2");
        });
    });
});
