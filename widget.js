/*\
title: $:/plugins/rimir/mindmap/widget.js
type: application/javascript
module-type: widget

The $mindmap widget. Coordinates four collaborators:

  - producer modules (module-type: mindmap-producer) → base MDOM from wiki
  - compose.js                                       → base + overlay → composite MDOM
  - overlay-store.js                                 → persistent op log per view
  - engine adapters (module-type: mindmapengine)     → actual rendering

Engine selection precedence:
  widget engine= attr  >  view tiddler mm.engine  >
  $:/config/rimir/mindmap/default-engine          >  first registered

\*/

"use strict";

var Widget = require("$:/core/modules/widgets/widget.js").widget;
var composer = require("$:/plugins/rimir/mindmap/compose.js");
var overlayStore = require("$:/plugins/rimir/mindmap/overlay-store.js");
var router = require("$:/plugins/rimir/mindmap/structural-ops.js");

var ENGINE_CONFIG_TIDDLER = "$:/config/rimir/mindmap/default-engine";
var CASCADE_THRESHOLD_TIDDLER = "$:/config/rimir/mindmap/structural/cascade-threshold";
// Global state tiddlers driving the cascade-confirm modal. Only one cascade
// can be pending at a time (modal is exclusive); widget key inside the JSON
// payload disambiguates which widget triggered it.
var CASCADE_PENDING_TIDDLER = "$:/state/rimir/mindmap/pending-cascade";
var CASCADE_APPLY_TIDDLER = "$:/state/rimir/mindmap/pending-cascade-apply";

function getEngines() {
    return $tw.modules.getModulesByTypeAsHashmap("mindmapengine");
}

function getProducers() {
    return $tw.modules.getModulesByTypeAsHashmap("mindmap-producer");
}

function findEngineByName(name) {
    if (!name) { return null; }
    var engines = getEngines();
    for (var key in engines) {
        if (engines[key] && engines[key].name === name) { return engines[key]; }
    }
    return null;
}

function findProducerByName(name) {
    if (!name) { return null; }
    var producers = getProducers();
    for (var key in producers) {
        if (producers[key] && producers[key].name === name) { return producers[key]; }
    }
    return null;
}

// Trim is mandatory: .tid config tiddlers carry trailing newlines.
function trim(s) { return (s || "").replace(/^\s+|\s+$/g, ""); }

function MindmapWidget(parseTreeNode, options) {
    this.initialise(parseTreeNode, options);
}

MindmapWidget.prototype = new Widget();

MindmapWidget.prototype.render = function (parent, nextSibling) {
    this.parentDomNode = parent;
    this.computeAttributes();
    this.execute();

    this.containerNode = this.document.createElement("div");
    this.containerNode.className = "rr-mindmap" + (this.cssClass ? " " + this.cssClass : "");
    if (this.styleAttr) { this.containerNode.setAttribute("style", this.styleAttr); }
    if (this.heightAttr) {
        this.containerNode.style.height = /^\d+$/.test(this.heightAttr) ?
            this.heightAttr + "px" : this.heightAttr;
    }
    parent.insertBefore(this.containerNode, nextSibling);
    this.domNodes.push(this.containerNode);

    if (this.errorMessage) {
        this.renderError();
        return;
    }

    this.renderToolbar();
    // Layout: a horizontal flex row containing the canvas (mind-elixir host)
    // on the left and an optional preview pane on the right.
    this.mainArea = this.document.createElement("div");
    this.mainArea.className = "rr-mindmap-main";
    this.containerNode.appendChild(this.mainArea);

    this.canvasNode = this.document.createElement("div");
    this.canvasNode.className = "rr-mindmap-canvas";
    this.mainArea.appendChild(this.canvasNode);

    // Preview pane: empty until a node with a backing tiddler is selected.
    // Lives outside canvasNode so it doesn't go into fullscreen with the
    // engine (the canvas keeps the full screen for the map itself).
    this.previewPane = this.document.createElement("div");
    this.previewPane.className = "rr-mindmap-preview";
    this.previewPane.style.display = "none";
    this.mainArea.appendChild(this.previewPane);
    this.renderPreviewChildren();

    this.engineInstance = null;
    this.lastComposite = null;
    this.lastOrphans = [];

    try {
        var baseTriple = this.produceBase();
        if (!baseTriple) {
            this.errorMessage = "Producer returned no MDOM.";
            this.renderError();
            return;
        }
        this.lastBase = baseTriple.mdom;
        this.lastRefreshFilter = baseTriple.refreshFilter;
        this.lastWatchedTitles = this.evaluateWatched(this.lastRefreshFilter);

        this.store = overlayStore.createStore(this.wiki, this.overlayTitle);
        var ops = this.store.read();
        var composed = composer.compose(this.lastBase, ops);
        this.lastComposite = composed.mdom;
        this.lastOrphans = composed.orphans;

        // Engines are browser-only (canvas, DOM events, global keyboard listeners).
        // Server-side renders (--render, static-export) skip init — the client
        // will re-render and pick up the engine when the page loads.
        if ($tw.browser) {
            this.initEngine();
        }
        this.updateToolbar();
    } catch (e) {
        console.error("[$mindmap] render error", e);
        this.errorMessage = e && e.message ? e.message : String(e);
        this.renderError();
    }
};

