/*
 * ExtendScript side of the Copal panel.
 *
 * The palette files are read and written by the panel's Node context, so
 * After Effects is only asked for what it alone can do: say where the
 * project lives, read the paint off the selection, and write paint back.
 * That also means the panel works without the preference that lets scripts
 * write files.
 *
 * Every entry point returns a string of the form "OK|payload" or "ERR|reason"
 * because evalScript can only hand a string back to the panel.
 */

#include "lib/json.jsx"
#include "lib/CopalCore.jsx"
#include "lib/CopalSampler.jsx"

var CopalHost = (function () {

    function ok(payload)  { return 'OK|' + (payload === undefined ? '' : String(payload)); }
    function err(reason)  { return 'ERR|' + String(reason); }

    /* The selected shape layers of the composition being worked on, or a
     * sentence saying what is missing. */
    function selection() {
        var comp = app.project ? app.project.activeItem : null;
        if (!(comp && comp instanceof CompItem)) {
            return { error: 'Open a composition and select a shape layer.' };
        }
        var layers = [];
        var selected = comp.selectedLayers;
        for (var i = 0; i < selected.length; i++) {
            if (CopalCore.isShapeLayer(selected[i])) layers.push(selected[i]);
        }
        if (!layers.length) {
            return { error: selected.length ? 'The selection has no shape layer in it.'
                                            : 'Select a shape layer first.' };
        }
        return { comp: comp, layers: layers, selected: selected };
    }

    /* The folder the project is saved in, or nothing for an unsaved project.
     * The panel keeps the project's palettes there. */
    function projectDir() {
        try {
            var file = app.project ? app.project.file : null;
            return ok(file ? file.parent.fsName : '');
        } catch (e) {
            return err(e.toString());
        }
    }

    /*
     * Reads the fill and stroke off the first selected shape layer, as JSON.
     *
     * A gradient comes back with the samples of its ramp in place of colour
     * stops, which the panel works out from them. Reading one builds and
     * removes a temporary composition, so it is wrapped as one undo step,
     * and a step that leaves the project as it found it.
     */
    function capture() {
        var undoOpen = false;
        try {
            var sel = selection();
            if (sel.error) return err(sel.error);

            var layer = sel.layers[0];
            var found = CopalCore.capture(layer);
            if (!found.fill && !found.stroke) {
                return err('"' + layer.name + '" has no fill or stroke to save.');
            }

            var kinds = ['fill', 'stroke'];
            for (var i = 0; i < kinds.length; i++) {
                var paint = found[kinds[i]];
                if (!paint || !paint.gradient) continue;
                if (!undoOpen) {
                    app.beginUndoGroup('Read gradient for Copal');
                    undoOpen = true;
                }
                var read = CopalSampler.read(app.project, layer, paint.path, sel.comp.time);
                paint.gradient.start = read.start;
                paint.gradient.end = read.end;
                paint.samples = read.samples;
                delete paint.path;
            }
            if (undoOpen) { app.endUndoGroup(); undoOpen = false; }

            return ok(CopalJson.stringify(found));
        } catch (e) {
            if (undoOpen) { try { app.endUndoGroup(); } catch (e2) {} }
            return err(e.toString());
        }
    }

    function deselectProperties(layer) {
        var props = layer.selectedProperties;
        for (var i = props.length - 1; i >= 0; i--) {
            try { props[i].selected = false; } catch (e) {}
        }
    }

    /*
     * What the paint logic calls to bring a gradient into being: it applies
     * the preset the panel wrote for it.
     *
     * applyPreset does not act on the layer it is called on. It acts on
     * whichever layers are selected, makes a new solid if none are, and does
     * nothing at all while a property is selected. So the layer is made the
     * only thing selected first. apply() puts the selection back.
     */
    function gradientMaker(comp, presets) {
        return {
            selectionChanged: false,
            gradient: function (layer, kind) {
                var file = new File(presets[kind]);
                if (!file.exists) throw new Error('The gradient preset is missing.');
                this.selectionChanged = true;
                var selected = comp.selectedLayers;
                for (var i = 0; i < selected.length; i++) selected[i].selected = false;
                layer.selected = true;
                deselectProperties(layer);
                layer.applyPreset(file);
                deselectProperties(layer);
            },

            /*
             * Groups children of the layer's Contents, by position, with the
             * Group Shapes command. A script has no other way to move a shape
             * property from one group into another, and a gradient can only
             * be made at the top level, so this is how one reaches a group.
             *
             * The command acts on what is selected. If nothing comes of it,
             * the viewer is made active and it is tried once more, since a
             * menu command can depend on which panel last had the focus.
             */
            group: function (layer, indices) {
                this.selectionChanged = true;
                var root = function () { return layer.property('ADBE Root Vectors Group'); };
                var count = root().numProperties;
                selectOnly(comp, layer);
                for (var i = 0; i < indices.length; i++) root().property(indices[i]).selected = true;
                app.executeCommand(GROUP_SHAPES);
                if (root().numProperties === count) {
                    try { app.activeViewer.setActive(); } catch (e) {}
                    app.executeCommand(GROUP_SHAPES);
                }
                deselectProperties(layer);
            },

            /* Takes a group apart again, leaving what it held in its place. */
            ungroup: function (layer, path) {
                this.selectionChanged = true;
                selectOnly(comp, layer);
                CopalCore.at(layer, path).selected = true;
                app.executeCommand(UNGROUP_SHAPES);
                deselectProperties(layer);
            }
        };
    }

    function selectOnly(comp, layer) {
        var selected = comp.selectedLayers;
        for (var i = 0; i < selected.length; i++) selected[i].selected = false;
        layer.selected = true;
        deselectProperties(layer);
    }

    /* Looked up by name where the menus are in English, and by the numbers
     * they have had for years where they are not. */
    function commandId(name, fallback) {
        try { return app.findMenuCommandId(name) || fallback; } catch (e) { return fallback; }
    }
    var GROUP_SHAPES = commandId('Group Shapes', 3741);
    var UNGROUP_SHAPES = commandId('Ungroup Shapes', 3742);

    /*
     * Applies a palette to every selected shape layer as one undo step.
     * fillPreset and strokePreset are the files that carry the colours of a
     * gradient fill and stroke, when the palette has them.
     *
     * Replies with the number of layers painted, paints changed, paints
     * added, settings After Effects refused, layers left alone, and why.
     */
    function apply(paletteJson, fillPreset, strokePreset) {
        var undoOpen = false;
        var sel = null;
        var env = null;
        try {
            var palette = CopalJson.parse(paletteJson);
            sel = selection();
            if (sel.error) return err(sel.error);

            // Read before anything is applied: applying a gradient to the
            // first layer clears the selection the later ones are read from.
            var targets = [];
            var i;
            for (i = 0; i < sel.layers.length; i++) targets.push(CopalCore.targetsFor(sel.layers[i]));

            env = gradientMaker(sel.comp, { fill: fillPreset, stroke: strokePreset });
            var report = CopalCore.newReport(sel.comp.time);
            app.beginUndoGroup('Apply Copal palette');
            undoOpen = true;
            for (i = 0; i < sel.layers.length; i++) {
                CopalCore.applyTo(sel.layers[i], palette, report, env, targets[i]);
            }
            if (env.selectionChanged) {
                restoreSelection(sel);
                reselectGroups(sel.layers, targets);
            }
            app.endUndoGroup();
            undoOpen = false;

            return ok([report.layers, report.paints, report.added, report.failed, report.refused, report.reason].join('|'));
        } catch (e) {
            if (env && env.selectionChanged) restoreSelection(sel);
            if (undoOpen) { try { app.endUndoGroup(); } catch (e2) {} }
            return err(e.toString());
        }
    }

    /* The layers that were selected, selected again. Which properties were
     * selected inside them is not put back. Only called when a gradient had
     * to change the selection, so applying a solid palette leaves a selected
     * group selected for the next one. */
    function restoreSelection(sel) {
        try {
            var now = sel.comp.selectedLayers;
            var i;
            for (i = 0; i < now.length; i++) now[i].selected = false;
            for (i = 0; i < sel.selected.length; i++) sel.selected[i].selected = true;
        } catch (e) {}
    }

    /*
     * Selects again the top-level group each target was in. Without this,
     * a group that has just been given a gradient is no longer selected, and
     * the next palette tried on it would paint the whole layer instead.
     * Wrapping keeps a group's position, so the old position still finds it.
     */
    function reselectGroups(layers, targets) {
        for (var i = 0; i < layers.length; i++) {
            for (var j = 0; j < targets[i].length; j++) {
                var path = targets[i][j].path;
                if (path.length < 2) continue;
                try {
                    var group = CopalCore.at(layers[i], path.slice(0, 2));
                    if (group) group.selected = true;
                } catch (e) {}
            }
        }
    }

    return {
        projectDir: projectDir,
        capture: capture,
        apply: apply
    };
})();
