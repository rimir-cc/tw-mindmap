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

INPUT: one or more owner tiddler titles. Each yields zero-or-more outputs
(slide titles for mm-slides; one count for mm-slide-count; one yes/no for
mm-has-slides).

\*/

"use strict";

var slideTiddlers = require("$:/plugins/rimir/mindmap/lib/slide-tiddlers.js");

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