// When opening the popup-edit-modal while mind-elixir is in fullscreen mode,
// the modal renders behind the fullscreen layer (per Fullscreen API spec).
// Auto-exit fullscreen so the modal is visible. Re-entering fullscreen after
// closing the modal is left to the user.
MindmapWidget.prototype.exitFullscreenIfInside = function () {
    if (typeof document === "undefined" || !document.fullscreenElement) { return; }
    var fsEl = document.fullscreenElement;
    if (fsEl === this.canvasNode || this.canvasNode.contains(fsEl)) {
        try { document.exitFullscreen(); } catch (e) { /* ignore */ }
    }
};

MindmapWidget.prototype.execute = function () {
    this.viewAttr = trim(this.getAttribute("view", ""));
    this.filterAttr = this.getAttribute("filter", "");
    this.engineAttr = trim(this.getAttribute("engine", ""));
    this.overlayAttr = trim(this.getAttribute("overlay", ""));
    this.cssClass = this.getAttribute("class", "");
    this.styleAttr = this.getAttribute("style", "");
    this.heightAttr = trim(this.getAttribute("height", ""));
    this.readonly = this.getAttribute("readonly", "") === "yes";
    this.stateAttr = trim(this.getAttribute("state", ""));
    this.onSelectActions = this.getAttribute("onSelectActions", "");

    this.errorMessage = null;
    this.producerName = null;
    this.producerArgs = {};
    this.engineName = null;
    this.overlayTitle = null;

    if (this.viewAttr && this.filterAttr) {
        this.errorMessage = "Set either view= or filter=, not both.";
        return;
    }

    if (this.viewAttr) {
        var view = this.wiki.getTiddler(this.viewAttr);
        if (!view) {
            this.errorMessage = "View tiddler not found: " + this.viewAttr;
            return;
        }
        var f = view.fields;
        this.producerName = trim(f["mm.producer"] || "");
        this.engineName = trim(f["mm.engine"] || "");
        this.overlayTitle = trim(f["mm.overlay"] || "");
        try {
            this.producerArgs = f["mm.args"] ? JSON.parse(f["mm.args"]) : {};
        } catch (e) {
            this.errorMessage = "Invalid JSON in mm.args of " + this.viewAttr;
            return;
        }
        try {
            this.engineOptions = f["mm.options"] ? JSON.parse(f["mm.options"]) : {};
        } catch (e2) {
            this.errorMessage = "Invalid JSON in mm.options of " + this.viewAttr;
            return;
        }
    } else if (this.filterAttr) {
        this.producerName = "filter-tree";
        this.producerArgs = { filter: this.filterAttr };
        this.overlayTitle = this.overlayAttr || null;
        this.engineOptions = {};
    } else {
        this.errorMessage = "Provide either view= or filter=.";
        return;
    }

    if (this.engineAttr) { this.engineName = this.engineAttr; }
    if (!this.engineName) {
        this.engineName = trim(this.wiki.getTiddlerText(ENGINE_CONFIG_TIDDLER, ""));
    }
    if (!this.engineName) {
        var engines = getEngines();
        for (var key in engines) {
            if (engines[key] && engines[key].name) {
                this.engineName = engines[key].name;
                break;
            }
        }
    }
    if (!this.engineName) {
        this.errorMessage = "No mindmap engine registered. Install an adapter plugin (e.g. rimir/mindmap-elixir).";
        return;
    }
    if (!this.producerName) {
        this.errorMessage = "View tiddler missing mm.producer field.";
        return;
    }
};

// Session-only state tiddler holding the currently-focused subtree's title.
// $:/state/ is not synced — losing it on reload is intentional.
MindmapWidget.prototype.focusStateTitle = function () {
    var key = this.stateAttr || this.viewAttr || this.filterAttr || "default";
    return "$:/state/rimir/mindmap/" + key + "/focus-title";
};

MindmapWidget.prototype.currentFocusTitle = function () {
    return trim(this.wiki.getTiddlerText(this.focusStateTitle(), ""));
};

