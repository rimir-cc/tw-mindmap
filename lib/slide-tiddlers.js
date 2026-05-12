/*\
title: $:/plugins/rimir/mindmap/lib/slide-tiddlers.js
type: application/javascript
module-type: library

Helpers for the slide-tiddler model (v0.2.7+). Slides are first-class
tiddlers stored at "<owner>/slides/<slug>" so a rename of the owner cascades
to its slides via flibbles/relink-titles. The owner's `mm.slide-order` TW
list field gives the playback / display order.

Slide tiddler fields:
  title            <owner>/slides/<slug>
  kn.type          slide              (so the rest of the toolchain recognises it)
  tags             $:/tags/rimir/mindmap/slide
  mm.slide-of      <owner-title>      (back-reference; survives relink-titles)
  mm.slide-layout  default|title|bullets|<custom>   (slide pane CSS class)
  mm.slide-notes   <single-line presenter notes>
  caption          <optional display name>
  text             <wikitext body of the slide>

Pure-JS (no `$tw`) so the module is trivially unit-testable.

\*/

"use strict";

var SLIDE_TAG = "$:/tags/rimir/mindmap/slide";
var SLIDE_KN_TYPE = "slide";
var SLIDE_DIR = "/slides/";

function trim(s) { return (s || "").replace(/^\s+|\s+$/g, ""); }

// Parse a TW list-field string into an array. Uses $tw.utils.parseStringArray
// when available (handles bracketed [[multi word]] tokens); falls back to a
// whitespace split for the no-$tw test harness.
function parseList(text) {
    if (!text) { return []; }
    if (typeof $tw !== "undefined" && $tw.utils && $tw.utils.parseStringArray) {
        return $tw.utils.parseStringArray(text).slice();
    }
    return String(text).split(/\s+/).filter(function (s) { return !!s; });
}

function stringifyList(items) {
    if (typeof $tw !== "undefined" && $tw.utils && $tw.utils.stringifyList) {
        return $tw.utils.stringifyList(items);
    }
    return items.map(function (s) {
        return /\s/.test(s) ? "[[" + s + "]]" : s;
    }).join(" ");
}

exports.SLIDE_TAG = SLIDE_TAG;
exports.SLIDE_KN_TYPE = SLIDE_KN_TYPE;
exports.SLIDE_DIR = SLIDE_DIR;

// Test "looks like a slide tiddler" — by title shape, then by field marker.
// Title shape alone is a strong hint but not authoritative (some user could
// legitimately have "<x>/slides/<y>" as a regular note); the kn.type / tag
// markers are the canonical signal.
exports.isSlideTiddler = function (tiddler) {
    if (!tiddler || !tiddler.fields) { return false; }
    if (trim(tiddler.fields["kn.type"]) === SLIDE_KN_TYPE) { return true; }
    var tags = parseList(tiddler.fields.tags || "");
    return tags.indexOf(SLIDE_TAG) >= 0;
};

// Compose a slide title from its owner + slug. Pure string op.
exports.slideTitleFor = function (ownerTitle, slug) {
    if (!ownerTitle || !slug) { return null; }
    return ownerTitle + SLIDE_DIR + slug;
};

// Inverse of slideTitleFor: return the owner title for a slide tiddler title,
// or null when the title doesn't have the expected shape.
exports.ownerTitleFor = function (slideTitle) {
    if (!slideTitle) { return null; }
    var i = slideTitle.lastIndexOf(SLIDE_DIR);
    return i > 0 ? slideTitle.substring(0, i) : null;
};

// Read the owner's `mm.slide-order` list and filter out titles that don't
// resolve to actual slide tiddlers (defensive against stale order entries
// after a manual tiddler delete or a half-applied rename).
exports.getSlideTitles = function (wiki, ownerTitle) {
    if (!wiki || !ownerTitle) { return []; }
    var owner = wiki.getTiddler(ownerTitle);
    if (!owner) { return []; }
    var list = parseList(owner.fields["mm.slide-order"] || "");
    var out = [];
    for (var i = 0; i < list.length; i++) {
        var t = list[i];
        var tiddler = wiki.getTiddler(t);
        if (tiddler) { out.push(t); }
    }
    return out;
};

// Find a fresh slug under <owner>/slides/ that doesn't collide with existing
// slide tiddlers OR existing entries in the order list. Default scheme is
// "slide-N" where N is the smallest integer that produces a unique slug.
exports.freshSlideSlug = function (wiki, ownerTitle) {
    if (!wiki || !ownerTitle) { return null; }
    var prefix = ownerTitle + SLIDE_DIR;
    var taken = Object.create(null);
    // Existing slide tiddlers under <owner>/slides/
    var titles = wiki.filterTiddlers("[all[tiddlers+shadows]prefix[" + prefix + "]]");
    for (var i = 0; i < titles.length; i++) {
        var slug = titles[i].substring(prefix.length);
        // Reject child-of-slide entries — shouldn't happen for slides but
        // belt-and-braces against future hierarchies.
        if (slug && slug.indexOf("/") < 0) { taken[slug] = true; }
    }
    var n = 1;
    while (taken["slide-" + n]) { n++; }
    return "slide-" + n;
};

