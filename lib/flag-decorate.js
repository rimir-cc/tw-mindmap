/*\
title: $:/plugins/rimir/mindmap/lib/flag-decorate.js
type: application/javascript
module-type: library

Filter-driven flag decoration for the mindmap MDOM.

Two responsibilities, exposed as pure-ish functions:

  loadFlagRules(wiki, opts) → [Rule]
      Resolve the candidate rule-tiddler titles from a TW filter, read each
      rule's fields, drop rules whose scope filter excludes the current
      view/producer, normalise field types, sort ascending by priority.

  decorateFlags(mdom, rules, wiki) → mdom    (mutated in place)
      For each rule, evaluate its filter ONCE over the universe of leaf
      titles (inverted loop — M filter calls, not N×M). Stamp the matching
      leaves with mx:flags / mx:icons / mx:flag-classes plus first-class
      style attrs (mx:text-color, mx:font-weight, mx:border → outline, …).
      If any rule declares aggregation, also walk bottom-up and stamp
      synthetic ancestors (core:synthetic === true) whose leaf-descendant
      counts satisfy the rule's `any` / `all` policy.

Engine-neutral: emits only MDOM attrs. The mind-elixir adapter is the only
component that translates those into DOM `data-*` attrs and inline `style.*`.
A future engine adapter can read the same attrs and render its own way.

\*/

"use strict";

// ----------------------------------------------------------------------------
// Rule loader

// Trim is mandatory: .tid field bodies often carry trailing newlines, and
// TW's filter parser silently no-ops on a name with a surprise " " or "\n".
function trim(s) { return (s === null || s === undefined) ? "" : String(s).replace(/^\s+|\s+$/g, ""); }

// Defensive lookup that tolerates wiki implementations exposing fields via
// `tiddler.fields` (in-tree wiki) vs `tiddler.getFieldString` (older test mocks).
function fieldOf(tiddler, name) {
    if (!tiddler) { return ""; }
    if (tiddler.fields && Object.prototype.hasOwnProperty.call(tiddler.fields, name)) {
        return tiddler.fields[name];
    }
    if (typeof tiddler.getFieldString === "function") {
        return tiddler.getFieldString(name);
    }
    return "";
}

// Build a widget-like object the wiki filter engine can query for variables.
// Two anchors we expose:
//   currentTiddler = the view tiddler title (so scope filters reading
//                    <<currentTiddler>> see the view, not a leaf — see gotcha
//                    in plan)
//   mm-producer    = the producer module name (so a rule can scope itself
//                    to a specific producer with [<mm-producer>match[...]])
function makeScopeWidget(viewTitle, mmProducer) {
    var vars = { "currentTiddler": viewTitle || "", "mm-producer": mmProducer || "" };
    return {
        getVariable: function (name) {
            return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : "";
        }
    };
}

/*
 * loadFlagRules(wiki, opts) → [Rule]
 *
 * opts:
 *   rulesFilter : string   — TW filter resolving to flag-rule tiddler titles
 *                            (mm.flags view field or `flags=` widget attr)
 *   viewTitle   : string   — used as currentTiddler in mm.flag-scope eval
 *   mmProducer  : string   — exposed as <<mm-producer>> in mm.flag-scope
 *
 * Returns a sorted (ascending priority, ties broken by source title) list of
 * normalised Rule objects. Invalid rules are skipped with a console warning.
 */