MindmapWidget.prototype.produceBase = function () {
    var producer = findProducerByName(this.producerName);
    if (!producer || typeof producer.produce !== "function") {
        throw new Error("Unknown producer: " + this.producerName);
    }
    // Merge session focus into producer args. Done at produce-time so the
    // focus state can change without a refreshSelf — refresh() detects the
    // focus state tiddler in changedTiddlers and calls reproduce().
    var effectiveArgs = Object.assign({}, this.producerArgs);
    var focusTitle = this.currentFocusTitle();
    if (focusTitle) { effectiveArgs["focus-title"] = focusTitle; }
    var mdom = producer.produce(effectiveArgs, this.wiki, this);
    if (!mdom || !mdom.root) {
        throw new Error("Producer " + this.producerName + " returned invalid MDOM");
    }
    var refreshFilter = null;
    if (typeof producer.refreshFilter === "function") {
        try {
            refreshFilter = producer.refreshFilter(effectiveArgs);
        } catch (e) {
            refreshFilter = null;
        }
    }
    return { mdom: mdom, refreshFilter: refreshFilter };
};

MindmapWidget.prototype.evaluateWatched = function (filter) {
    if (!filter) { return null; }
    try {
        var titles = this.wiki.filterTiddlers(filter, this);
        var map = Object.create(null);
        for (var i = 0; i < titles.length; i++) { map[titles[i]] = true; }
        return map;
    } catch (e) {
        return null;
    }
};

MindmapWidget.prototype.initEngine = function () {
    var Engine = findEngineByName(this.engineName);
    if (!Engine) {
        throw new Error("Engine not found: " + this.engineName);
    }
    // Engines can export either a constructor (class with prototype) or a
    // bare object with methods. Normalise to an instance with the contract.
    var instance;
    if (typeof Engine === "function") {
        instance = new Engine(this.wiki);
    } else if (Engine.create && typeof Engine.create === "function") {
        instance = Engine.create(this.wiki);
    } else {
        instance = Engine;
    }
    this.engineInstance = instance;
    instance.init(this.canvasNode, this.lastComposite, this.engineOptions || {});
    // Append the actions panel INSIDE canvasNode so it goes fullscreen with
    // the engine. Done after engine.init since the engine clears canvasNode's
    // children at the top of its init().
    if (this.actionsPanel) {
        this.canvasNode.appendChild(this.actionsPanel);
    }
    // Inform the engine whether this producer is structural so it can decide
    // to intercept Tab/Enter for add-child / add-sibling popups.
    var producer = findProducerByName(this.producerName);
    var isStructural = !!(producer && producer.capabilities && producer.capabilities.structural);
    if (typeof instance.setStructural === "function") {
        instance.setStructural(isStructural);
    }
    if (typeof instance.on === "function") {
        var self = this;
        instance.on("op", function (op) { self.handleEngineOp(op); });
        instance.on("select", function (nodeId) { self.handleSelect(nodeId); });
    }
};

MindmapWidget.prototype.handleEngineOp = function (op) {
    if (this.readonly || !op) { return; }
    // Synthetic edit-request from the adapter's F2 intercept. Opens the
    // popup-edit-modal for the supplied node id (unlocked title).
    if (op.op === "requestEditNode") {
        this.selectedNodeId = op.id || this.selectedNodeId;
        this.handleEditSelected();
        return;
    }
    var producer = findProducerByName(this.producerName);
    var routing = router.routeOp(op, producer, {
        wiki: this.wiki,
        cascadeThreshold: this.cascadeThreshold()
    });
    switch (routing.mode) {
        case "structural":
            this.applyStructuralOp(op, producer);
            break;
        case "overlay":
            if (this.store) { this.store.append(op); }
            break;
        case "deferred":
            this.requestCascadeConfirm(op, routing.count);
            // Mind-elixir already applied the drag visually before emitting
            // the op. Snap visuals back to the unchanged base+overlay so the
            // canvas matches reality while the user decides at the modal.
            // If they Confirm, the structural apply will redraw normally;
            // if they Cancel, the canvas already shows the correct state.
            if (this.engineInstance && typeof this.engineInstance.update === "function" && this.lastComposite) {
                try { this.engineInstance.update(this.lastComposite); }
                catch (e) { /* engine race; refresh will catch up */ }
            }
            break;
        case "drop":
        default:
            // Malformed op; nothing to do.
            break;
    }
};

// Per-widget state tiddler holding the currently-selected node's tiddler
// title. The preview pane and any custom UI can read it.
MindmapWidget.prototype.previewStateTitle = function () {
    var key = this.stateAttr || this.viewAttr || this.filterAttr || "default";
    return "$:/state/rimir/mindmap/" + key + "/preview-title";
};

