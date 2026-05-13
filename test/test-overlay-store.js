/*\
title: $:/plugins/rimir/mindmap/test/test-overlay-store.js
type: application/javascript
tags: [[$:/tags/test-spec]]

Pins for overlay-store.createStore — focused on the peek() semantics added
in v0.2.11 (widget needs immediate visibility of debounce-pending ops to
keep the saved-state toolbar buttons responsive, and to keep compose() from
showing a stale state for a quarter second after each user toggle).

\*/

"use strict";

describe("mindmap-overlay-store", function () {
    var overlayStore = require("$:/plugins/rimir/mindmap/overlay-store.js");

    // Minimal fake wiki: an in-memory map of title → tiddler-like object.
    // Only the methods overlay-store touches are stubbed.
    function fakeWiki(initial) {
        var store = Object.create(null);
        if (initial) {
            for (var k in initial) {
                store[k] = { fields: { title: k, text: initial[k] } };
            }
        }
        return {
            getTiddler: function (t) { return store[t] || null; },
            getTiddlerText: function (t, fallback) {
                var tid = store[t];
                return tid ? tid.fields.text : (fallback || "");
            },
            addTiddler: function (t) {
                // t may be $tw.Tiddler instance or plain object — both expose .fields.
                var fields = t.fields || t;
                var title = fields.title;
                store[title] = { fields: fields };
            },
            getCreationFields: function () { return {}; },
            getModificationFields: function () { return {}; }
        };
    }

    describe("peek()", function () {
        it("returns the wiki snapshot when no append has happened yet", function () {
            var wiki = fakeWiki({
                "X/overlay": JSON.stringify([
                    { op: "setAttr", id: "a", key: "core:collapsed", value: true }
                ])
            });
            var store = overlayStore.createStore(wiki, "X/overlay");
            var peeked = store.peek();
            expect(peeked.length).toBe(1);
            expect(peeked[0].id).toBe("a");
        });

        it("returns pending ops after append() before flush — wiki unchanged", function () {
            var wiki = fakeWiki({ "X/overlay": "[]" });
            var store = overlayStore.createStore(wiki, "X/overlay", { debounceMs: 10000 });
            store.append({ op: "setAttr", id: "a", key: "core:collapsed", value: true });
            // peek sees the just-appended op.
            var peeked = store.peek();
            expect(peeked.length).toBe(1);
            expect(peeked[0].id).toBe("a");
            // read() sees the wiki tiddler, which hasn't been written yet
            // (flush is scheduled but the debounce hasn't fired).
            expect(store.read()).toEqual([]);
        });

        it("returns a copy — caller mutations don't affect the pending list", function () {
            var wiki = fakeWiki({ "X/overlay": "[]" });
            var store = overlayStore.createStore(wiki, "X/overlay", { debounceMs: 10000 });
            store.append({ op: "setAttr", id: "a", key: "core:collapsed", value: true });
            var peeked = store.peek();
            peeked.push({ op: "fake" });
            // The next peek() should NOT see the externally pushed op.
            expect(store.peek().length).toBe(1);
        });

        it("coalesced setAttr on same id/key shows the latest value", function () {
            var wiki = fakeWiki({ "X/overlay": "[]" });
            var store = overlayStore.createStore(wiki, "X/overlay", { debounceMs: 10000 });
            store.append({ op: "setAttr", id: "a", key: "core:collapsed", value: true });
            store.append({ op: "setAttr", id: "a", key: "core:collapsed", value: null });
            store.append({ op: "setAttr", id: "a", key: "core:collapsed", value: true });
            var peeked = store.peek();
            expect(peeked.length).toBe(1);
            expect(peeked[0].value).toBe(true);
        });

        it("after replace() returns the replacement, before flush", function () {
            var wiki = fakeWiki({
                "X/overlay": JSON.stringify([{ op: "setAttr", id: "a", key: "k", value: 1 }])
            });
            var store = overlayStore.createStore(wiki, "X/overlay", { debounceMs: 10000 });
            store.replace([]);
            expect(store.peek()).toEqual([]);
        });

        it("returns empty array when no overlay title configured", function () {
            var wiki = fakeWiki({});
            var store = overlayStore.createStore(wiki, "" /* no title */);
            expect(store.peek()).toEqual([]);
            store.append({ op: "setAttr", id: "a", key: "k", value: 1 });
            // Append is a no-op when title is missing.
            expect(store.peek()).toEqual([]);
        });
    });
});
