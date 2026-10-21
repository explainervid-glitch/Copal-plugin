/*
 * A check that runs inside After Effects, for the things the Node tests
 * cannot know: that the match names are right, that a hidden dash is told
 * apart from an added one, and that the selection is reported the way the
 * panel expects.
 *
 *     File > Scripts > Run Script File... > test/ae-smoke.jsx
 *
 * It makes a composition called "Copal smoke test", works in it, removes
 * it again and shows the results. Everything is one undo step. Run it in a
 * scratch project all the same.
 */

#include "../cep/com.copal.panel/jsx/lib/json.jsx"
#include "../cep/com.copal.panel/jsx/lib/CopalCore.jsx"

(function () {

    var lines = [];
    var failures = 0;

    function check(name, passed, detail) {
        if (!passed) failures++;
        lines.push((passed ? 'ok      ' : 'FAIL  ') + name + (!passed && detail !== undefined ? '   got: ' + detail : ''));
    }

    function text(value) { return CopalJson.stringify(value); }

    /* Fetched fresh every time. A reference kept across addProperty is dead. */
    function inner(layer) {
        return layer.property('ADBE Root Vectors Group').property(1).property('ADBE Vectors Group');
    }

    function order(layer) {
        var contents = inner(layer);
        var out = [];
        for (var i = 1; i <= contents.numProperties; i++) {
            var child = contents.property(i);
            var name = child.matchName.replace('ADBE Vector Graphic - ', '').replace('ADBE Vector Shape - ', '');
            out.push(child.enabled ? name : '(' + name + ')');
        }
        return out.join(' ');
    }

    function deselect(layer) {
        var selected = layer.selectedProperties;
        for (var i = selected.length - 1; i >= 0; i--) {
            try { selected[i].selected = false; } catch (e) {}
        }
    }

    function matchNames(props) {
        var out = [];
        for (var i = 0; i < props.length; i++) out.push(props[i].matchName);
        return out.join(', ');
    }

    function shapeLayer(comp, shape) {
        var layer = comp.layers.addShape();
        layer.property('ADBE Root Vectors Group').addProperty('ADBE Vector Group');
        inner(layer).addProperty(shape);
        return layer;
    }

    if (!app.project) { alert('Open a project first.'); return; }

    app.beginUndoGroup('Copal smoke test');
    var comp = app.project.items.addComp('Copal smoke test', 400, 400, 1, 2, 25);

    try {
        /* ---- a source layer: Rect, Stroke, Fill ---- */
        var a = shapeLayer(comp, 'ADBE Vector Shape - Rect');
        inner(a).addProperty('ADBE Vector Graphic - Stroke');
        inner(a).addProperty('ADBE Vector Graphic - Fill');
        check('new paints are added at the bottom', order(a) === 'Rect Stroke Fill', order(a));

        inner(a).property(2).property('ADBE Vector Stroke Color').setValue([0, 0, 1, 1]);
        inner(a).property(2).property('ADBE Vector Stroke Width').setValue(7);
        inner(a).property(2).property('ADBE Vector Stroke Line Cap').setValue(2);
        inner(a).property(3).property('ADBE Vector Fill Color').setValue([0, 1, 0, 1]);
        inner(a).property(3).property('ADBE Vector Fill Opacity').setValue(40);
        deselect(a);

        var solid = CopalCore.capture(a);
        check('capture finds the fill', !!solid.fill && text(solid.fill.color) === '[0,1,0]' && solid.fill.opacity === 40, text(solid.fill));
        check('capture finds the stroke', !!solid.stroke && solid.stroke.width === 7 && solid.stroke.lineCap === 2, text(solid.stroke));
        check('a solid stroke reads as having no dashes', !!solid.stroke && solid.stroke.dashes.length === 0,
            solid.stroke ? text(solid.stroke.dashes) : 'no stroke');

        inner(a).property(2).property('ADBE Vector Stroke Dashes').addProperty('ADBE Vector Stroke Dash 1').setValue(9);
        inner(a).property(2).property('ADBE Vector Stroke Dashes').addProperty('ADBE Vector Stroke Gap 1').setValue(5);
        deselect(a);

        var dashed = CopalCore.capture(a);
        check('added dashes are read, and only those', text(dashed.stroke.dashes) === '[9,5]', text(dashed.stroke.dashes));

        /* ---- a target layer: Ellipse, Fill ---- */
        var b = shapeLayer(comp, 'ADBE Vector Shape - Ellipse');
        inner(b).addProperty('ADBE Vector Graphic - Fill');
        deselect(b);

        var report = CopalCore.applyTo(b, dashed, CopalCore.newReport(0));
        check('apply adds the missing stroke above the fill', order(b) === 'Ellipse Stroke Fill', order(b));
        check('apply is refused nothing', report.failed === 0, report.failed + ' refused');
        deselect(b);
        var copy = CopalCore.capture(b);
        check('the target now reads the same as the source',
            text(copy.fill) === text(dashed.fill) && text(copy.stroke) === text(dashed.stroke),
            text(copy));

        report = CopalCore.applyTo(b, solid, CopalCore.newReport(0));
        deselect(b);
        check('a palette without dashes takes them off',
            CopalCore.capture(b).stroke.dashes.length === 0 && report.failed === 0,
            text(CopalCore.capture(b).stroke.dashes) + ', ' + report.failed + ' refused');

        CopalCore.applyTo(b, { fill: solid.fill, stroke: null }, CopalCore.newReport(0));
        check('a palette with no stroke switches the stroke off', order(b) === 'Ellipse (Stroke) Fill', order(b));

        /* ---- what the selection reports ---- */
        deselect(b);
        inner(b).property(3).property('ADBE Vector Fill Color').selected = true;
        lines.push('info    selecting a fill colour reports: ' + matchNames(b.selectedProperties));
        var targets = CopalCore.targetsFor(b);
        check('a selected colour means its fill', targets.length === 1 && targets[0].kind === 'fill',
            targets.length + ' target(s), first is ' + targets[0].kind);

        deselect(b);
        b.property('ADBE Root Vectors Group').property(1).selected = true;
        lines.push('info    selecting a group reports: ' + matchNames(b.selectedProperties));
        targets = CopalCore.targetsFor(b);
        check('a selected group means that group', targets.length === 1 && targets[0].kind === 'group',
            targets.length + ' target(s), first is ' + targets[0].kind);

        /* ---- an animated property ---- */
        deselect(b);
        inner(b).property(3).property('ADBE Vector Fill Opacity').setValueAtTime(0, 10);
        report = CopalCore.applyTo(b, solid, CopalCore.newReport(1));
        check('an animated property takes a keyframe instead of failing',
            report.failed === 0 && inner(b).property(3).property('ADBE Vector Fill Opacity').numKeys === 2,
            report.failed + ' refused, ' + inner(b).property(3).property('ADBE Vector Fill Opacity').numKeys + ' keys');

        /* ---- a gradient ---- */
        var c = shapeLayer(comp, 'ADBE Vector Shape - Rect');
        inner(c).addProperty('ADBE Vector Graphic - G-Fill');
        deselect(c);
        var none = CopalCore.capture(c);
        check('a gradient is found, with the path to sample it by', !!none.fill && !!none.fill.gradient && none.fill.path.length === 4 && !none.stroke, text(none));
        report = CopalCore.applyTo(c, solid, CopalCore.newReport(0));
        check('apply switches the gradient off and paints over it',
            order(c) === 'Rect (G-Fill) Stroke Fill' && report.failed === 0,
            order(c) + ', ' + report.failed + ' refused');

    } catch (error) {
        failures++;
        lines.push('FAIL  the script stopped: ' + error.toString() + (error.line ? ' (line ' + error.line + ')' : ''));
    } finally {
        try { comp.remove(); } catch (e2) {}
        app.endUndoGroup();
    }

    alert('Copal smoke test, After Effects ' + app.version + '\n\n' + lines.join('\n') + '\n\n' +
          (failures ? failures + ' failed' : 'All passed'));
})();