// Companion state tiddler driving inline-edit toggle for the preview pane.
MindmapWidget.prototype.previewEditStateTitle = function () {
    var key = this.stateAttr || this.viewAttr || this.filterAttr || "default";
    return "$:/state/rimir/mindmap/" + key + "/preview-edit-state";
};

// Render the preview pane content. Two modes driven by a state tiddler:
//   - VIEW: transcluded body, double-click to switch to edit
//   - EDIT: rr-text-editor with auto-focus; Ctrl-Enter or Escape exits
// Changes write directly to the tiddler's text field (no draft buffer), so
// exiting in either way just toggles the state — work is already saved.
MindmapWidget.prototype.renderPreviewChildren = function () {
    if (!this.previewPane) { return; }
    var wikitext =
        "<$set name='previewTitle' filter='[<__state__>get[text]]'>" +
        "<$list filter='[<previewTitle>!is[blank]is[tiddler]]' variable='_'>" +
        "<$let editState=<<__editstate__>>>" +
        "<div class='rr-mindmap-preview-header'>" +
        "<strong><$text text=<<previewTitle>>/></strong>" +
        "</div>" +
        "<div class='rr-mindmap-preview-body'>" +
        "<%if [<editState>get[text]match[yes]] %>" +
        "<$keyboard key='ctrl-Return' actions=\"<$action-setfield $tiddler=<<editState>> text=''/>\">" +
        "<$keyboard key='escape' actions=\"<$action-setfield $tiddler=<<editState>> text=''/>\">" +
        "<$let editTiddler=<<previewTitle>> wrapClass='rr-mindmap-preview-edit' editAutoFocus='yes'>" +
        "<$transclude $tiddler='$:/plugins/rimir/theme/rr-text-editor'/>" +
        "</$let>" +
        "</$keyboard>" +
        "</$keyboard>" +
        "<%else%>" +
        "<$let viewTiddler=<<previewTitle>>>" +
        "<$transclude $tiddler='$:/plugins/rimir/theme/rr-text-view-editable' $mode='block'/>" +
        "</$let>" +
        "<%endif%>" +
        "</div>" +
        "</$let>" +
        "</$list>" +
        "</$set>";
    var parser = this.wiki.parseText("text/vnd.tiddlywiki", wikitext, { parseAsInline: false });
    if (!parser) { return; }
    var widgetNode = this.wiki.makeWidget(parser, {
        parentWidget: this,
        document: this.document,
        variables: {
            __state__: this.previewStateTitle(),
            __editstate__: this.previewEditStateTitle()
        }
    });
    widgetNode.render(this.previewPane, null);
    this.previewWidget = widgetNode;
};

// Update the preview-state tiddler to reflect the currently-selected node's
// backing title. Empty string when no real tiddler is selected → preview pane
// content collapses to nothing (via $list filter), and the pane itself can
// hide via CSS.
MindmapWidget.prototype.updatePreviewState = function (nodeId) {
    var stateTitle = this.previewStateTitle();
    var producer = findProducerByName(this.producerName);
    var title = "";
    if (nodeId && producer && typeof producer.titleForOp === "function") {
        var t = producer.titleForOp({ op: "rename", id: nodeId });
        if (t && this.wiki.getTiddler(t)) { title = t; }
    }
    this.wiki.addTiddler(new $tw.Tiddler({
        title: stateTitle,
        text: title
    }));
    // Switching nodes always exits inline-edit mode (the active edit was on
    // the prior node; staying in edit mode would now point at a different
    // tiddler's text).
    this.wiki.addTiddler(new $tw.Tiddler({
        title: this.previewEditStateTitle(),
        text: ""
    }));
    if (this.previewPane) {
        this.previewPane.style.display = title ? "" : "none";
    }
};

// Create a `Draft of '<targetTitle>'` tiddler the way TW's navigator widget
// would, but without bubbling tm-edit-tiddler (which would also open the
// tiddler in the main story river). Idempotent — returns the existing draft
// if one already exists.
MindmapWidget.prototype.ensureDraft = function (targetTitle) {
    if (!targetTitle) { return null; }
    var existing = this.wiki.findDraft(targetTitle);
    if (existing) { return existing; }
    var draftTitle = this.wiki.generateDraftTitle(targetTitle);
    var target = this.wiki.getTiddler(targetTitle);
    var draft = new $tw.Tiddler(
        { text: "" },
        target,
        {
            title: draftTitle,
            "draft.title": targetTitle,
            "draft.of": targetTitle
        },
        this.wiki.getModificationFields()
    );
    this.wiki.addTiddler(draft);
    return draftTitle;
};

