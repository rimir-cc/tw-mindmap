/*\
title: $:/plugins/rimir/mindmap/lib/sanitize-title.js
type: application/javascript
module-type: library

Pure-JS helpers for turning user-supplied node labels into safe tiddler title
segments. Used by structural producers (knowledge-tree) when renaming and
creating tiddlers; surfaced to wikitext via `mindmap/filters/sanitize.js`.

No `$tw` dependency — keeps the module trivially unit-testable.

\*/

"use strict";

/*
 * Convert a free-form label into a single path segment.
 *
 *   "API Endpoints"            -> "api-endpoints"
 *   "  multiple   spaces  "    -> "multiple-spaces"
 *   "a/b\\c|d[e]f{g}<h>i#j?\"k" -> "abcdefghijk"
 *   "---"                      -> null  (empty after strip)
 *
 * Returns null when nothing usable remains — callers should reject the input
 * and surface a validation message rather than silently using an empty slug.
 */
exports.sanitize = function (label) {
    if (label === null || label === undefined) { return null; }
    var s = String(label);
    s = s.toLowerCase();
    // Whitespace runs (including \t \n which would also match the control-char
    // strip below) become a single hyphen. MUST run before the control-char
    // strip — otherwise tabs/newlines silently disappear instead of acting as
    // word separators.
    s = s.replace(/\s+/g, "-");
    s = s.replace(/[\x00-\x1f]+/g, "");
    // Strip TW/path-hostile chars: / \ | [ ] { } < > # ? " '
    s = s.replace(/[\/\\|\[\]{}<>#?"']/g, "");
    s = s.replace(/-+/g, "-");
    s = s.replace(/^-+|-+$/g, "");
    return s ? s : null;
};

/*
 * Make `slug` unique against `takenSet` by appending -2, -3, ... as needed.
 * `takenSet` may be a Set OR a plain object map OR an array of strings.
 *
 *   uniquify("foo", new Set(["foo"]))            -> "foo-2"
 *   uniquify("foo", new Set(["foo","foo-2"]))    -> "foo-3"
 *   uniquify("bar", new Set(["foo"]))            -> "bar"
 */
exports.uniquify = function (slug, taken) {
    if (!slug) { return slug; }
    var has;
    if (taken && typeof taken.has === "function") {
        has = function (s) { return taken.has(s); };
    } else if (Array.isArray(taken)) {
        var set = Object.create(null);
        for (var i = 0; i < taken.length; i++) { set[taken[i]] = true; }
        has = function (s) { return !!set[s]; };
    } else if (taken && typeof taken === "object") {
        has = function (s) { return !!taken[s]; };
    } else {
        return slug;
    }
    if (!has(slug)) { return slug; }
    var n = 2;
    while (has(slug + "-" + n)) { n++; }
    return slug + "-" + n;
};
