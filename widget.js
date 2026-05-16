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
var flagDecorate = require("$:/plugins/rimir/mindmap/lib/flag-decorate.js");

// Tag for flag-rule tiddlers. Watched in refresh() so editing a rule re-runs
// the decoration pass without needing a structural change to anything else.
var FLAG_RULE_TAG = "$:/tags/rimir/mindmap/flag";

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
    // Custom widget message — fired by the presentation pane when the user
    // clicks a node title in the playlist. Resolves the title back to a
    // producer node-id and asks the engine to focus/highlight it.
    this.addEventListeners([
        { type: "rr-mindmap-select-node-by-title", handler: "handleSelectNodeByTitle" },
        { type: "rr-mindmap-add-slide", handler: "handleAddSlide" }
    ]);
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
    this.bindPlayHotkey();
    // Layout: a horizontal flex row containing the canvas (mind-elixir host)
    // on the left and an optional preview pane on the right.
    this.mainArea = this.document.createElement("div");
    this.mainArea.className = "rr-mindmap-main";
    this.containerNode.appendChild(this.mainArea);

    this.canvasNode = this.document.createElement("div");
    this.canvasNode.className = "rr-mindmap-canvas";
    this.mainArea.appendChild(this.canvasNode);

    // Preview pane: hidden until there's a reason to show it — either a
    // node selection (Body / Slides modes) or an active presentation
    // (Presentation mode). updatePreviewPaneVisibility re-evaluates this on
    // selection changes and after view-tiddler field writes.
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
        var composed = composer.compose(this.lastBase, this.composedOps());
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
    // Generic engine policy: native node-creation gestures (Tab/Enter in
    // mind-elixir, equivalent in other engines). Widget attr wins; view-
    // tiddler `mm.allow-node-creation` is the fallback. Default "yes".
    this.allowNodeCreationAttr = trim(this.getAttribute("allow-node-creation", ""));
    // Flag-rule selection. Widget `flags=` attr overrides the view's
    // `mm.flags` field. Either is a TW filter resolving to flag-rule tiddler
    // titles (tagged $:/tags/rimir/mindmap/flag). Empty → no flags applied.
    this.flagsAttr = trim(this.getAttribute("flags", ""));

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
        // Overlay target resolution. Two-layer model:
        //   - `mm.overlay-filter` (filter) — dynamic per-render target.
        //     Evaluated in the widget's variable scope (parent <$let> vars
        //     are visible — e.g. <<entity>>). First result wins. Empty/no
        //     result falls back to the static field below.
        //   - `mm.overlay` (literal title) — fallback / legacy single target.
        // The widget AUTO-PERSISTS engine state (collapse/expand/setAttr) to
        // this tiddler. Per-entity overrides come from the filter form.
        var overlayFilter = trim(f["mm.overlay-filter"] || "");
        if (overlayFilter) {
            try {
                var resolved = this.wiki.filterTiddlers(overlayFilter, this);
                this.overlayTitle = (resolved && resolved.length > 0) ? trim(resolved[0]) : "";
            } catch (e) {
                this.overlayTitle = "";
            }
        }
        if (!this.overlayTitle) {
            this.overlayTitle = trim(f["mm.overlay"] || "");
        }
        // Saved-default target. A STATIC tiddler title (no filter) — view-
        // wide initial state applied BEFORE overlay ops, so the per-entity
        // overlay (when present) overrides the default. The toolbar's "Save
        // as default" promotes the current overlay's contents to this target.
        this.savedDefaultTitle = trim(f["mm.saved-default"] || "");
        // Optional: tiddler whose body renders the preview pane in body-mode.
        // Receives `previewTitle` in scope (the selected node's backing tiddler).
        // Default falls back to the standard rr-text-view-editable.
        this.previewBodyTemplate = trim(f["mm.preview-body-template"] || "");
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

    // Flag rules resolution. Widget attr beats view field — same precedence
    // as engine/overlay. Rules are loaded once per execute() (i.e. per
    // refreshSelf) and on every reproduce() via reloadFlagRules() so edits
    // to the rule tiddlers reflect without a full teardown.
    this.flagsFilter = this.flagsAttr;
    if (!this.flagsFilter && this.viewAttr) {
        var viewForFlags = this.wiki.getTiddler(this.viewAttr);
        if (viewForFlags) {
            this.flagsFilter = trim(viewForFlags.fields["mm.flags"] || "");
        }
    }
    this.reloadFlagRules();
};

MindmapWidget.prototype.reloadFlagRules = function () {
    this.flagRules = flagDecorate.loadFlagRules(this.wiki, {
        rulesFilter: this.flagsFilter,
        viewTitle: this.viewAttr,
        mmProducer: this.producerName
    });
};

// Pure: decide allow-node-creation from (attr value, view-field value).
// Both inputs are strings ("yes", "no", or empty/anything-else). Widget attr
// wins over view field; default when neither is "yes"/"no" is true.
function resolveAllowNodeCreation(attrValue, viewFieldValue) {
    if (attrValue === "no") { return false; }
    if (attrValue === "yes") { return true; }
    if (viewFieldValue === "no") { return false; }
    if (viewFieldValue === "yes") { return true; }
    return true;
}