// Unique key identifying this widget's pending op in the global cascade state.
MindmapWidget.prototype.widgetKey = function () {
    return this.stateAttr || this.viewAttr || this.filterAttr || "default";
};

// Stash a pending cascade op into the global state tiddler so the modal can
// render its summary. The widget then watches CASCADE_APPLY_TIDDLER in
// refresh() for the user's OK click and re-runs the op via applyOps directly.
MindmapWidget.prototype.requestCascadeConfirm = function (op, count) {
    var producer = findProducerByName(this.producerName);
    var title = (producer && typeof producer.titleForOp === "function")
        ? producer.titleForOp(op) : (op && op.id) || "?";
    var verb = ({
        rename: "Rename",
        reparent: "Move",
        removeNode: "Delete"
    })[op.op] || op.op;
    var summary = verb + " \"" + title + "\"";
    // Clear any stale apply flag, then write the new pending op. We store the
    // op JSON in the `op` field (not `text`) and surface display values as
    // plain fields so the modal can read them with `get[field]` — `jsonget`
    // on the text field had silent-fail issues with the modal renderer.
    this.wiki.addTiddler(new $tw.Tiddler({
        title: CASCADE_APPLY_TIDDLER, text: ""
    }));
    this.wiki.addTiddler(new $tw.Tiddler({
        title: CASCADE_PENDING_TIDDLER,
        text: "yes",
        summary: summary,
        count: String(count),
        widgetKey: this.widgetKey(),
        op: JSON.stringify(op)
    }));
};

// When the user clicks Confirm in the modal, the CASCADE_APPLY_TIDDLER is set
// to "yes". Each widget checks this on refresh; whichever widget's key
// matches the JSON payload's widgetKey applies the op (bypassing the
// threshold check) and clears both state tiddlers.
MindmapWidget.prototype.maybeApplyPendingCascade = function () {
    var applyText = trim(this.wiki.getTiddlerText(CASCADE_APPLY_TIDDLER, ""));
    if (applyText !== "yes") { return; }
    var pendingTiddler = this.wiki.getTiddler(CASCADE_PENDING_TIDDLER);
    if (!pendingTiddler) { return; }
    var pendingFields = pendingTiddler.fields || {};
    if (trim(pendingFields.text || "") !== "yes") { return; }
    if (pendingFields.widgetKey !== this.widgetKey()) { return; }
    var op;
    try { op = JSON.parse(pendingFields.op || ""); } catch (e) { return; }
    if (!op) { return; }
    // Match — this widget owns the pending op. Apply via producer directly
    // so the threshold check (which would defer again) is bypassed.
    var producer = findProducerByName(this.producerName);
    if (!producer || typeof producer.applyOps !== "function") { return; }
    var self = this;
    this.applying = true;
    try {
        if (this.engineInstance && typeof this.engineInstance.setSuspendOps === "function") {
            this.engineInstance.setSuspendOps(true);
        }
        producer.applyOps([op], this.producerArgs, this.wiki);
    } catch (e) {
        console.error("[$mindmap] cascade apply failed", e);
    } finally {
        setTimeout(function () {
            self.applying = false;
            if (self.engineInstance && typeof self.engineInstance.setSuspendOps === "function") {
                self.engineInstance.setSuspendOps(false);
            }
        }, 0);
    }
    // Clear the state tiddlers (modal closes via $reveal when pending empties).
    this.wiki.addTiddler(new $tw.Tiddler({ title: CASCADE_PENDING_TIDDLER, text: "" }));
    this.wiki.addTiddler(new $tw.Tiddler({ title: CASCADE_APPLY_TIDDLER, text: "" }));
};

// Read the cascade-confirm threshold from config; falls back to the router's
// default when the tiddler is missing or invalid.
MindmapWidget.prototype.cascadeThreshold = function () {
    var raw = trim(this.wiki.getTiddlerText(CASCADE_THRESHOLD_TIDDLER, ""));
    if (!raw) { return router.DEFAULT_CASCADE_THRESHOLD; }
    var n = parseInt(raw, 10);
    return (isFinite(n) && n >= 0) ? n : router.DEFAULT_CASCADE_THRESHOLD;
};

