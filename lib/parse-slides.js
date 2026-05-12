/*\
title: $:/plugins/rimir/mindmap/lib/parse-slides.js
type: application/javascript
module-type: library

Pure-JS slide parser / serializer / mutators for the `slides` field convention.

Format:
  A `slides` field contains one or more slides separated by a line that
  consists ONLY of `===` (optionally surrounded by whitespace). Each slide
  may begin with metadata directives — lines of the form `!! key: value`
  — followed by a blank line and then the slide body (wikitext).

  Example:

      !! layout: title
      # Welcome to topic X

      ===

      !! layout: bullets
      * point A
      * point B

      ===

      Plain content with no directives uses the default layout.

Recognised metadata keys for v1:
  - layout  : "title" | "bullets" | "default" (or any custom name; consumer decides)
  - notes   : presenter notes (single line)

No `$tw` dependency — keeps the module trivially unit-testable.

\*/

"use strict";

function parse(text) {
    if (!text) { return []; }
    var slices = String(text).split(/^[ \t]*===[ \t]*$/m);
    var result = [];
    for (var i = 0; i < slices.length; i++) {
        var slice = slices[i];
        var lines = slice.split("\n");
        var metadata = {};
        var contentStart = 0;
        var leadingBlanksDone = false;
        var inHeader = true;
        for (var j = 0; j < lines.length; j++) {
            var line = lines[j];
            if (!leadingBlanksDone) {
                if (/^\s*$/.test(line)) { contentStart = j + 1; continue; }
                leadingBlanksDone = true;
            }
            if (inHeader) {
                var m = /^!!\s*([a-z][a-z0-9-]*)\s*:\s*(.+)$/i.exec(line);
                if (m) {
                    metadata[m[1].toLowerCase()] = m[2].trim();
                    contentStart = j + 1;
                    continue;
                }
                inHeader = false;
            }
            break;
        }
        var content = lines.slice(contentStart).join("\n").replace(/^\n+|\n+$/g, "");
        result.push({
            layout: metadata.layout || "default",
            notes: metadata.notes || "",
            content: content
        });
    }
    return result;
}

function serialize(slides) {
    if (!slides || !slides.length) { return ""; }
    var out = [];
    for (var i = 0; i < slides.length; i++) {
        var s = slides[i] || {};
        var head = "";
        if (s.layout && s.layout !== "default") { head += "!! layout: " + s.layout + "\n"; }
        if (s.notes) { head += "!! notes: " + s.notes + "\n"; }
        var body = s.content || "";
        if (head) {
            out.push(head + "\n" + body);
        } else if (body) {
            out.push(body);
        } else {
            // Empty default slide: emit a sentinel directive so the round-
            // trip through serialize/parse preserves the slide. Without this,
            // `[{layout:"default", content:""}]` would serialize to "" which
            // parses back to [] — newly-inserted blank slides would vanish.
            out.push("!! layout: default");
        }
    }
    return out.join("\n\n===\n\n");
}

function update(text, idx, patch) {
    var slides = parse(text);
    if (idx < 0 || idx >= slides.length) { return text; }
    var current = slides[idx];
    if (patch && typeof patch === "object") {
        for (var key in patch) {
            if (patch[key] !== undefined) { current[key] = patch[key]; }
        }
    }
    return serialize(slides);
}

function insert(text, idx, slide) {
    var slides = parse(text);
    var n = slides.length;
    if (idx < 0) { idx = 0; }
    if (idx > n) { idx = n; }
    var blank = { layout: "default", notes: "", content: "" };
    var s = slide ? Object.assign(blank, slide) : blank;
    slides.splice(idx, 0, s);
    return serialize(slides);
}

function remove(text, idx) {
    var slides = parse(text);
    if (idx < 0 || idx >= slides.length) { return text; }
    slides.splice(idx, 1);
    return serialize(slides);
}

function move(text, idx, delta) {
    var slides = parse(text);
    var newIdx = idx + delta;
    if (idx < 0 || idx >= slides.length) { return text; }
    if (newIdx < 0 || newIdx >= slides.length) { return text; }
    var moved = slides.splice(idx, 1)[0];
    slides.splice(newIdx, 0, moved);
    return serialize(slides);
}

exports.parse = parse;
exports.serialize = serialize;
exports.update = update;
exports.insert = insert;
exports.remove = remove;
exports.move = move;