// Create a new blank slide tiddler under `ownerTitle` and append its title to
// the owner's `mm.slide-order`. Returns the new slide title, or null when
// preconditions fail (no owner tiddler, etc.).
//
// `opts` is optional and may carry:
//   layout    — initial mm.slide-layout (default "default")
//   text      — initial body text (default "")
//   caption   — initial caption (default "")
//   notes     — initial mm.slide-notes (default "")
//
// Does NOT delete-uniquify — falling back to a fresh slug from
// freshSlideSlug() so callers don't have to manage that themselves.
exports.addSlide = function (wiki, ownerTitle, opts) {
    if (!wiki || !ownerTitle) { return null; }
    var owner = wiki.getTiddler(ownerTitle);
    if (!owner) { return null; }
    opts = opts || {};
    var slug = opts.slug || exports.freshSlideSlug(wiki, ownerTitle);
    if (!slug) { return null; }
    var slideTitle = exports.slideTitleFor(ownerTitle, slug);
    if (!slideTitle) { return null; }
    if (wiki.getTiddler(slideTitle)) {
        // Defensive: re-uniquify if our fresh slug somehow already exists.
        slug = exports.freshSlideSlug(wiki, ownerTitle);
        slideTitle = exports.slideTitleFor(ownerTitle, slug);
    }
    var fields = {
        title: slideTitle,
        "kn.type": SLIDE_KN_TYPE,
        tags: SLIDE_TAG,
        "mm.slide-of": ownerTitle,
        "mm.slide-layout": opts.layout || "default",
        "mm.slide-notes": opts.notes || "",
        caption: opts.caption || "",
        text: opts.text || ""
    };
    var creation = wiki.getCreationFields ? wiki.getCreationFields() : {};
    var modification = wiki.getModificationFields ? wiki.getModificationFields() : {};
    wiki.addTiddler(new $tw.Tiddler(creation, fields, modification));

    var order = parseList(owner.fields["mm.slide-order"] || "");
    order.push(slideTitle);
    wiki.addTiddler(new $tw.Tiddler(owner, {
        "mm.slide-order": stringifyList(order)
    }, modification));
    return slideTitle;
};

// Remove a slide tiddler and scrub its title from the owner's
// mm.slide-order. The owner's title is derived from the slide title
// when not supplied (since slide titles encode their owner). Returns
// true on success; false if the slide didn't exist.
exports.removeSlide = function (wiki, slideTitle, ownerTitle) {
    if (!wiki || !slideTitle) { return false; }
    var owner = ownerTitle || exports.ownerTitleFor(slideTitle);
    var slide = wiki.getTiddler(slideTitle);
    if (!slide) { return false; }
    wiki.deleteTiddler(slideTitle);
    if (!owner) { return true; }
    var ownerTid = wiki.getTiddler(owner);
    if (!ownerTid) { return true; }
    var list = parseList(ownerTid.fields["mm.slide-order"] || "");
    var idx = list.indexOf(slideTitle);
    if (idx < 0) { return true; }
    list.splice(idx, 1);
    var modification = wiki.getModificationFields ? wiki.getModificationFields() : {};
    wiki.addTiddler(new $tw.Tiddler(ownerTid, {
        "mm.slide-order": stringifyList(list)
    }, modification));
    return true;
};

// Move a slide within its owner's `mm.slide-order` by `delta` positions.
// Negative delta = up; positive = down. Saturates at list bounds; no-op when
// the slide isn't in the list. Returns true when the list changed.
exports.moveSlide = function (wiki, slideTitle, delta, ownerTitle) {
    if (!wiki || !slideTitle || !delta) { return false; }
    var owner = ownerTitle || exports.ownerTitleFor(slideTitle);
    if (!owner) { return false; }
    var ownerTid = wiki.getTiddler(owner);
    if (!ownerTid) { return false; }
    var list = parseList(ownerTid.fields["mm.slide-order"] || "");
    var idx = list.indexOf(slideTitle);
    if (idx < 0) { return false; }
    var target = idx + delta;
    if (target < 0) { target = 0; }
    if (target > list.length - 1) { target = list.length - 1; }
    if (target === idx) { return false; }
    list.splice(idx, 1);
    list.splice(target, 0, slideTitle);
    var modification = wiki.getModificationFields ? wiki.getModificationFields() : {};
    wiki.addTiddler(new $tw.Tiddler(ownerTid, {
        "mm.slide-order": stringifyList(list)
    }, modification));
    return true;
};

// Exposed for tests so the parse/stringify path can be exercised directly.
exports._parseList = parseList;
exports._stringifyList = stringifyList;