// Run a structural op through the producer. Suspends adapter event emission
// during the call so the cascade of wiki changes doesn't re-trigger ops.
MindmapWidget.prototype.applyStructuralOp = function (op, producer) {
    if (!producer || typeof producer.applyOps !== "function") {
        console.error("[$mindmap] structural op routed but producer has no applyOps", op);
        return;
    }
    if (this.applying) {
        console.warn("[$mindmap] op dropped (already applying)", op);
        return;
    }
    this.applying = true;
    try {
        if (this.engineInstance && typeof this.engineInstance.setSuspendOps === "function") {
            this.engineInstance.setSuspendOps(true);
        }
        var results = producer.applyOps([op], this.producerArgs, this.wiki);
        for (var i = 0; i < results.length; i++) {
            var r = results[i];
            if (r && r.error) {
                console.error("[$mindmap] applyOps error", r);
            } else if (r && r.collisionResolved) {
                console.info("[$mindmap] slug collision resolved →", r.newTitle);
            }
        }
        // Schedule refresh: the wiki change events will trigger refresh()
        // naturally; we clear suspendOps after the next microtask.
    } finally {
        var self = this;
        setTimeout(function () {
            self.applying = false;
            if (self.engineInstance && typeof self.engineInstance.setSuspendOps === "function") {
                self.engineInstance.setSuspendOps(false);
            }
        }, 0);
    }
};

MindmapWidget.prototype.handleSelect = function (nodeId) {
    this.selectedNodeId = nodeId || null;
    this.updateActionsVisibility();
    this.updatePreviewState(nodeId);
    if (!this.onSelectActions) { return; }
    this.invokeActionString(this.onSelectActions, this, null, {
        nodeId: nodeId || "",
        selectedNodeId: nodeId || ""
    });
};

MindmapWidget.prototype.recompose = function () {
    if (!this.lastBase) { return; }
    var ops = this.store ? this.store.read() : [];
    var composed = composer.compose(this.lastBase, ops);
    this.lastComposite = composed.mdom;
    this.lastOrphans = composed.orphans;
    if (this.engineInstance && typeof this.engineInstance.update === "function") {
        this.engineInstance.update(this.lastComposite);
    }
    this.updateToolbar();
};

MindmapWidget.prototype.reproduce = function () {
    var baseTriple = this.produceBase();
    this.lastBase = baseTriple.mdom;
    this.lastRefreshFilter = baseTriple.refreshFilter;
    this.lastWatchedTitles = this.evaluateWatched(this.lastRefreshFilter);
    this.recompose();
};

MindmapWidget.prototype.refresh = function (changedTiddlers) {
    var changedAttrs = this.computeAttributes();
    var rebuilders = ["view", "filter", "engine", "overlay", "class", "style", "height", "readonly"];
    for (var i = 0; i < rebuilders.length; i++) {
        if (changedAttrs[rebuilders[i]]) {
            this.refreshSelf();
            return true;
        }
    }
    if (this.errorMessage) { return false; }
    // Cascade-confirm apply signal from the modal.
    if (changedTiddlers[CASCADE_APPLY_TIDDLER]) {
        this.maybeApplyPendingCascade();
    }
    var baseChanged = false;
    if (this.lastWatchedTitles) {
        // Check OLD set (catches renames + removals of titles we knew about).
        for (var title in changedTiddlers) {
            if (this.lastWatchedTitles[title]) { baseChanged = true; break; }
        }
        // Also check CURRENT set (catches newly-created titles that match the
        // refresh filter — these are absent from the cached snapshot).
        if (!baseChanged && this.lastRefreshFilter) {
            var currentTitles = this.evaluateWatched(this.lastRefreshFilter);
            if (currentTitles) {
                for (var title2 in changedTiddlers) {
                    if (currentTitles[title2]) { baseChanged = true; break; }
                }
            }
        }
    }
    if (this.viewAttr && changedTiddlers[this.viewAttr]) {
        this.refreshSelf();
        return true;
    }
    // Focus state changes force a full re-produce (new MDOM root) and the
    // toolbar buttons need to re-evaluate visibility.
    if (changedTiddlers[this.focusStateTitle()]) {
        try { this.reproduce(); } catch (e) {
            console.error("[$mindmap] focus re-produce failed", e);
        }
        this.updateActionsVisibility();
        return true;
    }
    if (baseChanged) {
        try { this.reproduce(); } catch (e) {
            console.error("[$mindmap] re-produce failed", e);
        }
        return true;
    }
    if (this.overlayTitle && changedTiddlers[this.overlayTitle]) {
        this.recompose();
        return true;
    }
    // Forward to the preview widget so it re-renders when the selected
    // tiddler's body changes or the preview-state tiddler is updated.
    if (this.previewWidget) {
        try { this.previewWidget.refresh(changedTiddlers); } catch (e) { /* ignore */ }
    }
    return false;
};