MindmapWidget.prototype.allowNodeCreation = function () {
    var viewField = "";
    if (this.viewAttr) {
        var view = this.wiki.getTiddler(this.viewAttr);
        if (view) { viewField = trim(view.fields["mm.allow-node-creation"] || ""); }
    }
    return resolveAllowNodeCreation(this.allowNodeCreationAttr, viewField);
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

// Session override for the visible-label field. Empty means "use the view's
// mm.label-field, or 'title' if unset". Lives in $:/state/ so it doesn't
// sync — pick-on-the-fly per browser session.
MindmapWidget.prototype.labelFieldStateTitle = function () {
    var key = this.stateAttr || this.viewAttr || this.filterAttr || "default";
    return "$:/state/rimir/mindmap/" + key + "/label-field";
};

MindmapWidget.prototype.currentLabelField = function () {
    var session = trim(this.wiki.getTiddlerText(this.labelFieldStateTitle(), ""));
    if (session) { return session; }
    if (this.viewAttr) {
        var view = this.wiki.getTiddler(this.viewAttr);
        var viewField = view && trim(view.fields["mm.label-field"] || "");
        if (viewField) { return viewField; }
    }
    return "title";
};

// Session-only state tiddler for the slides-only filter. When "yes", the
// producer prunes the MDOM to nodes that have slides (or descendants with
// slides). $:/state/ — lost on reload, intentional since it's a transient
// view-mode rather than a durable per-view preference.
MindmapWidget.prototype.slidesOnlyStateTitle = function () {
    var key = this.stateAttr || this.viewAttr || this.filterAttr || "default";
    return "$:/state/rimir/mindmap/" + key + "/slides-only";
};

MindmapWidget.prototype.currentSlidesOnly = function () {
    return trim(this.wiki.getTiddlerText(this.slidesOnlyStateTitle(), "")) === "yes";
};

// "Pin the preview pane open" toggle. When yes, the pane is visible
// regardless of selection / inspect-mode rules — useful when configuring a
// presentation without first having to click an arbitrary node just to make
// the modebar appear. When the toggle is off (default), the pane reverts to
// the rule encoded by isPreviewPaneVisible(). $:/state/ — session-scoped.
MindmapWidget.prototype.viewPinnedStateTitle = function () {
    var key = this.stateAttr || this.viewAttr || this.filterAttr || "default";
    return "$:/state/rimir/mindmap/" + key + "/view-pinned";
};

MindmapWidget.prototype.currentViewPinned = function () {
    return trim(this.wiki.getTiddlerText(this.viewPinnedStateTitle(), "")) === "yes";
};

MindmapWidget.prototype.toggleViewPinned = function () {
    var on = this.currentViewPinned();
    this.wiki.addTiddler(new $tw.Tiddler({
        title: this.viewPinnedStateTitle(),
        text: on ? "" : "yes"
    }));
};

// Session-only state tiddler for the right-pane inspect mode.
//   "body"         -> existing body view/edit (default)
//   "slides"       -> slide list + per-slide editor (Phase 1)
//   "presentation" -> ordered slide sequence of the active presentation (Phase 2)
MindmapWidget.prototype.inspectModeStateTitle = function () {
    var key = this.stateAttr || this.viewAttr || this.filterAttr || "default";
    return "$:/state/rimir/mindmap/" + key + "/inspect-mode";
};

MindmapWidget.prototype.currentInspectMode = function () {
    var mode = trim(this.wiki.getTiddlerText(this.inspectModeStateTitle(), ""));
    if (mode === "slides" || mode === "presentation") { return mode; }
    return "body";
};

var PRESENTATION_TAG = "$:/tags/rimir/mindmap/presentation";

// Title of the presentation currently active for this view (empty if none).
// Stored on the view tiddler's `mm.presentation` field — durable across
// reloads, intentional since presentation choice is editorial.
MindmapWidget.prototype.currentPresentationTitle = function () {
    if (!this.viewAttr) { return ""; }
    var view = this.wiki.getTiddler(this.viewAttr);
    return view ? trim(view.fields["mm.presentation"] || "") : "";
};

// All presentation tiddlers (tag $:/tags/rimir/mindmap/presentation) whose
// `mm.view` field points at the current view. Sorted alphabetically by title.
MindmapWidget.prototype.viewPresentations = function () {
    if (!this.viewAttr) { return []; }
    var results = [];
    var self = this;
    this.wiki.each(function (tiddler, title) {
        if (!tiddler || !tiddler.fields) { return; }
        var tags = $tw.utils.parseStringArray(tiddler.fields.tags || "");
        if (tags.indexOf(PRESENTATION_TAG) < 0) { return; }
        var view = trim(tiddler.fields["mm.view"] || "");
        if (view === self.viewAttr) { results.push(title); }
    });
    results.sort();
    return results;
};

// Does the active presentation include this tiddler title in its
// `mm.slides-order` list?
MindmapWidget.prototype.presentationIncludes = function (presentationTitle, nodeTitle) {
    if (!presentationTitle || !nodeTitle) { return false; }
    var p = this.wiki.getTiddler(presentationTitle);
    if (!p) { return false; }
    var list = $tw.utils.parseStringArray(p.fields["mm.slides-order"] || "");
    return list.indexOf(nodeTitle) >= 0;
};

// Stable key used to derive per-widget state-tiddler titles in the preview
// wikitext template.
MindmapWidget.prototype.previewStateKey = function () {
    return this.stateAttr || this.viewAttr || this.filterAttr || "default";
};

// Compose the full args set passed to producer.produce() AND
// producer.applyOps. Includes the session-driven focus + label-field so
// structural mutations know which surface they're editing.
MindmapWidget.prototype.effectiveProducerArgs = function () {
    var args = Object.assign({}, this.producerArgs);
    var focusTitle = this.currentFocusTitle();
    if (focusTitle) { args["focus-title"] = focusTitle; }
    var labelField = this.currentLabelField();
    if (labelField && labelField !== "title") { args["label-field"] = labelField; }
    if (this.currentSlidesOnly()) { args["slides-only"] = "yes"; }
    var rootLabel = this.resolveRootLabel();
    if (rootLabel) { args["root-label"] = rootLabel; }
    return args;
};

// View-tiddler `mm.root-label` resolves the visible label of the MDOM root.
// Two evaluation modes (matching mm.axis-label-template):
//   - Literal: any non-empty string starting with anything other than `[`
//   - Filter:  starts with `[`. Evaluated in the widget's variable scope so
//              parent `<$let entity=…>` variables are visible. First result
//              wins; empty result falls through to the producer's default.
// Returns empty string when unset or unresolvable.
MindmapWidget.prototype.resolveRootLabel = function () {
    if (!this.viewAttr) { return ""; }
    var view = this.wiki.getTiddler(this.viewAttr);
    if (!view) { return ""; }
    var expr = trim(view.fields["mm.root-label"] || "");
    if (!expr) { return ""; }
    if (expr.charAt(0) !== "[") { return expr; }
    try {
        var out = this.wiki.filterTiddlers(expr, this);
        return (out && out.length > 0) ? out[0] : "";
    } catch (e) {
        return "";
    }
};

MindmapWidget.prototype.produceBase = function () {
    var producer = findProducerByName(this.producerName);
    if (!producer || typeof producer.produce !== "function") {
        throw new Error("Unknown producer: " + this.producerName);
    }
    // Merge session focus + label-field into producer args. Done at
    // produce-time so the state can change without a refreshSelf — refresh()
    // detects the state tiddlers in changedTiddlers and calls reproduce().
    var effectiveArgs = this.effectiveProducerArgs();
    var mdom = producer.produce(effectiveArgs, this.wiki, this);
    if (!mdom || !mdom.root) {
        throw new Error("Producer " + this.producerName + " returned invalid MDOM");
    }
    // Filter-driven flag decoration. Runs BEFORE compose so live overlay
    // setAttr ops can still override flag-stamped attrs. No-ops cleanly when
    // no rules are configured for this view.
    if (this.flagRules && this.flagRules.length > 0) {
        try {
            flagDecorate.decorateFlags(mdom, this.flagRules, this.wiki);
        } catch (e) {
            console.error("[$mindmap] flag decoration failed", e);
        }
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
    // Engine-agnostic policy toggle: when the host (view config or widget
    // attr) disables node creation, the engine adapter must swallow its
    // native Tab/Enter (or equivalent) gestures so a read-only/structural-
    // view canvas doesn't silently create placeholder nodes the user can't
    // commit. Engines that don't implement the method ignore the call.
    if (typeof instance.setAllowNodeCreation === "function") {
        instance.setAllowNodeCreation(this.allowNodeCreation());
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
        cascadeThreshold: this.cascadeThreshold(),
        args: this.effectiveProducerArgs()
    });
    switch (routing.mode) {
        case "structural":
            this.applyStructuralOp(op, producer);
            break;
        case "overlay":
            if (this.store) {
                this.store.append(op);
                // Reflect just-appended ops in the toolbar buttons before
                // the debounced wiki write completes — users get instant
                // visual feedback that the per-entity state diverges from
                // the saved default.
                this.updateSavedStateButtons();
            }
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

// Per-widget state tiddler holding the currently-selected synthetic node's
// "preview kind" descriptor. Producers that classify synthetic nodes (e.g.
// grouped-tree's chain / axis roots) expose `previewKindForId(id)` returning
// an object whose `chainId` (and `axisKey`, `keyPath`) end up in this state
// + companion fields. Empty when the selection is a leaf or unclassified.
MindmapWidget.prototype.previewKindStateTitle = function () {
    var key = this.stateAttr || this.viewAttr || this.filterAttr || "default";
    return "$:/state/rimir/mindmap/" + key + "/preview-kind";
};

// Build the preview pane's two layers:
//   - Modebar (JS-built): title span + unified mode/presentation dropdown.
//     Dropdown options: Body / Slides / <each presentation for this view> /
//     + New presentation… — picking a presentation atomically activates it
//     AND switches inspect-mode to "presentation".
//   - Content (wikitext widget tree): branches on inspect-mode to render
//     body view/edit, slide pane, or presentation pane.
// The JS modebar is necessary because the prompt-and-create flow for
// "+ New presentation…" can't be expressed in pure wikitext.
MindmapWidget.prototype.renderPreviewChildren = function () {
    if (!this.previewPane) { return; }

    // Modebar
    this.previewModebar = this.document.createElement("div");
    this.previewModebar.className = "rr-mindmap-preview-modebar";

    this.modebarTitle = this.document.createElement("span");
    this.modebarTitle.className = "rr-mindmap-preview-modebar-title";
    this.previewModebar.appendChild(this.modebarTitle);

    // Inline ✎ edit button next to the title. Always opens the body editor
    // (sets the preview-edit-state tiddler to "yes" → wikitext branch flips
    // to the rr-text-editor). Necessary because the default view template
    // requires existing body text to trigger its double-click-to-edit
    // affordance — empty nodes had no way in.
    this.modebarEditBtn = this.document.createElement("button");
    this.modebarEditBtn.type = "button";
    this.modebarEditBtn.className = "rr-mindmap-modebar-edit-btn";
    this.modebarEditBtn.textContent = "✎";
    this.modebarEditBtn.title = "Edit body";
    this.modebarEditBtn.style.display = "none";
    var selfEdit = this;
    this.modebarEditBtn.addEventListener("click", function () {
        selfEdit.openBodyEditor();
    });
    this.previewModebar.appendChild(this.modebarEditBtn);

    this.modebarSelect = this.document.createElement("select");
    this.modebarSelect.className = "rr-mindmap-modebar-select";
    var self = this;
    this.modebarSelect.addEventListener("change", function () {
        self.handleModebarSelectChange(self.modebarSelect.value);
    });
    this.previewModebar.appendChild(this.modebarSelect);

    // Inline ▶ play button next to the dropdown. Visible only when inspect
    // mode is Presentation AND the active deck resolves to ≥1 slide; hidden
    // otherwise so it never invites a no-op click.
    this.modebarPlayBtn = this.document.createElement("button");
    this.modebarPlayBtn.type = "button";
    this.modebarPlayBtn.className = "rr-mindmap-modebar-play-btn";
    this.modebarPlayBtn.textContent = "▶";
    this.modebarPlayBtn.title = "Start the fullscreen player (Shift+F2)";
    this.modebarPlayBtn.style.display = "none";
    this.modebarPlayBtn.addEventListener("click", function () {
        self.startPresentation();
    });
    this.previewModebar.appendChild(this.modebarPlayBtn);

    this.previewPane.appendChild(this.previewModebar);

    // Content container — wikitext widget tree renders here.
    this.previewContent = this.document.createElement("div");
    this.previewContent.className = "rr-mindmap-preview-content";
    this.previewPane.appendChild(this.previewContent);

    this.updateModebarTitle();
    this.populateModebarSelect();

    // Wikitext below the modebar branches on inspect-mode. Two signals
    // determine what the pane renders in non-presentation modes:
    //   previewTitle : non-blank leaf-selection backing tiddler
    //   previewKind  : non-blank synthetic-node classifier (chainId)
    // previewKind takes precedence for the body-template branch — the host
    // template (mm.preview-body-template) is responsible for branching on
    // <<previewKind>> first, falling through to <<previewTitle>>.
    var wikitext =
        "<$set name='previewTitle' filter='[<__state__>get[text]]'>" +
        "<$set name='previewKind' filter='[<__kindstate__>get[text]]'>" +
        "<$set name='previewKindAxisKey' filter='[<__kindstate__>get[axis-key]]'>" +
        "<$set name='previewKindKeyPath' filter='[<__kindstate__>get[key-path]]'>" +
        "<$let inspectMode={{{ [<__inspectstate__>get[text]] }}}>" +
        "<%if [<inspectMode>match[presentation]] %>" +
        "<$transclude $variable='mm-presentation-pane' previewTitle=<<previewTitle>> stateKey=<<__statekey__>> viewTitle=<<__viewtitle__>>/>" +
        "<%else%>" +
        "<$list filter='[<previewTitle>!is[blank]is[tiddler]] [<previewKind>!is[blank]]' variable='_' " +
        "emptyMessage=\"\"\"<div class='rr-mindmap-preview-empty'>Select a node in the canvas to inspect it.</div>\"\"\">" +
        "<%if [<inspectMode>match[slides]] %>" +
        "<$transclude $variable='mm-slide-pane' previewTitle=<<previewTitle>> stateKey=<<__statekey__>>/>" +
        "<%else%>" +
        "<$let editState=<<__editstate__>>>" +
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
        "<%if [<__bodytemplate__>!is[blank]] %>" +
        "<$transclude $tiddler=<<__bodytemplate__>> $mode='block'/>" +
        "<%else%>" +
        "<%if [<previewKind>!is[blank]] %>" +
        "<div class='rr-mindmap-preview-empty'>No preview template configured for kind: <$text text=<<previewKind>>/></div>" +
        "<%else%>" +
        "<$let viewTiddler=<<previewTitle>>>" +
        "<$transclude $tiddler='$:/plugins/rimir/theme/rr-text-view-editable' $mode='block'/>" +
        "</$let>" +
        "<%endif%>" +
        "<%endif%>" +
        "<%endif%>" +
        "</div>" +
        "</$let>" +
        "<%endif%>" +
        "</$list>" +
        "<%endif%>" +
        "</$let>" +
        "</$set>" +
        "</$set>" +
        "</$set>" +
        "</$set>";
    var parser = this.wiki.parseText("text/vnd.tiddlywiki", wikitext, { parseAsInline: false });
    if (!parser) { return; }
    var widgetNode = this.wiki.makeWidget(parser, {
        parentWidget: this,
        document: this.document,
        variables: {
            __state__: this.previewStateTitle(),
            __editstate__: this.previewEditStateTitle(),
            __inspectstate__: this.inspectModeStateTitle(),
            __kindstate__: this.previewKindStateTitle(),
            __statekey__: this.previewStateKey(),
            __viewtitle__: this.viewAttr || "",
            __bodytemplate__: this.previewBodyTemplate || ""
        }
    });
    widgetNode.render(this.previewContent, null);
    this.previewWidget = widgetNode;
};

// Update the modebar title span to reflect the currently-selected tiddler
// or — for synthetic-node selections — the producer-supplied kind label.
MindmapWidget.prototype.updateModebarTitle = function () {
    if (!this.modebarTitle) { return; }
    var title = this.selectedBackingTitle();
    var kindId = title ? "" : this.currentPreviewKindId();
    var label = title || (kindId ? kindId : "");
    if (label) {
        this.modebarTitle.textContent = label;
        this.modebarTitle.title = label;
        this.modebarTitle.classList.remove("rr-mindmap-preview-modebar-empty");
    } else {
        this.modebarTitle.textContent = "(no selection)";
        this.modebarTitle.removeAttribute("title");
        this.modebarTitle.classList.add("rr-mindmap-preview-modebar-empty");
    }
    this.updateModebarEditButton();
};

// Rebuild the modebar dropdown options. Called on render and whenever the
// presentation list changes. Sets the selected value to reflect the current
// inspect-mode + active presentation.
MindmapWidget.prototype.populateModebarSelect = function () {
    if (!this.modebarSelect) { return; }
    while (this.modebarSelect.firstChild) {
        this.modebarSelect.removeChild(this.modebarSelect.firstChild);
    }
    var bodyOpt = this.document.createElement("option");
    bodyOpt.value = "body";
    bodyOpt.textContent = "Body";
    this.modebarSelect.appendChild(bodyOpt);

    var slidesOpt = this.document.createElement("option");
    slidesOpt.value = "slides";
    slidesOpt.textContent = "Slides";
    this.modebarSelect.appendChild(slidesOpt);

    // Presentations group — only meaningful for view-mode widgets (filter=
    // form has no view tiddler to hold mm.presentation, so skip).
    if (this.viewAttr) {
        var group = this.document.createElement("optgroup");
        group.label = "Presentations";
        var presentations = this.viewPresentations();
        for (var i = 0; i < presentations.length; i++) {
            var t = presentations[i];
            var opt = this.document.createElement("option");
            opt.value = "pres:" + t;
            var p = this.wiki.getTiddler(t);
            var caption = p && trim(p.fields.caption || "");
            opt.textContent = caption || t;
            group.appendChild(opt);
        }
        var newOpt = this.document.createElement("option");
        newOpt.value = "__new_presentation__";
        newOpt.textContent = "+ New presentation…";
        group.appendChild(newOpt);
        this.modebarSelect.appendChild(group);
    }

    this.updateModebarSelectedValue();
};

// Compute and apply the dropdown's selected value from the inspect-mode
// state and active presentation. Called after populate + on state changes.
MindmapWidget.prototype.updateModebarSelectedValue = function () {
    if (!this.modebarSelect) { return; }
    var mode = this.currentInspectMode();
    var value;
    if (mode === "presentation") {
        var active = this.currentPresentationTitle();
        value = active ? "pres:" + active : "body";
    } else {
        value = mode; // "body" or "slides"
    }
    // Verify the option exists; fall back to "body" if not (e.g., dropped
    // presentation reference).
    var found = false;
    for (var i = 0; i < this.modebarSelect.options.length; i++) {
        if (this.modebarSelect.options[i].value === value) { found = true; break; }
    }
    this.modebarSelect.value = found ? value : "body";
    this.updateModebarPlayButton();
    this.updateModebarEditButton();
};

// Handle a change in the modebar dropdown.
//   "body" / "slides"     -> set inspect-mode only
//   "pres:<title>"        -> set view's mm.presentation AND inspect-mode = presentation
//   "__new_presentation__" -> prompt-and-create flow
MindmapWidget.prototype.handleModebarSelectChange = function (value) {
    if (value === "body" || value === "slides") {
        this.wiki.addTiddler(new $tw.Tiddler({
            title: this.inspectModeStateTitle(),
            text: value
        }));
        return;
    }
    if (value === "__new_presentation__") {
        this.createPresentationAndActivate();
        return;
    }
    if (value.indexOf("pres:") === 0) {
        var title = value.substring(5);
        if (this.viewAttr) {
            var view = this.wiki.getTiddler(this.viewAttr);
            if (view) {
                this.wiki.addTiddler(new $tw.Tiddler(view, { "mm.presentation": title }));
            }
        }
        this.wiki.addTiddler(new $tw.Tiddler({
            title: this.inspectModeStateTitle(),
            text: "presentation"
        }));
    }
};

// Prompt the user for a presentation name, create the tiddler with the
// right tag + fields, set as active on this view, and switch inspect-mode
// to "presentation". Aborts cleanly on user cancel.
MindmapWidget.prototype.createPresentationAndActivate = function () {
    if (!this.viewAttr) {
        this.updateModebarSelectedValue();  // reset dropdown
        return;
    }
    var raw = (typeof window !== "undefined" && window.prompt)
        ? window.prompt("New presentation name:", "")
        : "";
    if (raw == null || !(raw + "").replace(/^\s+|\s+$/g, "")) {
        this.updateModebarSelectedValue();  // reset dropdown to previous
        return;
    }
    var name = (raw + "").replace(/^\s+|\s+$/g, "");
    var sanitize = require("$:/plugins/rimir/mindmap/lib/sanitize-title.js");
    var slug = sanitize.sanitize(name) || "presentation";
    var base = "presentations/" + slug;
    var existing = Object.create(null);
    this.wiki.each(function (t, title) { existing[title] = true; });
    var title = sanitize.uniquify(base, existing);
    this.wiki.addTiddler(new $tw.Tiddler({
        title: title,
        tags: PRESENTATION_TAG,
        "mm.view": this.viewAttr,
        "mm.slides-order": "",
        caption: name
    }));
    var view = this.wiki.getTiddler(this.viewAttr);
    if (view) {
        this.wiki.addTiddler(new $tw.Tiddler(view, { "mm.presentation": title }));
    }
    this.wiki.addTiddler(new $tw.Tiddler({
        title: this.inspectModeStateTitle(),
        text: "presentation"
    }));
};

// Update the preview-state tiddlers to reflect the currently-selected node.
// Two parallel signals:
//   - preview-title : backing tiddler title when the selection is a leaf
//   - preview-kind  : producer-classified descriptor for synthetic nodes
//                     (chain root, axis group). text=chainId for branching;
//                     companion fields carry the rest of the descriptor.
// Either signal triggers the preview pane to open. A given selection
// populates at most one of the two — leaves write title; synthetic nodes
// write kind. updatePreviewPaneVisibility treats either as "show me".
MindmapWidget.prototype.updatePreviewState = function (nodeId) {
    var stateTitle = this.previewStateTitle();
    var kindTitle = this.previewKindStateTitle();
    var producer = findProducerByName(this.producerName);
    var title = "";
    var kindFields = { title: kindTitle, text: "" };
    if (nodeId && producer) {
        // Leaves first: a backing tiddler beats a chain classification (e.g.
        // a future producer might tag leaves with a kind too, but its tiddler
        // is what the user wants to see).
        if (typeof producer.titleForOp === "function") {
            var t = producer.titleForOp({ op: "rename", id: nodeId });
            if (t && this.wiki.getTiddler(t)) { title = t; }
        }
        if (!title && typeof producer.previewKindForId === "function") {
            try {
                var pk = producer.previewKindForId(nodeId);
                // Only `chain` selections currently trigger a pane preview.
                // Axis-group selections have no natural kind-view yet — the
                // descriptor is still recorded (kind="axis") so future host
                // templates can opt in, but pane visibility ignores it.
                if (pk && pk.kind === "chain" && pk.chainId) {
                    kindFields.text = pk.chainId;
                    kindFields.kind = pk.kind;
                    kindFields["axis-key"] = pk.axisKey || "";
                    kindFields["key-path"] = pk.keyPath || "";
                }
            } catch (e) { /* producer bug — ignore, pane stays unchanged */ }
        }
    }
    this.wiki.addTiddler(new $tw.Tiddler({
        title: stateTitle,
        text: title
    }));
    this.wiki.addTiddler(new $tw.Tiddler(kindFields));
    // Switching nodes always exits inline-edit mode (the active edit was on
    // the prior node; staying in edit mode would now point at a different
    // tiddler's text).
    this.wiki.addTiddler(new $tw.Tiddler({
        title: this.previewEditStateTitle(),
        text: ""
    }));
    this.updatePreviewPaneVisibility();
};

// True iff the producer classified the current selection as a synthetic kind
// (chain/axis). Used by pane-visibility and modebar-title logic.
MindmapWidget.prototype.currentPreviewKindId = function () {
    return trim(this.wiki.getTiddlerText(this.previewKindStateTitle(), ""));
};

// Pure decision: should the preview pane be visible right now?
// Extracted from updatePreviewPaneVisibility so the rule can be unit-tested
// without rendering the widget. Pinned by test-preview-visibility specs.
//
// Rule (v0.2.9+):
//   - body / slides: visible iff a node is selected (presence of an active
//     presentation MUST NOT pin the pane open in these modes — the v0.2.6
//     logic did, and that's the regression we're guarding against).
//   - presentation:  visible iff an active presentation exists (selection
//     optional — the playlist is whole-view).
function isPreviewPaneVisible(mode, hasSelection, hasPresentation) {
    if (mode === "presentation") { return !!hasPresentation; }
    return !!hasSelection;
}

MindmapWidget.prototype.updatePreviewPaneVisibility = function () {
    if (!this.previewPane) { return; }
    // "Selection" for pane purposes = a real tiddler title OR a synthetic
    // preview-kind. Either gives the preview pane something meaningful to
    // render (leaf body vs. chain "kind view"). For mode-specific rules,
    // see isPreviewPaneVisible — only the third arg (hasSelection) widens.
    var hasSelection = !!(
        this.selectedNodeId && (
            this.selectedBackingTitle() || this.currentPreviewKindId()
        )
    );
    var mode = this.currentInspectMode();
    var hasPresentation = !!this.currentPresentationTitle();
    // "View" toggle pins the pane open unconditionally. Otherwise fall back
    // to the rule encoded by isPreviewPaneVisible() (which the regression
    // specs pin). Kept as a wrapper override so the pure function stays
    // 3-arg and the test contract doesn't change.
    var visible = this.currentViewPinned() ||
        isPreviewPaneVisible(mode, hasSelection, hasPresentation);
    this.previewPane.style.display = visible ? "" : "none";
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
        producer.applyOps([op], this.effectiveProducerArgs(), this.wiki);
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

// Fire a transient TW notification for a resolved slug collision so the
// user notices the auto-uniquify suffix (-2, -3, ...). The notification
// tiddler reads `wanted`, `got`, `parent` from paramObject.
MindmapWidget.prototype.notifySlugCollision = function (result) {
    if (!result || !result.collisionResolved) { return; }
    var got = result.newTitle ? leafSegmentOf(result.newTitle) : "";
    this.dispatchEvent({
        type: "tm-notify",
        param: "$:/plugins/rimir/mindmap/notifications/slug-collision",
        paramObject: {
            wanted: result.wanted || "",
            got: got,
            parent: result.parent || ""
        }
    });
};

function leafSegmentOf(title) {
    if (!title) { return ""; }
    var i = title.lastIndexOf("/");
    return i < 0 ? title : title.substring(i + 1);
}

// When the view tiddler's mm.producer changes mid-life, the live overlay
// almost certainly contains ops keyed by the OLD producer's id encoding
// (e.g. `kt:knowledge/llm/foo` from knowledge-tree). Re-applying those to
// a new producer's MDOM either silently no-ops or corrupts state. Move
// them aside to a sibling `<overlay>/archive-<ts>` tiddler — preserves
// the user's work, lets them recover by hand, but stops the new producer
// from inheriting stale ops. The live overlay tiddler is cleared so the
// store starts fresh on the next produce cycle.
MindmapWidget.prototype.archiveOverlayIfProducerChanged = function () {
    if (!this.viewAttr || !this.overlayTitle) { return; }
    var view = this.wiki.getTiddler(this.viewAttr);
    if (!view) { return; }
    var newProducer = trim(view.fields["mm.producer"] || "");
    if (!newProducer || newProducer === this.producerName) { return; }
    var liveTiddler = this.wiki.getTiddler(this.overlayTitle);
    if (!liveTiddler) { return; }
    var liveText = trim(liveTiddler.fields.text || "");
    if (!liveText || liveText === "[]") { return; } // nothing to preserve
    var archiveTitle = this.overlayTitle + "/archive-" + Date.now();
    // Preserve all fields so type/tags etc. survive — only retitle + carry
    // over a couple of breadcrumb fields so the user can identify what it was.
    this.wiki.addTiddler(new $tw.Tiddler(liveTiddler, {
        title: archiveTitle,
        "mm.archived-from-producer": this.producerName,
        "mm.archived-at": "" + new Date().toISOString()
    }));
    // Empty the live overlay (don't delete — a missing tiddler would
    // reincarnate from a server-side source on next sync).
    this.wiki.addTiddler(new $tw.Tiddler(liveTiddler, { text: "" }));
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
        var results = producer.applyOps([op], this.effectiveProducerArgs(), this.wiki);
        for (var i = 0; i < results.length; i++) {
            var r = results[i];
            if (r && r.error) {
                console.error("[$mindmap] applyOps error", r);
            } else if (r && r.collisionResolved && r.newTitle) {
                this.notifySlugCollision(r);
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
    this.updateModebarTitle();
    if (!this.onSelectActions) { return; }
    this.invokeActionString(this.onSelectActions, this, null, {
        nodeId: nodeId || "",
        selectedNodeId: nodeId || ""
    });
};

MindmapWidget.prototype.recompose = function () {
    if (!this.lastBase) { return; }
    var composed = composer.compose(this.lastBase, this.composedOps());
    this.lastComposite = composed.mdom;
    this.lastOrphans = composed.orphans;
    if (this.engineInstance && typeof this.engineInstance.update === "function") {
        this.engineInstance.update(this.lastComposite);
    }
    this.updateToolbar();
};

// Pure: merge a saved-default op log and a live-overlay op log into the
// ordered list compose() expects. Defaults apply first, overlay overrides —
// `setAttr` is last-write-wins, so a per-entity override always beats the
// view-wide default for the same id/key. Either side may be undefined/null
// (returns the other) or empty (returns the other).
function mergeSavedAndOverlay(defaults, overlay) {
    var d = Array.isArray(defaults) ? defaults : [];
    var o = Array.isArray(overlay) ? overlay : [];
    if (d.length === 0) { return o; }
    if (o.length === 0) { return d; }
    return d.concat(o);
}

// Build the ordered op log that composes the engine view from the base MDOM.
// See mergeSavedAndOverlay for the precedence rules. Uses `peek()` so a
// debounce-pending overlay op is visible to compose() immediately —
// otherwise a recompose() between user-toggle and the 250ms flush would
// rebuild the engine with the OLD overlay, snapping a just-collapsed node
// back to expanded for a quarter second.
MindmapWidget.prototype.composedOps = function () {
    var defaults = this.savedDefaultTitle
        ? overlayStore.readOps(this.wiki, this.savedDefaultTitle)
        : [];
    var live = this.store ? this.store.peek() : [];
    return mergeSavedAndOverlay(defaults, live);
};

MindmapWidget.prototype.reproduce = function () {
    var baseTriple = this.produceBase();
    this.lastBase = baseTriple.mdom;
    this.lastRefreshFilter = baseTriple.refreshFilter;
    this.lastWatchedTitles = this.evaluateWatched(this.lastRefreshFilter);
    this.recompose();
};

// Forward refresh to the preview-pane widget tree so it picks up changes to
// the selected tiddler (body, slide tiddlers under it, edit state, inspect-
// mode). Called from refresh() before each early return — otherwise
// reproduce() / recompose() would short-circuit propagation and leave the
// right pane stale.
MindmapWidget.prototype.forwardPreviewRefresh = function (changedTiddlers) {
    if (this.previewWidget) {
        try { this.previewWidget.refresh(changedTiddlers); } catch (e) { /* ignore */ }
    }
};

// React to changes that affect the modebar's presentation choices or the
// actions-panel toggle button: any tiddler tagged as a presentation OR any
// title in our cached presentation list (covers deletions). Re-populates the
// dropdown and reflects new membership state in the toggle button.
MindmapWidget.prototype.refreshPresentationUI = function (changedTiddlers) {
    if (!this.viewAttr || !this.modebarSelect) { return; }
    var relevant = false;
    var cache = this.lastPresentations || [];
    for (var t in changedTiddlers) {
        var tiddler = this.wiki.getTiddler(t);
        if (tiddler && tiddler.fields) {
            var tags = $tw.utils.parseStringArray(tiddler.fields.tags || "");
            if (tags.indexOf(PRESENTATION_TAG) >= 0) { relevant = true; break; }
        }
        if (cache.indexOf(t) >= 0) { relevant = true; break; }
    }
    if (relevant) {
        this.lastPresentations = this.viewPresentations();
        this.populateModebarSelect();
        this.updatePreviewPaneVisibility();
    }
    // Active presentation's slides-order may have changed — update the
    // toggle button's add/remove label.
    var active = this.currentPresentationTitle();
    if (active && changedTiddlers[active]) {
        this.updateActionsVisibility();
    }
    // Slide-tiddler add/remove on owner nodes can flip the deck from
    // empty → non-empty (or vice versa) without touching the presentation
    // tiddler itself. Re-evaluate the modebar play-button on every refresh
    // so the affordance stays in sync.
    this.updateModebarPlayButton();
};

MindmapWidget.prototype.refresh = function (changedTiddlers) {
    var changedAttrs = this.computeAttributes();
    var rebuilders = ["view", "filter", "engine", "overlay", "flags", "class", "style", "height", "readonly"];
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
        // Decide whether the change demands a full teardown or just a
        // light-touch UI update. mm.producer / mm.engine / mm.overlay
        // switches require refreshSelf (new producer module, new engine
        // instance, new overlay tiddler). Other field changes —
        // mm.presentation, mm.label-field, mm.focus — should NOT tear down
        // the canvas: refreshSelf reinits mind-elixir (losing zoom/position
        // and risking duplicate-canvas symptoms) and resets the selection.
        var view = this.wiki.getTiddler(this.viewAttr);
        var newProducer = view ? trim(view.fields["mm.producer"] || "") : "";
        var newEngine = view ? trim(view.fields["mm.engine"] || "") : "";
        var newOverlay = view ? trim(view.fields["mm.overlay"] || "") : "";
        var structuralChange =
            (newProducer && newProducer !== this.producerName) ||
            (newEngine && newEngine !== this.engineName) ||
            (newOverlay && newOverlay !== this.overlayTitle);
        if (structuralChange) {
            // Overlay ops keyed by an old producer's id encoding would corrupt
            // the new producer's MDOM. Archive before teardown.
            this.archiveOverlayIfProducerChanged();
            this.refreshSelf();
            return true;
        }
        // Non-structural view fields changed. Update only what depends on
        // them: modebar dropdown (active presentation may have changed),
        // pane visibility, action panel toggle button. The preview widget
        // tree picks up field-level changes reactively via $let bindings.
        // refreshPresentationUI first so the dropdown re-populates with any
        // newly-created presentation tiddler BEFORE updateModebarSelectedValue
        // tries to select it — otherwise the new "pres:<title>" option doesn't
        // exist yet and the dropdown falls back to "body".
        this.refreshPresentationUI(changedTiddlers);
        this.updateModebarSelectedValue();
        this.updateActionsVisibility();
        this.updatePreviewPaneVisibility();
        this.forwardPreviewRefresh(changedTiddlers);
        return true;
    }
    // Focus state changes force a full re-produce (new MDOM root) and the
    // toolbar buttons need to re-evaluate visibility.
    if (changedTiddlers[this.focusStateTitle()]) {
        try { this.reproduce(); } catch (e) {
            console.error("[$mindmap] focus re-produce failed", e);
        }
        this.updateActionsVisibility();
        this.forwardPreviewRefresh(changedTiddlers);
        return true;
    }
    // Label-field switch: re-run the producer so every node's `label`
    // reflects the newly-chosen field (or the title fallback). The view-
    // tiddler change (handled above) already triggers a refreshSelf, so we
    // only need to react to the session-state override here.
    if (changedTiddlers[this.labelFieldStateTitle()]) {
        try { this.reproduce(); } catch (e) {
            console.error("[$mindmap] label-field re-produce failed", e);
        }
        if (this.labelFieldSelect) {
            this.labelFieldSelect.value = this.currentLabelField();
        }
        this.applyLabelFieldClasses();
        this.forwardPreviewRefresh(changedTiddlers);
        return true;
    }
    // Slides-only toggle: re-produce so the producer applies / un-applies
    // its pruning pass. Pressed-state of the toolbar button updates here too.
    if (changedTiddlers[this.slidesOnlyStateTitle()]) {
        try { this.reproduce(); } catch (e) {
            console.error("[$mindmap] slides-only re-produce failed", e);
        }
        this.updateSlidesOnlyButton();
        this.forwardPreviewRefresh(changedTiddlers);
        return true;
    }
    // View-pin toggle: no producer re-run; just flip pane visibility +
    // button pressed-state.
    if (changedTiddlers[this.viewPinnedStateTitle()]) {
        this.updateViewPinButton();
        this.updatePreviewPaneVisibility();
        this.forwardPreviewRefresh(changedTiddlers);
        return true;
    }
    // Inspect-mode switch: keep the JS-built modebar dropdown in sync and
    // update pane visibility (presentation mode shows pane even without a
    // selection). The wikitext content branch reads the state reactively so
    // its own re-render comes for free through forwardPreviewRefresh below.
    if (changedTiddlers[this.inspectModeStateTitle()]) {
        this.updateModebarSelectedValue();
        this.updatePreviewPaneVisibility();
    }
    if (baseChanged) {
        try { this.reproduce(); } catch (e) {
            console.error("[$mindmap] re-produce failed", e);
        }
        // CRITICAL: forward to preview even after reproduce. mm.slide-order
        // writes on the owner (slide add / move / remove) land on a watched
        // tiddler, which triggers baseChanged → we reproduce the MDOM AND
        // must still nudge the preview pane so the slide list re-evaluates
        // `[<owner>mm-slides[]]`. Without this the right pane goes stale until
        // an unrelated refresh (e.g. selecting a different tiddler).
        this.forwardPreviewRefresh(changedTiddlers);
        return true;
    }
    if (this.overlayTitle && changedTiddlers[this.overlayTitle]) {
        this.recompose();
        this.updateSavedStateButtons();
        this.forwardPreviewRefresh(changedTiddlers);
        return true;
    }
    // Flag-rule tiddler edits: reload rules and re-decorate. Cheap reproduce
    // because decoration is the only thing that depends on rule contents;
    // base MDOM is unchanged. Detect by inspecting tags on each changed
    // tiddler (and on the wiki's current tagged set, to catch deletions).
    if (this.flagsFilter) {
        var flagsChanged = false;
        for (var ct in changedTiddlers) {
            var ctt = this.wiki.getTiddler(ct);
            if (ctt && ctt.fields) {
                var tags = $tw.utils.parseStringArray(ctt.fields.tags || "");
                if (tags.indexOf(FLAG_RULE_TAG) >= 0) { flagsChanged = true; break; }
            }
            // Tiddler may have been deleted — check if its title was in the
            // last-resolved rule set.
            if (this.flagRules) {
                for (var fri = 0; fri < this.flagRules.length; fri++) {
                    if (this.flagRules[fri].sourceTitle === ct) { flagsChanged = true; break; }
                }
                if (flagsChanged) { break; }
            }
        }
        if (flagsChanged) {
            this.reloadFlagRules();
            try { this.reproduce(); } catch (e) {
                console.error("[$mindmap] flag-rule re-produce failed", e);
            }
            this.forwardPreviewRefresh(changedTiddlers);
            return true;
        }
    }
    // Saved-default tiddler edited externally (or by our save action). Re-
    // compose so the default layer reflects the new ops.
    if (this.savedDefaultTitle && changedTiddlers[this.savedDefaultTitle]) {
        this.recompose();
        this.updateSavedStateButtons();
        this.forwardPreviewRefresh(changedTiddlers);
        return true;
    }
    // Presentation tiddler add/remove/edit → repopulate dropdown + toggle btn.
    this.refreshPresentationUI(changedTiddlers);
    // Forward to the preview widget so it re-renders when the selected
    // tiddler's body changes or the preview-state tiddler is updated.
    this.forwardPreviewRefresh(changedTiddlers);
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

    // Title-mode warning banner. Always in the DOM; CSS reveals it only
    // when the container carries the .rr-mindmap-title-active class.
    this.titleModeWarning = this.document.createElement("span");
    this.titleModeWarning.className = "rr-mindmap-title-warning";
    this.titleModeWarning.textContent = "⚠ Title-mode — drag-rename rewrites tiddler titles (other modes only update the chosen field). Reparents cascade references in every mode.";
    this.toolbarNode.appendChild(this.titleModeWarning);

    // Slides-only filter toggle. Visible only when the producer advertises
    // `capabilities.slides` (currently knowledge-tree). When pressed, the
    // canvas shows only the spine of nodes that have at least one slide or
    // descend into a slide-bearing subtree.
    var producerForSlides = findProducerByName(this.producerName);
    if (producerForSlides && producerForSlides.capabilities && producerForSlides.capabilities.slides) {
        this.slidesOnlyBtn = this.document.createElement("button");
        this.slidesOnlyBtn.type = "button";
        this.slidesOnlyBtn.className = "rr-mindmap-toolbar-toggle rr-mindmap-slides-only-btn";
        this.slidesOnlyBtn.textContent = "Slides only";
        this.slidesOnlyBtn.title = "Show only nodes with slides (or descendants that have slides)";
        var slidesOnlySelf = this;
        this.slidesOnlyBtn.addEventListener("click", function () {
            slidesOnlySelf.toggleSlidesOnly();
        });
        this.toolbarNode.appendChild(this.slidesOnlyBtn);
        this.updateSlidesOnlyButton();
    }

    // "View" toggle — pins the preview pane open regardless of selection or
    // inspect-mode. Only meaningful when (a) we have a view tiddler (so the
    // modebar's Presentations group exists and the user has somewhere to
    // store mm.presentation) AND (b) the producer is structural (so node
    // selection maps to real tiddler content; the pane wouldn't be useful
    // for hand-crafted MDOM or filter= mode). Hidden otherwise.
    var producerForView = findProducerByName(this.producerName);
    var isStructuralForView = !!(producerForView && producerForView.capabilities &&
        producerForView.capabilities.structural);
    if (this.viewAttr && isStructuralForView) {
        this.viewPinBtn = this.document.createElement("button");
        this.viewPinBtn.type = "button";
        this.viewPinBtn.className = "rr-mindmap-toolbar-toggle rr-mindmap-view-pin-btn";
        this.viewPinBtn.textContent = "View";
        this.viewPinBtn.title = "Keep the right-hand view always open (otherwise it appears only when a node is selected or a presentation is active)";
        var viewPinSelf = this;
        this.viewPinBtn.addEventListener("click", function () {
            viewPinSelf.toggleViewPinned();
        });
        this.toolbarNode.appendChild(this.viewPinBtn);
        this.updateViewPinButton();
    }

    // Saved-state controls. Visible only when the view configures persistent
    // state (overlayTitle for the per-entity layer, savedDefaultTitle for
    // the view-wide default).
    //   - "Save as default" promotes current overlay ops into the saved-
    //     default tiddler. After this, any view-instance with no per-entity
    //     overlay ops starts from this state.
    //   - "Reset" clears the per-entity overlay tiddler so the canvas falls
    //     back to the saved default (or, if none, to template-defined
    //     initial-collapsed config).
    if (this.savedDefaultTitle) {
        this.saveDefaultBtn = this.document.createElement("button");
        this.saveDefaultBtn.type = "button";
        this.saveDefaultBtn.className = "rr-mindmap-toolbar-toggle rr-mindmap-save-default-btn";
        this.saveDefaultBtn.textContent = "💾 Save as default";
        this.saveDefaultBtn.title = "Snapshot the current view state (which branches are collapsed, etc.) as the default applied to any entity that hasn't been customised";
        var saveSelf = this;
        this.saveDefaultBtn.addEventListener("click", function () {
            saveSelf.saveCurrentAsDefault();
        });
        this.toolbarNode.appendChild(this.saveDefaultBtn);
    }
    if (this.overlayTitle) {
        this.resetOverlayBtn = this.document.createElement("button");
        this.resetOverlayBtn.type = "button";
        this.resetOverlayBtn.className = "rr-mindmap-toolbar-toggle rr-mindmap-reset-overlay-btn";
        this.resetOverlayBtn.textContent = "🔄 Reset";
        this.resetOverlayBtn.title = "Discard per-entity state and revert to the saved default (or, if none, to template defaults)";
        var resetSelf = this;
        this.resetOverlayBtn.addEventListener("click", function () {
            resetSelf.resetEntityOverlay();
        });
        this.toolbarNode.appendChild(this.resetOverlayBtn);
    }

    this.orphanBadge = this.document.createElement("button");
    this.orphanBadge.type = "button";
    this.orphanBadge.className = "rr-mindmap-orphan-badge";
    this.orphanBadge.style.display = "none";
    var orphanSelf = this;
    this.orphanBadge.addEventListener("click", function () { orphanSelf.pruneOrphans(); });
    this.toolbarNode.appendChild(this.orphanBadge);

    // Presentation selection lives in the preview-pane modebar dropdown
    // alongside Body / Slides — see renderPreviewChildren. Keeping it off
    // the canvas toolbar avoids two parallel selectors for "what should the
    // right pane show right now".

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

        // Label-field selector — chooses which tiddler field drives the
        // visible label. Options come from $:/config/rimir/mindmap/label-
        // fields (newline-separated; default: "title\ncaption"). The picked
        // value is written to a $:/state/ tiddler so it's session-scoped.
        var labelFieldSelect = this.document.createElement("select");
        labelFieldSelect.className = "rr-mindmap-label-field-select";
        labelFieldSelect.title = "Field used as the visible node label";
        var options = this.labelFieldOptions();
        var currentField = this.currentLabelField();
        for (var li = 0; li < options.length; li++) {
            var opt = this.document.createElement("option");
            opt.value = options[li];
            opt.textContent = options[li];
            if (options[li] === currentField) { opt.selected = true; }
            labelFieldSelect.appendChild(opt);
        }
        labelFieldSelect.addEventListener("change", function () {
            self.wiki.addTiddler(new $tw.Tiddler({
                title: self.labelFieldStateTitle(),
                text: labelFieldSelect.value
            }));
            // Apply immediate visual cue — refresh() will catch up but the
            // user expects feedback the instant they pick from the dropdown.
            self.applyLabelFieldClasses();
        });
        this.actionsPanel.appendChild(labelFieldSelect);
        this.labelFieldSelect = labelFieldSelect;

        // Inspect-mode lives in the preview pane's modebar (see
        // renderPreviewChildren) — it controls what the preview shows, so it
        // belongs above the preview, not floating over the canvas.

        // Presentation-membership toggle. Visible only when a node is
        // selected AND a presentation is active (otherwise the button has
        // nothing meaningful to do). Text flips between "+ Add" and "- Remove"
        // based on whether the node is already in the slides-order list.
        var presBtn = this.document.createElement("button");
        presBtn.type = "button";
        presBtn.className = "rr-mindmap-edit-btn rr-mindmap-presentation-toggle-btn";
        presBtn.textContent = "+";
        presBtn.style.display = "none";
        presBtn.addEventListener("click", function () { self.togglePresentationMembership(); });
        this.actionsPanel.appendChild(presBtn);
        this.presentationToggleBtn = presBtn;

        // The step-out state is independent of selection — update it once
        // at render time. handleSelect updates the others on selection change.
        this.updateActionsVisibility();
        this.applyLabelFieldClasses();
    }
};

// Visual cue for title-mode on a structural view: tints the canvas with a
// soft warning wash so the user knows drag-rename will mutate filesystem
// titles (and references will cascade via flibbles/relink). Caption / other
// label-fields keep the neutral canvas — only the chosen field changes.
MindmapWidget.prototype.applyLabelFieldClasses = function () {
    if (!this.containerNode) { return; }
    var producer = findProducerByName(this.producerName);
    var isStructural = !!(producer && producer.capabilities && producer.capabilities.structural);
    var titleMode = (this.currentLabelField() === "title");
    var cl = this.containerNode.classList;
    if (isStructural && titleMode) { cl.add("rr-mindmap-title-active"); }
    else { cl.remove("rr-mindmap-title-active"); }
};

// Read the list of pickable label fields. Newline-separated list (default
// "title\ncaption"). Returns an array, with "title" guaranteed to be present
// even when the user mis-configures.
MindmapWidget.prototype.labelFieldOptions = function () {
    var raw = this.wiki.getTiddlerText("$:/config/rimir/mindmap/label-fields", "title\ncaption");
    var fields = [];
    var seen = Object.create(null);
    var lines = (raw || "").split("\n");
    for (var i = 0; i < lines.length; i++) {
        var f = trim(lines[i]);
        if (f && !seen[f]) { fields.push(f); seen[f] = true; }
    }
    if (!seen.title) { fields.unshift("title"); }
    return fields;
};

// Compute which buttons should be visible right now and apply.
MindmapWidget.prototype.updateActionsVisibility = function () {
    if (!this.actionsPanel) { return; }
    var selectedTitle = this.selectedBackingTitle();
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
    // Presentation-toggle button — visible only when a node is selected AND a
    // presentation is active for this view.
    if (this.presentationToggleBtn) {
        var presentationTitle = this.currentPresentationTitle();
        if (selectedTitle && presentationTitle) {
            var isMember = this.presentationIncludes(presentationTitle, selectedTitle);
            this.presentationToggleBtn.style.display = "";
            this.presentationToggleBtn.textContent = isMember ? "−" : "+";
            this.presentationToggleBtn.title = (isMember
                ? "Remove this node from presentation: "
                : "Add this node to presentation: ") + presentationTitle;
        } else {
            this.presentationToggleBtn.style.display = "none";
        }
    }
    // Panel itself stays visible — the label-field selector is global UI
    // that should always be reachable, not gated on a selection.
    this.actionsPanel.style.display = "";
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

// Flip the slides-only state. refresh() picks up the change via the
// slidesOnlyStateTitle branch and re-runs produce().
MindmapWidget.prototype.toggleSlidesOnly = function () {
    var on = this.currentSlidesOnly();
    this.wiki.addTiddler(new $tw.Tiddler({
        title: this.slidesOnlyStateTitle(),
        text: on ? "" : "yes"
    }));
};

// Reflect the slides-only state in the toolbar button's pressed class and
// label, and stamp/clear a container class so CSS can target slide-bearing
// nodes selectively (only-while-pruning, to avoid the indicator showing up
// when the whole tree is visible). Called from renderToolbar (initial
// render) and refresh() when the state tiddler changes.
// Mirror the View-pin state into the toolbar button's pressed class.
MindmapWidget.prototype.updateViewPinButton = function () {
    if (!this.viewPinBtn) { return; }
    var on = this.currentViewPinned();
    this.viewPinBtn.classList.toggle("rr-mindmap-toolbar-toggle-active", on);
    this.viewPinBtn.setAttribute("aria-pressed", on ? "true" : "false");
};

MindmapWidget.prototype.updateSlidesOnlyButton = function () {
    var on = this.currentSlidesOnly();
    if (this.slidesOnlyBtn) {
        this.slidesOnlyBtn.classList.toggle("rr-mindmap-toolbar-toggle-active", on);
        this.slidesOnlyBtn.setAttribute("aria-pressed", on ? "true" : "false");
    }
    if (this.containerNode) {
        this.containerNode.classList.toggle("rr-mindmap-slides-only-active", on);
    }
};

// Handler for the rr-mindmap-add-slide custom message dispatched from the
// "+ Add slide" button in the slide pane. Creates a new blank slide tiddler
// under `paramObject.owner` and writes the new slide's title to the slide-
// editing state so it opens in edit mode immediately (user just types).
MindmapWidget.prototype.handleAddSlide = function (event) {
    var owner = event && event.paramObject && event.paramObject.owner;
    if (!owner) { return; }
    var slideTiddlers = require("$:/plugins/rimir/mindmap/lib/slide-tiddlers.js");
    var newTitle = slideTiddlers.addSlide(this.wiki, owner);
    if (!newTitle) { return; }
    var key = this.previewStateKey();
    this.wiki.addTiddler(new $tw.Tiddler({
        title: "$:/state/rimir/mindmap/" + key + "/slide-editing",
        text: newTitle
    }));
};

// Handler for the rr-mindmap-select-node-by-title custom message dispatched
// from the presentation pane. Translates the supplied tiddler title back into
// a producer node-id via the producer's idForTitle helper, then asks the
// engine to focus/highlight it. Also updates the widget's selectedNodeId so
// the actions panel + preview pane reflect the new selection.
MindmapWidget.prototype.handleSelectNodeByTitle = function (event) {
    var title = event && event.paramObject && event.paramObject.title;
    if (!title) { return; }
    var producer = findProducerByName(this.producerName);
    if (!producer || typeof producer.idForTitle !== "function") { return; }
    var nodeId = producer.idForTitle(title);
    if (!nodeId) { return; }
    // Ask the engine to focus the node (mind-elixir: centers + selects it).
    // The adapter may or may not implement focus — guard accordingly.
    if (this.engineInstance && typeof this.engineInstance.focus === "function") {
        try { this.engineInstance.focus(nodeId); } catch (e) { /* engine bug, ignore */ }
    }
    // Synthesize a selection update so the actions panel + preview pane catch
    // up. The engine may also emit its own select event but we don't rely on
    // that — different engines behave differently after focus().
    this.handleSelect(nodeId);
};

// Resolve the currently-selected node id to its backing tiddler title via
// the producer's titleForOp helper. Returns null when no selection, no
// producer mapping, or the resolved title doesn't exist in the wiki.
MindmapWidget.prototype.selectedBackingTitle = function () {
    var producer = findProducerByName(this.producerName);
    if (!producer || typeof producer.titleForOp !== "function") { return null; }
    var id = this.selectedNodeId;
    if (!id) { return null; }
    var title = producer.titleForOp({ op: "rename", id: id });
    if (!title || !this.wiki.getTiddler(title)) { return null; }
    return title;
};

// Toggle the currently-selected node's membership in the active presentation's
// `mm.slides-order` list. Add if absent; remove if present. No-op when no
// presentation is active or no node is selected.
MindmapWidget.prototype.togglePresentationMembership = function () {
    var presentationTitle = this.currentPresentationTitle();
    if (!presentationTitle) { return; }
    var nodeTitle = this.selectedBackingTitle();
    if (!nodeTitle) { return; }
    var p = this.wiki.getTiddler(presentationTitle);
    if (!p) { return; }
    var list = $tw.utils.parseStringArray(p.fields["mm.slides-order"] || "");
    var idx = list.indexOf(nodeTitle);
    var next;
    if (idx >= 0) {
        next = list.slice();
        next.splice(idx, 1);
    } else {
        next = list.concat([nodeTitle]);
    }
    this.wiki.addTiddler(new $tw.Tiddler(p, {
        "mm.slides-order": $tw.utils.stringifyList(next)
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
    if (this.orphanBadge) {
        var n = (this.lastOrphans || []).length;
        if (n > 0) {
            this.orphanBadge.textContent = "⚠ " + n + " orphan op" + (n === 1 ? "" : "s");
            this.orphanBadge.title = "Overlay ops whose target id is missing from the current base — typically left over from a tiddler rename or reparent. Click to prune (irreversible).";
            this.orphanBadge.style.display = "";
        } else {
            this.orphanBadge.style.display = "none";
        }
    }
    this.updateSavedStateButtons();
};

// Saved-default + reset buttons share their enabled state with the actual
// content of the underlying tiddlers — there's nothing to save when the
// overlay is empty, and nothing to reset when there's no per-entity layer.
// Reflect that here so users get visual feedback that the gesture is no-op
// before they click. Uses `peek()` so just-appended (in-memory, debounce-
// pending) ops count immediately, not only after the wiki write lands.
MindmapWidget.prototype.updateSavedStateButtons = function () {
    var live = this.store ? this.store.peek() : [];
    if (this.saveDefaultBtn) {
        var current = this.savedDefaultTitle
            ? overlayStore.readOps(this.wiki, this.savedDefaultTitle)
            : [];
        var sameAsDefault = JSON.stringify(live) === JSON.stringify(current);
        this.saveDefaultBtn.disabled = sameAsDefault;
        this.saveDefaultBtn.classList.toggle("rr-mindmap-toolbar-toggle-disabled", sameAsDefault);
    }
    if (this.resetOverlayBtn) {
        var hasLive = live.length > 0;
        this.resetOverlayBtn.disabled = !hasLive;
        this.resetOverlayBtn.classList.toggle("rr-mindmap-toolbar-toggle-disabled", !hasLive);
    }
};

// Copy the current per-entity overlay into the view-wide saved-default
// tiddler. After this, any view-instance whose overlay is empty (e.g. a
// freshly-opened entity that's never been touched) renders with this state.
// Idempotent: if the default already matches the overlay, a no-op write
// still goes through; the comparison happens at the button-enabled level.
// We peek() rather than read() so a just-appended op that hasn't flushed
// yet still makes it into the snapshot — the user expects "Save" to capture
// the visible state.
MindmapWidget.prototype.saveCurrentAsDefault = function () {
    if (!this.savedDefaultTitle) { return; }
    var ops = this.store ? this.store.peek() : [];
    overlayStore.writeOps(this.wiki, this.savedDefaultTitle, ops);
    this.updateSavedStateButtons();
};

// Clear the per-entity overlay tiddler. The canvas falls back to the
// saved-default (if configured) or the template's initially-collapsed-*
// config. Doesn't touch the saved-default itself.
MindmapWidget.prototype.resetEntityOverlay = function () {
    if (!this.overlayTitle || !this.store) { return; }
    this.store.replace([]);
    this.store.flush();
    this.updateSavedStateButtons();
};

// Drop the orphan ops from the overlay store. Indices recorded by compose
// point into the original op list; we filter by index instead of by
// reference so dup-prone deserialised ops are removed exactly once.
MindmapWidget.prototype.pruneOrphans = function () {
    if (!this.store || !this.lastOrphans || !this.lastOrphans.length) { return; }
    var n = this.lastOrphans.length;
    var ok = $tw.utils.confirm
        ? $tw.utils.confirm("Discard " + n + " orphan op" + (n === 1 ? "" : "s") + "? Cannot be undone.")
        : window.confirm("Discard " + n + " orphan op" + (n === 1 ? "" : "s") + "? Cannot be undone.");
    if (!ok) { return; }
    var drop = Object.create(null);
    for (var i = 0; i < this.lastOrphans.length; i++) { drop[this.lastOrphans[i].index] = true; }
    var ops = this.store.read();
    var kept = [];
    for (var j = 0; j < ops.length; j++) { if (!drop[j]) { kept.push(ops[j]); } }
    this.store.replace(kept);
    this.store.flush();
    // recompose + redraw immediately; refresh() on the overlay change will
    // happen too but flushing makes the toolbar count update without lag.
    this.recompose();
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
    if (this.unbindPlayHotkey) { this.unbindPlayHotkey(); this.unbindPlayHotkey = null; }
};

// Does the given presentation tiddler resolve to ≥1 slide? Used to gate the
// modebar play button and the Shift+F2 hotkey so neither opens an empty
// deck. Evaluating `[mm-presentation-slides[]]` lazily here keeps the check
// honest — adding/removing slides on owner nodes flows through immediately.
MindmapWidget.prototype.presentationHasSlides = function (presentationTitle) {
    if (!presentationTitle) { return false; }
    var slides = this.wiki.filterTiddlers(
        "[mm-presentation-slides[]]",
        null,
        this.wiki.makeTiddlerIterator([presentationTitle])
    );
    return slides.length > 0;
};

// Start the fullscreen player for the currently-active presentation on this
// view. Used by both the modebar ▶ button and the Shift+F2 hotkey. Returns
// true when the deck was actually opened (visible to the hotkey so it can
// preventDefault selectively).
MindmapWidget.prototype.startPresentation = function () {
    var presentationTitle = this.currentPresentationTitle && this.currentPresentationTitle();
    if (!this.presentationHasSlides(presentationTitle)) { return false; }
    this.wiki.addTiddler(new $tw.Tiddler({
        title: "$:/state/rimir/mindmap/present-target",
        text: presentationTitle
    }));
    this.wiki.addTiddler(new $tw.Tiddler({
        title: "$:/state/rimir/mindmap/present-open",
        text: "yes"
    }));
    return true;
};

// Shift+F2 launches the active presentation. Scoped to keydowns inside the
// container so multiple mindmaps don't fight; the canvas grabs focus on
// click. F2 alone is taken by the edit-node intercept in the adapter, so
// we layer on Shift. The browser leaves Shift+F2 unbound — preventDefault
// is just belt-and-suspenders.
MindmapWidget.prototype.bindPlayHotkey = function () {
    if (!this.containerNode) { return; }
    var self = this;
    var handler = function (ev) {
        if (ev.key !== "F2" || !ev.shiftKey) { return; }
        var t = ev.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
            return;
        }
        if (self.startPresentation()) { ev.preventDefault(); }
    };
    this.containerNode.addEventListener("keydown", handler);
    this.unbindPlayHotkey = function () {
        if (self.containerNode) { self.containerNode.removeEventListener("keydown", handler); }
    };
};

// Show/hide the modebar ▶ button based on inspect-mode + deck content. Call
// from any code path that touches inspect-mode state or the active
// presentation.
MindmapWidget.prototype.updateModebarPlayButton = function () {
    if (!this.modebarPlayBtn) { return; }
    var show = this.currentInspectMode &&
        this.currentInspectMode() === "presentation" &&
        this.presentationHasSlides(this.currentPresentationTitle());
    this.modebarPlayBtn.style.display = show ? "" : "none";
};

// Show/hide the modebar ✎ edit button. Visible only when a tiddler-backed
// node is selected AND inspect mode is "body" — the editor only writes the
// owning tiddler's text field; slides / presentation modes have their own
// edit affordances.
MindmapWidget.prototype.updateModebarEditButton = function () {
    if (!this.modebarEditBtn) { return; }
    var show = !!this.selectedBackingTitle() &&
        this.currentInspectMode &&
        this.currentInspectMode() === "body";
    this.modebarEditBtn.style.display = show ? "" : "none";
};

// Flip the preview pane into edit mode for the currently-selected node.
// Wired to the modebar ✎ button. Idempotent — already-editing just rewrites
// "yes".
MindmapWidget.prototype.openBodyEditor = function () {
    if (!this.selectedBackingTitle()) { return; }
    this.wiki.addTiddler({
        title: this.previewEditStateTitle(),
        text: "yes"
    });
};

exports.mindmap = MindmapWidget;

// Exposed for unit tests — pure decision functions extracted from widget
// instance methods so their behaviour can be pinned without DOM rendering.
exports._isPreviewPaneVisible = isPreviewPaneVisible;
exports._resolveAllowNodeCreation = resolveAllowNodeCreation;
exports._mergeSavedAndOverlay = mergeSavedAndOverlay;
// Re-export the flag-decoration helpers so tests can pin both the loader and
// the decorator from a single import surface alongside the rest of the
// widget's pure functions.
exports._loadFlagRules = flagDecorate.loadFlagRules;
exports._decorateFlags = flagDecorate.decorateFlags;