exports.loadFlagRules = function (wiki, opts) {
    opts = opts || {};
    var rulesFilter = trim(opts.rulesFilter);
    if (!rulesFilter || !wiki || typeof wiki.filterTiddlers !== "function") { return []; }

    var titles;
    try {
        titles = wiki.filterTiddlers(rulesFilter) || [];
    } catch (e) {
        console.error("[mindmap-flags] rules filter failed: " + rulesFilter, e);
        return [];
    }

    var scopeWidget = makeScopeWidget(opts.viewTitle, opts.mmProducer);
    var rules = [];

    for (var i = 0; i < titles.length; i++) {
        var title = titles[i];
        var tiddler = wiki.getTiddler(title);
        if (!tiddler) { continue; }

        var name = trim(fieldOf(tiddler, "mm.flag-name"));
        if (!name) {
            console.warn("[mindmap-flags] rule '" + title + "' missing mm.flag-name; skipped");
            continue;
        }
        var filter = trim(fieldOf(tiddler, "mm.flag-filter"));
        if (!filter) {
            console.warn("[mindmap-flags] rule '" + title + "' missing mm.flag-filter; skipped");
            continue;
        }

        var scope = trim(fieldOf(tiddler, "mm.flag-scope"));
        if (scope) {
            try {
                var scoped = wiki.filterTiddlers(scope, scopeWidget) || [];
                if (scoped.length === 0) { continue; }
            } catch (e2) {
                console.error("[mindmap-flags] rule '" + name + "' scope filter failed", e2);
                continue;
            }
        }

        var priorityRaw = trim(fieldOf(tiddler, "mm.flag-priority"));
        var priority = priorityRaw === "" ? 0 : parseFloat(priorityRaw);
        if (isNaN(priority)) {
            console.warn("[mindmap-flags] rule '" + name + "' invalid priority '" + priorityRaw + "'; defaulting to 0");
            priority = 0;
        }

        var aggregate = trim(fieldOf(tiddler, "mm.flag-aggregate"));
        if (aggregate && aggregate !== "any" && aggregate !== "all") {
            console.warn("[mindmap-flags] rule '" + name + "' invalid aggregate '" + aggregate + "'; treating as leaf-only");
            aggregate = "";
        }

        var opacityRaw = trim(fieldOf(tiddler, "mm.flag-opacity"));
        var opacity = "";
        if (opacityRaw !== "") {
            var op = parseFloat(opacityRaw);
            if (isNaN(op)) {
                console.warn("[mindmap-flags] rule '" + name + "' invalid opacity '" + opacityRaw + "'; ignoring");
            } else {
                if (op < 0 || op > 1) {
                    console.warn("[mindmap-flags] rule '" + name + "' opacity out of [0,1]; clamping");
                    op = Math.min(1, Math.max(0, op));
                }
                opacity = String(op);
            }
        }

        rules.push({
            name: name,
            filter: filter,
            aggregate: aggregate,
            priority: priority,
            sourceTitle: title,
            "mm.flag-icon": trim(fieldOf(tiddler, "mm.flag-icon")),
            "mm.flag-text-color": trim(fieldOf(tiddler, "mm.flag-text-color")),
            "mm.flag-bg-color": trim(fieldOf(tiddler, "mm.flag-bg-color")),
            "mm.flag-border-color": trim(fieldOf(tiddler, "mm.flag-border-color")),
            "mm.flag-border-width": trim(fieldOf(tiddler, "mm.flag-border-width")),
            "mm.flag-border-style": trim(fieldOf(tiddler, "mm.flag-border-style")),
            "mm.flag-font-weight": trim(fieldOf(tiddler, "mm.flag-font-weight")),
            "mm.flag-font-style": trim(fieldOf(tiddler, "mm.flag-font-style")),
            "mm.flag-text-transform": trim(fieldOf(tiddler, "mm.flag-text-transform")),
            "mm.flag-opacity": opacity,
            "mm.flag-font-size-scale": trim(fieldOf(tiddler, "mm.flag-font-size-scale")),
            "mm.flag-class": trim(fieldOf(tiddler, "mm.flag-class")),
            "mm.flag-tooltip": trim(fieldOf(tiddler, "mm.flag-tooltip"))
        });
    }

    rules.sort(function (a, b) {
        if (a.priority !== b.priority) { return a.priority - b.priority; }
        return a.sourceTitle.localeCompare(b.sourceTitle);
    });

    return rules;
};

// ----------------------------------------------------------------------------
// Decoration