MindmapWidget.prototype.renderToolbar = function () {
    this.toolbarNode = this.document.createElement("div");
    this.toolbarNode.className = "rr-mindmap-toolbar";

    var producerLabel = this.document.createElement("span");
    producerLabel.className = "rr-mindmap-producer";
    producerLabel.textContent = "producer: " + this.producerName;
    this.toolbarNode.appendChild(producerLabel);

    var engineLabel = this.document.createElement("span");
    engineLabel.className = "rr-mindmap-engine";
    engineLabel.textContent = "engine: " + this.engineName;
    this.toolbarNode.appendChild(engineLabel);

    this.orphanBadge = this.document.createElement("span");
    this.orphanBadge.className = "rr-mindmap-orphan-badge";
    this.orphanBadge.style.display = "none";
    this.toolbarNode.appendChild(this.orphanBadge);

    this.containerNode.appendChild(this.toolbarNode);

    // Floating action panel pinned bottom-right of the canvas. Mind-elixir
    // doesn't expose an extension API for its built-in toolbars, so we add
    // our own corner panel styled to match. Appended INSIDE canvasNode (the
    // element mind-elixir requests fullscreen on) so the panel goes
    // fullscreen with it.
    var producer = findProducerByName(this.producerName);
    var isStructural = !!(producer && producer.capabilities && producer.capabilities.structural);
    if (isStructural) {
        this.actionsPanel = this.document.createElement("div");
        this.actionsPanel.className = "rr-mindmap-actions";

        var self = this;

        var focusInBtn = this.document.createElement("button");
        focusInBtn.type = "button";
        focusInBtn.className = "rr-mindmap-edit-btn rr-mindmap-focus-in-btn";
        focusInBtn.textContent = "↓";
        focusInBtn.title = "Focus into selected node (drill down to subtree)";
        focusInBtn.style.display = "none";
        focusInBtn.addEventListener("click", function () { self.handleFocusInto(); });
        this.actionsPanel.appendChild(focusInBtn);
        this.focusInBtn = focusInBtn;

        var stepUpBtn = this.document.createElement("button");
        stepUpBtn.type = "button";
        stepUpBtn.className = "rr-mindmap-edit-btn rr-mindmap-step-up-btn";
        stepUpBtn.textContent = "↑";
        stepUpBtn.title = "Step out one level (focus on parent subtree)";
        stepUpBtn.style.display = "none";
        stepUpBtn.addEventListener("click", function () { self.handleStepOutOne(); });
        this.actionsPanel.appendChild(stepUpBtn);
        this.stepUpBtn = stepUpBtn;

        var stepOutBtn = this.document.createElement("button");
        stepOutBtn.type = "button";
        stepOutBtn.className = "rr-mindmap-edit-btn rr-mindmap-step-out-btn";
        stepOutBtn.textContent = "⇪";
        stepOutBtn.title = "Step out fully (back to area root)";
        stepOutBtn.style.display = "none";
        stepOutBtn.addEventListener("click", function () { self.handleStepOut(); });
        this.actionsPanel.appendChild(stepOutBtn);
        this.stepOutBtn = stepOutBtn;

        var editBtn = this.document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "rr-mindmap-edit-btn";
        editBtn.textContent = "✎";
        editBtn.title = "Edit selected node — body + fields (F2)";
        editBtn.style.display = "none";
        editBtn.addEventListener("click", function () { self.handleEditSelected(); });
        this.actionsPanel.appendChild(editBtn);
        this.editBtn = editBtn;

        // The step-out state is independent of selection — update it once
        // at render time. handleSelect updates the others on selection change.
        this.updateActionsVisibility();
    }
};

// Compute which buttons should be visible right now and apply.
MindmapWidget.prototype.updateActionsVisibility = function () {
    if (!this.actionsPanel) { return; }
    var nodeId = this.selectedNodeId;
    var producer = findProducerByName(this.producerName);
    var selectedTitle = null;
    if (nodeId && producer && typeof producer.titleForOp === "function") {
        var t = producer.titleForOp({ op: "rename", id: nodeId });
        if (t && this.wiki.getTiddler(t)) { selectedTitle = t; }
    }
    // ✎ Edit: visible when a real tiddler is selected
    if (this.editBtn) { this.editBtn.style.display = selectedTitle ? "" : "none"; }
    // ↓ Focus into: visible when a real tiddler is selected AND it's not
    // already the current focus root AND it has children to drill into.
    var currentFocus = this.currentFocusTitle();
    var canFocusIn = false;
    if (selectedTitle && selectedTitle !== currentFocus) {
        // Cheap check: any tiddler with a deeper prefix means children exist.
        var hasChildren = this.wiki.filterTiddlers(
            "[all[shadows+tiddlers]prefix[" + selectedTitle + "/]limit[1]]"
        ).length > 0;
        canFocusIn = hasChildren;
    }
    if (this.focusInBtn) { this.focusInBtn.style.display = canFocusIn ? "" : "none"; }
    // Step buttons: visible whenever focus is set. ↑ goes up one level, ⇪
    // jumps to area root. We show both whenever focused even if they'd both
    // resolve to the same destination (focus directly under area root): the
    // dual affordance is the point of having two buttons.
    if (this.stepUpBtn) { this.stepUpBtn.style.display = currentFocus ? "" : "none"; }
    if (this.stepOutBtn) { this.stepOutBtn.style.display = currentFocus ? "" : "none"; }
    // Panel itself: visible when any child button is.
    var anyVisible = selectedTitle || currentFocus;
    this.actionsPanel.style.display = anyVisible ? "" : "none";
};

