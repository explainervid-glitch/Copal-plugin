/*
 * Reads the fill and stroke of a shape layer and writes them back.
 *
 * Nothing here touches the application object, only layers and properties
 * handed in from outside, so the Node test harness can run the same file
 * against a stand-in property tree.
 *
 * Properties are reached through a path of steps from the layer rather than
 * by holding on to them. Adding, moving or removing a child of a shape's
 * Contents makes After Effects throw away every reference to the other
 * children, so anything kept across one of those calls is dead. A path is
 * walked again each time and is never stale.
 *
 * Gradients are the awkward part. After Effects gives a script every
 * property of a gradient fill except its colours, which can be neither read
 * nor set. Reading is done elsewhere, by rendering the gradient and looking
 * at the pixels. Writing is done by applying a small animation preset that
 * carries the colours, and a preset can only ever add a new gradient at the
 * top level of a layer's Contents. It cannot recolour one that exists or
 * put one inside a group. So a palette with a gradient in it is applied to
 * the layer as a whole, with its paints at the top level, where they paint
 * every shape in the layer.
 */

var CopalCore = (function () {

    var LAYER = 'ADBE Vector Layer';
    var ROOT = 'ADBE Root Vectors Group';
    var GROUP = 'ADBE Vector Group';
    var CONTENTS = 'ADBE Vectors Group';
    var FILL = 'ADBE Vector Graphic - Fill';
    var STROKE = 'ADBE Vector Graphic - Stroke';
    var GFILL = 'ADBE Vector Graphic - G-Fill';
    var GSTROKE = 'ADBE Vector Graphic - G-Stroke';
    var DASHES = 'ADBE Vector Stroke Dashes';
    var DASH_OFFSET = 'ADBE Vector Stroke Offset';
    var TAPER = 'ADBE Vector Stroke Taper';
    var WAVE = 'ADBE Vector Stroke Wave';
    var GRAD_START = 'ADBE Vector Grad Start Pt';
    var GRAD_END = 'ADBE Vector Grad End Pt';
    var EFFECTS = 'ADBE Effect Parade';
    var TEXT = 'ADBE Text Properties';
    var TEXT_DOCUMENT = 'ADBE Text Document';
    var TEXT_ANIMATORS = 'ADBE Text Animators';

    /* The things a fill or stroke paints. A container holding none of these
     * has nothing to paint, so nothing is added to it. */
    var SHAPES = {};
    SHAPES['ADBE Vector Shape - Group'] = true;
    SHAPES['ADBE Vector Shape - Rect'] = true;
    SHAPES['ADBE Vector Shape - Ellipse'] = true;
    SHAPES['ADBE Vector Shape - Star'] = true;

    /* Saved name, then the property it is read from. A third entry of true
     * marks a property that is hidden in some states, where failing to set it
     * is expected and not worth reporting.
     *
     * The gradient kinds of fill and stroke share these match names, apart
     * from colour, which they do not have. A missing property is skipped both
     * ways, so the same tables serve all four kinds of paint. */
    var FILL_PROPS = [
        ['color',     'ADBE Vector Fill Color'],
        ['opacity',   'ADBE Vector Fill Opacity'],
        ['fillRule',  'ADBE Vector Fill Rule'],
        ['blendMode', 'ADBE Vector Blend Mode'],
        ['composite', 'ADBE Vector Composite Order']
    ];

    var STROKE_PROPS = [
        ['color',      'ADBE Vector Stroke Color'],
        ['opacity',    'ADBE Vector Stroke Opacity'],
        ['width',      'ADBE Vector Stroke Width'],
        ['lineCap',    'ADBE Vector Stroke Line Cap'],
        ['lineJoin',   'ADBE Vector Stroke Line Join'],
        // Only shown while the join is a miter.
        ['miterLimit', 'ADBE Vector Stroke Miter Limit', true],
        ['blendMode',  'ADBE Vector Blend Mode'],
        ['composite',  'ADBE Vector Composite Order']
    ];

    /* What a script can reach of a gradient. The start and end points are
     * handled apart, because they are saved relative to the shape. */
    var GRADIENT_PROPS = [
        ['type',            'ADBE Vector Grad Type'],
        // Only shown for a radial gradient.
        ['highlightLength', 'ADBE Vector Grad HiLite Length', true],
        ['highlightAngle',  'ADBE Vector Grad HiLite Angle', true]
    ];

    /* In the order After Effects adds them, which is also the order they are
     * saved in: a palette's dashes are simply the values of the first few. */
    var DASH_NAMES = [
        'ADBE Vector Stroke Dash 1', 'ADBE Vector Stroke Gap 1',
        'ADBE Vector Stroke Dash 2', 'ADBE Vector Stroke Gap 2',
        'ADBE Vector Stroke Dash 3', 'ADBE Vector Stroke Gap 3'
    ];

    /* The names given to gradient paints put at the top level, so the next
     * palette can find the ones this panel made and clear them away. */
    var OURS = { fill: 'Copal Fill', stroke: 'Copal Stroke' };

    function isShapeLayer(layer) {
        return !!layer && layer.matchName === LAYER;
    }

    function isNumber(v) {
        return typeof v === 'number' && isFinite(v);
    }

    function round(v) {
        return Math.round(v * 10000) / 10000;
    }

    function isFillKind(name) { return name === FILL || name === GFILL; }
    function isStrokeKind(name) { return name === STROKE || name === GSTROKE; }

    /* A gradient the panel could have written a preset for. The panel asks
     * the same in CopalGradient.isGradient, and the two must agree: a
     * palette the panel takes for solid arrives here with no preset. */
    function isGradient(paint) {
        var g = paint ? paint.gradient : null;
        return !!g && typeof g === 'object' && rows(g.colors, 2, 4) && rows(g.alphas, 1, 2);
    }

    /* Whether list holds at least count rows of at least width numbers. */
    function rows(list, count, width) {
        if (!(list instanceof Array) || list.length < count) return false;
        for (var i = 0; i < list.length; i++) {
            var row = list[i];
            if (!(row instanceof Array) || row.length < width) return false;
            for (var j = 0; j < row.length; j++) {
                if (!isNumber(row[j])) return false;
            }
        }
        return true;
    }

    /* ------------------------------------------------------------ paths */

    function at(layer, path) {
        var p = layer;
        for (var i = 0; i < path.length; i++) {
            p = p.property(path[i]);
            if (!p) return null;
        }
        return p;
    }

    /* Children of Contents are numbered, because two fills in one group share
     * a match name. Everything else is reached by match name, which does not
     * move when a sibling is added. */
    function pathOf(prop) {
        var path = [];
        var p = prop;
        while (p && p.propertyDepth > 0) {
            var parent = p.parentProperty;
            var parentName = parent ? parent.matchName : '';
            path.unshift(parentName === ROOT || parentName === CONTENTS ? p.propertyIndex : p.matchName);
            p = parent;
        }
        return path;
    }

    /* ---------------------------------------------------------- targets */

    /*
     * What a selected property stands for. Selecting a colour means its fill,
     * selecting a path means the group it sits in, and anything outside
     * Contents, such as the layer's own transform, means nothing.
     */
    function targetOf(prop) {
        var p = prop;
        while (p && p.propertyDepth > 0) {
            var name = p.matchName;
            if (isFillKind(name)) return { kind: 'fill', prop: p };
            if (isStrokeKind(name)) return { kind: 'stroke', prop: p };
            if (name === GROUP) return { kind: 'group', prop: p };
            if (name === ROOT) return { kind: 'root', prop: p };
            p = p.parentProperty;
        }
        return null;
    }

    /*
     * The parts of a layer the selection points at, or the whole of its
     * Contents when nothing inside it is selected.
     *
     * After Effects can report a group as selected alongside the property
     * inside it that was actually clicked. Treating that group as a target
     * would repaint everything in it, so a target with another target inside
     * it is dropped and the narrower one is kept.
     */
    function targetsFor(layer) {
        var selected = layer.selectedProperties || [];
        var found = [];
        var seen = {};
        var i, j;

        for (i = 0; i < selected.length; i++) {
            var target = targetOf(selected[i]);
            if (!target) continue;
            var path = pathOf(target.prop);
            var key = path.join('/');
            if (seen[key] === true) continue;
            seen[key] = true;
            found.push({ kind: target.kind, path: path, key: key });
        }

        var out = [];
        for (i = 0; i < found.length; i++) {
            var holdsAnother = false;
            for (j = 0; j < found.length; j++) {
                if (j !== i && found[j].key.indexOf(found[i].key + '/') === 0) {
                    holdsAnother = true;
                    break;
                }
            }
            if (!holdsAnother) out.push(found[i]);
        }

        if (!out.length) out.push({ kind: 'root', path: [ROOT], key: ROOT });
        return out;
    }

    /* ---------------------------------------------------------- reading */

    function valueOf(prop) {
        var v;
        try { v = prop.value; } catch (e) { return undefined; }
        if (isNumber(v)) return round(v);
        if (v instanceof Array) {
            var out = [];
            for (var i = 0; i < v.length; i++) {
                if (!isNumber(v[i])) return undefined;
                out.push(round(v[i]));
            }
            return out;
        }
        return undefined;
    }

    function readProps(group, table, into) {
        var out = into || {};
        for (var i = 0; i < table.length; i++) {
            var prop = group.property(table[i][1]);
            if (!prop) continue;
            var v = valueOf(prop);
            if (v === undefined) continue;
            // After Effects hands back an alpha that a shape colour never uses.
            if (table[i][0] === 'color' && v instanceof Array) v = v.slice(0, 3);
            out[table[i][0]] = v;
        }
        return out;
    }

    /* Every numeric property in a group, by match name. Used for taper and
     * wave, which newer versions keep adding to. */
    function readGroup(group) {
        if (!group) return undefined;
        var out = {};
        var any = false;
        for (var i = 1; i <= group.numProperties; i++) {
            var prop = group.property(i);
            var v = valueOf(prop);
            if (v === undefined) continue;
            out[prop.matchName] = v;
            any = true;
        }
        return any ? out : undefined;
    }

    /*
     * Whether a dash, a gap or the dash offset has been added to the stroke.
     *
     * All of them exist on every stroke and stay hidden until added, and a
     * hidden one still reports a value. The sign that one is showing is that
     * it can take an expression. canAddProperty looks like the obvious test
     * and is no use: After Effects answers true whether or not the dash is
     * already there.
     */
    function isLive(dashes, name) {
        var prop = dashes.property(name);
        if (!prop) return false;
        try { return prop.canSetExpression === true; } catch (e) { return false; }
    }

    function readStroke(stroke) {
        var out = readProps(stroke, STROKE_PROPS);

        out.dashes = [];
        var dashes = stroke.property(DASHES);
        if (dashes) {
            for (var i = 0; i < DASH_NAMES.length; i++) {
                if (!isLive(dashes, DASH_NAMES[i])) break;
                var v = valueOf(dashes.property(DASH_NAMES[i]));
                if (v === undefined) break;
                out.dashes.push(v);
            }
            if (out.dashes.length && isLive(dashes, DASH_OFFSET)) {
                var offset = valueOf(dashes.property(DASH_OFFSET));
                if (offset !== undefined) out.dashOffset = offset;
            }
        }

        var taper = readGroup(stroke.property(TAPER));
        if (taper) out.taper = taper;
        var wave = readGroup(stroke.property(WAVE));
        if (wave) out.wave = wave;

        return out;
    }

    /* The first switched-on fill, or stroke, reading down the timeline. */
    function find(container, wanted) {
        for (var i = 1; i <= container.numProperties; i++) {
            var child = container.property(i);
            if (!child.enabled) continue;
            if (wanted(child.matchName)) return child;
            if (child.matchName === GROUP) {
                var inside = find(child.property(CONTENTS), wanted);
                if (inside) return inside;
            }
        }
        return null;
    }

    /* What can be read of one paint. For a gradient that is everything but
     * its colours and where it sits, and path says where to go for those. */
    function readPaint(node, isStroke) {
        var out = isStroke ? readStroke(node) : readProps(node, FILL_PROPS);
        if (node.matchName === GFILL || node.matchName === GSTROKE) {
            out.gradient = readProps(node, GRADIENT_PROPS);
            out.path = pathOf(node);
        }
        return out;
    }

    /*
     * The fill and stroke of a layer, or of whatever is selected inside it.
     * A missing one comes back as null, which is a setting in its own right:
     * applying the palette switches that paint off.
     *
     * A gradient comes back with a path and no colours. The caller has to
     * fetch those by sampling and take the path out again.
     */
    function capture(layer) {
        var target = targetsFor(layer)[0];
        var picked = { fill: null, stroke: null };
        var containerPath = target.path;

        if (target.kind === 'fill' || target.kind === 'stroke') {
            // The one the user pointed at wins, even if it is switched off.
            picked[target.kind] = at(layer, target.path);
            containerPath = target.path.slice(0, target.path.length - 1);
        } else if (target.kind === 'group') {
            containerPath = target.path.concat([CONTENTS]);
        }

        var container = at(layer, containerPath);
        var fill = picked.fill || find(container, isFillKind);
        var stroke = picked.stroke || find(container, isStrokeKind);

        return {
            fill: fill ? readPaint(fill, false) : null,
            stroke: stroke ? readPaint(stroke, true) : null
        };
    }

    /* ---------------------------------------------------------- writing */

    function newReport(time) {
        return { time: time || 0, layers: 0, paints: 0, added: 0, failed: 0, refused: 0, reason: '' };
    }

    function set(prop, value, report, quiet) {
        if (!prop) return;
        try {
            // setValue is refused on an animated property. Writing at the
            // current time is what changing the value by hand would do.
            if (prop.numKeys > 0) prop.setValueAtTime(report.time, value);
            else prop.setValue(value);
        } catch (e) {
            if (!quiet) report.failed++;
        }
    }

    function setEnabled(group, on, report) {
        try {
            if (group.enabled !== on) group.enabled = on;
        } catch (e) {
            report.failed++;
        }
    }

    /* A palette file can be edited by hand, so a value is only passed on when
     * it is the kind of thing the property takes. */
    function usable(key, value) {
        if (key !== 'color') return isNumber(value);
        return value instanceof Array && value.length >= 3 &&
            isNumber(value[0]) && isNumber(value[1]) && isNumber(value[2]);
    }

    function writeProps(group, table, settings, report) {
        for (var i = 0; i < table.length; i++) {
            var key = table[i][0];
            var value = settings[key];
            if (!usable(key, value)) continue;
            if (key === 'color') value = [value[0], value[1], value[2], 1];
            set(group.property(table[i][1]), value, report, table[i][2] === true);
        }
    }

    function writeGroup(group, values, report) {
        if (!group || !values || typeof values !== 'object') return;
        for (var name in values) {
            if (!values.hasOwnProperty(name) || !isNumber(values[name])) continue;
            // Which of these are showing depends on the others, so a refusal
            // here is ordinary.
            set(group.property(name), values[name], report, true);
        }
    }

    function writeDashes(layer, strokePath, wanted, offset, report) {
        var path = strokePath.concat([DASHES]);
        if (!at(layer, path)) return;
        var i;

        // Surplus dashes come off last one first, as the minus button does.
        var surplus = DASH_NAMES.slice(wanted.length);
        if (!wanted.length || !isNumber(offset)) surplus.push(DASH_OFFSET);
        for (i = surplus.length - 1; i >= 0; i--) {
            if (!isLive(at(layer, path), surplus[i])) continue;
            try {
                at(layer, path).property(surplus[i]).remove();
            } catch (e) {
                report.failed++;
            }
        }

        var names = DASH_NAMES.slice(0, wanted.length);
        var values = wanted.slice(0, DASH_NAMES.length);
        if (wanted.length && isNumber(offset)) {
            names.push(DASH_OFFSET);
            values.push(offset);
        }
        for (i = 0; i < names.length; i++) {
            if (!isNumber(values[i])) continue;
            if (!isLive(at(layer, path), names[i])) {
                // If this is refused the value below fails too, and is counted.
                try { at(layer, path).addProperty(names[i]); } catch (e2) {}
            }
            set(at(layer, path).property(names[i]), values[i], report);
        }
    }

    /* settings of null means the palette has no fill: the fill is switched
     * off, not deleted, so applying another palette can bring it back. */
    function writeFill(layer, path, settings, report) {
        var fill = at(layer, path);
        if (!fill) return;
        report.paints++;
        if (!settings) { setEnabled(fill, false, report); return; }
        setEnabled(fill, true, report);
        writeProps(fill, FILL_PROPS, settings, report);
        if (isGradient(settings)) writeProps(fill, GRADIENT_PROPS, settings.gradient, report);
    }

    function writeStroke(layer, path, settings, report) {
        var stroke = at(layer, path);
        if (!stroke) return;
        report.paints++;
        if (!settings) { setEnabled(stroke, false, report); return; }
        setEnabled(stroke, true, report);
        writeProps(stroke, STROKE_PROPS, settings, report);
        if (isGradient(settings)) writeProps(stroke, GRADIENT_PROPS, settings.gradient, report);
        writeDashes(layer, path, settings.dashes instanceof Array ? settings.dashes : [],
            settings.dashOffset, report);
        // Fetched again: changing the dashes may have replaced the stroke.
        stroke = at(layer, path);
        writeGroup(stroke.property(TAPER), settings.taper, report);
        writeGroup(stroke.property(WAVE), settings.wave, report);
    }

    /* Where each kind of child sits in a container. */
    function scan(container) {
        var s = {
            shapes: 0, groups: [],
            fills: [], fillsOff: [], strokes: [], strokesOff: [],
            gfills: [], gstrokes: [], gfillsOn: [], gstrokesOn: []
        };
        for (var i = 1; i <= container.numProperties; i++) {
            var child = container.property(i);
            var name = child.matchName;
            if (SHAPES[name] === true) s.shapes++;
            else if (name === GROUP) s.groups.push(i);
            else if (name === FILL) (child.enabled ? s.fills : s.fillsOff).push(i);
            else if (name === STROKE) (child.enabled ? s.strokes : s.strokesOff).push(i);
            else if (name === GFILL) { s.gfills.push(i); if (child.enabled) s.gfillsOn.push(i); }
            else if (name === GSTROKE) { s.gstrokes.push(i); if (child.enabled) s.gstrokesOn.push(i); }
        }
        return s;
    }

    /* A gradient this panel put at the top level on an earlier visit. */
    function isOurs(child) {
        return (child.matchName === GFILL && child.name === OURS.fill) ||
               (child.matchName === GSTROKE && child.name === OURS.stroke);
    }

    /*
     * Brings the solid paints of one kind in a container in line with the
     * palette and says whether the container ends up with one switched on.
     *
     * A paint that is switched off is left alone while another is on, so a
     * spare fill someone parked there does not come back to life. With none
     * on, the first spare is used before anything new is added, unless a
     * container further up already paints this one, in which case a second
     * paint here would show through a see-through first.
     */
    function repaint(layer, path, settings, on, off, write, inherited, report) {
        var i;
        if (!settings) {
            for (i = 0; i < on.length; i++) write(layer, path.concat([on[i]]), null, report);
            return false;
        }
        if (!on.length && off.length && !inherited) on = [off[0]];
        for (i = 0; i < on.length; i++) write(layer, path.concat([on[i]]), settings, report);
        return on.length > 0;
    }

    /*
     * A new paint lands at the bottom of the container. place, when given,
     * is the position to lift it to.
     *
     * Two things here are shaped by a fault in After Effects. A solid paint
     * that is moved above an older gradient of its own kind can no longer
     * have its colour set: After Effects fails an internal check, and shows
     * the user a dialog saying so. So the paint is given all its values
     * where it lands, before it is moved anywhere, and callers never ask for
     * a place above a gradient of the same kind.
     */
    function add(layer, path, matchName, settings, place, write, report) {
        var index;
        try {
            var container = at(layer, path);
            if (!container.canAddProperty(matchName)) return;
            index = container.addProperty(matchName).propertyIndex;
        } catch (e) {
            report.failed++;
            return;
        }

        report.added++;
        write(layer, path.concat([index]), settings, report);
        if (place && place < index) {
            try { at(layer, path.concat([index])).moveTo(place); } catch (e2) {}
        }
    }

    /* The position just below the last of some children, or 0 for none. */
    function justBelow(indices) {
        return indices.length ? indices[indices.length - 1] + 1 : 0;
    }

    /*
     * Puts right what an earlier version of this panel left behind: a solid
     * paint sitting above a switched-off gradient of its kind, which is the
     * arrangement After Effects cannot set a colour in. Lifting the gradient
     * back above the solid paint clears it, and a gradient that is switched
     * off looks the same wherever it sits.
     */
    function mend(layer, path, fills, strokes) {
        for (var guard = 0; guard < 20; guard++) {
            var container = at(layer, path);
            var solid = 0, gradient = 0, i;
            for (var pass = 0; pass < 2 && !gradient; pass++) {
                var wantFill = pass === 0;
                if (wantFill ? !fills : !strokes) continue;
                solid = 0;
                for (i = 1; i <= container.numProperties; i++) {
                    var name = container.property(i).matchName;
                    if (name === (wantFill ? FILL : STROKE)) { if (!solid) solid = i; }
                    else if (name === (wantFill ? GFILL : GSTROKE) && solid && !container.property(i).enabled) { gradient = i; break; }
                }
            }
            if (!gradient) return;
            try { at(layer, path).property(gradient).moveTo(solid); } catch (e) { return; }
        }
    }

    /*
     * Gradients in a container that are in the way of a solid paint. One
     * this panel made is removed, since nothing else can be done with it.
     * Any other is switched off: its colours cannot be changed, and left on
     * it would paint over the result.
     *
     * keep, when given, is how many children at the end of the container
     * were made just now for the new palette and are to be left alone.
     */
    function retireGradients(layer, path, fills, strokes, report, keep) {
        for (var i = at(layer, path).numProperties - (keep || 0); i >= 1; i--) {
            var child = at(layer, path).property(i);
            var name = child.matchName;
            if (!(name === GFILL && fills) && !(name === GSTROKE && strokes)) continue;
            if (isOurs(child)) {
                try { child.remove(); report.paints++; continue; } catch (e) {}
            }
            if (child.enabled) {
                report.paints++;
                setEnabled(at(layer, path).property(i), false, report);
            }
        }
    }

    /*
     * Applies the solid paints of a palette to a container and, when deep,
     * to every group below it. only narrows it to 'fill' or 'stroke'.
     *
     * inherited says whether a container further up already paints this one.
     * A fill beside a group paints the paths inside that group, so the group
     * needs no fill of its own, and giving it one would stack two fills.
     */
    function applyContainer(layer, path, palette, inherited, report, only, deep) {
        if (!at(layer, path)) return;
        var fills = only !== 'stroke';
        var strokes = only !== 'fill';
        var i;

        retireGradients(layer, path, fills, strokes, report);
        mend(layer, path, fills, strokes);
        var s = scan(at(layer, path));
        var hasFill = inherited.fill;
        var hasStroke = inherited.stroke;

        if (fills) {
            hasFill = repaint(layer, path, palette.fill, s.fills, s.fillsOff, writeFill, inherited.fill, report);
            if (palette.fill && !hasFill && s.shapes && !inherited.fill) {
                // Directly below the gradient it stands in for, which keeps the
                // stacking as it was. Never above it: see add().
                add(layer, path, FILL, palette.fill, justBelow(s.gfills), writeFill, report);
                hasFill = true;
            }
        }

        if (strokes) {
            // Scanned again: a fill that has just gone in above the stroke has
            // pushed the stroke down a place.
            s = scan(at(layer, path));
            hasStroke = repaint(layer, path, palette.stroke, s.strokes, s.strokesOff, writeStroke, inherited.stroke, report);
            if (palette.stroke && !hasStroke && s.shapes && !inherited.stroke) {
                // Below a gradient stroke it stands in for. Otherwise above the
                // fill it outlines, or the fill covers the inner half of it.
                add(layer, path, STROKE, palette.stroke, justBelow(s.gstrokes) || s.fills[0] || 0, writeStroke, report);
                hasStroke = true;
            }
        }

        if (deep === false) return;
        s = scan(at(layer, path));
        var below = { fill: inherited.fill || hasFill, stroke: inherited.stroke || hasStroke };
        for (i = 0; i < s.groups.length; i++) {
            applyContainer(layer, path.concat([s.groups[i], CONTENTS]), palette, below, report, only, true);
        }
    }

    /* ------------------------------------------------- top-level paints */

    /*
     * Clears the way for paints at the top level: every paint below it is
     * switched off, and at the top level gradients go, leaving the solid
     * paints there to be reused. keep is as for retireGradients.
     */
    function clearBelow(layer, path, fills, strokes, isTop, report, keep) {
        if (isTop) retireGradients(layer, path, fills, strokes, report, keep);
        for (var i = at(layer, path).numProperties; i >= 1; i--) {
            var child = at(layer, path).property(i);
            var name = child.matchName;
            if (name === GROUP) {
                clearBelow(layer, path.concat([i, CONTENTS]), fills, strokes, false, report);
                continue;
            }
            if (isTop) continue;
            if (!(isFillKind(name) && fills) && !(isStrokeKind(name) && strokes)) continue;
            if (isOursAny(child)) {
                // One this panel put there for an earlier palette has no
                // other use, and left behind they would pile up.
                try { child.remove(); report.paints++; continue; } catch (e) {}
            }
            if (child.enabled) {
                report.paints++;
                setEnabled(at(layer, path).property(i), false, report);
            }
        }
    }

    /* Any paint carrying one of this panel's names, solid or gradient. */
    function isOursAny(child) {
        return (isFillKind(child.matchName) && child.name === OURS.fill) ||
               (isStrokeKind(child.matchName) && child.name === OURS.stroke);
    }

    /* One solid paint of a kind at the top level, switched on and set. */
    function solidAtTop(layer, kind, settings, report) {
        var path = [ROOT];
        mend(layer, path, kind === 'fill', kind === 'stroke');
        var s = scan(at(layer, path));
        var on = kind === 'fill' ? s.fills : s.strokes;
        var off = kind === 'fill' ? s.fillsOff : s.strokesOff;
        var write = kind === 'fill' ? writeFill : writeStroke;
        var i;

        if (!settings || isGradient(settings)) {
            for (i = 0; i < on.length; i++) write(layer, path.concat([on[i]]), null, report);
            return;
        }
        if (on.length) {
            write(layer, path.concat([on[0]]), settings, report);
            for (i = 1; i < on.length; i++) write(layer, path.concat([on[i]]), null, report);
        } else if (off.length) {
            write(layer, path.concat([off[0]]), settings, report);
        } else {
            add(layer, path, kind === 'fill' ? FILL : STROKE, settings, 0, write, report);
        }
    }

    /*
     * One gradient paint of a kind at the top level. env.gradient is what
     * brings it into being, by applying the preset that carries its colours.
     * It arrives as the last child of Contents with a default name. Returns
     * where it is, or 0 if it did not arrive, leaving whatever came in its
     * place for the caller to take back.
     */
    function gradientAtTop(layer, kind, settings, report, env) {
        var path = [ROOT];
        var wanted = kind === 'fill' ? GFILL : GSTROKE;
        var before = at(layer, path).numProperties;
        try {
            env.gradient(layer, kind);
        } catch (e) {
            return 0;
        }

        var count = at(layer, path).numProperties;
        var made = count > before ? at(layer, path).property(count) : null;
        if (!made || made.matchName !== wanted) return 0;
        try { made.name = OURS[kind]; } catch (e2) {}
        report.added++;
        (kind === 'fill' ? writeFill : writeStroke)(layer, path.concat([count]), settings, report);
        return count;
    }

    function tally(report) {
        return { paints: report.paints, added: report.added, failed: report.failed };
    }

    /* Takes away whatever arrived at the end of the layer's Contents after
     * it held count children, and puts the report back to an earlier tally,
     * so that a layer left alone is reported as untouched. */
    function takeBack(layer, count, report, before) {
        for (var i = at(layer, [ROOT]).numProperties; i > count; i--) {
            try { at(layer, [ROOT]).property(i).remove(); } catch (e) {}
        }
        report.paints = before.paints;
        report.added = before.added;
        report.failed = before.failed;
    }

    /* The switched-on paint of a kind at the top level, solid or gradient. */
    function topPaint(layer, kind) {
        var s = scan(at(layer, [ROOT]));
        if (kind === 'fill') return s.fills[0] || s.gfillsOn[0] || 0;
        return s.strokes[0] || s.gstrokesOn[0] || 0;
    }

    /* Puts the stroke directly above the fill, and both below every shape,
     * which is where a paint has to be to reach all of them. */
    function arrange(layer) {
        var path = [ROOT];
        var last = at(layer, path).numProperties;
        var fill = topPaint(layer, 'fill');
        try {
            if (fill && fill !== last) at(layer, path).property(fill).moveTo(last);
            var stroke = topPaint(layer, 'stroke');
            var place = fill ? last - 1 : last;
            if (stroke && stroke !== place) at(layer, path).property(stroke).moveTo(place);
        } catch (e) {}
    }

    /*
     * Places a gradient over a box. Its start and end are saved as fractions
     * of the box round the shape they were saved from, so on a shape of
     * another size or in another place the gradient still runs, say, from
     * its left edge to its right.
     */
    function placeGradient(paint, settings, box, report) {
        if (!paint || (paint.matchName !== GFILL && paint.matchName !== GSTROKE)) return;
        var left = -50, top = -50, width = 100, height = 100;
        if (box && box.width > 0 && box.height > 0) {
            left = box.left; top = box.top; width = box.width; height = box.height;
        }

        var g = settings.gradient;
        var start = g.start instanceof Array && isNumber(g.start[0]) && isNumber(g.start[1]) ? g.start : [0, 0.5];
        var end = g.end instanceof Array && isNumber(g.end[0]) && isNumber(g.end[1]) ? g.end : [1, 0.5];
        set(paint.property(GRAD_START), [left + start[0] * width, top + start[1] * height], report);
        set(paint.property(GRAD_END), [left + end[0] * width, top + end[1] * height], report);
    }

    /*
     * Paints the whole layer from the top level of its Contents. Returns ''
     * once done, or 'preset' if After Effects would not make a gradient, in
     * which case the layer is left as it was.
     *
     * The gradients are made before anything else is touched. Made after
     * the paints inside the groups were switched off, a preset that failed
     * would leave the layer with no fill at all.
     */
    function applyAtTop(layer, palette, report, env, only) {
        var kinds = only ? [only] : ['stroke', 'fill'];
        var start = at(layer, [ROOT]).numProperties;
        var before = tally(report);
        var made = 0;
        var i;

        for (i = 0; i < kinds.length; i++) {
            if (!isGradient(palette[kinds[i]])) continue;
            if (!gradientAtTop(layer, kinds[i], palette[kinds[i]], report, env)) {
                takeBack(layer, start, report, before);
                return 'preset';
            }
            made++;
        }

        clearBelow(layer, [ROOT], only !== 'stroke', only !== 'fill', true, report, made);
        for (i = 0; i < kinds.length; i++) solidAtTop(layer, kinds[i], palette[kinds[i]], report);
        if (!only) arrange(layer);
        // Measured last, when the paints that give the layer its bounds are on.
        var box = null;
        try { box = layer.sourceRectAtTime(report.time, false); } catch (e) {}
        for (i = 0; i < kinds.length; i++) {
            var index = isGradient(palette[kinds[i]]) ? topPaint(layer, kinds[i]) : 0;
            if (index) placeGradient(at(layer, [ROOT, index]), palette[kinds[i]], box, report);
        }
        return '';
    }

    /* ---------------------------------------------- one group of several */

    /*
     * A gradient cannot be put inside a group, but After Effects has a
     * command that can: Group Shapes. A gradient made at the top level and
     * the group it is meant for are grouped together, which leaves a new
     * group holding the old one with the gradient below it, where it paints
     * that group's shapes and no others. The new group takes the old one's
     * place in the stacking, and everything in the old one, keyframes and
     * all, is carried along untouched.
     *
     * A wrapper is what that leaves behind: a group holding one group and
     * otherwise only paints, at least one of them made by this panel.
     */
    function isWrapper(group) {
        if (!group || group.matchName !== GROUP) return false;
        var contents = group.property(CONTENTS);
        var groups = 0, ours = 0;
        for (var i = 1; i <= contents.numProperties; i++) {
            var child = contents.property(i);
            if (child.matchName === GROUP) groups++;
            else if (!isFillKind(child.matchName) && !isStrokeKind(child.matchName)) return false;
            else if (isOursAny(child)) ours++;
        }
        return groups === 1 && ours > 0;
    }

    /* The box round one child of Contents, found by switching the others off
     * for a moment. The layer only reports the box round everything. */
    function boxOfChild(layer, index, time) {
        var states = [];
        var box = null;
        var count = at(layer, [ROOT]).numProperties;
        var i, child;
        for (i = 1; i <= count; i++) {
            child = at(layer, [ROOT]).property(i);
            states.push(child.enabled);
            if (i !== index && child.enabled) { try { child.enabled = false; } catch (e) {} }
        }
        try { box = layer.sourceRectAtTime(time, false); } catch (e2) {}
        for (i = 1; i <= count; i++) {
            child = at(layer, [ROOT]).property(i);
            if (child.enabled !== states[i - 1]) { try { child.enabled = states[i - 1]; } catch (e3) {} }
        }
        return box;
    }

    /*
     * Applies a palette with a gradient in it to one group at the top level.
     * Returns '' once done. Returns 'preset' if After Effects would not make
     * a gradient, and 'wrap' if it would not group the shapes, having
     * changed nothing that shows either way.
     *
     * The paints are made first and the grouping done second, before anything
     * in the group is switched off. If either fails, the new paints are
     * taken away again and the layer is as it was.
     */
    function applyAtGroup(layer, index, palette, report, env, only) {
        var kinds = only ? [only] : ['stroke', 'fill'];
        var wasWrapper = isWrapper(at(layer, [ROOT, index]));
        var innerName = at(layer, [ROOT, index]).name;
        var start = at(layer, [ROOT]).numProperties;
        var counts = tally(report);
        var made = [];
        var i, where;

        for (i = 0; i < kinds.length; i++) {
            var settings = palette[kinds[i]];
            if (!settings) continue;
            if (isGradient(settings)) {
                where = gradientAtTop(layer, kinds[i], settings, report, env);
                // Grouped without it, the group would lose this paint and
                // gain nothing in its place.
                if (!where) {
                    takeBack(layer, start, report, counts);
                    return 'preset';
                }
            } else {
                var count = at(layer, [ROOT]).numProperties;
                add(layer, [ROOT], kinds[i] === 'fill' ? FILL : STROKE, settings, 0,
                    kinds[i] === 'fill' ? writeFill : writeStroke, report);
                where = at(layer, [ROOT]).numProperties > count ? count + 1 : 0;
                if (where) { try { at(layer, [ROOT]).property(where).name = OURS[kinds[i]]; } catch (e) {} }
            }
            if (where) made.push({ kind: kinds[i], index: where });
        }

        var wanted = [index];
        for (i = 0; i < made.length; i++) wanted.push(made[i].index);
        var before = at(layer, [ROOT]).numProperties;
        var grouped = false;
        if (made.length) {
            try { env.group(layer, wanted); } catch (e2) {}
            var wrapper = at(layer, [ROOT, index]);
            grouped = at(layer, [ROOT]).numProperties === before - made.length &&
                !!wrapper && wrapper.matchName === GROUP &&
                wrapper.property(CONTENTS).numProperties === wanted.length;
        }
        if (!grouped) {
            // Taken away last one first, so the positions of the rest hold.
            for (i = made.length - 1; i >= 0; i--) {
                try {
                    var stray = at(layer, [ROOT, made[i].index]);
                    if (stray && isOursAny(stray)) stray.remove();
                } catch (e3) {}
            }
            return 'wrap';
        }

        var inside = [ROOT, index, CONTENTS];
        clearBelow(layer, inside.concat([1, CONTENTS]), only !== 'stroke', only !== 'fill', false, report);

        // A wrapper from an earlier palette, emptied of its paints, is taken
        // out again so that wrappers do not nest one inside the next.
        var inner = at(layer, inside.concat([1]));
        if (wasWrapper && inner.property(CONTENTS).numProperties === 1) {
            try { env.ungroup(layer, inside.concat([1])); } catch (e4) {}
            innerName = at(layer, inside.concat([1])).name;
        }
        try { at(layer, [ROOT, index]).name = innerName + ' gradient'; } catch (e5) {}

        // The new group's own transform comes out as no change at all, so
        // points inside it are points in the layer.
        var box = boxOfChild(layer, index, report.time);
        for (i = 0; i < made.length; i++) {
            if (isGradient(palette[made[i].kind])) {
                placeGradient(at(layer, inside.concat([2 + i])), palette[made[i].kind], box, report);
            }
        }
        return '';
    }

    /*
     * The top-level groups a set of targets comes down to, or null if any of
     * them is something a gradient cannot be given: a group inside another
     * group, or a path at the top level.
     */
    function groupTargets(layer, targets) {
        var root = at(layer, [ROOT]);
        var seen = {};
        var out = [];
        for (var i = 0; i < targets.length; i++) {
            var path = targets[i].path;
            var top = path.length > 1 ? root.property(path[1]) : null;
            if (!top || top.matchName !== GROUP) return null;
            var isPaint = targets[i].kind === 'fill' || targets[i].kind === 'stroke';
            // The group itself, a paint directly in it, or the one group
            // inside a wrapper, which stands for the wrapper.
            var fits = isPaint ? path.length === 4
                : (path.length === 2 || (path.length === 4 && isWrapper(top)));
            if (!fits) return null;
            if (seen[path[1]] !== true) {
                seen[path[1]] = true;
                out.push(path[1]);
            }
        }
        return out;
    }

    /* ------------------------------------------------------------ apply */

    function paintOf(palette, kind) {
        var paint = palette ? palette[kind] : null;
        return paint && typeof paint === 'object' ? paint : null;
    }

    /*
     * Whether the targets amount to the whole layer: the layer itself, a
     * paint at the top level, the one group that holds everything in the
     * layer, or a paint directly in that group.
     */
    function coversLayer(layer, targets) {
        var root = at(layer, [ROOT]);
        var holder = 0;
        var single = true;
        var i;
        for (i = 1; i <= root.numProperties; i++) {
            var name = root.property(i).matchName;
            if (SHAPES[name] === true) single = false;
            else if (name === GROUP) {
                if (holder) single = false;
                holder = i;
            }
        }

        for (i = 0; i < targets.length; i++) {
            var target = targets[i];
            if (target.kind === 'root') continue;
            var isPaint = target.kind === 'fill' || target.kind === 'stroke';
            if (isPaint && target.path.length === 2) continue;
            if (!single || !holder || target.path[1] !== holder) return false;
            if (target.path.length !== (isPaint ? 4 : 2)) return false;
        }
        return true;
    }

    /* Which paints a palette has a say over: 'fill' or 'stroke' when it
     * leaves the other out altogether, 'both', or 'neither'. A paint that
     * is null is one it has a say over: it switches that paint off. */
    function heldKind(palette) {
        var fill = !!palette && palette.fill !== undefined;
        var stroke = !!palette && palette.stroke !== undefined;
        if (fill && stroke) return 'both';
        if (fill) return 'fill';
        return stroke ? 'stroke' : 'neither';
    }

    /* 'fill' or 'stroke' when every target is a paint of that one kind. */
    function onlyKind(targets) {
        var kind = targets[0].kind;
        if (kind !== 'fill' && kind !== 'stroke') return undefined;
        for (var i = 1; i < targets.length; i++) {
            if (targets[i].kind !== kind) return undefined;
        }
        return kind;
    }

    /*
     * Applies a palette to a layer, or to whatever is selected inside it.
     *
     * A selected fill or stroke takes only its own half of the palette. That
     * is the way to change one without the other. A palette that leaves out
     * one half altogether, as one taken from a picture leaves out the
     * stroke, works as if only the other kind had been selected.
     *
     * targets is what targetsFor found. It is passed in when the caller has
     * to work it out early: applying a gradient changes the selection, and
     * with several layers the later ones would be read too late.
     *
     * When a gradient is called for and the selection is only part of a
     * layer, or After Effects will not make the gradient, nothing is done
     * and report.reason says why.
     */
    function applyTo(layer, palette, report, env, targets) {
        var clean = { fill: paintOf(palette, 'fill'), stroke: paintOf(palette, 'stroke') };
        var none = { fill: false, stroke: false };
        var only, i;
        targets = targets || targetsFor(layer);
        only = onlyKind(targets);

        var holds = heldKind(palette);
        if (holds === 'neither' || (holds !== 'both' && only && only !== holds)) {
            report.refused++;
            report.reason = 'half';
            return report;
        }
        if (holds !== 'both') only = holds;

        var gradientWanted = (only !== 'stroke' && isGradient(clean.fill)) ||
                             (only !== 'fill' && isGradient(clean.stroke));
        if (gradientWanted) {
            var whole = coversLayer(layer, targets);
            var groups = whole ? null : groupTargets(layer, targets);
            var reason = '';
            if (!env || !env.gradient) reason = 'unsupported';
            else if (!whole && !groups) reason = 'part';
            else if (!whole && !env.group) reason = 'unsupported';
            // A gradient stroke on its own would sit under the fills inside
            // the groups, which would hide the inner half of it.
            else if (only === 'stroke') reason = 'stroke';
            if (reason) {
                report.refused++;
                report.reason = reason;
                return report;
            }

            if (whole) {
                reason = applyAtTop(layer, clean, report, env, only);
                if (!reason) report.layers++;
            } else {
                // Wrapping a group keeps its place in Contents, so the
                // positions of the other targets hold from one to the next.
                var done = 0;
                for (i = 0; i < groups.length; i++) {
                    var failure = applyAtGroup(layer, groups[i], clean, report, env, only);
                    if (failure) reason = failure;
                    else done++;
                }
                if (done) report.layers++;
            }
            if (reason) {
                report.refused++;
                report.reason = reason;
            }
            return report;
        }

        /*
         * Targets are found by position, so the order they are painted in
         * matters. Painting a paint or a group changes nothing outside it.
         * A selected gradient is another matter: it cannot be turned solid,
         * so a solid paint goes in beside it, and adding to its container
         * moves every target after it there. Those containers are therefore
         * done last, deepest first, and once each.
         */
        var swaps = [];
        var swapAt = {};
        for (i = 0; i < targets.length; i++) {
            var target = targets[i];
            var node = target.kind === 'fill' || target.kind === 'stroke' ? at(layer, target.path) : null;
            if (node && (node.matchName === GFILL || node.matchName === GSTROKE)) {
                var container = target.path.slice(0, target.path.length - 1);
                var key = container.join('/');
                if (!swapAt[key]) {
                    swapAt[key] = { path: container, fill: false, stroke: false };
                    swaps.push(swapAt[key]);
                }
                swapAt[key][target.kind] = true;
            } else {
                applyTarget(layer, target, clean, report, env, only);
            }
        }

        swaps.sort(function (a, b) { return b.path.length - a.path.length; });
        for (i = 0; i < swaps.length; i++) {
            var fills = swaps[i].fill && only !== 'stroke';
            var strokes = swaps[i].stroke && only !== 'fill';
            if (!fills && !strokes) continue;
            var which = fills && strokes ? undefined : (fills ? 'fill' : 'stroke');
            applyContainer(layer, swaps[i].path, clean, none, report, which, false);
        }

        report.layers++;
        return report;
    }

    /* Applies the solid paints of a palette to one target that is not a
     * gradient. Nothing outside the target is added, moved or removed.
     * only, when given, is the one kind of paint to touch. */
    function applyTarget(layer, target, clean, report, env, only) {
        var none = { fill: false, stroke: false };
        if (only && (target.kind === 'fill' || target.kind === 'stroke') && target.kind !== only) return;
        // The group inside a wrapper stands for the wrapper, whose
        // gradients would otherwise go on painting it.
        if (target.kind === 'group' && target.path.length >= 4 &&
            isWrapper(at(layer, target.path.slice(0, target.path.length - 2)))) {
            target = { kind: 'group', path: target.path.slice(0, target.path.length - 2) };
        }
        if (target.kind === 'fill') {
            writeFill(layer, target.path, clean.fill, report);
        } else if (target.kind === 'stroke') {
            writeStroke(layer, target.path, clean.stroke, report);
        } else if (target.kind === 'group') {
            var wrapped = target.path.length === 2 && isWrapper(at(layer, target.path));
            applyContainer(layer, target.path.concat([CONTENTS]), clean, none, report, only);
            // A wrapper whose gradients have all gone holds one group and
            // nothing else. Taking it apart puts the layer back as it was
            // before the first gradient. The group inside takes the
            // wrapper's place, so no other target moves.
            if (wrapped && env && env.ungroup &&
                at(layer, target.path.concat([CONTENTS])).numProperties === 1) {
                try { env.ungroup(layer, target.path); } catch (e) {}
            }
        } else {
            applyContainer(layer, target.path, clean, none, report, only);
        }
    }

    /* ---------------------------------------------- replacing one colour */

    function newReplaceReport() {
        return { changed: 0, layers: 0, gradients: 0, expressions: 0, failed: 0 };
    }

    /* Whether a colour is the one wanted. Colours are compared in levels of
     * 255, the steps a hex code counts in, and match when no channel is
     * further off than tolerance. */
    function sameColor(value, wanted, tolerance) {
        if (!(value instanceof Array) || value.length < 3) return false;
        for (var c = 0; c < 3; c++) {
            if (!isNumber(value[c])) return false;
            if (Math.abs(Math.round(value[c] * 255) - Math.round(wanted[c] * 255)) > tolerance) return false;
        }
        return true;
    }

    /* One colour property: every keyframe holding the colour, or its single
     * value. A colour an expression decides is counted and left, since the
     * expression would go on overriding whatever is set underneath. */
    function recolor(prop, from, to, tolerance, report) {
        if (!prop) return;
        try {
            if (prop.expressionEnabled && prop.expression) {
                if (sameColor(prop.value, from, tolerance)) report.expressions++;
                return;
            }
            if (prop.numKeys > 0) {
                for (var k = 1; k <= prop.numKeys; k++) {
                    if (!sameColor(prop.keyValue(k), from, tolerance)) continue;
                    prop.setValueAtKey(k, to);
                    report.changed++;
                }
            } else if (sameColor(prop.value, from, tolerance)) {
                prop.setValue(to);
                report.changed++;
            }
        } catch (e) {
            report.failed++;
        }
    }

    function replaceIn(container, from, to, tolerance, report) {
        for (var i = 1; i <= container.numProperties; i++) {
            var child = container.property(i);
            var name = child.matchName;
            if (name === GROUP) replaceIn(child.property(CONTENTS), from, to, tolerance, report);
            else if (name === FILL) recolor(child.property(FILL_PROPS[0][1]), from, to, tolerance, report);
            else if (name === STROKE) recolor(child.property(STROKE_PROPS[0][1]), from, to, tolerance, report);
            else if (name === GFILL || name === GSTROKE) report.gradients++;
        }
    }

    /* The numbers behind PropertyType.PROPERTY and PropertyValueType.COLOR,
     * for when the file runs outside After Effects. */
    var PROPERTY = typeof PropertyType !== 'undefined' ? PropertyType.PROPERTY : 6212;
    var COLOR_VALUE = typeof PropertyValueType !== 'undefined' ? PropertyValueType.COLOR : 6418;

    /* A hidden setting still reports a value. As with dashes, the sign that
     * one is showing is that it can take an expression. */
    function showing(prop) {
        try { return prop.canSetExpression === true; } catch (e) { return false; }
    }

    /*
     * Every colour setting under a group, however deep: the colours of
     * effects such as Fill, Tint and Tritone, and the fill and stroke
     * colours of text animators. A setting After Effects keeps hidden, as
     * some effects do until a menu above it calls for it, cannot be set and
     * is passed over.
     */
    function replaceSettings(group, from, to, tolerance, report) {
        if (!group) return;
        for (var i = 1; i <= group.numProperties; i++) {
            var child = group.property(i);
            if (!child) continue;
            if (child.propertyType !== PROPERTY) {
                replaceSettings(child, from, to, tolerance, report);
            } else if (child.propertyValueType === COLOR_VALUE && showing(child)) {
                recolor(child, from, to, tolerance, report);
            }
        }
    }

    /*
     * The fill and stroke of a text document, in place. Where After Effects
     * can address single characters (24.3 and later), each character is
     * looked at on its own, so a word in another colour keeps it. Before
     * that, only the first character's colour can be read, and setting a
     * document gives every character that colour. Returns how many of fill
     * and stroke changed.
     */
    function recolorDocument(doc, from, to, tolerance) {
        var rgb = [to[0], to[1], to[2]];
        var fill = false;
        var stroke = false;
        var length = doc.text ? String(doc.text).length : 0;
        if (typeof doc.characterRange === 'function' && length) {
            for (var c = 0; c < length; c++) {
                var range = doc.characterRange(c, c + 1);
                if (range.applyFill && sameColor(range.fillColor, from, tolerance)) { range.fillColor = rgb; fill = true; }
                if (range.applyStroke && sameColor(range.strokeColor, from, tolerance)) { range.strokeColor = rgb; stroke = true; }
            }
        } else {
            if (doc.applyFill && sameColor(doc.fillColor, from, tolerance)) { doc.fillColor = rgb; fill = true; }
            if (doc.applyStroke && sameColor(doc.strokeColor, from, tolerance)) { doc.strokeColor = rgb; stroke = true; }
        }
        return (fill ? 1 : 0) + (stroke ? 1 : 0);
    }

    /* Source Text, keyframes included, under the same rule for an
     * expression as any other colour. */
    function recolorText(prop, from, to, tolerance, report) {
        if (!prop) return;
        try {
            if (prop.expressionEnabled && prop.expression) {
                if (recolorDocument(prop.value, from, to, tolerance)) report.expressions++;
                return;
            }
            var doc, n;
            if (prop.numKeys > 0) {
                for (var k = 1; k <= prop.numKeys; k++) {
                    doc = prop.keyValue(k);
                    n = recolorDocument(doc, from, to, tolerance);
                    if (!n) continue;
                    prop.setValueAtKey(k, doc);
                    report.changed += n;
                }
            } else {
                doc = prop.value;
                n = recolorDocument(doc, from, to, tolerance);
                if (n) {
                    prop.setValue(doc);
                    report.changed += n;
                }
            }
        } catch (e) {
            report.failed++;
        }
    }

    /* The colour of a solid layer, which belongs to the solid in the
     * project and so changes on every layer that uses it. A null or an
     * adjustment layer is a solid too, but its colour is never seen. */
    function recolorSolid(layer, from, to, tolerance, report) {
        try {
            if (layer.nullLayer || layer.adjustmentLayer) return;
            var solid = layer.source ? layer.source.mainSource : null;
            if (!solid || !(solid.color instanceof Array)) return;
            if (!sameColor(solid.color, from, tolerance)) return;
            solid.color = [to[0], to[1], to[2]];
            report.changed++;
        } catch (e) {
            report.failed++;
        }
    }

    /*
     * Changes every colour of a layer that is from into to, both [red,
     * green, blue] from 0 to 1: the solid fills and strokes of a shape
     * layer, inside every group and whether switched on or off, so a paint
     * switched back on later matches the rest; the fill and stroke of text
     * and the colours of its animators; the colour of a solid; and the
     * colour settings of every effect. Only values change: nothing is
     * added, moved or removed. Gradients, whose colours no script can
     * reach, are counted and left alone.
     */
    function replaceColor(layer, from, to, tolerance, report) {
        var color = [to[0], to[1], to[2], 1];
        var before = report.changed;
        var root = layer.property(ROOT);
        if (root) replaceIn(root, from, color, tolerance, report);
        var text = layer.property(TEXT);
        if (text) {
            recolorText(text.property(TEXT_DOCUMENT), from, to, tolerance, report);
            replaceSettings(text.property(TEXT_ANIMATORS), from, color, tolerance, report);
        }
        recolorSolid(layer, from, to, tolerance, report);
        replaceSettings(layer.property(EFFECTS), from, color, tolerance, report);
        if (report.changed > before) report.layers++;
        return report;
    }

    return {
        isShapeLayer: isShapeLayer,
        isGradient: isGradient,
        targetsFor: targetsFor,
        capture: capture,
        applyTo: applyTo,
        newReport: newReport,
        replaceColor: replaceColor,
        newReplaceReport: newReplaceReport,
        // For the gradient reader, which works on a copy of the layer.
        at: at,
        writeDashes: writeDashes
    };
})();

// Node.js test harness support. ExtendScript ignores this branch.
if (typeof module !== 'undefined' && module.exports) { module.exports = CopalCore; }