// Build title → [node] for every node carrying a non-empty `core:tiddler`.
// A single title may appear in multiple nodes (rare, but possible — focus mode
// can root the same tiddler twice). We stamp ALL such nodes from one matched
// result so the user sees consistent flags wherever the tiddler shows up.
function collectTitledNodes(root) {
    var byTitle = Object.create(null);
    var allTitled = [];   // ordered list of titled nodes — used by aggregation
    function walk(node) {
        if (!node) { return; }
        var attrs = node.attrs || {};
        var title = attrs["core:tiddler"];
        if (title) {
            if (!byTitle[title]) { byTitle[title] = []; }
            byTitle[title].push(node);
            allTitled.push({ node: node, title: title });
        }
        var children = node.children || [];
        for (var i = 0; i < children.length; i++) { walk(children[i]); }
    }
    walk(root);
    return { byTitle: byTitle, allTitled: allTitled };
}

// Parse "2px solid #d04444" → { width, style, color }. Each component may be
// missing — we just treat missing pieces as defaults during composition.
function parseBorderComposite(s) {
    if (!s) { return {}; }
    var parts = String(s).trim().split(/\s+/);
    var out = {};
    for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (/^\d/.test(p)) { out.width = p; }
        else if (/^(solid|dashed|dotted|double|groove|ridge|inset|outset)$/.test(p)) { out.style = p; }
        else { out.color = p; }
    }
    return out;
}

