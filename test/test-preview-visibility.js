/*\
title: $:/plugins/rimir/mindmap/test/test-preview-visibility.js
type: application/javascript
tags: [[$:/tags/test-spec]]

Regression pins for `_isPreviewPaneVisible` (extracted from
`updatePreviewPaneVisibility`).

The rule is mode-aware: Body / Slides need a selection; Presentation needs
an active presentation (selection optional). The v0.2.6 implementation
kept the pane open whenever a presentation was active on the view, which
blocked the canvas from reclaiming full width when the user deselected in
Body / Slides mode. v0.2.9 fixed that — these specs make sure the rule
doesn't regress.

\*/

"use strict";

describe("mindmap-preview-visibility", function () {
    var widget = require("$:/plugins/rimir/mindmap/widget.js");
    var fn = widget._isPreviewPaneVisible;

    describe("body mode", function () {
        it("visible iff there is a selection (presentation existence ignored)", function () {
            expect(fn("body", true,  false)).toBe(true);
            expect(fn("body", true,  true)).toBe(true);
            expect(fn("body", false, false)).toBe(false);
            // The regression: presentation active but no selection → still
            // hidden. The v0.2.6 logic returned true here.
            expect(fn("body", false, true)).toBe(false);
        });
    });

    describe("slides mode", function () {
        it("visible iff there is a selection (presentation existence ignored)", function () {
            expect(fn("slides", true,  false)).toBe(true);
            expect(fn("slides", true,  true)).toBe(true);
            expect(fn("slides", false, false)).toBe(false);
            // Same regression check as body mode.
            expect(fn("slides", false, true)).toBe(false);
        });
    });

    describe("presentation mode", function () {
        it("visible iff there is an active presentation (selection optional)", function () {
            expect(fn("presentation", false, true)).toBe(true);
            expect(fn("presentation", true,  true)).toBe(true);
            expect(fn("presentation", false, false)).toBe(false);
            // No selection AND no presentation → nothing to render.
            expect(fn("presentation", true,  false)).toBe(false);
        });
    });

    describe("unknown / falsy mode (defensive)", function () {
        it("treats unknown modes as body (selection-gated)", function () {
            // The current implementation: if mode !== "presentation",
            // visibility follows hasSelection. This means a stale state
            // tiddler with garbage in it doesn't accidentally pin the pane
            // open — it falls into the selection-gated branch.
            expect(fn("garbage", true,  false)).toBe(true);
            expect(fn("garbage", false, true)).toBe(false);
            expect(fn("",        false, true)).toBe(false);
            expect(fn(undefined, false, true)).toBe(false);
        });
    });
});
