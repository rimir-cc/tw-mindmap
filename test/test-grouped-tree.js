/*\
title: $:/plugins/rimir/mindmap/test/test-grouped-tree.js
type: application/javascript
tags: [[$:/tags/test-spec]]

Unit tests for the grouped-tree producer and its pure-JS lib helpers.
Covers groupBy / applyChain in isolation, then exercises the producer
against fixtured wikis with axis / chain / template tiddlers.

\*/

"use strict";

describe("mindmap-grouped-tree", function () {

    var lib = require("$:/plugins/rimir/mindmap/lib/grouped-tree.js");
    var producer = require("$:/plugins/rimir/mindmap/producers/grouped-tree.js");

    // ---------------------------------------------------------------------
    // Pure-JS helpers
    // ---------------------------------------------------------------------

    describe("lib.groupBy", function () {
        it("groups items by their computed key", function () {
            var items = ["a", "b", "c", "d"];
            var groups = lib.groupBy(items, function (x) { return x === "a" || x === "c" ? "odd" : "even"; });
            expect(groups.length).toBe(2);
            expect(groups[0].key).toBe("odd");
            expect(groups[0].items).toEqual(["a", "c"]);
            expect(groups[1].key).toBe("even");
            expect(groups[1].items).toEqual(["b", "d"]);
        });

        it("preserves first-seen order across keys", function () {
            var items = [1, 2, 3, 4, 5];
            var groups = lib.groupBy(items, function (x) { return (x % 3) + ""; });
            expect(groups.map(function (g) { return g.key; })).toEqual(["1", "2", "0"]);
        });

        it("routes null / undefined / empty keys into the UNSET bucket", function () {
            var items = ["a", "b", "c"];
            var groups = lib.groupBy(items, function (x) { return x === "b" ? "" : null; });
            expect(groups.length).toBe(1);
            expect(groups[0].key).toBe(lib.UNSET_KEY);
            expect(groups[0].items).toEqual(["a", "b", "c"]);
        });

        it("returns an empty list for empty input", function () {
            expect(lib.groupBy([], function () { return "x"; })).toEqual([]);
        });
    });

    describe("lib.applyChain", function () {
        it("returns a flat leaf list when there are no axes", function () {
            var result = lib.applyChain(["x", "y"], []);
            expect(result.length).toBe(2);
            expect(result[0]).toEqual({ kind: "leaf", leaf: "x" });
            expect(result[1]).toEqual({ kind: "leaf", leaf: "y" });
        });

        it("groups one level deep with a single axis", function () {
            var axes = [{
                id: "by-first-char",
                keyFn: function (s) { return s.charAt(0); },
                labelFn: function (k) { return "Group " + k; }
            }];
            var result = lib.applyChain(["apple", "ant", "banana"], axes);
            expect(result.length).toBe(2);
            expect(result[0].kind).toBe("group");
            expect(result[0].axisId).toBe("by-first-char");
            expect(result[0].key).toBe("a");
            expect(result[0].label).toBe("Group a");
            expect(result[0].children.length).toBe(2);
            expect(result[0].children[0]).toEqual({ kind: "leaf", leaf: "apple" });
            expect(result[1].key).toBe("b");
        });

        it("nests two axes correctly", function () {
            var axes = [
                { id: "first", keyFn: function (s) { return s.charAt(0); } },
                { id: "length", keyFn: function (s) { return String(s.length); } }
            ];
            var result = lib.applyChain(["apple", "ant", "banana", "berry"], axes);
            // a-group has two length sub-groups: 3 (ant), 5 (apple)
            expect(result[0].axisId).toBe("first");
            expect(result[0].children.length).toBe(2);
            expect(result[0].children[0].axisId).toBe("length");
            // Order of inner groups follows first-seen — "apple" (len 5) first, "ant" (len 3) second.
            expect(result[0].children[0].key).toBe("5");
            expect(result[0].children[0].children[0].leaf).toBe("apple");
            expect(result[0].children[1].key).toBe("3");
            expect(result[0].children[1].children[0].leaf).toBe("ant");
        });

        it("drops items that fail an axis's leafFilter", function () {
            var axes = [{
                id: "only-a",
                keyFn: function (s) { return s.charAt(0); },
                leafFilter: function (s) { return s.charAt(0) === "a"; }
            }];
            var result = lib.applyChain(["apple", "banana", "ant"], axes);
            expect(result.length).toBe(1);
            expect(result[0].key).toBe("a");
            expect(result[0].children.length).toBe(2);
        });

        it("prunes parent groups whose descendants are all filtered out", function () {
            // Level 1 groups by first-char (no filter); level 2 only keeps
            // items longer than 4 chars. "ant" + "be" lose all descendants
            // → their parent groups must be pruned.
            var axes = [
                { id: "first", keyFn: function (s) { return s.charAt(0); } },
                {
                    id: "len-gt-4",
                    keyFn: function (s) { return s.length > 4 ? "long" : "short"; },
                    leafFilter: function (s) { return s.length > 4; }
                }
            ];
            var result = lib.applyChain(["apple", "ant", "berry", "be"], axes);
            // Only "a" (apple survives) and "b" (berry survives) remain.
            expect(result.length).toBe(2);
            expect(result.map(function (g) { return g.key; })).toEqual(["a", "b"]);
            expect(result[0].children[0].children[0].leaf).toBe("apple");
        });
    });

    // ---------------------------------------------------------------------
    // Producer fixtures
    // ---------------------------------------------------------------------

    function setupWiki(tiddlers) {
        var wiki = new $tw.Wiki();
        wiki.addTiddlers(tiddlers || []);
        wiki.addIndexersToWiki();
        return wiki;
    }

    function meetingFixtures() {
        return [
            // axes
            { title: "Axis/by-year",
              "mm.axis-id": "by-year",
              "mm.axis-caption": "Year",
              "mm.axis-field": "year" },
            { title: "Axis/by-month",
              "mm.axis-id": "by-month",
              "mm.axis-caption": "Month",
              "mm.axis-field": "month" },
            { title: "Axis/by-state",
              "mm.axis-id": "by-state",
              "mm.axis-caption": "State",
              "mm.axis-field": "state" },
            // chains
            { title: "Chain/by-time",
              "mm.chain-id": "by-time",
              "mm.chain-caption": "By time",
              "mm.axes": "[[Axis/by-year]] [[Axis/by-month]]" },
            { title: "Chain/by-state",
              "mm.chain-id": "by-state",
              "mm.chain-caption": "By state",
              "mm.axes": "[[Axis/by-state]]" },
            // template
            { title: "Template/meetings",
              "mm.template-id": "meetings",
              "mm.template-caption": "Meetings",
              "mm.leaf-filter": "[tag[meeting]]",
              "mm.chains": "[[Chain/by-time]] [[Chain/by-state]]" },
            // single-chain variant
            { title: "Template/meetings-single",
              "mm.template-caption": "Meetings by time",
              "mm.leaf-filter": "[tag[meeting]]",
              "mm.chains": "[[Chain/by-time]]" },
            // leaves
            { title: "meeting/jan", tags: "meeting", year: "2026", month: "01", state: "closed" },
            { title: "meeting/feb-a", tags: "meeting", year: "2026", month: "02", state: "open" },
            { title: "meeting/feb-b", tags: "meeting", year: "2026", month: "02", state: "open", caption: "Sprint review" },
            { title: "meeting/last-year", tags: "meeting", year: "2025", month: "12", state: "closed" }
        ];
    }

    // ---------------------------------------------------------------------
    // Schema readers
    // ---------------------------------------------------------------------

    describe("readers", function () {
        it("readAxis pulls all known fields", function () {
            var wiki = setupWiki(meetingFixtures());
            var ax = producer._readAxis(wiki, "Axis/by-year");
            expect(ax.id).toBe("by-year");
            expect(ax.field).toBe("year");
            expect(ax.caption).toBe("Year");
        });

        it("readAxis falls back to title for missing axis-id", function () {
            var wiki = setupWiki([{ title: "Axis/nameless", "mm.axis-field": "x" }]);
            var ax = producer._readAxis(wiki, "Axis/nameless");
            expect(ax.id).toBe("Axis/nameless");
        });

        it("readChain materialises its axes in order", function () {
            var wiki = setupWiki(meetingFixtures());
            var chain = producer._readChain(wiki, "Chain/by-time");
            expect(chain.id).toBe("by-time");
            expect(chain.caption).toBe("By time");
            expect(chain.axes.map(function (a) { return a.id; })).toEqual(["by-year", "by-month"]);
        });

        it("readTemplate enumerates chains in declared order", function () {
            var wiki = setupWiki(meetingFixtures());
            var tpl = producer._readTemplate(wiki, "Template/meetings");
            expect(tpl.chains.length).toBe(2);
            expect(tpl.chains[0].id).toBe("by-time");
            expect(tpl.chains[1].id).toBe("by-state");
            expect(tpl.leafFilter).toBe("[tag[meeting]]");
        });
    });

    // ---------------------------------------------------------------------
    // Disabled-set resolution
    // ---------------------------------------------------------------------

    describe("readDisabledSet", function () {
        it("falls back to template defaults when state tiddler absent", function () {
            var wiki = setupWiki([]);
            var disabled = producer._readDisabledSet(wiki, "myCanvas", ["by-state"]);
            expect(disabled["by-state"]).toBe(true);
            expect(disabled["by-year"]).toBeUndefined();
        });

        it("state tiddler fully replaces template defaults", function () {
            var wiki = setupWiki([{
                title: "$:/state/rimir/mindmap/myCanvas/axes-disabled",
                text: "by-year by-month"
            }]);
            var disabled = producer._readDisabledSet(wiki, "myCanvas", ["by-state"]);
            // template's "by-state" no longer disabled; state wins.
            expect(disabled["by-state"]).toBeUndefined();
            expect(disabled["by-year"]).toBe(true);
            expect(disabled["by-month"]).toBe(true);
        });

        it("empty state tiddler means 'nothing disabled' (not 'use defaults')", function () {
            var wiki = setupWiki([{
                title: "$:/state/rimir/mindmap/myCanvas/axes-disabled",
                text: ""
            }]);
            var disabled = producer._readDisabledSet(wiki, "myCanvas", ["by-state"]);
            expect(Object.keys(disabled).length).toBe(0);
        });
    });

    // ---------------------------------------------------------------------
    // produce()
    // ---------------------------------------------------------------------

    describe("produce — guards", function () {
        it("emits an empty MDOM when no template arg is supplied", function () {
            var wiki = setupWiki([]);
            var mdom = producer.produce({}, wiki);
            expect(mdom.root.label).toBe("(no template)");
            expect(mdom.root.children).toEqual([]);
        });

        it("emits an empty MDOM when the template tiddler is missing", function () {
            var wiki = setupWiki([]);
            var mdom = producer.produce({ template: "Template/missing" }, wiki);
            expect(mdom.root.label).toContain("missing");
        });

        it("emits an empty MDOM when the template has no leaf-filter", function () {
            var wiki = setupWiki([{
                title: "Template/broken",
                "mm.chains": ""
            }]);
            var mdom = producer.produce({ template: "Template/broken" }, wiki);
            expect(mdom.root.label).toContain("no mm.leaf-filter");
        });
    });

    describe("produce — single chain", function () {
        it("collapses the chain root into the producer root", function () {
            var wiki = setupWiki(meetingFixtures());
            var mdom = producer.produce({ template: "Template/meetings-single", "canvas-id": "c1" }, wiki);
            // Root carries the template caption AND single-chain marker.
            expect(mdom.root.label).toBe("Meetings by time");
            expect(mdom.root.attrs["gt:single-chain"]).toBe(true);
            // Year groups directly under root: 2026 and 2025 (first-seen order).
            expect(mdom.root.children.length).toBe(2);
            expect(mdom.root.children[0].attrs["gt:axis-key"]).toBe("2026");
            expect(mdom.root.children[1].attrs["gt:axis-key"]).toBe("2025");
        });

        it("nests months inside years and lists leaves at the bottom", function () {
            var wiki = setupWiki(meetingFixtures());
            var mdom = producer.produce({ template: "Template/meetings-single", "canvas-id": "c1" }, wiki);
            var year2026 = mdom.root.children[0];
            // [tag[meeting]] returns titles alphabetically: feb-a, feb-b, jan,
            // last-year — so within 2026 month "02" is first-seen (via feb-a),
            // then "01" (via jan).
            expect(year2026.children.length).toBe(2);
            expect(year2026.children[0].attrs["gt:axis-key"]).toBe("02");
            expect(year2026.children[1].attrs["gt:axis-key"]).toBe("01");
            var feb = year2026.children[0];
            expect(feb.children.length).toBe(2);
            expect(feb.children[0].id).toBe("gt:leaf:meeting/feb-a@by-time");
            // Caption fallback to leaf segment
            expect(feb.children[0].label).toBe("feb-a");
            // Caption preferred when present
            expect(feb.children[1].label).toBe("Sprint review");
            expect(feb.children[1].attrs["core:tiddler"]).toBe("meeting/feb-b");
        });
    });

    describe("produce — multi chain", function () {
        it("builds a separate sub-tree per chain", function () {
            var wiki = setupWiki(meetingFixtures());
            var mdom = producer.produce({ template: "Template/meetings", "canvas-id": "c1" }, wiki);
            expect(mdom.root.label).toBe("Meetings");
            expect(mdom.root.attrs["gt:single-chain"]).toBeUndefined();
            expect(mdom.root.children.length).toBe(2);
            expect(mdom.root.children[0].id).toBe("gt:chain:by-time");
            expect(mdom.root.children[1].id).toBe("gt:chain:by-state");
        });

        it("each chain sees the same leaves with distinct occurrence ids", function () {
            var wiki = setupWiki(meetingFixtures());
            var mdom = producer.produce({ template: "Template/meetings", "canvas-id": "c1" }, wiki);
            // Title-alphabetical leaf order: feb-a, feb-b, jan, last-year.
            // First feb-a populates year 2026 / month 02 in the by-time chain
            // and state "open" in the by-state chain.
            var time = mdom.root.children[0];
            var year2026 = time.children[0];
            var feb = year2026.children[0]; // month 02 first-seen
            var feba = feb.children[0];
            expect(feba.id).toBe("gt:leaf:meeting/feb-a@by-time");
            // Same leaf appears under by-state with a distinct occurrence id.
            var state = mdom.root.children[1];
            var open = state.children[0];
            expect(open.attrs["gt:axis-key"]).toBe("open");
            var febaAgain = open.children[0];
            expect(febaAgain.id).toBe("gt:leaf:meeting/feb-a@by-state");
            expect(febaAgain.attrs["core:tiddler"]).toBe("meeting/feb-a");
        });
    });

    describe("produce — disabled axes", function () {
        it("template's initially-disabled axis hides that level of the chain", function () {
            var fix = meetingFixtures();
            // Disable by-month: chain "by-time" should now group by year only.
            for (var i = 0; i < fix.length; i++) {
                if (fix[i].title === "Template/meetings-single") {
                    fix[i]["mm.initially-disabled-axes"] = "by-month";
                }
            }
            var wiki = setupWiki(fix);
            var mdom = producer.produce({ template: "Template/meetings-single", "canvas-id": "c1" }, wiki);
            // Year nodes hold leaves directly now (no month groups).
            var year2026 = mdom.root.children[0];
            expect(year2026.attrs["gt:axis-key"]).toBe("2026");
            expect(year2026.children.length).toBe(3); // jan + feb-a + feb-b
            expect(year2026.children[0].attrs["core:tiddler"]).toBeDefined();
        });

        it("state tiddler override beats template defaults", function () {
            var fix = meetingFixtures();
            for (var i = 0; i < fix.length; i++) {
                if (fix[i].title === "Template/meetings-single") {
                    fix[i]["mm.initially-disabled-axes"] = "by-month";
                }
            }
            // State re-enables by-month by saying "nothing is disabled".
            fix.push({
                title: "$:/state/rimir/mindmap/c1/axes-disabled",
                text: ""
            });
            var wiki = setupWiki(fix);
            var mdom = producer.produce({ template: "Template/meetings-single", "canvas-id": "c1" }, wiki);
            // by-month is back: 2026 now has month groups
            var year2026 = mdom.root.children[0];
            expect(year2026.children[0].attrs["gt:axis-id"]).toBe("by-month");
        });

        it("disabling all axes in a chain flattens it to leaves directly", function () {
            var fix = meetingFixtures();
            fix.push({
                title: "$:/state/rimir/mindmap/c1/axes-disabled",
                text: "by-year by-month"
            });
            var wiki = setupWiki(fix);
            var mdom = producer.produce({ template: "Template/meetings-single", "canvas-id": "c1" }, wiki);
            // Single-chain: root IS the chain; with no axes, leaves hang off the root.
            expect(mdom.root.children.length).toBe(4);
            for (var i = 0; i < mdom.root.children.length; i++) {
                expect(mdom.root.children[i].attrs["core:tiddler"]).toBeDefined();
            }
        });
    });

    describe("produce — id uniqueness across ancestor paths", function () {
        it("encodes the full key path so duplicate keys under different ancestors don't collide", function () {
            // Fixture has 2026/02 and 2025/12. Add a 2025/02 leaf so "02"
            // appears under BOTH years — the two month-group nodes must have
            // distinct ids.
            var fix = meetingFixtures();
            fix.push({ title: "meeting/old-feb", tags: "meeting", year: "2025", month: "02", state: "closed" });
            var wiki = setupWiki(fix);
            var mdom = producer.produce({ template: "Template/meetings-single", "canvas-id": "c1" }, wiki);
            // Walk: root → year 2026 → month 02 (first-seen via feb-a)
            //                    → year 2025 → month 02 (via old-feb)
            // Need to handle ordering: first-seen year 2026 (via feb-a), then 2025 (via last-year/old-feb).
            var seen = {};
            function collect(n) {
                seen[n.id] = (seen[n.id] || 0) + 1;
                (n.children || []).forEach(collect);
            }
            collect(mdom.root);
            for (var id in seen) {
                expect(seen[id]).toBe(1);
            }
            // And the two "02" group ids should be different
            var year2026 = mdom.root.children[0];
            var year2025 = mdom.root.children[1];
            var feb2026 = year2026.children[0];
            var feb2025 = year2025.children[0]; // for 2025 first-seen is old-feb (alphabetical: "meeting/old-feb" comes before "meeting/last-year"? actually "l" < "o", so last-year first → month "12" first)
            // Just confirm: both years have an "02" node somewhere AND they differ.
            function findKey(parent, key) {
                for (var i = 0; i < parent.children.length; i++) {
                    if (parent.children[i].attrs && parent.children[i].attrs["gt:axis-key"] === key) {
                        return parent.children[i];
                    }
                }
                return null;
            }
            var feb26 = findKey(year2026, "02");
            var feb25 = findKey(year2025, "02");
            expect(feb26).not.toBeNull();
            expect(feb25).not.toBeNull();
            expect(feb26.id).not.toBe(feb25.id);
            expect(feb26.attrs["gt:key-path"]).toBe("2026|02");
            expect(feb25.attrs["gt:key-path"]).toBe("2025|02");
        });
    });

    describe("titleForOp / titleFromId", function () {
        it("recovers the tiddler title from a leaf occurrence id", function () {
            expect(producer._titleFromId("gt:leaf:meeting/jan@by-time"))
                .toBe("meeting/jan");
        });

        it("handles titles that contain @ by splitting on the LAST one", function () {
            // Chain suffix is always after the last @ since chain-ids are simple.
            expect(producer._titleFromId("gt:leaf:foo@bar@chain1")).toBe("foo@bar");
        });

        it("returns null for synthetic group/chain/root ids", function () {
            expect(producer._titleFromId("gt:axis:by-time:2026")).toBe(null);
            expect(producer._titleFromId("gt:chain:by-time")).toBe(null);
            expect(producer._titleFromId("gt:__root__")).toBe(null);
            expect(producer._titleFromId("gt:__empty__")).toBe(null);
        });

        it("titleForOp dispatches to titleFromId", function () {
            expect(producer.titleForOp({ op: "rename", id: "gt:leaf:meeting/jan@by-time" }))
                .toBe("meeting/jan");
            expect(producer.titleForOp({ op: "rename", id: "gt:axis:by-time:2026" }))
                .toBe(null);
            expect(producer.titleForOp(null)).toBe(null);
        });
    });

    describe("produce — chain-level leaf-filter", function () {
        function setupMixedFixtures() {
            return [
                { title: "Axis/by-status",
                  "mm.axis-id": "by-status",
                  "mm.axis-field": "status" },
                { title: "Chain/meetings-only",
                  "mm.chain-id": "meetings",
                  "mm.chain-caption": "Meetings",
                  "mm.leaf-filter": "[get[rrt.type]match[meeting]]",
                  "mm.axes": "[[Axis/by-status]]" },
                { title: "Chain/tasks-only",
                  "mm.chain-id": "tasks",
                  "mm.chain-caption": "Tasks",
                  "mm.leaf-filter": "[get[rrt.type]match[task]]",
                  "mm.axes": "[[Axis/by-status]]" },
                { title: "Template/mixed",
                  "mm.template-caption": "Mixed",
                  "mm.leaf-filter": "[tag[mixed]]",
                  "mm.chains": "[[Chain/meetings-only]] [[Chain/tasks-only]]" },
                { title: "m1", tags: "mixed", "rrt.type": "meeting", status: "open" },
                { title: "m2", tags: "mixed", "rrt.type": "meeting", status: "closed" },
                { title: "t1", tags: "mixed", "rrt.type": "task", status: "next" },
                { title: "t2", tags: "mixed", "rrt.type": "task", status: "next" },
                { title: "n1", tags: "mixed", "rrt.type": "note", "note-type": "streams" }
            ];
        }

        it("each chain only sees leaves passing its mm.leaf-filter", function () {
            var wiki = setupWiki(setupMixedFixtures());
            var mdom = producer.produce({ template: "Template/mixed", "canvas-id": "c1" }, wiki);
            // Two chains
            expect(mdom.root.children.length).toBe(2);
            var meetingsChain = mdom.root.children[0];
            var tasksChain = mdom.root.children[1];
            // Meetings chain: only m1+m2 reach axes → status open, closed
            expect(meetingsChain.children.length).toBe(2);
            // Tasks chain: only t1+t2 → status next (1 group, 2 leaves)
            expect(tasksChain.children.length).toBe(1);
            expect(tasksChain.children[0].attrs["gt:axis-key"]).toBe("next");
            expect(tasksChain.children[0].children.length).toBe(2);
            // Notes (n1) appear in neither chain — both filter them out.
        });

        it("chain leaf-filter is applied BEFORE axis leaf-filters", function () {
            var wiki = setupWiki(setupMixedFixtures());
            var mdom = producer.produce({ template: "Template/mixed", "canvas-id": "c1" }, wiki);
            // Verify no task title appears under the meetings chain.
            var meetingsChain = mdom.root.children[0];
            function collectLeaves(n, out) {
                if (n.attrs && n.attrs["core:tiddler"]) { out.push(n.attrs["core:tiddler"]); }
                (n.children || []).forEach(function (c) { collectLeaves(c, out); });
            }
            var meetingTitles = [];
            collectLeaves(meetingsChain, meetingTitles);
            expect(meetingTitles).toEqual(jasmine.arrayWithExactContents(["m1", "m2"]));
        });
    });

    describe("produce — chain-level leaf-sort", function () {
        function setupDatedFixtures(chainExtra) {
            chainExtra = chainExtra || {};
            return [
                { title: "Axis/by-status",
                  "mm.axis-id": "by-status",
                  "mm.axis-field": "status" },
                Object.assign({
                    title: "Chain/meetings",
                    "mm.chain-id": "meetings",
                    "mm.chain-caption": "Meetings",
                    "mm.leaf-filter": "[get[rrt.type]match[meeting]]",
                    "mm.axes": "[[Axis/by-status]]"
                }, chainExtra),
                { title: "Template/meetings",
                  "mm.template-caption": "Meetings",
                  "mm.leaf-filter": "[tag[meeting]]",
                  "mm.chains": "[[Chain/meetings]]" },
                // Title-alphabetical order: m-a, m-b, m-c (default leaf order
                // from wiki.filterTiddlers). Their datetimes are intentionally
                // anti-correlated so sort-by-datetime gives a different order.
                { title: "m-a", tags: "meeting", "rrt.type": "meeting", status: "open", datetime: "20260301000000000" },
                { title: "m-b", tags: "meeting", "rrt.type": "meeting", status: "open", datetime: "20260101000000000" },
                { title: "m-c", tags: "meeting", "rrt.type": "meeting", status: "open", datetime: "20260201000000000" }
            ];
        }

        function leafTitlesUnder(node) {
            var out = [];
            (function walk(n) {
                if (n.attrs && n.attrs["core:tiddler"]) { out.push(n.attrs["core:tiddler"]); }
                (n.children || []).forEach(walk);
            })(node);
            return out;
        }

        it("with no leaf-sort, leaves are in input (title-alphabetical) order", function () {
            var wiki = setupWiki(setupDatedFixtures());
            var mdom = producer.produce({ template: "Template/meetings", "canvas-id": "c1" }, wiki);
            // Single-chain collapse → mdom.root IS the chain. One status group: "open".
            var statusGroup = mdom.root.children[0];
            expect(leafTitlesUnder(statusGroup)).toEqual(["m-a", "m-b", "m-c"]);
        });

        it("nsort by datetime ascending reorders leaves inside the bucket", function () {
            // datetime asc → m-b (Jan), m-c (Feb), m-a (Mar).
            var wiki = setupWiki(setupDatedFixtures({ "mm.leaf-sort": "[nsort[datetime]]" }));
            var mdom = producer.produce({ template: "Template/meetings", "canvas-id": "c1" }, wiki);
            var statusGroup = mdom.root.children[0];
            expect(leafTitlesUnder(statusGroup)).toEqual(["m-b", "m-c", "m-a"]);
        });

        it("nsort + reverse[] gives newest-first (the meetings use case)", function () {
            var wiki = setupWiki(setupDatedFixtures({ "mm.leaf-sort": "[nsort[datetime]reverse[]]" }));
            var mdom = producer.produce({ template: "Template/meetings", "canvas-id": "c1" }, wiki);
            var statusGroup = mdom.root.children[0];
            expect(leafTitlesUnder(statusGroup)).toEqual(["m-a", "m-c", "m-b"]);
        });

        it("preserves the sort across multiple axis buckets", function () {
            // Mixed statuses so a date-sort affects both groups.
            var fix = setupDatedFixtures({ "mm.leaf-sort": "[nsort[datetime]reverse[]]" });
            // Override status to split into two groups: m-a/m-b open, m-c closed.
            for (var i = 0; i < fix.length; i++) {
                if (fix[i].title === "m-c") { fix[i].status = "closed"; }
            }
            var wiki = setupWiki(fix);
            var mdom = producer.produce({ template: "Template/meetings", "canvas-id": "c1" }, wiki);
            // Groups (first-seen by status): m-a → "open", m-b → "open" (already exists),
            // m-c → "closed". But the SORT runs FIRST: leaves are m-a, m-c, m-b
            // (Mar, Feb, Jan desc). So group order: open (m-a) then closed (m-c) then back to open (m-b).
            // Actually groupBy preserves first-seen keys: m-a→open (new), m-c→closed (new), m-b→open (existing).
            // → 2 groups in order [open, closed].
            expect(mdom.root.children.length).toBe(2);
            expect(mdom.root.children[0].attrs["gt:axis-key"]).toBe("open");
            expect(leafTitlesUnder(mdom.root.children[0])).toEqual(["m-a", "m-b"]);
            expect(mdom.root.children[1].attrs["gt:axis-key"]).toBe("closed");
            expect(leafTitlesUnder(mdom.root.children[1])).toEqual(["m-c"]);
        });

        it("blanks-last pattern: [has[field]nsort[field]] [!has[field]]", function () {
            var fix = [
                { title: "Axis/all", "mm.axis-id": "all", "mm.axis-field": "kind" },
                { title: "Chain/tasks", "mm.chain-id": "tasks", "mm.chain-caption": "Tasks",
                  "mm.axes": "[[Axis/all]]",
                  // Sort by due-date asc; tasks without due-date end up at the end.
                  "mm.leaf-sort": "[has[due-date]nsort[due-date]] [!has[due-date]]" },
                { title: "Template/tasks", "mm.template-caption": "Tasks",
                  "mm.leaf-filter": "[tag[task]]",
                  "mm.chains": "[[Chain/tasks]]" },
                { title: "t-future", tags: "task", kind: "open", "due-date": "20260601" },
                { title: "t-soon", tags: "task", kind: "open", "due-date": "20260201" },
                { title: "t-none", tags: "task", kind: "open" }
            ];
            var wiki = setupWiki(fix);
            var mdom = producer.produce({ template: "Template/tasks", "canvas-id": "c1" }, wiki);
            // Single-chain → root IS the chain. One kind group: "open".
            var group = mdom.root.children[0];
            expect(leafTitlesUnder(group)).toEqual(["t-soon", "t-future", "t-none"]);
        });

        it("dropped leaves are appended in input order (fail-safe)", function () {
            // Sort filter only emits m-a → m-b and m-c should be appended at end
            // in their input-relative order.
            var wiki = setupWiki(setupDatedFixtures({ "mm.leaf-sort": "[title[m-a]]" }));
            var mdom = producer.produce({ template: "Template/meetings", "canvas-id": "c1" }, wiki);
            var statusGroup = mdom.root.children[0];
            expect(leafTitlesUnder(statusGroup)).toEqual(["m-a", "m-b", "m-c"]);
        });

        it("empty sort result with non-empty input keeps input order (fail-safe)", function () {
            // Filter yielding nothing — typo or impossible predicate. Producer
            // shouldn't drop all leaves; it should keep the original order.
            var wiki = setupWiki(setupDatedFixtures({ "mm.leaf-sort": "[title[nonexistent]]" }));
            var mdom = producer.produce({ template: "Template/meetings", "canvas-id": "c1" }, wiki);
            var statusGroup = mdom.root.children[0];
            expect(leafTitlesUnder(statusGroup)).toEqual(["m-a", "m-b", "m-c"]);
        });

        it("synthesized titles outside the input set are ignored", function () {
            // A buggy filter that adds tiddler titles via [[...]] — we must
            // not let those leak into the tree. Only leaves that ALSO survive
            // the leaf-filter (i.e. were in the input set) reach buckets.
            var wiki = setupWiki(setupDatedFixtures({
                "mm.leaf-sort": "[[invented]] [[m-a]] [[m-c]] [[m-b]]"
            }));
            var mdom = producer.produce({ template: "Template/meetings", "canvas-id": "c1" }, wiki);
            var statusGroup = mdom.root.children[0];
            expect(leafTitlesUnder(statusGroup)).toEqual(["m-a", "m-c", "m-b"]);
        });
    });

    describe("produce — chain-hide-when-empty", function () {
        function hideFixtures(opts) {
            opts = opts || {};
            var topicsChain = { title: "Chain/topics",
                  "mm.chain-id": "topics",
                  "mm.chain-caption": "Topics",
                  "mm.leaf-filter": "[get[rrt.type]match[shared-topic]]",
                  "mm.axes": "[[Axis/by-status]]" };
            if (opts.hide) { topicsChain["mm.chain-hide-when-empty"] = "yes"; }
            return [
                { title: "Axis/by-status",
                  "mm.axis-id": "by-status",
                  "mm.axis-field": "status" },
                { title: "Chain/meetings-only",
                  "mm.chain-id": "meetings",
                  "mm.chain-caption": "Meetings",
                  "mm.leaf-filter": "[get[rrt.type]match[meeting]]",
                  "mm.axes": "[[Axis/by-status]]" },
                topicsChain,
                { title: "Template/mixed",
                  "mm.template-caption": "Mixed",
                  "mm.leaf-filter": "[tag[mixed]]",
                  "mm.chains": "[[Chain/meetings-only]] [[Chain/topics]]" },
                { title: "m1", tags: "mixed", "rrt.type": "meeting", status: "open" }
                // no shared-topic — topics chain will be empty
            ];
        }

        it("opt-out (default): empty chain renders with zero leaves", function () {
            var wiki = setupWiki(hideFixtures({ hide: false }));
            var mdom = producer.produce({ template: "Template/mixed", "canvas-id": "c1" }, wiki);
            // Both chains present; topics chain empty
            expect(mdom.root.children.length).toBe(2);
            var topicsChain = mdom.root.children[1];
            expect(topicsChain.attrs["gt:chain-id"]).toBe("topics");
            expect(topicsChain.children.length).toBe(0);
        });

        it("opt-in: empty chain omitted from rendered tree", function () {
            var wiki = setupWiki(hideFixtures({ hide: true }));
            var mdom = producer.produce({ template: "Template/mixed", "canvas-id": "c1" }, wiki);
            // Only meetings chain renders; topics omitted entirely
            expect(mdom.root.children.length).toBe(1);
            expect(mdom.root.children[0].attrs["gt:chain-id"]).toBe("meetings");
        });

        it("opt-in: non-empty chain still renders", function () {
            var fix = hideFixtures({ hide: true });
            fix.push({ title: "topic1", tags: "mixed", "rrt.type": "shared-topic", status: "open" });
            var wiki = setupWiki(fix);
            var mdom = producer.produce({ template: "Template/mixed", "canvas-id": "c1" }, wiki);
            expect(mdom.root.children.length).toBe(2);
            expect(mdom.root.children[1].attrs["gt:chain-id"]).toBe("topics");
        });

        it("opt-in: when all chains are empty, single-chain collapse does not crash", function () {
            // Template has two chains; one opts in to hide-when-empty, the
            // other is the only one with leaves — final children count should
            // still drop to one without breaking the multi-chain root.
            var fix = hideFixtures({ hide: true });
            // remove the meeting → both chains would be empty
            fix = fix.filter(function (t) { return t.title !== "m1"; });
            var wiki = setupWiki(fix);
            var mdom = producer.produce({ template: "Template/mixed", "canvas-id": "c1" }, wiki);
            // meetings chain still renders (opted out), topics omitted
            expect(mdom.root.children.length).toBe(1);
            expect(mdom.root.children[0].attrs["gt:chain-id"]).toBe("meetings");
        });
    });

    describe("produce — leaf counts on synthetic nodes", function () {
        it("emits gt:leaf-count attribute on chain root and group nodes when mm.show-counts is yes", function () {
            var fix = meetingFixtures();
            for (var i = 0; i < fix.length; i++) {
                if (fix[i].title === "Template/meetings-single") {
                    fix[i]["mm.show-counts"] = "yes";
                }
            }
            var wiki = setupWiki(fix);
            var mdom = producer.produce({ template: "Template/meetings-single", "canvas-id": "c1" }, wiki);
            // Label stays clean; count moved to attrs.
            expect(mdom.root.label).toBe("Meetings by time");
            expect(mdom.root.attrs["gt:leaf-count"]).toBe(4);
            var year2026 = mdom.root.children[0];
            expect(year2026.label).toBe("2026");
            expect(year2026.attrs["gt:leaf-count"]).toBe(3);
        });

        it("omits gt:leaf-count when mm.show-counts is not set", function () {
            var wiki = setupWiki(meetingFixtures());
            var mdom = producer.produce({ template: "Template/meetings-single", "canvas-id": "c1" }, wiki);
            expect(mdom.root.attrs["gt:leaf-count"]).toBeUndefined();
            expect(mdom.root.children[0].attrs["gt:leaf-count"]).toBeUndefined();
        });
    });

    describe("previewKindForId", function () {
        it("returns null for empty / non-string / foreign-namespace ids", function () {
            expect(producer.previewKindForId(null)).toBeNull();
            expect(producer.previewKindForId("")).toBeNull();
            expect(producer.previewKindForId(42)).toBeNull();
            expect(producer.previewKindForId("kt:knowledge/llm/foo")).toBeNull();
        });

        it("classifies chain roots", function () {
            var pk = producer.previewKindForId("gt:chain:notes");
            expect(pk.kind).toBe("chain");
            expect(pk.chainId).toBe("notes");
        });

        it("classifies axis nodes and exposes chainId + key path", function () {
            var pk = producer.previewKindForId("gt:axis:by-time:2026|02");
            expect(pk.kind).toBe("axis");
            expect(pk.chainId).toBe("by-time");
            expect(pk.keyPath).toBe("2026|02");
            // The deepest path segment is the axis-key the user sees.
            expect(pk.axisKey).toBe("02");
        });

        it("returns null for leaf ids (they have a backing tiddler instead)", function () {
            expect(producer.previewKindForId("gt:leaf:meeting/jan@by-time")).toBeNull();
        });

        it("returns null for the synthetic empty / root markers", function () {
            // __root__ / __empty__ are not chains — they don't carry a chainId
            // and shouldn't claim to be classifiable as a kind.
            expect(producer.previewKindForId("gt:__root__")).toBeNull();
            expect(producer.previewKindForId("gt:__empty__")).toBeNull();
        });
    });

    describe("produce — root-label override", function () {
        it("respects args.root-label, replacing the template caption", function () {
            var wiki = setupWiki(meetingFixtures());
            var mdom = producer.produce({
                template: "Template/meetings-single",
                "canvas-id": "c1",
                "root-label": "ACME Project"
            }, wiki);
            expect(mdom.root.label).toBe("ACME Project");
        });

        it("falls back to the template caption when root-label is empty or unset", function () {
            var wiki = setupWiki(meetingFixtures());
            // Unset.
            var mdom1 = producer.produce({ template: "Template/meetings-single", "canvas-id": "c1" }, wiki);
            expect(mdom1.root.label).toBe("Meetings by time");
            // Empty string — treated as no override.
            var mdom2 = producer.produce({
                template: "Template/meetings-single",
                "canvas-id": "c1",
                "root-label": ""
            }, wiki);
            expect(mdom2.root.label).toBe("Meetings by time");
        });

        it("applies to multi-chain root as well", function () {
            var wiki = setupWiki(meetingFixtures());
            var mdom = producer.produce({
                template: "Template/meetings",
                "canvas-id": "c1",
                "root-label": "Custom Root"
            }, wiki);
            expect(mdom.root.label).toBe("Custom Root");
            expect(mdom.root.children.length).toBe(2);
        });
    });

    describe("produce — initially-collapsed config", function () {
        it("marks group nodes of named axes as core:collapsed", function () {
            var fix = meetingFixtures();
            for (var i = 0; i < fix.length; i++) {
                if (fix[i].title === "Template/meetings-single") {
                    fix[i]["mm.initially-collapsed-axes"] = "by-month";
                }
            }
            var wiki = setupWiki(fix);
            var mdom = producer.produce({ template: "Template/meetings-single", "canvas-id": "c1" }, wiki);
            // Year groups are NOT marked (not in list)
            var year2026 = mdom.root.children[0];
            expect(year2026.attrs["core:collapsed"]).toBeUndefined();
            // Month groups ARE marked
            var feb = year2026.children[0];
            expect(feb.attrs["gt:axis-id"]).toBe("by-month");
            expect(feb.attrs["core:collapsed"]).toBe(true);
        });

        it("marks chain roots as collapsed when listed in initially-collapsed-chains", function () {
            var fix = meetingFixtures();
            for (var i = 0; i < fix.length; i++) {
                if (fix[i].title === "Template/meetings") {
                    fix[i]["mm.initially-collapsed-chains"] = "by-state";
                }
            }
            var wiki = setupWiki(fix);
            var mdom = producer.produce({ template: "Template/meetings", "canvas-id": "c1" }, wiki);
            // by-time chain NOT collapsed
            expect(mdom.root.children[0].attrs["core:collapsed"]).toBeUndefined();
            // by-state chain IS collapsed
            expect(mdom.root.children[1].attrs["gt:chain-id"]).toBe("by-state");
            expect(mdom.root.children[1].attrs["core:collapsed"]).toBe(true);
        });
    });

    describe("lib.sortGroups", function () {
        function mkEntries(keys) {
            return keys.map(function (k) { return { kind: "group", key: k }; });
        }

        it("first-seen (default) preserves input order", function () {
            var e = mkEntries(["b", "a", "c"]);
            lib.sortGroups(e, { sort: "first-seen" });
            expect(e.map(function (x) { return x.key; })).toEqual(["b", "a", "c"]);
        });

        it("asc sorts alphabetically", function () {
            var e = mkEntries(["b", "a", "c"]);
            lib.sortGroups(e, { sort: "asc" });
            expect(e.map(function (x) { return x.key; })).toEqual(["a", "b", "c"]);
        });

        it("desc sorts reverse-alphabetically (e.g. years newest first)", function () {
            var e = mkEntries(["2024", "2026", "2025"]);
            lib.sortGroups(e, { sort: "desc" });
            expect(e.map(function (x) { return x.key; })).toEqual(["2026", "2025", "2024"]);
        });

        it("enum orders by sortKeys; un-listed appear after, alpha", function () {
            var e = mkEntries(["finished", "planned", "z-unknown", "active"]);
            lib.sortGroups(e, {
                sort: "enum",
                sortKeys: ["planned", "active", "finished"]
            });
            expect(e.map(function (x) { return x.key; })).toEqual(["planned", "active", "finished", "z-unknown"]);
        });
    });

    describe("produce — sub-chains (nested parent)", function () {
        function nestedFixtures() {
            return [
                { title: "Axis/by-year",
                  "mm.axis-id": "by-year",
                  "mm.axis-derive": "[get[datetime]format:date[YYYY]]" },
                { title: "Axis/by-status",
                  "mm.axis-id": "by-status",
                  "mm.axis-field": "status" },
                { title: "Chain/m-by-date",
                  "mm.chain-id": "m-by-date",
                  "mm.chain-caption": "By date",
                  "mm.axes": "[[Axis/by-year]]" },
                { title: "Chain/m-by-state",
                  "mm.chain-id": "m-by-state",
                  "mm.chain-caption": "By state",
                  "mm.axes": "[[Axis/by-status]]" },
                { title: "Chain/meetings",
                  "mm.chain-id": "meetings",
                  "mm.chain-caption": "Meetings",
                  "mm.leaf-filter": "[get[rrt.type]match[meeting]]",
                  "mm.sub-chains": "[[Chain/m-by-date]] [[Chain/m-by-state]]" },
                { title: "Template/nested",
                  "mm.template-caption": "Nested",
                  "mm.leaf-filter": "[tag[m]]",
                  "mm.chains": "[[Chain/meetings]]" },
                { title: "m1", tags: "m", "rrt.type": "meeting", datetime: "20260513120000000", status: "planned" },
                { title: "m2", tags: "m", "rrt.type": "meeting", datetime: "20250513120000000", status: "active" }
            ];
        }

        it("renders sub-chains as children of the parent chain", function () {
            var wiki = setupWiki(nestedFixtures());
            var mdom = producer.produce({ template: "Template/nested", "canvas-id": "c1" }, wiki);
            // Single-chain template collapses root into the only chain ("Meetings")
            expect(mdom.root.attrs["gt:chain-id"]).toBe("meetings");
            expect(mdom.root.label).toBe("Nested");
            // Two children = two sub-chains
            expect(mdom.root.children.length).toBe(2);
            expect(mdom.root.children[0].attrs["gt:chain-id"]).toBe("m-by-date");
            expect(mdom.root.children[1].attrs["gt:chain-id"]).toBe("m-by-state");
        });

        it("cascades the parent's leaf-filter into every sub-chain", function () {
            var fix = nestedFixtures();
            // Add a non-meeting leaf — should be filtered out by parent chain.
            fix.push({ title: "t1", tags: "m", "rrt.type": "task", status: "next" });
            var wiki = setupWiki(fix);
            var mdom = producer.produce({ template: "Template/nested", "canvas-id": "c1" }, wiki);
            function collectLeafTitles(n, out) {
                if (n.attrs && n.attrs["core:tiddler"]) { out.push(n.attrs["core:tiddler"]); }
                (n.children || []).forEach(function (c) { collectLeafTitles(c, out); });
            }
            var byDate = mdom.root.children[0];
            var titlesUnderDate = [];
            collectLeafTitles(byDate, titlesUnderDate);
            // No task ever appears under the meetings parent's sub-chains.
            expect(titlesUnderDate).toEqual(jasmine.arrayWithExactContents(["m1", "m2"]));
        });
    });

    describe("produce — axis sorting", function () {
        function statusFixtures() {
            return [
                { title: "Axis/by-status",
                  "mm.axis-id": "by-status",
                  "mm.axis-field": "status",
                  "mm.axis-sort": "enum",
                  "mm.axis-sort-keys": "planned active finished" },
                { title: "Chain/states",
                  "mm.chain-id": "states",
                  "mm.axes": "[[Axis/by-status]]" },
                { title: "Template/states",
                  "mm.template-caption": "S",
                  "mm.leaf-filter": "[tag[m]]",
                  "mm.chains": "[[Chain/states]]" },
                { title: "a", tags: "m", status: "finished" },
                { title: "b", tags: "m", status: "active" },
                { title: "c", tags: "m", status: "planned" }
            ];
        }

        it("enum sort orders groups by axis-sort-keys regardless of input order", function () {
            var wiki = setupWiki(statusFixtures());
            var mdom = producer.produce({ template: "Template/states", "canvas-id": "c1" }, wiki);
            // alphabetical leaf order is a,b,c → status finished,active,planned;
            // first-seen would give that order. enum should give planned, active, finished.
            expect(mdom.root.children.map(function (g) { return g.attrs["gt:axis-key"]; }))
                .toEqual(["planned", "active", "finished"]);
        });
    });

    describe("produce — filter-style label-template", function () {
        it("evaluates a leading-[ template as a TW filter with <key> bound", function () {
            var fix = [
                { title: "Axis/code",
                  "mm.axis-id": "code",
                  "mm.axis-field": "code",
                  "mm.axis-label-template": "[<key>match[01]then[January]] ~[<key>match[02]then[February]] ~[<key>]" },
                { title: "Chain/x",
                  "mm.chain-id": "x",
                  "mm.axes": "[[Axis/code]]" },
                { title: "Template/x",
                  "mm.template-caption": "X",
                  "mm.leaf-filter": "[tag[c]]",
                  "mm.chains": "[[Chain/x]]" },
                { title: "a", tags: "c", code: "01" },
                { title: "b", tags: "c", code: "02" },
                { title: "z", tags: "c", code: "99" }
            ];
            var wiki = setupWiki(fix);
            var mdom = producer.produce({ template: "Template/x", "canvas-id": "c1" }, wiki);
            var labels = {};
            for (var i = 0; i < mdom.root.children.length; i++) {
                var n = mdom.root.children[i];
                labels[n.attrs["gt:axis-key"]] = n.label;
            }
            expect(labels["01"]).toBe("January");
            expect(labels["02"]).toBe("February");
            // Fallback to raw key when filter yields nothing else
            expect(labels["99"]).toBe("99");
        });
    });

    describe("produce — derived keys + label templates", function () {
        it("uses mm.axis-derive to compute the key from a filter", function () {
            var tiddlers = [
                { title: "Axis/year-from-date",
                  "mm.axis-id": "year-from-date",
                  "mm.axis-derive": "[get[date]split[-]first[]]",
                  "mm.axis-label-template": "Year <<key>>" },
                { title: "Chain/timeline",
                  "mm.chain-id": "timeline",
                  "mm.axes": "[[Axis/year-from-date]]" },
                { title: "Template/dated",
                  "mm.template-caption": "Dated",
                  "mm.leaf-filter": "[tag[dated]]",
                  "mm.chains": "[[Chain/timeline]]" },
                { title: "x", tags: "dated", date: "2026-05-13" },
                { title: "y", tags: "dated", date: "2025-12-01" }
            ];
            var wiki = setupWiki(tiddlers);
            var mdom = producer.produce({ template: "Template/dated", "canvas-id": "c1" }, wiki);
            expect(mdom.root.children.length).toBe(2);
            expect(mdom.root.children[0].attrs["gt:axis-key"]).toBe("2026");
            expect(mdom.root.children[0].label).toBe("Year 2026");
        });
    });
});