// Apply an ordered (ascending-priority) list of rules to a single MDOM node,
// merging their visual contributions into the node's attrs map. Idempotent in
// the sense that calling it a second time with the same rules yields the same
// resulting attrs.
//
// Stacking rules:
//   - mx:flags        : space-separated names, ascending priority order.
//   - mx:flag-<name>  : boolean true for each matching rule.
//   - mx:flag-classes : space-separated class tokens (de-duped).
//   - mx:icons        : pipe-separated chars, DESCENDING priority order
//                       (highest-priority icon appears leftmost in the topic).
//   - style attrs     : last-write wins (so the highest-priority rule's
//                       value sticks for any given style key).
//   - border          : composed from any/all of border-{color,width,style}
//                       from the matching rules — width/style/color each
//                       collapse to the highest-priority value that defined
//                       them.
function applyRulesToNode(node, rules) {
    if (!rules || rules.length === 0) { return; }
    node.attrs = node.attrs || {};
    var attrs = node.attrs;

    var names = [];
    var classes = [];
    var iconEntries = [];   // [{icon, priority}]
    var tooltips = [];      // one per matching rule that defined mm.flag-tooltip
    var styleMap = {};
    var borderParts = {};   // { width, style, color }

    for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        names.push(r.name);

        if (r["mm.flag-class"]) { classes.push(r["mm.flag-class"]); }

        if (r["mm.flag-icon"]) {
            iconEntries.push({ icon: r["mm.flag-icon"], priority: r.priority });
        }
        if (r["mm.flag-tooltip"]) { tooltips.push(r["mm.flag-tooltip"]); }

        if (r["mm.flag-text-color"])     { styleMap["mx:text-color"]      = r["mm.flag-text-color"]; }
        if (r["mm.flag-bg-color"])       { styleMap["core:color"]         = r["mm.flag-bg-color"]; }
        if (r["mm.flag-font-weight"])    { styleMap["mx:font-weight"]     = r["mm.flag-font-weight"]; }
        if (r["mm.flag-font-style"])     { styleMap["mx:font-style"]      = r["mm.flag-font-style"]; }
        if (r["mm.flag-text-transform"]) { styleMap["mx:text-transform"]  = r["mm.flag-text-transform"]; }
        if (r["mm.flag-opacity"] !== "" && r["mm.flag-opacity"] !== undefined) {
            styleMap["mx:opacity"] = r["mm.flag-opacity"];
        }
        if (r["mm.flag-font-size-scale"]) { styleMap["mx:font-size-scale"] = r["mm.flag-font-size-scale"]; }

        if (r["mm.flag-border-width"]) { borderParts.width = r["mm.flag-border-width"]; }
        if (r["mm.flag-border-style"]) { borderParts.style = r["mm.flag-border-style"]; }
        if (r["mm.flag-border-color"]) { borderParts.color = r["mm.flag-border-color"]; }
    }

    // mx:flags — additive in case the node already carries some (defensive).
    var existingFlags = String(attrs["mx:flags"] || "").split(/\s+/).filter(Boolean);
    var combinedFlags = existingFlags.slice();
    for (var fi = 0; fi < names.length; fi++) {
        if (combinedFlags.indexOf(names[fi]) < 0) { combinedFlags.push(names[fi]); }
    }
    if (combinedFlags.length > 0) {
        attrs["mx:flags"] = combinedFlags.join(" ");
        for (var fj = 0; fj < names.length; fj++) {
            attrs["mx:flag-" + names[fj]] = true;
        }
    }

    if (classes.length > 0) {
        var existingClasses = String(attrs["mx:flag-classes"] || "").split(/\s+/).filter(Boolean);
        var combinedClasses = existingClasses.slice();
        for (var ci = 0; ci < classes.length; ci++) {
            if (combinedClasses.indexOf(classes[ci]) < 0) { combinedClasses.push(classes[ci]); }
        }
        attrs["mx:flag-classes"] = combinedClasses.join(" ");
    }

    if (tooltips.length > 0) {
        // Ascending priority order (== rule iteration order). Joined with
        // newline so the browser renders one tooltip line per active flag.
        var existingTip = String(attrs["mx:flag-tooltip"] || "");
        var existingLines = existingTip ? existingTip.split("\n") : [];
        var combined = existingLines.slice();
        for (var ti = 0; ti < tooltips.length; ti++) {
            if (combined.indexOf(tooltips[ti]) < 0) { combined.push(tooltips[ti]); }
        }
        attrs["mx:flag-tooltip"] = combined.join("\n");
    }

    if (iconEntries.length > 0) {
        // Descending priority. Stable on ties so equal-priority icons preserve
        // the order they were declared (loader gives us ascending priority,
        // ties broken by source-title — predictable).
        iconEntries.sort(function (a, b) { return b.priority - a.priority; });
        var existingIcons = String(attrs["mx:icons"] || "").split("|").filter(Boolean);
        var newIcons = iconEntries.map(function (e) { return e.icon; });
        attrs["mx:icons"] = existingIcons.concat(newIcons).join("|");
    }

    for (var key in styleMap) {
        attrs[key] = styleMap[key];
    }

    if (borderParts.width || borderParts.style || borderParts.color) {
        var existing = parseBorderComposite(attrs["mx:border"]);
        var w = borderParts.width || existing.width || "1px";
        var st = borderParts.style || existing.style || "solid";
        var cc = borderParts.color || existing.color || "#888";
        attrs["mx:border"] = w + " " + st + " " + cc;
    }
}

// Run each rule's filter against the universe of titled-node titles. Returns
// { ruleName → Set<title> }. Empty `titles` → all rules map to empty sets
// without any filter calls.
function evaluateRules(rules, titles, wiki) {
    var matched = Object.create(null);
    var hasFilter = wiki && typeof wiki.filterTiddlers === "function" &&
                    typeof wiki.makeTiddlerIterator === "function";
    for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        var set = Object.create(null);
        if (hasFilter && titles.length > 0) {
            try {
                var source = wiki.makeTiddlerIterator(titles);
                var out = wiki.filterTiddlers(rule.filter, null, source) || [];
                for (var k = 0; k < out.length; k++) { set[out[k]] = true; }
            } catch (e) {
                console.error("[mindmap-flags] rule '" + rule.name + "' filter failed", e);
            }
        }
        matched[rule.name] = set;
    }
    return matched;
}

