/*\
title: $:/plugins/rimir/mindmap/overlay-store.js
type: application/javascript
module-type: library

Reads, parses and persists overlay op logs. An overlay tiddler's `text` field
holds a JSON array of Op objects.

Writes are debounced (default 250 ms) so a drag gesture that emits many
intermediate events collapses to a single tiddler save - filesystem-watcher
and git-int would otherwise pick up every pointermove as a change.

The store does NOT interpret ops - that is the composer's job. It only
loads/saves and offers an append helper.

\*/

"use strict";

var DEFAULT_DEBOUNCE_MS = 250;

function readOps(wiki, title) {
    if (!title) { return []; }
    var text = wiki.getTiddlerText(title);
    if (!text) { return []; }
    try {
        var parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        // Surface as empty - widget will display a toolbar warning.
        return [];
    }
}

function writeOps(wiki, title, ops) {
    if (!title) { return; }
    var existing = wiki.getTiddler(title);
    var fields = existing ? Object.create(null) : { type: "application/json" };
    if (existing) {
        for (var k in existing.fields) { fields[k] = existing.fields[k]; }
        if (!fields.type) { fields.type = "application/json"; }
    }
    fields.title = title;
    fields.text = JSON.stringify(ops, null, 2);
    wiki.addTiddler(new $tw.Tiddler(wiki.getCreationFields(), fields, wiki.getModificationFields()));
}

/*
 * Store factory. Each $mindmap widget gets its own store bound to one
 * overlay tiddler title.
 *
 *   var store = createStore(wiki, "MyMap/overlay", { debounceMs: 250 });
 *   store.read();                  // → [op, ...]  (fresh from wiki)
 *   store.append(op);              // → enqueues a save (debounced)
 *   store.flush();                 // → forces an immediate save
 *   store.destroy();               // → cancels pending timer
 */
exports.createStore = function(wiki, title, options) {
    options = options || {};
    var debounceMs = typeof options.debounceMs === "number" ? options.debounceMs : DEFAULT_DEBOUNCE_MS;
    var pending = null;     // buffered ops not yet written
    var timer = null;
    var destroyed = false;

    function snapshot() {
        return readOps(wiki, title);
    }

    function scheduleFlush() {
        if (destroyed || !title) { return; }
        if (timer) { return; }
        timer = setTimeout(function () {
            timer = null;
            if (destroyed) { return; }
            if (!pending) { return; }
            var ops = pending;
            pending = null;
            writeOps(wiki, title, ops);
        }, debounceMs);
    }

    return {
        read: snapshot,

        // Return the current in-memory pending ops if a flush hasn't fired
        // yet, otherwise the wiki snapshot. Useful when callers need to
        // reflect just-appended ops in UI before the debounced write lands.
        peek: function () {
            return pending ? pending.slice() : snapshot();
        },

        // Replace the full op log atomically.
        replace: function (ops) {
            if (destroyed || !title) { return; }
            pending = Array.isArray(ops) ? ops.slice() : [];
            scheduleFlush();
        },

        // Append a single op. Buffers in memory; coalesces drag-style
        // setAttr ops on the same id/key so multiple intermediate values
        // collapse to the final one.
        append: function (op) {
            if (destroyed || !title || !op) { return; }
            if (!pending) { pending = snapshot(); }
            if (op.op === "setAttr" && pending.length > 0) {
                var last = pending[pending.length - 1];
                if (
                    last && last.op === "setAttr" &&
                    last.id === op.id && last.key === op.key
                ) {
                    pending[pending.length - 1] = op;
                    scheduleFlush();
                    return;
                }
            }
            pending.push(op);
            scheduleFlush();
        },

        flush: function () {
            if (timer) { clearTimeout(timer); timer = null; }
            if (pending && !destroyed && title) {
                var ops = pending;
                pending = null;
                writeOps(wiki, title, ops);
            }
        },

        destroy: function () {
            destroyed = true;
            if (timer) { clearTimeout(timer); timer = null; }
            pending = null;
        }
    };
};

// Exposed for tests / direct use
exports.readOps = readOps;
exports.writeOps = writeOps;