// Step out one level — walk the focus title up one path segment. If the
// resulting parent reaches the producer's natural root (or above), clear
// focus entirely (equivalent to ⇪).
MindmapWidget.prototype.handleStepOutOne = function () {
    var current = this.currentFocusTitle();
    if (!current) { return; }
    var producer = findProducerByName(this.producerName);
    var rootTitle = (producer && typeof producer.rootTitle === "function")
        ? producer.rootTitle(this.producerArgs) : null;
    var lastSlash = current.lastIndexOf("/");
    var parent = lastSlash > 0 ? current.substring(0, lastSlash) : "";
    var clearFocus = !parent;
    if (!clearFocus && rootTitle) {
        // Clear when parent has reached the natural root OR moved above it.
        var belowRoot = parent === rootTitle || parent.indexOf(rootTitle + "/") === 0;
        if (!belowRoot || parent === rootTitle) { clearFocus = true; }
    }
    this.wiki.addTiddler(new $tw.Tiddler({
        title: this.focusStateTitle(),
        text: clearFocus ? "" : parent
    }));
};

MindmapWidget.prototype.handleFocusInto = function () {
    var nodeId = this.selectedNodeId;
    if (!nodeId) { return; }
    var producer = findProducerByName(this.producerName);
    if (!producer || typeof producer.titleForOp !== "function") { return; }
    var title = producer.titleForOp({ op: "rename", id: nodeId });
    if (!title) { return; }
    this.wiki.addTiddler(new $tw.Tiddler({
        title: this.focusStateTitle(),
        text: title
    }));
};

MindmapWidget.prototype.handleStepOut = function () {
    this.wiki.addTiddler(new $tw.Tiddler({
        title: this.focusStateTitle(),
        text: ""
    }));
};

// Open the title-unlocked popup-edit-modal for the currently-selected node.
// Resolves the selection's id to a tiddler title via the producer's
// titleForOp helper (which understands kt:/ft: id encoding).
MindmapWidget.prototype.handleEditSelected = function () {
    var producer = findProducerByName(this.producerName);
    if (!producer || typeof producer.titleForOp !== "function") { return; }
    var id = this.selectedNodeId || null;
    if (!id) { return; }
    var title = producer.titleForOp({ op: "rename", id: id });
    if (!title) { return; }
    if (!this.wiki.getTiddler(title)) { return; }
    // Unlocked: user can rename via the popup if they want.
    this.exitFullscreenIfInside();
    this.wiki.addTiddler(new $tw.Tiddler({
        title: "$:/state/rimir/knowledge-app/popup-edit/title-lock",
        text: ""
    }));
    this.ensureDraft(title);
    this.wiki.addTiddler(new $tw.Tiddler({
        title: "$:/state/rimir/knowledge-app/popup-edit/target",
        text: title
    }));
};

MindmapWidget.prototype.updateToolbar = function () {
    if (!this.orphanBadge) { return; }
    var n = (this.lastOrphans || []).length;
    if (n > 0) {
        this.orphanBadge.textContent = "⚠ " + n + " orphan op" + (n === 1 ? "" : "s");
        this.orphanBadge.title = "Overlay ops whose target id is missing from the current base. Edit the overlay tiddler manually or use the prune action to clear them.";
        this.orphanBadge.style.display = "";
    } else {
        this.orphanBadge.style.display = "none";
    }
};

MindmapWidget.prototype.renderError = function () {
    var err = this.document.createElement("div");
    err.className = "rr-mindmap-error";
    err.textContent = this.errorMessage || "Unknown mindmap error.";
    this.containerNode.appendChild(err);
};

MindmapWidget.prototype.destroy = function () {
    if (this.engineInstance && typeof this.engineInstance.destroy === "function") {
        try { this.engineInstance.destroy(); } catch (e) { /* engine bug, ignore */ }
    }
    if (this.store) { this.store.flush(); this.store.destroy(); }
};

exports.mindmap = MindmapWidget;