// Bottom-up walk that stamps synthetic ancestors based on per-rule
// aggregation. Memoised: each node's leaf-count and per-rule matched-count
// are computed once. Recursion depth capped at 64 against malformed input.
function aggregateUpwards(root, rules, matchedByRule) {
    var aggregating = [];
    for (var i = 0; i < rules.length; i++) {
        if (rules[i].aggregate === "any" || rules[i].aggregate === "all") {
            aggregating.push(rules[i]);
        }
    }
    if (aggregating.length === 0) { return; }

    var MAX_DEPTH = 64;
    var warned = false;

    // Returns { totalLeaves, perRule } for the subtree rooted at `node`.
    function visit(node, depth) {
        if (depth > MAX_DEPTH) {
            if (!warned) {
                console.warn("[mindmap-flags] aggregation recursion depth exceeded — tree too deep, capping");
                warned = true;
            }
            return { totalLeaves: 0, perRule: zeroPerRule() };
        }
        var attrs = node.attrs || {};
        var directTitle = attrs["core:tiddler"];
        var total = 0;
        var perRule = zeroPerRule();

        if (directTitle) {
            total = 1;
            for (var r = 0; r < aggregating.length; r++) {
                var name = aggregating[r].name;
                if (matchedByRule[name] && matchedByRule[name][directTitle]) {
                    perRule[name] = 1;
                }
            }
        }

        var children = node.children || [];
        for (var c = 0; c < children.length; c++) {
            var sub = visit(children[c], depth + 1);
            total += sub.totalLeaves;
            for (var rn = 0; rn < aggregating.length; rn++) {
                var key = aggregating[rn].name;
                perRule[key] += sub.perRule[key];
            }
        }

        if (attrs["core:synthetic"] === true && total > 0) {
            var matching = [];
            for (var ai = 0; ai < aggregating.length; ai++) {
                var rule = aggregating[ai];
                var m = perRule[rule.name];
                if (rule.aggregate === "any" && m > 0) {
                    matching.push(rule);
                } else if (rule.aggregate === "all" && m === total) {
                    matching.push(rule);
                }
            }
            if (matching.length > 0) {
                applyRulesToNode(node, matching);
            }
        }

        return { totalLeaves: total, perRule: perRule };
    }

    function zeroPerRule() {
        var z = {};
        for (var i = 0; i < aggregating.length; i++) { z[aggregating[i].name] = 0; }
        return z;
    }

    visit(root, 0);
}

/*
 * decorateFlags(mdom, rules, wiki) → mdom
 *
 * Mutates `mdom` in place. Returns the same MDOM for chaining convenience.
 * No-ops cleanly when rules or mdom are empty / missing.
 *
 * The caller is responsible for keeping `mdom` ahead of `composer.compose` —
 * decoration runs BEFORE compose so live overlay setAttr ops can still
 * override flag-stamped values (a user "mute" gesture, for example).
 */
exports.decorateFlags = function (mdom, rules, wiki) {
    if (!mdom || !mdom.root || !rules || rules.length === 0) { return mdom; }

    var collected = collectTitledNodes(mdom.root);
    var titles = Object.keys(collected.byTitle);

    var matchedByRule = evaluateRules(rules, titles, wiki);

    // Stamp direct matches on every titled node.
    for (var ti = 0; ti < collected.allTitled.length; ti++) {
        var pair = collected.allTitled[ti];
        var matching = [];
        for (var ri = 0; ri < rules.length; ri++) {
            var rule = rules[ri];
            var set = matchedByRule[rule.name];
            if (set && set[pair.title]) { matching.push(rule); }
        }
        if (matching.length > 0) {
            applyRulesToNode(pair.node, matching);
        }
    }

    // Aggregation pass (skipped automatically if no aggregating rules exist).
    aggregateUpwards(mdom.root, rules, matchedByRule);

    return mdom;
};

// ----------------------------------------------------------------------------
// Test-only exports.

exports._applyRulesToNode = applyRulesToNode;
exports._evaluateRules = evaluateRules;
exports._collectTitledNodes = collectTitledNodes;
exports._parseBorderComposite = parseBorderComposite;
