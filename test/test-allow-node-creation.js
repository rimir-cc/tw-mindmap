/*\
title: $:/plugins/rimir/mindmap/test/test-allow-node-creation.js
type: application/javascript
tags: [[$:/tags/test-spec]]

Pins for `_resolveAllowNodeCreation`. The widget attr takes precedence over
the view-tiddler field; both can be missing (treated as default-allow).

\*/

"use strict";

describe("mindmap-allow-node-creation", function () {
    var widget = require("$:/plugins/rimir/mindmap/widget.js");
    var fn = widget._resolveAllowNodeCreation;

    it("defaults to true when neither attr nor field is set", function () {
        expect(fn("", "")).toBe(true);
        expect(fn(undefined, undefined)).toBe(true);
    });

    it("honors widget attr 'no' even when view field is 'yes'", function () {
        expect(fn("no", "yes")).toBe(false);
    });

    it("honors widget attr 'yes' even when view field is 'no'", function () {
        expect(fn("yes", "no")).toBe(true);
    });

    it("falls back to view field when attr is empty", function () {
        expect(fn("", "no")).toBe(false);
        expect(fn("", "yes")).toBe(true);
    });

    it("treats garbage values as 'not set' (default-allow)", function () {
        // Defensive: unknown strings shouldn't accidentally disable creation.
        expect(fn("maybe", "")).toBe(true);
        expect(fn("", "garbage")).toBe(true);
        expect(fn("xyz", "abc")).toBe(true);
    });
});
