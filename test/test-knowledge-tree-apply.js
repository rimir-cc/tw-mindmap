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
});
