/*\
title: $:/plugins/rimir/mindmap/test/test-saved-state.js
type: application/javascript
tags: [[$:/tags/test-spec]]

Pins for the saved-default + live-overlay merge contract. The widget reads
two op layers — `mm.saved-default` (view-wide default) and the live overlay
(per-entity, auto-persisted by the engine) — and feeds the concatenated list
to compose(). Order matters: defaults first, overlay second, so the last
write-wins semantics of `setAttr` lets a per-entity override beat the default
for the same id/key.

\*/

"use strict";

describe("mindmap-saved-state", function () {
    var widget = require("$:/plugins/rimir/mindmap/widget.js");
    var compose = require("$:/plugins/rimir/mindmap/compose.js").compose;
    var merge = widget._mergeSavedAndOverlay;

    describe("mergeSavedAndOverlay", function () {
        it("returns an empty list when both layers are empty / missing", function () {
            expect(merge([], [])).toEqual([]);
            expect(merge(null, null)).toEqual([]);
            expect(merge(undefined, undefined)).toEqual([]);
        });

        it("returns the non-empty side when the other is empty", function () {
            var a = [{ op: "setAttr", id: "x", key: "core:collapsed", value: true }];
            expect(merge(a, [])).toBe(a);     // identity — no needless clone
            expect(merge([], a)).toBe(a);
        });

        it("concatenates with defaults first, overlay second", function () {
            var d = [{ op: "setAttr", id: "a", key: "core:collapsed", value: true }];
            var o = [{ op: "setAttr", id: "b", key: "core:collapsed", value: true }];
            var out = merge(d, o);
            expect(out.length).toBe(2);
            expect(out[0]).toBe(d[0]);
            expect(out[1]).toBe(o[0]);
        });

        it("ignores non-array inputs (treats them as empty)", function () {
            expect(merge("garbage", null)).toEqual([]);
            expect(merge({}, [])).toEqual([]);
        });
    });

    describe("end-to-end compose order", function () {
        // The interesting property: when default and overlay both have a
        // setAttr for the same id+key, the overlay's value wins. compose()
        // applies ops left-to-right, so we just need to ensure overlay comes
        // after defaults.
        function baseMdom() {
            return {
                version: 1,
                root: {
                    id: "r",
                    label: "Root",
                    attrs: {},
                    children: [
                        { id: "a", label: "A", attrs: { "core:collapsed": true }, children: [] },
                        { id: "b", label: "B", attrs: {}, children: [] }
                    ]
                }
            };
        }

        it("overlay setAttr=null overrides default setAttr=true on the same id/key", function () {
            // Default: keep `a` collapsed (matching base).
            // Overlay: user expanded `a` — should win.
            var defaults = [{ op: "setAttr", id: "a", key: "core:collapsed", value: true }];
            var overlay  = [{ op: "setAttr", id: "a", key: "core:collapsed", value: null }];
            var merged = merge(defaults, overlay);
            var result = compose(baseMdom(), merged);
            var a = result.mdom.root.children[0];
            expect(a.attrs["core:collapsed"]).toBeUndefined();
        });

        it("overlay value beats default value on the same id/key", function () {
            var defaults = [{ op: "setAttr", id: "b", key: "core:collapsed", value: true }];
            var overlay  = [{ op: "setAttr", id: "b", key: "core:collapsed", value: false }];
            var merged = merge(defaults, overlay);
            var result = compose(baseMdom(), merged);
            var b = result.mdom.root.children[1];
            expect(b.attrs["core:collapsed"]).toBe(false);
        });

        it("defaults apply to ids the overlay doesn't touch", function () {
            var defaults = [
                { op: "setAttr", id: "a", key: "core:collapsed", value: null },
                { op: "setAttr", id: "b", key: "core:collapsed", value: true }
            ];
            var overlay = [];
            var merged = merge(defaults, overlay);
            var result = compose(baseMdom(), merged);
            expect(result.mdom.root.children[0].attrs["core:collapsed"]).toBeUndefined();
            expect(result.mdom.root.children[1].attrs["core:collapsed"]).toBe(true);
        });

        it("overlay-only is equivalent to legacy single-layer behaviour", function () {
            var defaults = [];
            var overlay  = [{ op: "setAttr", id: "a", key: "core:collapsed", value: null }];
            var merged = merge(defaults, overlay);
            var result = compose(baseMdom(), merged);
            expect(result.mdom.root.children[0].attrs["core:collapsed"]).toBeUndefined();
        });
    });
});
