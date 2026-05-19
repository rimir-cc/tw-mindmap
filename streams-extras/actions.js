/*\
title: $:/plugins/rimir/mindmap/streams-extras/actions.js
type: application/javascript
module-type: widget

Action widgets backing the sq/streams contextmenu Copy / Paste cascade.

Registers four widgets — each is a thin invokeAction wrapper around a
helper. All operate on stream-node tiddlers (fields `parent`, `stream-list`,
`stream-type`, `text`).

  * $action-streams-copy-structure
      attrs: node, state
      Builds {text, children: [...]} from `node` + its `stream-list`
      descendants and writes JSON to the `state` tiddler's text. Round-trips
      via $action-streams-paste-structure.

  * $action-streams-copy-list
      attrs: node, format ("tw" | "md" | "html")
      Walks the subtree, renders as a flat outline in the chosen format,
      writes to the system clipboard via navigator.clipboard.writeText.

  * $action-streams-paste-structure
      attrs: node, state
      Reads JSON from the `state` tiddler, creates one new stream node
      under `node` mirroring the root + descends recursively. Always
      duplicates — no shared titles.

  * $action-streams-paste-list
      attrs: node
      Reads clipboard text, sniffs TW (`*` outline) / MD (indented `- `) /
      HTML (`<ul><li>`), parses to a tree, creates new child nodes under
      `node` (the parsed root's children become target's new children).

Title generation uses `wiki.generateNewTitle(<target>/node-<ts>)` with the
node inserted BEFORE recursing into its descendants so subsequent
generateNewTitle calls see it as taken (otherwise siblings would collide).

\*/
(function () {

    "use strict";

    var Widget = require("$:/core/modules/widgets/widget.js").widget;

    // ---------- Subtree model ----------

    function buildSubtree(wiki, rootTitle) {
        var t = wiki.getTiddler(rootTitle);
        if (!t) { return null; }
        var streamList = $tw.utils.parseStringArray(t.fields["stream-list"] || "");
        var children = [];
        for (var i = 0; i < streamList.length; i++) {
            var child = buildSubtree(wiki, streamList[i]);
            if (child) { children.push(child); }
        }
        // `title` is carried in the serialised JSON so paste-structure can
        // stamp `orig-tiddler` per-node — lineage to the original survives
        // the copy/paste round-trip for the root AND every descendant.
        return {
            title: rootTitle,
            text: (t.fields.text || ""),
            children: children
        };
    }

    // ---------- Render to list formats ----------

    function oneLine(s) {
        return (s || "").replace(/\r?\n+/g, " ").trim();
    }

    function renderTW(node) {
        var out = [];
        (function walk(n, depth) {
            out.push(new Array(depth + 1).join("*") + " " + oneLine(n.text));
            n.children.forEach(function (c) { walk(c, depth + 1); });
        })(node, 1);
        return out.join("\n");
    }

    function renderMD(node) {
        var out = [];
        (function walk(n, depth) {
            var indent = new Array(depth * 2 + 1).join(" ");
            out.push(indent + "- " + oneLine(n.text));
            n.children.forEach(function (c) { walk(c, depth + 1); });
        })(node, 0);
        return out.join("\n");
    }

    function escHTML(s) {
        return (s || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    function renderHTML(node) {
        function walk(n, indent) {
            var pad = new Array(indent + 1).join("  ");
            var html = pad + "<li>" + escHTML(oneLine(n.text));
            if (n.children.length) {
                html += "\n" + pad + "  <ul>\n";
                n.children.forEach(function (c) { html += walk(c, indent + 2) + "\n"; });
                html += pad + "  </ul>\n" + pad;
            }
            html += "</li>";
            return html;
        }
        return "<ul>\n" + walk(node, 1) + "\n</ul>";
    }

    // ---------- Parse list formats ----------

    function detectFormat(text) {
        var t = (text || "").trim();
        if (/<\/?(ul|ol|li)\b/i.test(t)) { return "html"; }
        var firstNonEmpty = null;
        var lines = t.split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].trim() !== "") { firstNonEmpty = lines[i]; break; }
        }
        if (firstNonEmpty === null) { return null; }
        if (/^\*+\s/.test(firstNonEmpty.replace(/^\s+/, ""))) { return "tw"; }
        if (/^\s*[-*+]\s/.test(firstNonEmpty)) { return "md"; }
        return null;
    }

    function parseTWList(text) {
        var lines = text.split(/\r?\n/);
        var root = { text: "", children: [] };
        var stack = [{ node: root, depth: 0 }];
        lines.forEach(function (line) {
            var stripped = line.replace(/^\s+/, "");
            var m = /^(\*+)\s+(.*)$/.exec(stripped);
            if (!m) { return; }
            var depth = m[1].length;
            var content = m[2].trim();
            while (stack.length > 1 && stack[stack.length - 1].depth >= depth) { stack.pop(); }
            var node = { text: content, children: [] };
            stack[stack.length - 1].node.children.push(node);
            stack.push({ node: node, depth: depth });
        });
        return root;
    }

    function parseMDList(text) {
        // Indent unit is whatever the FIRST indented line uses — guesses 2 if
        // we can't tell. Falls back to "any indent > parent" without strict
        // unit-math, so mixed indentations don't fall through the cracks.
        var lines = text.split(/\r?\n/);
        var root = { text: "", children: [] };
        var stack = [{ node: root, indent: -1 }];
        lines.forEach(function (line) {
            var m = /^(\s*)[-*+]\s+(.*)$/.exec(line);
            if (!m) { return; }
            var indent = m[1].length;
            var content = m[2].trim();
            while (stack.length > 1 && stack[stack.length - 1].indent >= indent) { stack.pop(); }
            var node = { text: content, children: [] };
            stack[stack.length - 1].node.children.push(node);
            stack.push({ node: node, indent: indent });
        });
        return root;
    }

    function parseHTMLList(text) {
        if (typeof DOMParser !== "function") { return { text: "", children: [] }; }
        var doc = new DOMParser().parseFromString(text, "text/html");
        var root = { text: "", children: [] };

        function walkUL(ul, parent) {
            for (var i = 0; i < ul.children.length; i++) {
                var li = ul.children[i];
                if (li.tagName && li.tagName.toLowerCase() !== "li") { continue; }
                var nested = null;
                var liText = "";
                for (var j = 0; j < li.childNodes.length; j++) {
                    var n = li.childNodes[j];
                    if (n.nodeType === 3) {
                        liText += n.nodeValue;
                    } else if (n.nodeType === 1) {
                        var tag = n.tagName.toLowerCase();
                        if (tag === "ul" || tag === "ol") {
                            nested = n;
                        } else {
                            liText += n.textContent || "";
                        }
                    }
                }
                var node = { text: liText.trim(), children: [] };
                if (nested) { walkUL(nested, node); }
                parent.children.push(node);
            }
        }

        // Prefer top-level UL/OL in body; fall back to first list anywhere.
        var tops = [];
        for (var k = 0; k < doc.body.children.length; k++) {
            var c = doc.body.children[k];
            var tag = c.tagName && c.tagName.toLowerCase();
            if (tag === "ul" || tag === "ol") { tops.push(c); }
        }
        if (tops.length === 0) {
            var any = doc.querySelector("ul, ol");
            if (any) { tops.push(any); }
        }
        tops.forEach(function (ul) { walkUL(ul, root); });
        return root;
    }

    // ---------- Create new stream nodes ----------

    function createNodeUnder(wiki, parentTitle, treeNode, basetitle) {
        var newTitle = wiki.generateNewTitle(basetitle);
        var now = new Date();
        // Add this node FIRST (with an empty stream-list) so subsequent
        // generateNewTitle calls for descendants don't collide with siblings.
        var fields = {
            title: newTitle,
            text: treeNode.text || "",
            parent: parentTitle,
            "stream-type": "default",
            created: now,
            modified: now
        };
        // Stamp the original title onto the new node when the source
        // carries it (paste-structure case). Paste-list parses from
        // clipboard text and has no source title to record, so the
        // field stays off.
        if (treeNode.title) {
            fields["orig-tiddler"] = treeNode.title;
        }
        wiki.addTiddler(new $tw.Tiddler(fields));
        var childTitles = [];
        for (var i = 0; i < treeNode.children.length; i++) {
            childTitles.push(createNodeUnder(wiki, newTitle, treeNode.children[i], basetitle));
        }
        if (childTitles.length > 0) {
            var existing = wiki.getTiddler(newTitle);
            wiki.addTiddler(new $tw.Tiddler(existing.fields, {
                "stream-list": $tw.utils.stringifyList(childTitles)
            }));
        }
        return newTitle;
    }

    function appendChildrenToList(wiki, parentTitle, newChildTitles) {
        var parent = wiki.getTiddler(parentTitle);
        var existing = parent ? $tw.utils.parseStringArray(parent.fields["stream-list"] || "") : [];
        var combined = existing.concat(newChildTitles);
        var baseFields = parent ? parent.fields : { title: parentTitle };
        var override = {
            title: parentTitle,
            "stream-list": $tw.utils.stringifyList(combined),
            "stream-type": (parent && parent.fields["stream-type"]) || "default"
        };
        wiki.addTiddler(new $tw.Tiddler(baseFields, override));
    }

    function pasteAsChild(wiki, targetTitle, subtree) {
        var basetitle = targetTitle + "/node-" + Date.now();
        var newTitle = createNodeUnder(wiki, targetTitle, subtree, basetitle);
        appendChildrenToList(wiki, targetTitle, [newTitle]);
    }

    function pasteListUnder(wiki, targetTitle, parsedRoot) {
        var basetitle = targetTitle + "/node-" + Date.now();
        var newTitles = [];
        for (var i = 0; i < parsedRoot.children.length; i++) {
            newTitles.push(createNodeUnder(wiki, targetTitle, parsedRoot.children[i], basetitle));
        }
        if (newTitles.length > 0) {
            appendChildrenToList(wiki, targetTitle, newTitles);
        }
    }

    // ---------- Clipboard helpers ----------

    function copyToClipboard(text) {
        if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(function () {
                fallbackCopy(text);
            });
            return;
        }
        fallbackCopy(text);
    }

    function fallbackCopy(text) {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch (e) { /* noop */ }
        document.body.removeChild(ta);
    }

    function readClipboard(cb) {
        if (navigator && navigator.clipboard && navigator.clipboard.readText) {
            navigator.clipboard.readText()
                .then(function (t) { cb(t || ""); })
                .catch(function () { cb(""); });
            return;
        }
        cb("");
    }

    // ---------- Widget plumbing ----------

    function defineActionWidget(name, attrNames, invoke) {
        function W(parseTreeNode, options) { this.initialise(parseTreeNode, options); }
        W.prototype = new Widget();
        W.prototype.render = function (parent, nextSibling) {
            this.computeAttributes();
            this.execute();
            this.parentDomNode = parent;
            this.renderChildren(parent, nextSibling);
        };
        W.prototype.execute = function () {
            var self = this;
            attrNames.forEach(function (a) { self["attr_" + a] = self.getAttribute(a); });
            this.makeChildWidgets();
        };
        W.prototype.refresh = function (changedTiddlers) {
            var ch = this.computeAttributes();
            for (var i = 0; i < attrNames.length; i++) {
                if (ch[attrNames[i]]) { this.refreshSelf(); return true; }
            }
            return this.refreshChildren(changedTiddlers);
        };
        W.prototype.invokeAction = function (triggeringWidget, event) {
            invoke.call(this, triggeringWidget, event);
            return true;
        };
        W.prototype.allowActionPropagation = function () { return false; };
        exports[name] = W;
    }

    defineActionWidget("action-streams-copy-structure", ["node", "state"], function () {
        if (!this.attr_node || !this.attr_state) { return; }
        var sub = buildSubtree(this.wiki, this.attr_node);
        if (!sub) { return; }
        this.wiki.setText(this.attr_state, "text", null, JSON.stringify(sub));
    });

    defineActionWidget("action-streams-copy-list", ["node", "format"], function () {
        if (!this.attr_node || !this.attr_format) { return; }
        var sub = buildSubtree(this.wiki, this.attr_node);
        if (!sub) { return; }
        var text;
        if (this.attr_format === "tw") { text = renderTW(sub); }
        else if (this.attr_format === "md") { text = renderMD(sub); }
        else if (this.attr_format === "html") { text = renderHTML(sub); }
        else { return; }
        copyToClipboard(text);
    });

    defineActionWidget("action-streams-paste-structure", ["node", "state"], function () {
        if (!this.attr_node || !this.attr_state) { return; }
        var json = this.wiki.getTiddlerText(this.attr_state, "");
        if (!json) { return; }
        var sub;
        try { sub = JSON.parse(json); } catch (e) { return; }
        if (!sub || typeof sub !== "object") { return; }
        pasteAsChild(this.wiki, this.attr_node, sub);
    });

    defineActionWidget("action-streams-paste-list", ["node"], function () {
        if (!this.attr_node) { return; }
        var self = this;
        readClipboard(function (text) {
            if (!text) { return; }
            var fmt = detectFormat(text);
            if (!fmt) { return; }
            var parsed;
            if (fmt === "tw") { parsed = parseTWList(text); }
            else if (fmt === "md") { parsed = parseMDList(text); }
            else { parsed = parseHTMLList(text); }
            pasteListUnder(self.wiki, self.attr_node, parsed);
        });
    });

})();
