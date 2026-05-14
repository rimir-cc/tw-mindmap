/*\
title: $:/plugins/rimir/mindmap/test/test-flags.js
type: application/javascript
tags: [[$:/tags/test-spec]]

Comprehensive pins for the flag-decoration pipeline:
  - loadFlagRules() resolves view/widget filter into a sorted, validated rule
    set, honouring mm.flag-scope filters.
  - decorateFlags() stamps MDOM attrs on tiddler-backed nodes via inverted-
    loop filter evaluation (M calls, not N×M), then aggregates onto synthetic
    ancestors per rule's `any` / `all` policy.

Tests build small fake-wiki seeds with real $tw.Wiki instances and run real
TW filters — the same path used in production.

\*/

"use strict";

describe("mindmap-flags", function () {
    var widget = require("$:/plugins/rimir/mindmap/widget.js");
    var compose = require("$:/plugins/rimir/mindmap/compose.js").compose;
    var loadFlagRules = widget._loadFlagRules;
    var decorateFlags = widget._decorateFlags;

    function setupWiki(tiddlers) {
        var wiki = new $tw.Wiki();
        wiki.addTiddlers(tiddlers || []);
        wiki.addIndexersToWiki();
        return wiki;
    }

    // ----- MDOM helpers ----------------------------------------------------

    // Build a leaf node carrying `core:tiddler=title`.
    function leaf(id, title, extras) {
        var attrs = { "core:tiddler": title };
        if (extras) { for (var k in extras) { attrs[k] = extras[k]; } }
        return { id: id, label: title, attrs: attrs, children: [] };
    }

    // Build a synthetic chain/axis node.
    function syn(id, label, children) {
        return {
            id: id, label: label,
            attrs: { "core:synthetic": true },
            children: children || []
        };
    }

    function rootOf(children) {
        return {
            version: 1,
            root: {
                id: "root", label: "Root",
                attrs: { "core:synthetic": true },
                children: children || []
            }
        };
    }

    // -----------------------------------------------------------------------
    // decorateFlags — leaf-level decoration
    // -----------------------------------------------------------------------

    describe("decorateFlags (leaf-level)", function () {
        // Build a small wiki with `priority` field set on a few tiddlers; we
        // reuse it across specs.
        function priorityWiki() {
            return setupWiki([
                { title: "t-crit-1", priority: "critical" },
                { title: "t-crit-2", priority: "critical" },
                { title: "t-normal", priority: "normal" },
                { title: "t-low",    priority: "low" }
            ]);
        }

        function critRule(extras) {
            var r = {
                name: "critical",
                filter: "[priority[critical]]",
                aggregate: "",
                priority: 10,
                sourceTitle: "$:/flags/critical",
                "mm.flag-icon": "🔥",
                "mm.flag-font-weight": "bold",
                "mm.flag-bg-color": "",
                "mm.flag-border-color": "",
                "mm.flag-border-width": "",
                "mm.flag-border-style": "",
                "mm.flag-font-style": "",
                "mm.flag-text-color": "",
                "mm.flag-text-transform": "",
                "mm.flag-opacity": "",
                "mm.flag-font-size-scale": "",
                "mm.flag-class": ""
            };
            if (extras) { for (var k in extras) { r[k] = extras[k]; } }
            return r;
        }

        it("returns unchanged MDOM when rules is empty", function () {
            var mdom = rootOf([leaf("a", "t-crit-1")]);
            var snapshot = JSON.stringify(mdom);
            var out = decorateFlags(mdom, [], priorityWiki());
            expect(JSON.stringify(out)).toBe(snapshot);
        });

        it("returns unchanged MDOM when mdom is missing / rootless", function () {
            expect(decorateFlags(null, [critRule()], priorityWiki())).toBeNull();
            expect(decorateFlags({}, [critRule()], priorityWiki())).toEqual({});
        });

        it("does not error on empty MDOM root", function () {
            var mdom = rootOf([]);
            expect(function () { decorateFlags(mdom, [critRule()], priorityWiki()); })
                .not.toThrow();
        });

        it("stamps mx:flags / mx:icons / style attrs on a matching leaf", function () {
            var mdom = rootOf([leaf("a", "t-crit-1"), leaf("b", "t-normal")]);
            decorateFlags(mdom, [critRule()], priorityWiki());
            var a = mdom.root.children[0];
            var b = mdom.root.children[1];
            expect(a.attrs["mx:flags"]).toBe("critical");
            expect(a.attrs["mx:flag-critical"]).toBe(true);
            expect(a.attrs["mx:icons"]).toBe("🔥");
            expect(a.attrs["mx:font-weight"]).toBe("bold");
            expect(b.attrs["mx:flags"]).toBeUndefined();
            expect(b.attrs["mx:icons"]).toBeUndefined();
        });

        it("does NOT stamp mx:flags as empty string when no rules match", function () {
            var mdom = rootOf([leaf("a", "t-low")]);
            decorateFlags(mdom, [critRule()], priorityWiki());
            expect(mdom.root.children[0].attrs["mx:flags"]).toBeUndefined();
        });

        it("stacks two matching rules — priority controls icon + style order", function () {
            var lowPriority = critRule({ name: "warn", priority: 5,
                "mm.flag-icon": "⚠", "mm.flag-font-weight": "normal",
                "mm.flag-text-transform": "uppercase" });
            var highPriority = critRule({ priority: 20,
                "mm.flag-font-weight": "bold" /* overrides lower priority */ });
            // Sorted ascending — caller's responsibility (loader does it).
            var rules = [lowPriority, highPriority];
            var mdom = rootOf([leaf("a", "t-crit-1")]);
            decorateFlags(mdom, rules, priorityWiki());
            var a = mdom.root.children[0];
            // Names accumulate in ascending order:
            expect(a.attrs["mx:flags"]).toBe("warn critical");
            // Last-wins for style: critical's "bold" overrides warn's "normal":
            expect(a.attrs["mx:font-weight"]).toBe("bold");
            // text-transform contributed by warn only — passes through.
            expect(a.attrs["mx:text-transform"]).toBe("uppercase");
            // Icons in DESCENDING priority order (highest leftmost):
            expect(a.attrs["mx:icons"]).toBe("🔥|⚠");
        });

        it("rule with only icon writes only mx:icons (no style pollution)", function () {
            var iconOnly = critRule({ name: "marker",
                "mm.flag-font-weight": "", "mm.flag-icon": "⭐" });
            var mdom = rootOf([leaf("a", "t-crit-1")]);
            decorateFlags(mdom, [iconOnly], priorityWiki());
            var a = mdom.root.children[0];
            expect(a.attrs["mx:icons"]).toBe("⭐");
            expect(a.attrs["mx:font-weight"]).toBeUndefined();
            expect(a.attrs["mx:text-color"]).toBeUndefined();
        });

        it("rule with only class writes only mx:flag-classes", function () {
            var classOnly = critRule({ name: "starred",
                "mm.flag-font-weight": "", "mm.flag-icon": "",
                "mm.flag-class": "kn-starred" });
            var mdom = rootOf([leaf("a", "t-crit-1")]);
            decorateFlags(mdom, [classOnly], priorityWiki());
            var a = mdom.root.children[0];
            expect(a.attrs["mx:flag-classes"]).toBe("kn-starred");
            expect(a.attrs["mx:icons"]).toBeUndefined();
            expect(a.attrs["mx:font-weight"]).toBeUndefined();
        });

        it("rule with mm.flag-bg-color writes core:color (adapter reuses bg path)", function () {
            var bg = critRule({ "mm.flag-icon": "", "mm.flag-font-weight": "",
                                "mm.flag-bg-color": "#ffeb3b" });
            var mdom = rootOf([leaf("a", "t-crit-1")]);
            decorateFlags(mdom, [bg], priorityWiki());
            expect(mdom.root.children[0].attrs["core:color"]).toBe("#ffeb3b");
        });

        it("composes border parts (color+width+style) into one mx:border attr", function () {
            var border = critRule({ "mm.flag-icon": "", "mm.flag-font-weight": "",
                "mm.flag-border-color": "#d04444",
                "mm.flag-border-width": "2px",
                "mm.flag-border-style": "solid" });
            var mdom = rootOf([leaf("a", "t-crit-1")]);
            decorateFlags(mdom, [border], priorityWiki());
            expect(mdom.root.children[0].attrs["mx:border"]).toBe("2px solid #d04444");
        });

        it("inverted-loop: M rules → exactly M filter invocations", function () {
            var wiki = priorityWiki();
            var calls = 0;
            var originalFilter = wiki.filterTiddlers;
            wiki.filterTiddlers = function () { calls += 1; return originalFilter.apply(wiki, arguments); };
            var mdom = rootOf([
                leaf("a", "t-crit-1"), leaf("b", "t-crit-2"),
                leaf("c", "t-normal"), leaf("d", "t-low")
            ]);
            var rules = [
                critRule({ name: "r1" }),
                critRule({ name: "r2", filter: "[priority[normal]]" }),
                critRule({ name: "r3", filter: "[priority[low]]" })
            ];
            decorateFlags(mdom, rules, wiki);
            expect(calls).toBe(3);
        });

        it("nodes without core:tiddler are not tested against rule filters", function () {
            // A bare synthetic leaf (no core:tiddler). Even if a rule "would"
            // match a fictional title, the decorator must skip it.
            var wiki = priorityWiki();
            var calls = 0;
            var originalFilter = wiki.filterTiddlers;
            wiki.filterTiddlers = function () { calls += 1; return originalFilter.apply(wiki, arguments); };
            var bare = { id: "bare", label: "Bare", attrs: { "core:synthetic": true }, children: [] };
            var mdom = rootOf([bare]);
            decorateFlags(mdom, [critRule()], wiki);
            // No titled leaves → no filter call (early-exit on empty universe).
            expect(calls).toBe(0);
            expect(bare.attrs["mx:flags"]).toBeUndefined();
        });

        it("writes mx:flag-tooltip when rule defines mm.flag-tooltip", function () {
            var withTip = critRule({ "mm.flag-tooltip": "Critical priority" });
            var mdom = rootOf([leaf("a", "t-crit-1")]);
            decorateFlags(mdom, [withTip], priorityWiki());
            expect(mdom.root.children[0].attrs["mx:flag-tooltip"]).toBe("Critical priority");
        });

        it("stacks tooltips from multiple matching rules on newlines", function () {
            var crit = critRule({ priority: 30, "mm.flag-tooltip": "Critical" });
            var warn = critRule({ name: "warn", priority: 10, "mm.flag-tooltip": "Warning" });
            var mdom = rootOf([leaf("a", "t-crit-1")]);
            // Sorted ascending priority — warn first then crit.
            decorateFlags(mdom, [warn, crit], priorityWiki());
            expect(mdom.root.children[0].attrs["mx:flag-tooltip"]).toBe("Warning\nCritical");
        });

        it("omits mx:flag-tooltip when no matching rule defines one", function () {
            var noTip = critRule();  // no mm.flag-tooltip
            var mdom = rootOf([leaf("a", "t-crit-1")]);
            decorateFlags(mdom, [noTip], priorityWiki());
            expect(mdom.root.children[0].attrs["mx:flag-tooltip"]).toBeUndefined();
        });

        it("two nodes sharing one tiddler get the same stamp from one match", function () {
            var mdom = rootOf([leaf("a1", "t-crit-1"), leaf("a2", "t-crit-1")]);
            decorateFlags(mdom, [critRule()], priorityWiki());
            expect(mdom.root.children[0].attrs["mx:flags"]).toBe("critical");
            expect(mdom.root.children[1].attrs["mx:flags"]).toBe("critical");
        });
    });

    // -----------------------------------------------------------------------
    // decorateFlags — aggregation
    // -----------------------------------------------------------------------

    describe("decorateFlags (aggregation)", function () {
        function aggWiki() {
            return setupWiki([
                { title: "t1", priority: "critical" },
                { title: "t2", priority: "critical" },
                { title: "t3", priority: "normal" },
                { title: "t4", priority: "normal" },
                { title: "t5", priority: "normal" }
            ]);
        }

        function rule(aggregate, name) {
            return {
                name: name || "critical",
                filter: "[priority[critical]]",
                aggregate: aggregate,
                priority: 10,
                sourceTitle: "$:/flags/" + (name || "critical"),
                "mm.flag-icon": "🔥",
                "mm.flag-font-weight": "",
                "mm.flag-bg-color": "",
                "mm.flag-border-color": "", "mm.flag-border-width": "", "mm.flag-border-style": "",
                "mm.flag-font-style": "", "mm.flag-text-color": "",
                "mm.flag-text-transform": "", "mm.flag-opacity": "",
                "mm.flag-font-size-scale": "", "mm.flag-class": ""
            };
        }

        it("aggregate=any stamps synthetic ancestor when ≥1 leaf matches", function () {
            var chain = syn("chain", "Tasks", [
                leaf("a", "t1"),   // critical
                leaf("b", "t3"),   // normal
                leaf("c", "t4")    // normal
            ]);
            var mdom = rootOf([chain]);
            decorateFlags(mdom, [rule("any")], aggWiki());
            expect(chain.attrs["mx:flags"]).toBe("critical");
            expect(chain.attrs["mx:icons"]).toBe("🔥");
        });

        it("aggregate=any does NOT stamp ancestor when 0 leaves match", function () {
            var chain = syn("chain", "Notes", [
                leaf("a", "t3"), leaf("b", "t4"), leaf("c", "t5")
            ]);
            var mdom = rootOf([chain]);
            decorateFlags(mdom, [rule("any")], aggWiki());
            expect(chain.attrs["mx:flags"]).toBeUndefined();
        });

        it("aggregate=all stamps only when 100% of leaves match", function () {
            var chainAll = syn("chain-all", "All Crit", [leaf("a", "t1"), leaf("b", "t2")]);
            var chainMixed = syn("chain-mix", "Mixed", [leaf("c", "t1"), leaf("d", "t3")]);
            var mdom = rootOf([chainAll, chainMixed]);
            decorateFlags(mdom, [rule("all")], aggWiki());
            expect(chainAll.attrs["mx:flags"]).toBe("critical");
            expect(chainMixed.attrs["mx:flags"]).toBeUndefined();
        });

        it("aggregate=all does NOT stamp on an empty chain (no leaves)", function () {
            var empty = syn("empty", "Empty", []);
            var mdom = rootOf([empty]);
            decorateFlags(mdom, [rule("all")], aggWiki());
            expect(empty.attrs["mx:flags"]).toBeUndefined();
        });

        it("aggregation cascades through nested synthetic ancestors", function () {
            // root(syn) → axis(syn) → chain(syn) → leaf(t1)
            var leafN = leaf("a", "t1");
            var chain = syn("chain", "Chain", [leafN]);
            var axis  = syn("axis",  "Axis",  [chain]);
            var mdom = rootOf([axis]);
            decorateFlags(mdom, [rule("any")], aggWiki());
            expect(leafN.attrs["mx:flags"]).toBe("critical");      // direct
            expect(chain.attrs["mx:flags"]).toBe("critical");      // aggregated
            expect(axis.attrs["mx:flags"]).toBe("critical");       // aggregated
            // Root is also synthetic and should aggregate too.
            expect(mdom.root.attrs["mx:flags"]).toBe("critical");
        });

        it("empty mm.flag-aggregate leaves synthetic ancestors untouched", function () {
            var chain = syn("chain", "Chain", [leaf("a", "t1")]);
            var mdom = rootOf([chain]);
            decorateFlags(mdom, [rule("")], aggWiki());
            expect(chain.attrs["mx:flags"]).toBeUndefined();
        });

        it("synthetic ancestors stamp only when at least one rule has aggregation", function () {
            var leafOnlyRule = rule("");   // leaf-only
            var aggRule = rule("any", "starred");
            // Wiki marks t1 as critical (rule1 matches) and t1 also as starred-eligible.
            var wiki = aggWiki();
            // Override: starred filter just matches t1.
            aggRule.filter = "[[t1]]";
            var leafN = leaf("a", "t1");
            var chain = syn("chain", "Chain", [leafN]);
            var mdom = rootOf([chain]);
            decorateFlags(mdom, [leafOnlyRule, aggRule], wiki);
            // Both rules stamp the leaf directly.
            expect(leafN.attrs["mx:flags"]).toBe("critical starred");
            // Only the aggregating rule reaches the chain.
            expect(chain.attrs["mx:flags"]).toBe("starred");
        });

        it("non-synthetic ancestors are NEVER stamped by aggregation", function () {
            // Tiddler-backed parent — knowledge-tree pattern. Aggregation must
            // not bleed onto it even though one of its children matches.
            var parent = leaf("p", "t3");   // normal — doesn't match itself
            parent.children = [leaf("c", "t1")];
            var mdom = rootOf([parent]);
            decorateFlags(mdom, [rule("any")], aggWiki());
            expect(parent.attrs["mx:flags"]).toBeUndefined();
            expect(parent.children[0].attrs["mx:flags"]).toBe("critical");
        });
    });

    // -----------------------------------------------------------------------
    // loadFlagRules
    // -----------------------------------------------------------------------

    describe("loadFlagRules", function () {
        function ruleTiddler(title, fields) {
            return Object.assign({
                title: title,
                tags: "$:/tags/rimir/mindmap/flag",
                "mm.flag-name": "x",
                "mm.flag-filter": "[all[]]"
            }, fields || {});
        }

        function wikiWith(rules) {
            return setupWiki(rules);
        }

        it("returns [] for an empty rules filter", function () {
            var wiki = wikiWith([ruleTiddler("$:/r1", { "mm.flag-name": "a" })]);
            expect(loadFlagRules(wiki, { rulesFilter: "" })).toEqual([]);
            expect(loadFlagRules(wiki, { rulesFilter: "   " })).toEqual([]);
        });

        it("returns [] when no rules match the filter", function () {
            var wiki = wikiWith([]);
            expect(loadFlagRules(wiki, { rulesFilter: "[tag[no-such-tag]]" })).toEqual([]);
        });

        it("loads N rules matching a tag filter", function () {
            var wiki = wikiWith([
                ruleTiddler("$:/r1", { "mm.flag-name": "a" }),
                ruleTiddler("$:/r2", { "mm.flag-name": "b" })
            ]);
            var rs = loadFlagRules(wiki, { rulesFilter: "[tag[$:/tags/rimir/mindmap/flag]]" });
            expect(rs.length).toBe(2);
            expect(rs.map(function (r) { return r.name; }).sort()).toEqual(["a", "b"]);
        });

        it("skips rule without mm.flag-name", function () {
            var wiki = wikiWith([
                ruleTiddler("$:/bad", { "mm.flag-name": "" }),
                ruleTiddler("$:/ok",  { "mm.flag-name": "ok" })
            ]);
            var rs = loadFlagRules(wiki, { rulesFilter: "[tag[$:/tags/rimir/mindmap/flag]]" });
            expect(rs.length).toBe(1);
            expect(rs[0].name).toBe("ok");
        });

        it("skips rule without mm.flag-filter", function () {
            var wiki = wikiWith([
                ruleTiddler("$:/bad", { "mm.flag-name": "bad", "mm.flag-filter": "" }),
                ruleTiddler("$:/ok",  { "mm.flag-name": "ok" })
            ]);
            var rs = loadFlagRules(wiki, { rulesFilter: "[tag[$:/tags/rimir/mindmap/flag]]" });
            expect(rs.length).toBe(1);
            expect(rs[0].name).toBe("ok");
        });

        it("drops rule whose mm.flag-scope is unsatisfied by mmProducer", function () {
            var wiki = wikiWith([
                ruleTiddler("$:/r-grouped", {
                    "mm.flag-name": "g",
                    "mm.flag-scope": "[<mm-producer>match[grouped-tree]]"
                })
            ]);
            var rsOk = loadFlagRules(wiki, {
                rulesFilter: "[tag[$:/tags/rimir/mindmap/flag]]",
                mmProducer: "grouped-tree"
            });
            expect(rsOk.length).toBe(1);
            var rsDrop = loadFlagRules(wiki, {
                rulesFilter: "[tag[$:/tags/rimir/mindmap/flag]]",
                mmProducer: "json"
            });
            expect(rsDrop.length).toBe(0);
        });

        it("exposes view title as currentTiddler in scope filter", function () {
            var wiki = wikiWith([
                { title: "$:/views/v-tasks", tags: "view" },
                ruleTiddler("$:/r-view-scoped", {
                    "mm.flag-name": "s",
                    "mm.flag-scope": "[<currentTiddler>tag[view]]"
                })
            ]);
            var rsOk = loadFlagRules(wiki, {
                rulesFilter: "[tag[$:/tags/rimir/mindmap/flag]]",
                viewTitle: "$:/views/v-tasks"
            });
            expect(rsOk.length).toBe(1);
            var rsDrop = loadFlagRules(wiki, {
                rulesFilter: "[tag[$:/tags/rimir/mindmap/flag]]",
                viewTitle: "$:/views/other"
            });
            expect(rsDrop.length).toBe(0);
        });

        it("sorts rules ascending by priority", function () {
            var wiki = wikiWith([
                ruleTiddler("$:/r-a", { "mm.flag-name": "a", "mm.flag-priority": "30" }),
                ruleTiddler("$:/r-b", { "mm.flag-name": "b", "mm.flag-priority": "10" }),
                ruleTiddler("$:/r-c", { "mm.flag-name": "c", "mm.flag-priority": "20" })
            ]);
            var rs = loadFlagRules(wiki, { rulesFilter: "[tag[$:/tags/rimir/mindmap/flag]]" });
            expect(rs.map(function (r) { return r.name; })).toEqual(["b", "c", "a"]);
        });

        it("tie-breaks equal priorities by source title (stable)", function () {
            var wiki = wikiWith([
                ruleTiddler("$:/zeta", { "mm.flag-name": "z" }),
                ruleTiddler("$:/alpha", { "mm.flag-name": "a" })
            ]);
            var rs = loadFlagRules(wiki, { rulesFilter: "[tag[$:/tags/rimir/mindmap/flag]]" });
            expect(rs.map(function (r) { return r.name; })).toEqual(["a", "z"]);
        });

        it("treats invalid mm.flag-aggregate as empty (leaf-only)", function () {
            var wiki = wikiWith([
                ruleTiddler("$:/r-bad-agg", { "mm.flag-name": "x",
                                              "mm.flag-aggregate": "maybe" })
            ]);
            var rs = loadFlagRules(wiki, { rulesFilter: "[tag[$:/tags/rimir/mindmap/flag]]" });
            expect(rs[0].aggregate).toBe("");
        });

        it("clamps mm.flag-opacity to [0,1]", function () {
            var wiki = wikiWith([
                ruleTiddler("$:/r-over", { "mm.flag-name": "over",
                                           "mm.flag-opacity": "2.5" }),
                ruleTiddler("$:/r-under", { "mm.flag-name": "under",
                                            "mm.flag-opacity": "-0.3" })
            ]);
            var rs = loadFlagRules(wiki, { rulesFilter: "[tag[$:/tags/rimir/mindmap/flag]]" });
            var byName = {};
            rs.forEach(function (r) { byName[r.name] = r; });
            expect(byName.over["mm.flag-opacity"]).toBe("1");
            expect(byName.under["mm.flag-opacity"]).toBe("0");
        });

        it("defaults mm.flag-priority to 0 when missing or non-numeric", function () {
            var wiki = wikiWith([
                ruleTiddler("$:/r-no-prio", { "mm.flag-name": "no" }),
                ruleTiddler("$:/r-junk", { "mm.flag-name": "junk", "mm.flag-priority": "abc" })
            ]);
            var rs = loadFlagRules(wiki, { rulesFilter: "[tag[$:/tags/rimir/mindmap/flag]]" });
            rs.forEach(function (r) { expect(r.priority).toBe(0); });
        });
    });

    // -----------------------------------------------------------------------
    // Compose ordering — decoration runs BEFORE compose
    // -----------------------------------------------------------------------

    describe("decoration + compose ordering", function () {
        function rule() {
            return {
                name: "x", filter: "[priority[critical]]",
                aggregate: "", priority: 10, sourceTitle: "$:/r",
                "mm.flag-icon": "★",
                "mm.flag-bg-color": "#aaa",
                "mm.flag-font-weight": "bold",
                "mm.flag-border-color": "", "mm.flag-border-width": "", "mm.flag-border-style": "",
                "mm.flag-font-style": "", "mm.flag-text-color": "",
                "mm.flag-text-transform": "", "mm.flag-opacity": "",
                "mm.flag-font-size-scale": "", "mm.flag-class": ""
            };
        }

        it("overlay setAttr can override a decorator-stamped attr", function () {
            var wiki = setupWiki([{ title: "t", priority: "critical" }]);
            var mdom = {
                version: 1,
                root: { id: "r", label: "Root", attrs: { "core:synthetic": true }, children: [
                    { id: "a", label: "A", attrs: { "core:tiddler": "t" }, children: [] }
                ]}
            };
            decorateFlags(mdom, [rule()], wiki);
            // Decorator stamped mx:flags + font-weight. Overlay clears font-weight.
            var ops = [
                { op: "setAttr", id: "a", key: "mx:font-weight", value: null }
            ];
            var result = compose(mdom, ops);
            var a = result.mdom.root.children[0];
            expect(a.attrs["mx:flags"]).toBe("x");           // decoration preserved
            expect(a.attrs["mx:font-weight"]).toBeUndefined(); // overlay wins
        });
    });
});
