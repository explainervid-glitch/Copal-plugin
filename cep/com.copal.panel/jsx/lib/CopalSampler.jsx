/*
 * Reads the colours of a shape gradient.
 *
 * After Effects will not hand a gradient's colours to a script, so they are
 * read the long way round: the gradient is laid out as a straight ramp across
 * a small temporary composition, and an expression samples the rendered
 * pixels along it. The panel then works out which colour stops would draw
 * that ramp.
 *
 * All of it happens to a copy of the layer in a composition that is removed
 * again before this returns. The layer the user is working on is only read.
 *
 * What comes back is a picture of the gradient, not its original stops. The
 * two look the same, but a gradient saved from three stops and an off-centre
 * midpoint may come back as four stops with centred ones.
 */

var CopalSampler = (function () {

    var ROOT = 'ADBE Root Vectors Group';
    var GROUP = 'ADBE Vector Group';
    var CONTENTS = 'ADBE Vectors Group';
    var GFILL = 'ADBE Vector Graphic - G-Fill';
    var GSTROKE = 'ADBE Vector Graphic - G-Stroke';
    var RECT = 'ADBE Vector Shape - Rect';
    var SOURCE_NAME = 'copal-source';

    /* The ramp is this many pixels long, sampled once per pixel, with one
     * more sample off each end where the first and last colours run on. */
    var STEPS = 256;
    var MARGIN = 4;
    var HEIGHT = 8;

    var at = CopalCore.at;

    function isPaint(name) {
        return name === GFILL || name === GSTROKE ||
            name === 'ADBE Vector Graphic - Fill' || name === 'ADBE Vector Graphic - Stroke';
    }

    /* Sets a value come what may. An expression or keyframes on the copy
     * would otherwise go on deciding the value. */
    function force(prop, value) {
        if (!prop) return;
        try { if (prop.expression !== '') prop.expression = ''; } catch (e) {}
        try { while (prop.numKeys > 0) prop.removeKey(1); } catch (e2) {}
        try { prop.setValue(value); } catch (e3) {}
    }

    function switchOff(prop) {
        try { if (prop.enabled) prop.enabled = false; } catch (e) {}
    }

    function valueAt(prop, time) {
        try { return prop.valueAtTime(time, false); } catch (e) {}
        return prop.value;
    }

    function paintsOff(container) {
        for (var i = 1; i <= container.numProperties; i++) {
            var child = container.property(i);
            if (isPaint(child.matchName)) switchOff(child);
            else if (child.matchName === GROUP) paintsOff(child.property(CONTENTS));
        }
    }

    /* Takes the layer's own transform out of the picture, so that a point in
     * the layer is the same point in the composition. */
    function flattenLayer(copy) {
        try { copy.parent = null; } catch (e) {}
        try { copy.threeDLayer = false; } catch (e2) {}
        var transform = copy.property('ADBE Transform Group');
        try { transform.property('ADBE Position').dimensionsSeparated = false; } catch (e3) {}
        force(transform.property('ADBE Anchor Point'), [0, 0, 0]);
        force(transform.property('ADBE Position'), [0, 0, 0]);
        force(transform.property('ADBE Scale'), [100, 100, 100]);
        force(transform.property('ADBE Rotate Z'), 0);
        force(transform.property('ADBE Opacity'), 100);
    }

    function flattenGroup(group) {
        var transform = group.property('ADBE Vector Transform Group');
        if (!transform) return;
        force(transform.property('ADBE Vector Anchor'), [0, 0]);
        force(transform.property('ADBE Vector Position'), [0, 0]);
        force(transform.property('ADBE Vector Scale'), [100, 100]);
        force(transform.property('ADBE Vector Skew'), 0);
        force(transform.property('ADBE Vector Skew Axis'), 0);
        force(transform.property('ADBE Vector Rotation'), 0);
        force(transform.property('ADBE Vector Group Opacity'), 100);
    }

    /*
     * Leaves switched on only what the paint at path paints, and returns the
     * path of the container the paint sits in.
     *
     * The groups on the way down have their transforms flattened. They move
     * the shapes and the gradient together, so removing them changes nothing
     * about where one sits on the other, and afterwards the gradient's points
     * and the layer's bounds are measured in the same space.
     */
    function isolate(copy, path) {
        var containerPath = [ROOT];
        var i, container, child;

        for (var step = 1; step < path.length - 1; step += 2) {
            var keep = path[step];
            container = at(copy, containerPath);
            for (i = 1; i <= container.numProperties; i++) {
                if (i !== keep) switchOff(container.property(i));
            }
            flattenGroup(container.property(keep));
            containerPath = containerPath.concat([keep, CONTENTS]);
        }

        // A paint reaches the shapes above it. Whatever is below is not its
        // business, and other paints above would cover it.
        var index = path[path.length - 1];
        container = at(copy, containerPath);
        for (i = 1; i <= container.numProperties; i++) {
            child = container.property(i);
            if (i === index) continue;
            if (i > index || isPaint(child.matchName)) switchOff(child);
            else if (child.matchName === GROUP) paintsOff(child.property(CONTENTS));
        }
        return containerPath;
    }

    /* A point as fractions of a box, so it can be put back on a shape of
     * another size. */
    function fractions(point, box) {
        var width = box && box.width > 0 ? box.width : 0;
        var height = box && box.height > 0 ? box.height : 0;
        return [
            Math.round((width ? (point[0] - box.left) / width : 0.5) * 10000) / 10000,
            Math.round((height ? (point[1] - box.top) / height : 0.5) * 10000) / 10000
        ];
    }

    /*
     * Turns the paint into a plain left-to-right ramp over a shape that is
     * sure to cover the sampling line, whatever the layer held before.
     */
    function layOutRamp(copy, containerPath, index, isStroke, width) {
        var container = at(copy, containerPath);
        var i;
        for (i = 1; i <= container.numProperties; i++) {
            if (i !== index) switchOff(container.property(i));
        }

        // Added at the bottom, then lifted above the paint so it gets painted.
        container.addProperty(RECT).moveTo(1);
        var rect = at(copy, containerPath).property(1);
        force(rect.property('ADBE Vector Rect Position'), [width / 2, HEIGHT / 2]);
        // A stroke runs along the outline, so for a stroke the shape is a
        // sliver and the stroke is made wide enough to cover the line.
        force(rect.property('ADBE Vector Rect Size'), isStroke ? [width * 4, 1] : [width * 4, HEIGHT * 8]);
        force(rect.property('ADBE Vector Rect Roundness'), 0);

        var paintPath = containerPath.concat([index + 1]);
        var paint = at(copy, paintPath);
        try { paint.enabled = true; } catch (e) {}
        force(paint.property('ADBE Vector Grad Type'), 1);
        force(paint.property('ADBE Vector Grad Start Pt'), [MARGIN, HEIGHT / 2]);
        force(paint.property('ADBE Vector Grad End Pt'), [MARGIN + STEPS, HEIGHT / 2]);
        force(paint.property('ADBE Vector Fill Opacity'), 100);
        force(paint.property('ADBE Vector Stroke Opacity'), 100);

        if (isStroke) {
            force(paint.property('ADBE Vector Stroke Width'), HEIGHT * 4);
            // Anything that leaves gaps in the stroke leaves gaps in the ramp.
            CopalCore.writeDashes(copy, paintPath, [], undefined, CopalCore.newReport(0));
            paint = at(copy, paintPath);
            var taper = paint.property('ADBE Vector Stroke Taper');
            if (taper) {
                force(taper.property('ADBE Vector Taper Start Length'), 0);
                force(taper.property('ADBE Vector Taper End Length'), 0);
            }
            var wave = paint.property('ADBE Vector Stroke Wave');
            if (wave) force(wave.property('ADBE Vector Taper Wave Amount'), 0);
        }
    }

    /*
     * One sample per pixel of the ramp, as [red, green, blue, alpha].
     *
     * The expression lives on a second, empty shape layer, because that adds
     * nothing to the project, where a null would leave a solid behind. Time
     * is used to say which pixel is wanted, which lets one expression answer
     * for all of them.
     */
    function sample(temp, time) {
        var reader = temp.layers.addShape();
        reader.property(ROOT).addProperty('ADBE Vector Graphic - Fill');
        var color = reader.property(ROOT).property(1).property('ADBE Vector Fill Color');
        color.expression =
            'var i = Math.round(time * 100);\n' +
            'thisComp.layer("' + SOURCE_NAME + '").sampleImage([' + (MARGIN - 0.5) + ' + i, ' + (HEIGHT / 2) + '], [0.5, 0.5], false, ' + time + ')';

        var samples = [];
        for (var i = 0; i <= STEPS + 1; i++) {
            var v = color.valueAtTime(i / 100, false);
            samples.push([
                Math.round(v[0] * 100000) / 100000, Math.round(v[1] * 100000) / 100000,
                Math.round(v[2] * 100000) / 100000, Math.round(v[3] * 100000) / 100000
            ]);
        }
        if (color.expressionError) throw new Error('The gradient could not be sampled: ' + color.expressionError);
        return samples;
    }

    /*
     * Reads the gradient paint at path on a layer, as it stands at time.
     * Returns where it starts and ends, as fractions of the box round the
     * shapes it paints, and the samples of its ramp.
     */
    function read(project, layer, path, time) {
        var width = MARGIN * 2 + STEPS;
        var temp = project.items.addComp('Copal gradient reader', width, HEIGHT, 1, Math.max(4, time + 1), 30);
        try {
            layer.copyToComp(temp);
            var copy = temp.layer(1);
            copy.name = SOURCE_NAME;
            flattenLayer(copy);

            var containerPath = isolate(copy, path);
            var index = path[path.length - 1];
            var paint = at(copy, path);
            var isStroke = paint.matchName === GSTROKE;
            try { paint.enabled = true; } catch (e) {}

            var box = null;
            try { box = copy.sourceRectAtTime(time, false); } catch (e2) {}
            // With nothing to measure against, the gradient is taken to run
            // straight across, which is how a new one starts out.
            var start = [0, 0.5];
            var end = [1, 0.5];
            if (box && (box.width > 0 || box.height > 0)) {
                start = fractions(valueAt(paint.property('ADBE Vector Grad Start Pt'), time), box);
                end = fractions(valueAt(paint.property('ADBE Vector Grad End Pt'), time), box);
            }

            layOutRamp(copy, containerPath, index, isStroke, width);
            return { start: start, end: end, samples: sample(temp, time) };
        } finally {
            try { temp.remove(); } catch (e3) {}
        }
    }

    return { read: read };
})();
