/*\
title: $:/plugins/rimir/mindmap/filters/slides.js
type: application/javascript
module-type: filteroperator

Filter operators exposing the slide-tiddler model (v0.2.7+) to wikitext.

  [<owner>mm-slides[]]        — ordered slide tiddler titles for one or more
                                 owner tiddlers (skips titles that no longer
                                 resolve to slide tiddlers — defensive against
                                 stale order entries).
  [<owner>mm-slide-count[]]   — number of slides each owner has.
  [<owner>mm-has-slides[]]    — "yes" if the owner has at least one slide,
                                 "no" otherwise.
  [<pres>mm-presentation-slides[]]
                              — flat ordered list of slide tiddler titles for
                                 a presentation tiddler. Walks the
                                 presentation's `mm.slides-order` (owner
                                 nodes) and emits each owner's `mm-slides`
                                 in order. Designed to feed `<$present>`.

INPUT: one or more owner tiddler titles. Each yields zero-or-more outputs
(slide titles for mm-slides; one count for mm-slide-count; one yes/no for
mm-has-slides; many slide titles for mm-presentation-slides).

\*/

"use strict";

var slideTiddlers = require("$:/plugins/rimir/mindmap/lib/slide-tiddlers.js");

function trim(s) { return (s || "").replace(/^\s+|\s+$/g, ""); }

exports["mm-slides"] = function (source, operator, options) {
    var results = [];
    source(function (tiddler, title) {
        var slides = slideTiddlers.getSlideTitles(options.wiki, title);
        for (var i = 0; i < slides.length; i++) { results.push(slides[i]); }
    });
    return results;
};

exports["mm-slide-count"] = function (source, operator, options) {
    var results = [];
    source(function (tiddler, title) {
        var slides = slideTiddlers.getSlideTitles(options.wiki, title);
        results.push(String(slides.length));
    });
    return results;
};

exports["mm-has-slides"] = function (source, operator, options) {
    var results = [];
    source(function (tiddler, title) {
        var slides = slideTiddlers.getSlideTitles(options.wiki, title);
        results.push(slides.length > 0 ? "yes" : "no");
    });
    return results;
};

// Flat ordered list of slide tiddlers for a presentation tiddler. Each input
// title is treated as a presentation; we read its `mm.slides-order` (owner
// node titles) and concatenate each owner's `getSlideTitles` in list order.
// Owners that don't exist or have no slides are skipped silently.
exports["mm-presentation-slides"] = function (source, operator, options) {
    var results = [];
    source(function (tiddler, title) {
        var pres = options.wiki.getTiddler(title);
        if (!pres || !pres.fields) { return; }
        var orderRaw = trim(pres.fields["mm.slides-order"] || "");
        if (!orderRaw) { return; }
        var owners = $tw.utils.parseStringArray(orderRaw);
        for (var i = 0; i < owners.length; i++) {
            var slides = slideTiddlers.getSlideTitles(options.wiki, owners[i]);
            for (var j = 0; j < slides.length; j++) { results.push(slides[j]); }
        }
    });
    return results;
};
