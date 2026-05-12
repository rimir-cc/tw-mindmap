/*\
title: $:/plugins/rimir/mindmap/widgets/slide-content.js
type: application/javascript
module-type: widget

`<$mm-slide-content text="…" layout="…"/>` — renders the supplied text as
wikitext inside a div whose class includes the slide layout name. Used by the
slide-pane template so each slide card live-renders its content (bullets,
headings, etc.) rather than displaying it as preformatted source.

TiddlyWiki has no built-in "render this string as wikitext" widget — `<$transclude
$variable>` invokes a procedure by name, and `<$wikify>` produces a value but
doesn't paint it to the DOM. Doing it in JS is the path of least resistance:
parse the text, build a child widget tree, render into a container.

\*/

"use strict";

var Widget = require("$:/core/modules/widgets/widget.js").widget;

function SlideContentWidget(parseTreeNode, options) {
    this.initialise(parseTreeNode, options);
}

SlideContentWidget.prototype = new Widget();

SlideContentWidget.prototype.render = function (parent, nextSibling) {
    this.parentDomNode = parent;
    this.computeAttributes();
    this.execute();

    var container = this.document.createElement("div");
    container.className = "rr-mindmap-slide-content rr-mindmap-slide-content-" + (this.layout || "default");
    parent.insertBefore(container, nextSibling);
    this.domNodes.push(container);

    if (!this.text) { return; }

    try {
        var parser = this.wiki.parseText("text/vnd.tiddlywiki", this.text, { parseAsInline: false });
        if (!parser) { return; }
        var widgetNode = this.wiki.makeWidget(parser, {
            parentWidget: this,
            document: this.document
        });
        widgetNode.render(container, null);
        this.innerWidget = widgetNode;
    } catch (e) {
        var err = this.document.createElement("div");
        err.className = "rr-mindmap-slide-content-error";
        err.textContent = "Render error: " + (e && e.message ? e.message : String(e));
        container.appendChild(err);
    }
};

SlideContentWidget.prototype.execute = function () {
    this.text = this.getAttribute("text", "");
    this.layout = this.getAttribute("layout", "default");
};

SlideContentWidget.prototype.refresh = function (changedTiddlers) {
    var changedAttrs = this.computeAttributes();
    if (changedAttrs.text || changedAttrs.layout) {
        this.refreshSelf();
        return true;
    }
    if (this.innerWidget) {
        return this.innerWidget.refresh(changedTiddlers);
    }
    return false;
};

exports["mm-slide-content"] = SlideContentWidget;
