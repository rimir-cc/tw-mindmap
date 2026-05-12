/*\
title: $:/plugins/rimir/mindmap/filters/presentation.js
type: application/javascript
module-type: filteroperator

Filter operators for named-presentation discovery.

  [mm-presentations<viewTitle>]
      Lists titles of presentation tiddlers (tagged
      `$:/tags/rimir/mindmap/presentation`) whose `mm.view` field equals
      the given view title. Sorted alphabetically by title.

      Example: [mm-presentations<currentTiddler>]

\*/

"use strict";

var PRESENTATION_TAG = "$:/tags/rimir/mindmap/presentation";

exports["mm-presentations"] = function (source, operator, options) {
    var viewTitle = (operator.operand || "").replace(/^\s+|\s+$/g, "");
    if (!viewTitle) { return []; }
    var results = [];
    options.wiki.each(function (tiddler, title) {
        if (!tiddler || !tiddler.fields) { return; }
        var tags = $tw.utils.parseStringArray(tiddler.fields.tags || "");
        if (tags.indexOf(PRESENTATION_TAG) < 0) { return; }
        var view = (tiddler.fields["mm.view"] || "").replace(/^\s+|\s+$/g, "");
        if (view === viewTitle) { results.push(title); }
    });
    results.sort();
    return results;
};
