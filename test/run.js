/*
 * Tests for the parts of Copal that do not need After Effects running.
 *
 *     npm test
 *
 * The ExtendScript files are loaded as they ship and run against the
 * stand-in property tree in mockAe.js. That proves the logic, and that no
 * property is used after After Effects would have thrown it away. It cannot
 * prove the match names or the behaviour of After Effects itself; for that,
 * run test/ae-smoke.jsx inside After Effects.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PANEL = path.join(__dirname, '..', 'cep', 'com.copal.panel');
const ae = require('./mockAe');
const Store = require(path.join(PANEL, 'js', 'store.js'));

function source(...parts) {
    return fs.readFileSync(path.join(PANEL, ...parts), 'utf8');
}

/* Evaluated rather than required, so the files are read exactly as
 * ExtendScript reads them, with no module wrapper round them. */
function loadJsx(name, ...parts) {
    return new Function(source(...parts) + '\nreturn ' + name + ';')();
}

const Core = loadJsx('CopalCore', 'jsx', 'lib', 'CopalCore.jsx');
const Json = loadJsx('CopalJson', 'jsx', 'lib', 'json.jsx');

/* host.jsx with its includes pasted in, and After Effects passed in. */
function loadHost(app) {
    const sampler = 'var CopalSampler = { read: function (project, layer, path, time) { return { start: [0, 0.5], end: [1, 0.5], samples: [[1, 0, 0, 1], [1, 0, 0, 1], [0, 0, 1, 1], [0, 0, 1, 1]] }; } };';
    const text = [source('jsx', 'lib', 'json.jsx'), source('jsx', 'lib', 'CopalCore.jsx'), sampler, source('jsx', 'host.jsx')]
        .join('\n').replace(/^#include.*$/gm, '');
    function CompItem() {}
    function File(name) { this.fsName = name; this.exists = name !== ''; }
    const host = new Function('app', 'CompItem', 'File', text + '\nreturn CopalHost;')(app, CompItem, File);
    return { host, CompItem };
}

let passed = 0;
const failures = [];
function test(name, body) {
    try {
        body();
        passed++;
    } catch (error) {
        failures.push({ name, error });
    }
}

const { layer, group, rect, ellipse, fill, stroke, gradientFill, gradientStroke, child, valueOf, order, liveDashes } = ae;
const FILL_COLOR = 'ADBE Vector Fill Color';
const FILL_OPACITY = 'ADBE Vector Fill Opacity';
const STROKE_COLOR = 'ADBE Vector Stroke Color';
const STROKE_WIDTH = 'ADBE Vector Stroke Width';

const RED = [1, 0, 0];
const GREEN = [0, 1, 0];
const BLUE = [0, 0, 1];
const TEAL = [0.1, 0.6, 0.6];
const INK = [0.05, 0.05, 0.1];

function apply(target, palette, time) {
    return Core.applyTo(target._proxy, palette, Core.newReport(time));
}

const PALETTE = {
    fill: { color: TEAL, opacity: 90 },
    stroke: { color: INK, opacity: 100, width: 6, lineCap: 2, lineJoin: 2, miterLimit: 4, dashes: [] }
};

/* ============================================================ capture */

test('capture reads the fill and stroke of a whole layer', () => {
    const l = layer(rect(), stroke(BLUE, 5), fill(RED, 80));
    const got = Core.capture(l._proxy);
    assert.deepStrictEqual(got.fill.color, RED);
    assert.strictEqual(got.fill.opacity, 80);
    assert.deepStrictEqual(got.stroke.color, BLUE);
    assert.strictEqual(got.stroke.width, 5);
    assert.deepStrictEqual(got.stroke.dashes, []);
    assert.strictEqual(got.stroke.dashOffset, undefined);
    assert.strictEqual(got.fill.gradient, undefined);
});

test('capture rounds the noise off a colour and drops its alpha', () => {
    const l = layer(rect(), fill([0.20000000298, 0.4000000059, 1]));
    assert.deepStrictEqual(Core.capture(l._proxy).fill.color, [0.2, 0.4, 1]);
});

test('capture with no stroke reports none', () => {
    const l = layer(rect(), fill(RED));
    const got = Core.capture(l._proxy);
    assert.strictEqual(got.stroke, null);
    assert.ok(got.fill);
});

test('capture reads from the selected group, not the first one', () => {
    const l = layer(group('A', rect(), fill(GREEN)), group('B', rect(), stroke(RED, 3), fill(BLUE)));
    child(l, 2).selected = true;
    const got = Core.capture(l._proxy);
    assert.deepStrictEqual(got.fill.color, BLUE);
    assert.strictEqual(got.stroke.width, 3);
});

test('capture takes a selected fill even when it is switched off', () => {
    const l = layer(rect(), stroke(BLUE, 2), fill(RED), fill(GREEN));
    child(l, 4).enabled = false;
    child(l, 4).selected = true;
    const got = Core.capture(l._proxy);
    assert.deepStrictEqual(got.fill.color, GREEN);
    assert.deepStrictEqual(got.stroke.color, BLUE);
});

test('capture passes over a fill that is switched off', () => {
    const l = layer(rect(), fill(RED), fill(BLUE));
    child(l, 2).enabled = false;
    assert.deepStrictEqual(Core.capture(l._proxy).fill.color, BLUE);
});

test('capture of a gradient gives what a script can read, and where to sample the rest', () => {
    const l = layer(group('A', rect(), gradientStroke(7), gradientFill()));
    child(l, 1, 3, 'ADBE Vector Grad Type')._value = 2;
    const got = Core.capture(l._proxy);
    assert.strictEqual(got.fill.gradient.type, 2);
    assert.strictEqual(got.fill.color, undefined);
    assert.deepStrictEqual(got.fill.path, [ae.names.ROOT, 1, ae.names.CONTENTS, 3]);
    assert.strictEqual(got.stroke.gradient.type, 1);
    assert.strictEqual(got.stroke.width, 7);
    assert.deepStrictEqual(got.stroke.path, [ae.names.ROOT, 1, ae.names.CONTENTS, 2]);
});

test('capture reads only the dashes that were added', () => {
    const l = layer(rect(), stroke(RED, 4));
    const dashes = child(l, 2, ae.names.DASHES);
    dashes._proxy.addProperty('ADBE Vector Stroke Dash 1').setValue(12);
    dashes._proxy.addProperty('ADBE Vector Stroke Gap 1').setValue(6);
    dashes._proxy.addProperty('ADBE Vector Stroke Offset').setValue(3);
    const got = Core.capture(l._proxy).stroke;
    assert.deepStrictEqual(got.dashes, [12, 6]);
    assert.strictEqual(got.dashOffset, 3);
});

test('capture keeps taper and wave by match name', () => {
    const l = layer(rect(), stroke(RED, 4));
    child(l, 2, 'ADBE Vector Stroke Taper', 'ADBE Vector Taper Start Length')._value = 40;
    const got = Core.capture(l._proxy).stroke;
    assert.strictEqual(got.taper['ADBE Vector Taper Start Length'], 40);
    assert.strictEqual(got.wave['ADBE Vector Taper Wave Amount'], 0);
});

/* ============================================================== apply */

test('apply repaints every group of a layer', () => {
    const l = layer(group('A', rect(), stroke(RED, 1), fill(RED)), group('B', ellipse(), stroke(GREEN, 2), fill(GREEN)));
    const report = apply(l, PALETTE);
    for (const g of [1, 2]) {
        assert.deepStrictEqual(valueOf(child(l, g, 3), FILL_COLOR), TEAL.concat([1]));
        assert.strictEqual(valueOf(child(l, g, 3), FILL_OPACITY), 90);
        assert.deepStrictEqual(valueOf(child(l, g, 2), STROKE_COLOR), INK.concat([1]));
        assert.strictEqual(valueOf(child(l, g, 2), STROKE_WIDTH), 6);
    }
    assert.strictEqual(report.layers, 1);
    assert.strictEqual(report.paints, 4);
    assert.strictEqual(report.added, 0);
    assert.strictEqual(report.failed, 0);
});

test('apply adds a missing stroke above the fill', () => {
    const l = layer(ellipse(), fill(RED));
    const report = apply(l, PALETTE);
    assert.strictEqual(order(l), 'ellipse stroke fill');
    assert.strictEqual(valueOf(child(l, 2), STROKE_WIDTH), 6);
    assert.strictEqual(report.added, 1);
    assert.strictEqual(report.failed, 0);
});

test('apply adds a missing fill below the stroke', () => {
    const l = layer(rect(), stroke(RED, 2));
    apply(l, PALETTE);
    assert.strictEqual(order(l), 'rect stroke fill');
    assert.deepStrictEqual(valueOf(child(l, 3), FILL_COLOR), TEAL.concat([1]));
});

test('apply adds both paints to a bare path, stroke on top', () => {
    const l = layer(group('A', rect()));
    const report = apply(l, PALETTE);
    assert.strictEqual(order(child(l, 1)), 'rect stroke fill');
    assert.strictEqual(report.added, 2);
});

test('apply does not give a group a fill its parent already supplies', () => {
    const l = layer(group('A', rect()), group('B', rect()), fill(RED));
    apply(l, { fill: PALETTE.fill, stroke: null });
    assert.strictEqual(order(l), 'group group fill');
    assert.strictEqual(order(child(l, 1)), 'rect');
    assert.strictEqual(order(child(l, 2)), 'rect');
    assert.deepStrictEqual(valueOf(child(l, 3), FILL_COLOR), TEAL.concat([1]));
});

test('apply adds nothing to a container with no path in it', () => {
    const l = layer(group('A', rect(), fill(RED)));
    apply(l, PALETTE);
    assert.strictEqual(order(l), 'group');
    assert.strictEqual(order(child(l, 1)), 'rect stroke fill');
});

test('apply with no stroke in the palette switches strokes off', () => {
    const l = layer(rect(), stroke(RED, 4), fill(RED));
    apply(l, { fill: PALETTE.fill, stroke: null });
    assert.strictEqual(order(l), 'rect (stroke) fill');
    assert.strictEqual(valueOf(child(l, 2), STROKE_WIDTH), 4);
});

test('apply brings a switched-off stroke back instead of adding a second', () => {
    const l = layer(rect(), stroke(RED, 4), fill(RED));
    apply(l, { fill: PALETTE.fill, stroke: null });
    const report = apply(l, PALETTE);
    assert.strictEqual(order(l), 'rect stroke fill');
    assert.strictEqual(valueOf(child(l, 2), STROKE_WIDTH), 6);
    assert.strictEqual(report.added, 0);
});

test('apply leaves a parked spare fill switched off', () => {
    const l = layer(rect(), fill(RED), fill(GREEN));
    child(l, 3).enabled = false;
    apply(l, { fill: PALETTE.fill, stroke: null });
    assert.strictEqual(order(l), 'rect fill (fill)');
    assert.deepStrictEqual(valueOf(child(l, 3), FILL_COLOR), GREEN.concat([1]));
});

test('apply to a selected fill changes that fill and nothing else', () => {
    const l = layer(group('A', rect(), stroke(RED, 1), fill(RED)), group('B', rect(), fill(GREEN)));
    child(l, 1, 3).selected = true;
    const report = apply(l, PALETTE);
    assert.deepStrictEqual(valueOf(child(l, 1, 3), FILL_COLOR), TEAL.concat([1]));
    assert.deepStrictEqual(valueOf(child(l, 1, 2), STROKE_COLOR), RED.concat([1]));
    assert.deepStrictEqual(valueOf(child(l, 2, 2), FILL_COLOR), GREEN.concat([1]));
    assert.strictEqual(order(child(l, 2)), 'rect fill');
    assert.strictEqual(report.paints, 1);
});

test('apply to a selected stroke takes only the stroke half', () => {
    const l = layer(rect(), stroke(RED, 1), fill(RED));
    child(l, 2).selected = true;
    apply(l, PALETTE);
    assert.strictEqual(valueOf(child(l, 2), STROKE_WIDTH), 6);
    assert.deepStrictEqual(valueOf(child(l, 3), FILL_COLOR), RED.concat([1]));
});

test('a selected colour means its fill, even if the groups round it are reported too', () => {
    const l = layer(group('A', rect(), stroke(RED, 1), fill(RED)));
    child(l, 1).selected = true;
    child(l, 1, 3).selected = true;
    child(l, 1, 3, FILL_COLOR).selected = true;
    const targets = Core.targetsFor(l._proxy);
    assert.strictEqual(targets.length, 1);
    assert.strictEqual(targets[0].kind, 'fill');
    apply(l, PALETTE);
    assert.deepStrictEqual(valueOf(child(l, 1, 2), STROKE_COLOR), RED.concat([1]));
});

test('a selected path means the group it sits in', () => {
    const l = layer(group('A', rect(), fill(RED)), group('B', rect(), fill(GREEN)));
    child(l, 2, 1).selected = true;
    apply(l, { fill: PALETTE.fill, stroke: null });
    assert.deepStrictEqual(valueOf(child(l, 1, 2), FILL_COLOR), RED.concat([1]));
    assert.deepStrictEqual(valueOf(child(l, 2, 2), FILL_COLOR), TEAL.concat([1]));
});

test('a selection outside Contents means the whole layer', () => {
    const l = layer(rect(), fill(RED));
    l._children.find(c => c.matchName === 'ADBE Transform Group')._children[0].selected = true;   // Transform > Position
    const targets = Core.targetsFor(l._proxy);
    assert.strictEqual(targets.length, 1);
    assert.strictEqual(targets[0].kind, 'root');
});

test('apply to two selected groups leaves the third alone', () => {
    const l = layer(group('A', rect(), fill(RED)), group('B', rect(), fill(RED)), group('C', rect(), fill(RED)));
    child(l, 1).selected = true;
    child(l, 3).selected = true;
    apply(l, PALETTE);
    assert.strictEqual(order(child(l, 1)), 'rect stroke fill');
    assert.strictEqual(order(child(l, 2)), 'rect fill');
    assert.strictEqual(order(child(l, 3)), 'rect stroke fill');
    assert.deepStrictEqual(valueOf(child(l, 2, 2), FILL_COLOR), RED.concat([1]));
});

test('a selected group gets its own fill even when the layer has one', () => {
    const l = layer(group('A', rect()), fill(RED));
    child(l, 1).selected = true;
    apply(l, { fill: PALETTE.fill, stroke: null });
    assert.strictEqual(order(child(l, 1)), 'rect fill');
    assert.deepStrictEqual(valueOf(child(l, 2), FILL_COLOR), RED.concat([1]));
});

test('apply switches a gradient off and puts the fill just below it', () => {
    const l = layer(rect(), gradientFill(), stroke(RED, 2));
    child(l, 3).enabled = false;
    const report = apply(l, { fill: PALETTE.fill, stroke: null });
    assert.strictEqual(order(l), 'rect (gfill) fill (stroke)');
    assert.strictEqual(report.failed, 0);
    assert.deepStrictEqual(valueOf(child(l, 3), FILL_COLOR), TEAL.concat([1]));
});

/* After Effects cannot set the colour of a solid paint that has been moved
 * above an older gradient of its kind. The stand-in has the same fault, so
 * these fail if the plugin ever arranges things that way. */
test('a solid palette over a shape with its own gradient fill sets every value', () => {
    const l = layer(group('A', rect(), stroke(RED, 2), gradientFill()));
    const report = apply(l, PALETTE);
    assert.strictEqual(report.failed, 0);
    assert.strictEqual(order(child(l, 1)), 'rect stroke (gfill) fill');
    assert.deepStrictEqual(valueOf(child(l, 1, 4), FILL_COLOR), TEAL.concat([1]));
    assert.strictEqual(valueOf(child(l, 1, 2), STROKE_WIDTH), 6);
});

test('a gradient fill above the stroke: the stroke is still the one repainted', () => {
    const l = layer(rect(), gradientFill(), stroke(RED, 2));
    const report = apply(l, PALETTE);
    assert.strictEqual(report.failed, 0);
    assert.strictEqual(order(l), 'rect (gfill) fill stroke');
    assert.strictEqual(valueOf(child(l, 4), STROKE_WIDTH), 6);
    assert.deepStrictEqual(valueOf(child(l, 4), STROKE_COLOR), INK.concat([1]));
    assert.deepStrictEqual(valueOf(child(l, 3), FILL_COLOR), TEAL.concat([1]));
});

test('a solid palette over gradient fill and gradient stroke keeps stroke above fill', () => {
    const l = layer(rect(), gradientStroke(4), gradientFill());
    const report = apply(l, PALETTE);
    assert.strictEqual(report.failed, 0);
    assert.strictEqual(order(l), 'rect (gstroke) stroke (gfill) fill');
    assert.deepStrictEqual(valueOf(child(l, 3), STROKE_COLOR), INK.concat([1]));
    assert.deepStrictEqual(valueOf(child(l, 5), FILL_COLOR), TEAL.concat([1]));
});

test('a fill left above a gradient by an older version is put right before it is painted', () => {
    // Built the way the old code left it: the gradient first, the fill made later and moved above it.
    const l = layer(rect(), stroke(RED, 2), gradientFill());
    child(l, 3).enabled = false;
    l._root._proxy.addProperty(ae.names.FILL).moveTo(3);
    assert.strictEqual(order(l), 'rect stroke fill (gfill)');
    assert.throws(() => child(l, 3, FILL_COLOR)._proxy.setValue([0, 0, 0, 1]), /internal verification failure/);

    const report = apply(l, PALETTE);
    assert.strictEqual(report.failed, 0);
    assert.strictEqual(order(l), 'rect stroke (gfill) fill');
    assert.deepStrictEqual(valueOf(child(l, 4), FILL_COLOR), TEAL.concat([1]));
});

test('a gradient fill that is still switched on is never moved', () => {
    const l = layer(rect(), fill(RED), gradientFill());
    child(l, 2).selected = true;
    apply(l, { fill: PALETTE.fill, stroke: null });
    assert.strictEqual(order(l), 'rect fill gfill');
});

test('apply adds dashes to a solid stroke', () => {
    const l = layer(rect(), stroke(RED, 2));
    const report = apply(l, { fill: null, stroke: { color: INK, width: 3, dashes: [12, 6, 2], dashOffset: 5 } });
    assert.deepStrictEqual(liveDashes(child(l, 2)), [12, 6, 2]);
    assert.strictEqual(child(l, 2, ae.names.DASHES, 'ADBE Vector Stroke Offset')._value, 5);
    assert.strictEqual(report.failed, 0);
});

test('apply takes the dashes off when the palette has none', () => {
    const l = layer(rect(), stroke(RED, 2));
    apply(l, { fill: null, stroke: { color: INK, width: 3, dashes: [12, 6, 2, 6] } });
    const report = apply(l, { fill: null, stroke: { color: INK, width: 3, dashes: [8] } });
    assert.deepStrictEqual(liveDashes(child(l, 2)), [8]);
    assert.strictEqual(report.failed, 0);
    apply(l, { fill: null, stroke: { color: INK, width: 3, dashes: [] } });
    assert.deepStrictEqual(liveDashes(child(l, 2)), []);
});

test('a captured palette applied elsewhere reproduces the source', () => {
    const from = layer(rect(), stroke(BLUE, 7), fill(GREEN, 40));
    const dashes = child(from, 2, ae.names.DASHES);
    dashes._proxy.addProperty('ADBE Vector Stroke Dash 1').setValue(9);
    child(from, 2, 'ADBE Vector Stroke Line Cap')._value = 2;

    // Through JSON both ways, as it travels between the panel and the host.
    const palette = Json.parse(JSON.stringify(JSON.parse(Json.stringify(Core.capture(from._proxy)))));
    const to = layer(group('A', ellipse(), fill(RED)));
    const report = apply(to, palette);

    const again = Core.capture(to._proxy);
    assert.deepStrictEqual(again.fill, palette.fill);
    assert.deepStrictEqual(again.stroke, palette.stroke);
    assert.strictEqual(report.failed, 0);
});

test('apply does not count a hidden miter limit as a failure', () => {
    const l = layer(rect(), stroke(RED, 2));
    const report = apply(l, { fill: null, stroke: { color: INK, lineJoin: 2, miterLimit: 9 } });
    assert.strictEqual(report.failed, 0);
    assert.strictEqual(valueOf(child(l, 2), 'ADBE Vector Stroke Miter Limit'), 4);
});

test('apply writes a keyframe at the current time on an animated property', () => {
    const l = layer(rect(), fill(RED));
    const color = child(l, 2, FILL_COLOR);
    color.numKeys = 2;
    const report = apply(l, { fill: PALETTE.fill, stroke: null }, 1.5);
    assert.strictEqual(report.failed, 0);
    assert.deepStrictEqual(color._keyed, [{ time: 1.5, value: TEAL.concat([1]) }]);
});

test('apply ignores values of the wrong kind in a hand-edited palette', () => {
    const l = layer(rect(), stroke(RED, 2), fill(RED));
    const report = apply(l, {
        fill: { color: 'red', opacity: '50' },
        stroke: { color: [0, 0, 1], width: 'thick', dashes: 'yes', taper: 5 }
    });
    assert.deepStrictEqual(valueOf(child(l, 3), FILL_COLOR), RED.concat([1]));
    assert.strictEqual(valueOf(child(l, 3), FILL_OPACITY), 100);
    assert.deepStrictEqual(valueOf(child(l, 2), STROKE_COLOR), BLUE.concat([1]));
    assert.strictEqual(valueOf(child(l, 2), STROKE_WIDTH), 2);
    assert.strictEqual(report.failed, 0);
});

test('apply treats a palette with nonsense for paint as having none', () => {
    const l = layer(rect(), stroke(RED, 2), fill(RED));
    apply(l, { fill: 'teal', stroke: 7 });
    assert.strictEqual(order(l), 'rect (stroke) (fill)');
});

test('the mock kills held references the way After Effects does', () => {
    const l = layer(rect(), fill(RED));
    const held = l._root._proxy.property(2);
    l._root._proxy.addProperty(ae.names.STROKE);
    assert.throws(() => held.enabled, /stale reference/);
});

/* =============================================================== host */

test('host.apply reports what it did and closes its undo group', () => {
    const a = layer(rect(), fill(RED));
    const b = layer(rect(), fill(GREEN));
    const text = new ae.Layer('Title', 'ADBE Text Layer');
    const app = { project: { activeItem: null, file: null }, log: [] };
    app.beginUndoGroup = name => app.log.push('begin ' + name);
    app.endUndoGroup = () => app.log.push('end');
    const { host, CompItem } = loadHost(app);
    const comp = new CompItem();
    comp.time = 0;
    comp.selectedLayers = [a._proxy, text._proxy, b._proxy];
    app.project.activeItem = comp;

    assert.strictEqual(host.apply(JSON.stringify(PALETTE)), 'OK|2|4|2|0|0|');
    assert.deepStrictEqual(app.log, ['begin Apply Copal palette', 'end']);
    assert.strictEqual(order(a), 'rect stroke fill');
    assert.strictEqual(order(b), 'rect stroke fill');
});

test('host says what is missing instead of throwing', () => {
    const app = { project: { activeItem: null, file: null }, beginUndoGroup() {}, endUndoGroup() {} };
    const { host, CompItem } = loadHost(app);
    assert.strictEqual(host.capture(), 'ERR|Open a composition and select a shape layer.');

    const comp = new CompItem();
    comp.selectedLayers = [];
    app.project.activeItem = comp;
    assert.strictEqual(host.capture(), 'ERR|Select a shape layer first.');
    assert.strictEqual(host.apply('{}'), 'ERR|Select a shape layer first.');

    comp.selectedLayers = [new ae.Layer('Title', 'ADBE Text Layer')._proxy];
    assert.strictEqual(host.capture(), 'ERR|The selection has no shape layer in it.');

    comp.selectedLayers = [layer(rect(), gradientFill())._proxy];
    // A gradient is sent on as samples of its ramp, without the path used to find it.
    const sent = JSON.parse(host.capture().slice(3));
    assert.strictEqual(sent.fill.samples.length, 4);
    assert.deepStrictEqual(sent.fill.gradient.end, [1, 0.5]);
    assert.strictEqual(sent.fill.path, undefined);

    comp.selectedLayers = [layer(rect())._proxy];
    assert.ok(/^ERR\|.*has no fill or stroke to save/.test(host.capture()));
});

test('host.apply refuses text that is not JSON and runs none of it', () => {
    const app = { project: { activeItem: null, file: null }, beginUndoGroup() {}, endUndoGroup() {} };
    const { host } = loadHost(app);
    global.__copalRan = false;
    const reply = host.apply('(function(){ __copalRan = true; })()');
    assert.ok(/^ERR\|/.test(reply));
    assert.strictEqual(global.__copalRan, false);
    delete global.__copalRan;
});

test('host.capture hands back JSON the panel can read', () => {
    const app = { project: { activeItem: null, file: null }, beginUndoGroup() {}, endUndoGroup() {} };
    const { host, CompItem } = loadHost(app);
    const comp = new CompItem();
    comp.selectedLayers = [layer(rect(), stroke(BLUE, 3), fill(RED))._proxy];
    app.project.activeItem = comp;
    const reply = host.capture();
    assert.strictEqual(reply.slice(0, 3), 'OK|');
    const got = JSON.parse(reply.slice(3));
    assert.deepStrictEqual(got.fill.color, RED);
    assert.strictEqual(got.stroke.width, 3);
});

test('host.projectDir is empty until the project is saved', () => {
    const app = { project: { activeItem: null, file: null }, beginUndoGroup() {}, endUndoGroup() {} };
    const { host } = loadHost(app);
    assert.strictEqual(host.projectDir(), 'OK|');
    app.project.file = { parent: { fsName: 'Z:\\Jobs\\Spot' } };
    assert.strictEqual(host.projectDir(), 'OK|Z:\\Jobs\\Spot');
});

/* =============================================================== json */

test('ExtendScript JSON survives awkward strings', () => {
    const value = { name: 'A "quoted" \\ name\n\twith \u2028 breaks', list: [1, -0.5, null, true], deep: { n: 1e-7 } };
    assert.deepStrictEqual(JSON.parse(Json.stringify(value)), value);
    assert.deepStrictEqual(Json.parse(JSON.stringify(value)), value);
});

test('ExtendScript JSON writes null for what JSON cannot hold', () => {
    assert.strictEqual(Json.stringify({ a: NaN, b: Infinity, c: undefined, d: null }), '{"a":null,"b":null,"d":null}');
});

test('ExtendScript JSON refuses anything that is not JSON', () => {
    for (const text of ['alert(1)', '{"a": b}', '[1, 2', '{"a": function(){}}', 'new Date()']) {
        assert.throws(() => Json.parse(text), 'accepted: ' + text);
    }
});

/* The engine inside After Effects is ECMAScript 3. These slip in easily
 * when writing against Node and fail only once the panel is opened. */
test('the ExtendScript files use nothing newer than the engine has', () => {
    const banned = [
        [/\b(?:let|const)\s+[A-Za-z_$][\w$]*\s*[=;,]/, 'let or const'],
        [/=>/, 'arrow function'],
        [/`/, 'template string'],
        [/\.(?:forEach|map|filter|reduce|some|every|trim|bind|includes)\(/, 'ES5 method'],
        [/\bObject\.(?:keys|assign|create|entries)\b/, 'Object helper'],
        [/\bArray\.isArray\b/, 'Array.isArray'],
        [/\bJSON\.(?:parse|stringify)\b/, 'JSON object'],
        [/,\s*[\]}]/, 'trailing comma']
    ];
    for (const file of [['jsx', 'host.jsx'], ['jsx', 'lib', 'json.jsx'], ['jsx', 'lib', 'CopalCore.jsx'], ['jsx', 'lib', 'CopalSampler.jsx']]) {
        const code = source(...file)
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '')
            .replace(/\s\/\/ .*$/gm, '')
            .replace(/^if \(typeof module.*$/m, '');
        for (const [pattern, what] of banned) {
            const hit = pattern.exec(code);
            assert.ok(!hit, file.join('/') + ' uses ' + what + ' near: ' + (hit ? code.substr(Math.max(0, hit.index - 40), 90) : ''));
        }
    }
});

/* ============================================================== store */

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'copal-test-'));
}

const SAVED = [
    { id: 'one', name: 'Brand', fill: { color: [1, 0.5, 0], opacity: 100 }, stroke: null },
    { id: 'two', name: 'Line', fill: null, stroke: { color: [0, 0, 0], width: 4, dashes: [8, 4] } }
];

test('a missing palette file is an empty list, not an error', () => {
    const result = Store.read(path.join(tempDir(), 'nowhere', 'copal.json'));
    assert.deepStrictEqual(result.palettes, []);
    assert.strictEqual(result.error, null);
});

test('palettes survive a round trip, in folders that did not exist', () => {
    const file = path.join(tempDir(), 'a', 'b', 'copal.json');
    Store.update(file, list => { SAVED.forEach(p => list.push(p)); });
    const result = Store.read(file);
    assert.strictEqual(result.error, null);
    assert.deepStrictEqual(result.palettes, SAVED);
    assert.ok(result.mtime > 0);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['copal.json'], 'the temporary file was left behind');
});

test('two saves to one folder at once do not share a temporary file', () => {
    const file = path.join(tempDir(), 'copal.json');
    const realWrite = fs.writeFileSync;
    const temps = [];
    fs.writeFileSync = (target, ...rest) => { temps.push(target); return realWrite(target, ...rest); };
    try {
        Store.write(file, SAVED);
        Store.write(file, SAVED);
    } finally {
        fs.writeFileSync = realWrite;
    }
    assert.strictEqual(temps.length, 2);
    assert.notStrictEqual(temps[0], temps[1]);
    assert.ok(temps.every(t => path.dirname(t) === path.dirname(file) && t.endsWith('.tmp')), temps.join(', '));
});

test('a save the rename refuses leaves no temporary file behind', () => {
    const file = path.join(tempDir(), 'copal.json');
    const realRename = fs.renameSync;
    fs.renameSync = () => { const e = new Error('locked'); e.code = 'EPERM'; throw e; };
    try {
        assert.throws(() => Store.write(file, SAVED), /locked/);
    } finally {
        fs.renameSync = realRename;
    }
    assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), []);
});

test('the file is written to be read: colours on one line', () => {
    const file = path.join(tempDir(), 'copal.json');
    Store.write(file, SAVED);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('"color": [1, 0.5, 0]'), text);
    assert.ok(text.includes('"dashes": [8, 4]'), text);
    assert.ok(text.startsWith('{\n  "format": "copal",\n  "version": 1,\n  "palettes": [\n    {\n      "id": "one",'), text);
    assert.deepStrictEqual(JSON.parse(text).palettes, SAVED);
});

test('a file that is not valid JSON is reported and never overwritten', () => {
    const file = path.join(tempDir(), 'copal.json');
    const broken = '{ "palettes": [ {"name": "Brand", } ] }';
    fs.writeFileSync(file, broken);
    assert.strictEqual(Store.read(file).error, 'It is not valid JSON.');
    assert.throws(() => Store.update(file, list => { list.push(SAVED[0]); }), /was left alone/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), broken);
});

test('JSON that is not a palette file is reported and never overwritten', () => {
    const file = path.join(tempDir(), 'copal.json');
    fs.writeFileSync(file, '{"name": "some other tool"}');
    assert.strictEqual(Store.read(file).error, 'It is not a Copal palette file.');
    assert.throws(() => Store.update(file, () => {}));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"name": "some other tool"}');
});

test('an empty file and a file with a byte order mark both read', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'empty.json'), '');
    assert.strictEqual(Store.read(path.join(dir, 'empty.json')).error, null);
    fs.writeFileSync(path.join(dir, 'bom.json'), '\uFEFF' + JSON.stringify({ palettes: SAVED }));
    assert.strictEqual(Store.read(path.join(dir, 'bom.json')).palettes.length, 2);
});

test('reading keeps what it can use from a hand-edited file', () => {
    const file = path.join(tempDir(), 'copal.json');
    fs.writeFileSync(file, JSON.stringify({ format: 'copal', version: 9, palettes: [
        { id: 'x', name: '  Kept  ', fill: { color: [1, 1, 1] }, stroke: 'none', note: 'from a newer panel' },
        { id: 'x', fill: { color: [0, 0, 0] } },
        { name: 'No paint', fill: { color: 'red' }, stroke: null },
        'not an entry',
        null
    ] }));
    const { palettes, error } = Store.read(file);
    assert.strictEqual(error, null);
    assert.strictEqual(palettes.length, 2);
    assert.strictEqual(palettes[0].name, 'Kept');
    assert.strictEqual(palettes[0].stroke, null);
    assert.strictEqual(palettes[0].note, 'from a newer panel');
    assert.strictEqual(palettes[1].name, '000000');
    assert.notStrictEqual(palettes[1].id, 'x', 'two palettes share an id');
});

test('a change is made to the file as it is now, not as it was', () => {
    const file = path.join(tempDir(), 'copal.json');
    Store.write(file, [SAVED[0]]);
    // Someone else adds a palette after this panel last read the file.
    Store.write(file, [SAVED[0], SAVED[1]]);
    const { palettes } = Store.update(file, list => { list.push({ id: 'three', name: 'Mine', fill: { color: [0, 1, 0] }, stroke: null }); });
    assert.deepStrictEqual(palettes.map(p => p.id), ['one', 'two', 'three']);
});

test('a new palette is named for its colour', () => {
    const made = Store.create({ fill: { color: [1, 0.3529, 0.2118], opacity: 100 }, stroke: null, gradient: false });
    assert.strictEqual(made.name, 'FF5A36');
    assert.strictEqual(made.gradient, undefined);
    assert.ok(made.id);
    assert.strictEqual(Store.create({ fill: null, stroke: { color: [0, 0, 0] } }).name, '000000');
    assert.notStrictEqual(Store.create({ fill: { color: [0, 0, 0] } }).id, Store.create({ fill: { color: [0, 0, 0] } }).id);
});

test('a colour outside 0 to 1 still makes a hex code', () => {
    assert.strictEqual(Store.hex([1.8, -0.2, 0.5]), 'FF0080');
});

test('the two places a palette file lives', () => {
    assert.strictEqual(Store.projectFile(path.join('Z:', 'Jobs', 'Spot')), path.join('Z:', 'Jobs', 'Spot', 'copal.json'));
    assert.strictEqual(Store.userFile(path.join('C:', 'Roaming')), path.join('C:', 'Roaming', 'Copal', 'copal.json'));
});

/* ========================================================== gradients */

const Gradient = require(path.join(PANEL, 'js', 'gradient.js'));

/* What After Effects would sample from a gradient: one pixel per step, one
 * more off each end, rounded to the 256 levels of an 8 bit project. */
function ramp(colors, alphas, steps) {
    const n = steps || 256;
    const out = [];
    for (let i = 0; i <= n + 1; i++) {
        const t = i === 0 ? 0 : (i === n + 1 ? 1 : (i - 0.5) / n);
        out.push(Gradient.valueAt(colors, t).concat(Gradient.valueAt(alphas, t)).map(v => Math.round(v * 255) / 255));
    }
    return out;
}

const RGB = { colors: [[0, 1, 0, 0], [0.5, 0, 1, 0], [1, 0, 0, 1]], alphas: [[0, 1], [1, 0.25]] };

function near(actual, expected, tolerance, what) {
    assert.strictEqual(actual.length, expected.length, what + ': ' + JSON.stringify(actual));
    actual.forEach((row, i) => row.forEach((v, c) => {
        assert.ok(Math.abs(v - expected[i][c]) <= tolerance, what + ' stop ' + i + ': ' + JSON.stringify(actual));
    }));
}

test('two colours come back as two stops', () => {
    const got = Gradient.fit(ramp([[0, 1, 1, 0], [1, 1, 0, 1]], [[0, 1], [1, 1]]));
    near(got.colors, [[0, 1, 1, 0], [1, 1, 0, 1]], 0.005, 'colours');
    near(got.alphas, [[0, 1], [1, 1]], 0.005, 'alphas');
});

test('a stop in the middle comes back as one stop, where it was', () => {
    const got = Gradient.fit(ramp(RGB.colors, RGB.alphas));
    near(got.colors, RGB.colors, 0.006, 'colours');
    near(got.alphas, RGB.alphas, 0.006, 'alphas');
});

test('stops away from the pixel grid are found', () => {
    const colors = [[0, 0.1, 0.2, 0.9], [0.3, 1, 0.8, 0], [0.71, 0, 0.3, 0.4], [1, 1, 1, 1]];
    near(Gradient.fit(ramp(colors, [[0, 1], [1, 1]])).colors, colors, 0.012, 'colours');
});

test('a hard edge stays an edge', () => {
    const colors = [[0, 1, 0, 0], [0.4, 1, 0, 0], [0.4, 0, 0, 1], [1, 0, 0, 1]];
    const got = Gradient.fit(ramp(colors, [[0, 1], [1, 1]])).colors;
    assert.strictEqual(got.length, 4, JSON.stringify(got));
    assert.ok(got[2][0] - got[1][0] < 0.01, JSON.stringify(got));
    assert.ok(got[1][1] > 0.99 && got[2][3] > 0.99, JSON.stringify(got));
});

test('the fitted stops draw the ramp they were fitted to', () => {
    const colors = [[0, 0.9, 0.1, 0.3], [0.2, 0.2, 0.7, 0.1], [0.55, 1, 1, 0], [0.8, 0, 0, 0], [1, 0.5, 0.5, 1]];
    const alphas = [[0, 0.2], [0.6, 1], [1, 0.5]];
    const samples = ramp(colors, alphas);
    const got = Gradient.fit(samples);
    const again = ramp(got.colors, got.alphas);
    let worst = 0;
    samples.forEach((s, i) => s.forEach((v, c) => { worst = Math.max(worst, Math.abs(v - again[i][c])); }));
    assert.ok(worst < 3 / 255, 'off by ' + worst);
});

test('where nothing is painted, colour is borrowed, not read as black', () => {
    const samples = ramp([[0, 1, 0.5, 0], [1, 1, 0.5, 0]], [[0, 0], [0.5, 0], [1, 1]]).map(s => s[3] < 0.004 ? [0, 0, 0, 0] : s);
    near(Gradient.fit(samples).colors, [[0, 1, 0.5, 0], [1, 1, 0.5, 0]], 0.01, 'colours');
});

test('a busy gradient is held to a sane number of stops', () => {
    const colors = [];
    for (let i = 0; i <= 60; i++) colors.push([i / 60, i % 2, (i * 7 % 10) / 10, (i * 3 % 10) / 10]);
    assert.ok(Gradient.fit(ramp(colors, [[0, 1], [1, 1]])).colors.length <= 24);
});

test('finish turns samples into stops and leaves nothing else behind', () => {
    const paint = { opacity: 80, gradient: { type: 2, start: [0, 0], end: [1, 1] }, samples: ramp(RGB.colors, RGB.alphas), path: ['x', 1] };
    Gradient.finish(paint);
    assert.strictEqual(paint.samples, undefined);
    assert.strictEqual(paint.path, undefined);
    assert.strictEqual(paint.gradient.type, 2);
    assert.ok(Gradient.isGradient(paint));
    near([paint.color], [[1, 0, 0]], 0.005, 'plain colour');

    const lost = Gradient.finish({ color: [1, 1, 1], gradient: { type: 1 } });
    assert.strictEqual(lost.gradient, undefined);
    assert.strictEqual(Gradient.finish(null), null);
});

/* A reader for the preset, written apart from the writer it checks. */
function chunks(bytes, start, end) {
    const buf = Buffer.from(bytes);
    const out = [];
    let pos = start;
    while (pos + 8 <= end) {
        const id = buf.toString('latin1', pos, pos + 4);
        const size = buf.readUInt32BE(pos + 4);
        const node = { id, size, data: buf.slice(pos + 8, pos + 8 + size) };
        if (id === 'LIST' || id === 'RIFX') {
            node.form = buf.toString('latin1', pos + 8, pos + 12);
            node.children = chunks(buf, pos + 12, pos + 8 + size);
        }
        out.push(node);
        pos += 8 + size + (size % 2);
    }
    assert.strictEqual(pos, end, 'chunks do not fill their container exactly');
    return out;
}

test('a preset is a well formed file that names only the colours', () => {
    for (const kind of ['fill', 'stroke']) {
        const bytes = Gradient.preset(kind, RGB);
        const top = chunks(bytes, 0, bytes.length);
        assert.strictEqual(top.length, 1);
        assert.strictEqual(top[0].form, 'FaFX');

        const besc = top[0].children.find(c => c.form === 'besc').children;
        const paths = besc.filter(c => c.form === 'tdsp').map(p => p.children.filter(c => c.form === 'tdsi').map(step => ({
            index: step.children.find(c => c.id === 'tdix').data.toString('hex'),
            name: step.children.find(c => c.id === 'tdmn').data.toString('latin1').replace(/\0+$/, '')
        })));
        // A path that stopped at Contents would replace everything in the layer.
        assert.deepStrictEqual(paths[0], [
            { index: 'ffffffff', name: 'ADBE Root Vectors Group' },
            { index: '00000000', name: 'ADBE Vector Graphic - G-' + (kind === 'fill' ? 'Fill' : 'Stroke') },
            { index: 'ffffffff', name: 'ADBE Vector Grad Colors' }
        ]);
        assert.deepStrictEqual(paths[1], [{ index: 'ffffffff', name: 'ADBE End of path sentinel' }]);
        assert.strictEqual(paths.length, 2);
        assert.ok(!besc.some(c => c.form === 'tdgp'), 'the preset holds a whole group');

        const colors = besc.find(c => c.form === 'GCst').children;
        assert.strictEqual(colors.find(c => c.form === 'tdbs').children.find(c => c.id === 'tdb4').size, 124);
        const xml = colors.find(c => c.form === 'GCky').children[0].data.toString('utf8');
        assert.strictEqual(xml, Gradient.colorsXml(RGB));
    }
});

test('the colours are written the way After Effects writes them', () => {
    const xml = Gradient.colorsXml({ colors: [[0, 1, 0.5, 0], [1, 0, 0, 1.4]], alphas: [[0, 0.5]] });
    const floats = block => (xml.split('<key>' + block + '</key>')[1].split('<key>Stops Size</key>')[0].match(/<float>[^<]*<\/float>/g) || [])
        .map(f => Number(f.replace(/<\/?float>/g, '')));
    assert.deepStrictEqual(floats('Color Stops'), [0, 0.5, 1, 0.5, 0, 1, 1, 0.5, 0, 0, 1, 1]);
    // One alpha is not enough for After Effects, so it is given at both ends.
    assert.deepStrictEqual(floats('Alpha Stops'), [0, 0.5, 0.5, 1, 0.5, 0.5]);
    assert.ok(xml.startsWith('<?xml version=\'1.0\'?>\n<prop.map version=\'4\'>'));
    assert.ok(xml.endsWith('<key>Gradient Colors</key>\n<string>1.0</string>\n</prop.pair>\n</prop.list>\n</prop.map>\n'));
});

test('a swatch draws the gradient at its angle, from its start to its end', () => {
    const across = Gradient.css({ opacity: 100, gradient: { type: 1, start: [0, 0.5], end: [1, 0.5], colors: RGB.colors, alphas: [[0, 1]] } });
    assert.strictEqual(across, 'linear-gradient(90deg, rgba(255,0,0,1) 0%, rgba(0,255,0,1) 50%, rgba(0,0,255,1) 100%)');

    const down = Gradient.css({ opacity: 50, gradient: { type: 1, start: [0.5, 0.25], end: [0.5, 0.75], colors: [[0, 1, 1, 1], [1, 0, 0, 0]], alphas: [[0, 1]] } });
    assert.strictEqual(down, 'linear-gradient(180deg, rgba(255,255,255,0.5) 25%, rgba(0,0,0,0.5) 75%)');

    const round = Gradient.css({ gradient: { type: 2, start: [0.5, 0.5], end: [1, 0.5], colors: [[0, 1, 1, 1], [1, 0, 0, 0]], alphas: [[0, 1]] } });
    assert.ok(round.startsWith('radial-gradient(ellipse 50% 50% at 50% 50%, '), round);
});

/* -------------------------------------------------- gradients, applied */

function env(l, broken) {
    const made = [];
    return {
        made,
        gradient(target, kind) {
            made.push(kind);
            target.property(ae.names.ROOT).addProperty(kind === 'fill' ? ae.names.GFILL : ae.names.GSTROKE);
        },
        group(target, indices) { if (!broken) l._groupShapes(indices); },
        ungroup(target, at) { l._ungroup(l._at(at)); }
    };
}

const GRADIENT_FILL = { color: [1, 0, 0], opacity: 70, gradient: Object.assign({ type: 2, start: [0, 0.5], end: [1, 0.5], highlightLength: 20 }, RGB) };
const GRADIENT_STROKE = { color: [1, 1, 0], width: 6, dashes: [5, 5], gradient: Object.assign({ type: 1, start: [0, 0], end: [1, 1] }, RGB) };

function applyWith(target, palette, e, time) {
    return Core.applyTo(target._proxy, palette, Core.newReport(time), e);
}

test('a gradient fill goes to the top level and the fills inside go off', () => {
    const l = layer(group('A', rect(), stroke(RED, 1), fill(RED)), group('B', rect(), fill(GREEN)));
    const e = env(l);
    const report = applyWith(l, { fill: GRADIENT_FILL, stroke: PALETTE.stroke }, e);
    assert.deepStrictEqual(e.made, ['fill']);
    assert.strictEqual(order(l), 'group group stroke gfill');
    assert.strictEqual(order(child(l, 1)), 'rect (stroke) (fill)');
    assert.strictEqual(order(child(l, 2)), 'rect (fill)');
    assert.strictEqual(child(l, 4).name, 'Copal Fill');
    assert.strictEqual(valueOf(child(l, 4), FILL_OPACITY), 70);
    assert.strictEqual(valueOf(child(l, 4), 'ADBE Vector Grad Type'), 2);
    assert.strictEqual(valueOf(child(l, 4), 'ADBE Vector Grad HiLite Length'), 20);
    assert.strictEqual(valueOf(child(l, 3), STROKE_WIDTH), 6);
    assert.strictEqual(report.failed, 0);
    assert.strictEqual(report.refused, 0);
});

test('a gradient is laid over the box round the layer', () => {
    const l = layer(group('A', rect(), fill(RED)));
    l._box = { left: -110, top: -20, width: 300, height: 60 };
    applyWith(l, { fill: GRADIENT_FILL, stroke: GRADIENT_STROKE }, env(l));
    assert.strictEqual(order(l), 'group gstroke gfill');
    assert.deepStrictEqual(valueOf(child(l, 3), 'ADBE Vector Grad Start Pt'), [-110, 10]);
    assert.deepStrictEqual(valueOf(child(l, 3), 'ADBE Vector Grad End Pt'), [190, 10]);
    assert.deepStrictEqual(valueOf(child(l, 2), 'ADBE Vector Grad Start Pt'), [-110, -20]);
    assert.deepStrictEqual(valueOf(child(l, 2), 'ADBE Vector Grad End Pt'), [190, 40]);
    assert.strictEqual(valueOf(child(l, 2), STROKE_WIDTH), 6);
    assert.deepStrictEqual(liveDashes(child(l, 2)), [5, 5]);
});

test('a gradient stroke brings a solid fill up beside it, stroke on top', () => {
    const l = layer(group('A', rect(), stroke(RED, 1), fill(RED)));
    applyWith(l, { fill: PALETTE.fill, stroke: GRADIENT_STROKE }, env(l));
    assert.strictEqual(order(l), 'group gstroke fill');
    assert.strictEqual(order(child(l, 1)), 'rect (stroke) (fill)');
    assert.deepStrictEqual(valueOf(child(l, 3), FILL_COLOR), TEAL.concat([1]));
});

test('a gradient with no stroke in the palette switches strokes off', () => {
    const l = layer(group('A', rect(), stroke(RED, 1), fill(RED)));
    applyWith(l, { fill: GRADIENT_FILL, stroke: null }, env(l));
    assert.strictEqual(order(l), 'group gfill');
    assert.strictEqual(order(child(l, 1)), 'rect (stroke) (fill)');
});

test('applying gradients again replaces the last ones instead of piling up', () => {
    const l = layer(group('A', rect(), fill(RED)));
    const palette = { fill: GRADIENT_FILL, stroke: GRADIENT_STROKE };
    applyWith(l, palette, env(l));
    applyWith(l, palette, env(l));
    applyWith(l, { fill: GRADIENT_FILL, stroke: null }, env(l));
    assert.strictEqual(order(l), 'group gfill');
});

test('a solid palette clears the gradients away and brings the paints inside back', () => {
    const l = layer(group('A', rect(), stroke(RED, 1), fill(RED)));
    applyWith(l, { fill: GRADIENT_FILL, stroke: GRADIENT_STROKE }, env(l));
    apply(l, PALETTE);
    assert.strictEqual(order(l), 'group');
    assert.strictEqual(order(child(l, 1)), 'rect stroke fill');
    assert.deepStrictEqual(valueOf(child(l, 1, 3), FILL_COLOR), TEAL.concat([1]));
});

test('a see-through fill is not doubled by one above it', () => {
    const l = layer(group('A', rect(), fill(RED)), fill(GREEN));
    child(l, 1, 2).enabled = false;
    apply(l, { fill: PALETTE.fill, stroke: null });
    assert.strictEqual(order(child(l, 1)), 'rect (fill)');
    assert.strictEqual(order(l), 'group fill');
});

test('a gradient someone else made is switched off, not removed', () => {
    const l = layer(group('A', rect(), fill(RED)), gradientFill());
    applyWith(l, { fill: GRADIENT_FILL, stroke: null }, env(l));
    assert.strictEqual(order(l), 'group (gfill) gfill');
    assert.strictEqual(child(l, 2).name, 'Gradient Fill 1');
});

test('a gradient on one group of several wraps that group with the gradient', () => {
    const l = layer(group('A', rect(), fill(RED)), group('B', rect(), stroke(RED, 1), fill(GREEN)), group('C', rect(), fill(BLUE)));
    child(l, 2).selected = true;
    const report = applyWith(l, { fill: GRADIENT_FILL, stroke: GRADIENT_STROKE }, env(l));
    assert.strictEqual(report.refused, 0);
    assert.strictEqual(report.failed, 0);
    assert.strictEqual(report.layers, 1);
    // B keeps its place between A and C, inside a new group with the paints below it.
    assert.strictEqual(order(l), 'group group group');
    assert.strictEqual(child(l, 2).name, 'B gradient');
    assert.strictEqual(order(child(l, 2)), 'group gstroke gfill');
    assert.strictEqual(child(l, 2, 1).name, 'B');
    assert.strictEqual(order(child(l, 2, 1)), 'rect (stroke) (fill)');
    assert.strictEqual(child(l, 2, 3).name, 'Copal Fill');
    assert.deepStrictEqual(valueOf(child(l, 2, 3), 'ADBE Vector Grad Start Pt'), [-150, 0]);
    assert.strictEqual(valueOf(child(l, 2, 2), STROKE_WIDTH), 6);
    // The others are as they were, and switched back on after measuring.
    assert.strictEqual(order(child(l, 1)), 'rect fill');
    assert.strictEqual(order(child(l, 3)), 'rect fill');
    assert.deepStrictEqual(valueOf(child(l, 3, 2), FILL_COLOR), BLUE.concat([1]));
});

test('a solid half of the palette goes into the wrapper beside the gradient', () => {
    const l = layer(group('A', rect(), fill(RED)), group('B', rect(), stroke(RED, 1), fill(GREEN)));
    child(l, 2).selected = true;
    applyWith(l, { fill: PALETTE.fill, stroke: GRADIENT_STROKE }, env(l));
    assert.strictEqual(order(child(l, 2)), 'group gstroke fill');
    assert.deepStrictEqual(valueOf(child(l, 2, 3), FILL_COLOR), TEAL.concat([1]));
    assert.strictEqual(order(child(l, 2, 1)), 'rect (stroke) (fill)');
});

test('a wrapped group takes another gradient without wrappers nesting', () => {
    const l = layer(group('A', rect(), fill(RED)), group('B', rect(), fill(GREEN)));
    child(l, 2).selected = true;
    applyWith(l, { fill: GRADIENT_FILL, stroke: GRADIENT_STROKE }, env(l));
    // Selecting the wrapper, or the group inside it, both mean the wrapper.
    child(l, 2).selected = false;
    child(l, 2, 1).selected = true;
    const report = applyWith(l, { fill: GRADIENT_FILL, stroke: null }, env(l));
    assert.strictEqual(report.refused, 0);
    assert.strictEqual(order(l), 'group group');
    assert.strictEqual(child(l, 2).name, 'B gradient');
    assert.strictEqual(order(child(l, 2)), 'group gfill');
    assert.strictEqual(child(l, 2, 1).name, 'B');
    assert.strictEqual(order(child(l, 2, 1)), 'rect (fill)');
});

test('two selected groups are each wrapped, and the third is left alone', () => {
    const l = layer(group('A', rect(), fill(RED)), group('B', rect(), fill(GREEN)), group('C', rect(), fill(BLUE)));
    child(l, 1).selected = true;
    child(l, 3).selected = true;
    applyWith(l, { fill: GRADIENT_FILL, stroke: null }, env(l));
    assert.strictEqual(order(child(l, 1)), 'group gfill');
    assert.strictEqual(order(child(l, 2)), 'rect fill');
    assert.strictEqual(order(child(l, 3)), 'group gfill');
    assert.strictEqual(child(l, 3).name, 'C gradient');
});

test('if After Effects will not group, the layer is left as it was', () => {
    const l = layer(group('A', rect(), fill(RED)), group('B', rect(), stroke(RED, 1), fill(GREEN)));
    child(l, 2).selected = true;
    const report = applyWith(l, { fill: GRADIENT_FILL, stroke: GRADIENT_STROKE }, env(l, true));
    assert.strictEqual(report.refused, 1);
    assert.strictEqual(report.reason, 'wrap');
    assert.strictEqual(report.layers, 0);
    assert.strictEqual(order(l), 'group group');
    assert.strictEqual(order(child(l, 2)), 'rect stroke fill');
});

test('a gradient is refused for a group inside another group', () => {
    const l = layer(group('A', group('Inner', rect(), fill(RED)), rect()), group('B', rect(), fill(GREEN)));
    child(l, 1, 1).selected = true;
    const e = env(l);
    const report = applyWith(l, { fill: GRADIENT_FILL, stroke: null }, e);
    assert.strictEqual(report.refused, 1);
    assert.strictEqual(report.reason, 'part');
    assert.deepStrictEqual(e.made, []);
    assert.strictEqual(order(child(l, 1, 1)), 'rect fill');
});

test('a solid palette over a wrapped group repaints inside the wrapper', () => {
    const l = layer(group('A', rect(), fill(RED)), group('B', rect(), stroke(RED, 1), fill(GREEN)));
    child(l, 2).selected = true;
    applyWith(l, { fill: GRADIENT_FILL, stroke: GRADIENT_STROKE }, env(l));
    apply(l, PALETTE);
    assert.strictEqual(order(child(l, 2)), 'group');
    assert.strictEqual(order(child(l, 2, 1)), 'rect stroke fill');
    assert.deepStrictEqual(valueOf(child(l, 2, 1, 3), FILL_COLOR), TEAL.concat([1]));
});

test('the only group of a layer counts as the layer', () => {
    const l = layer(group('A', rect(), fill(RED)));
    child(l, 1).selected = true;
    const report = applyWith(l, { fill: GRADIENT_FILL, stroke: null }, env(l));
    assert.strictEqual(report.refused, 0);
    assert.strictEqual(order(l), 'group gfill');
});

test('a selected fill takes a gradient fill and leaves the stroke alone', () => {
    const l = layer(group('A', rect(), stroke(RED, 1), fill(RED)));
    child(l, 1, 3).selected = true;
    const e = env(l);
    applyWith(l, { fill: GRADIENT_FILL, stroke: GRADIENT_STROKE }, e);
    assert.deepStrictEqual(e.made, ['fill']);
    assert.strictEqual(order(l), 'group gfill');
    assert.strictEqual(order(child(l, 1)), 'rect stroke (fill)');
});

test('a selected stroke is refused a gradient stroke, but takes a solid one', () => {
    const l = layer(group('A', rect(), stroke(RED, 1), fill(RED)));
    child(l, 1, 2).selected = true;
    const refused = applyWith(l, { fill: PALETTE.fill, stroke: GRADIENT_STROKE }, env(l));
    assert.strictEqual(refused.reason, 'stroke');
    assert.strictEqual(order(l), 'group');

    const report = applyWith(l, { fill: GRADIENT_FILL, stroke: PALETTE.stroke }, env(l));
    assert.strictEqual(report.refused, 0);
    assert.strictEqual(valueOf(child(l, 1, 2), STROKE_WIDTH), 6);
    assert.strictEqual(order(l), 'group');
});

test('a gradient is refused when nothing can make one', () => {
    const l = layer(group('A', rect(), fill(RED)));
    const report = Core.applyTo(l._proxy, { fill: GRADIENT_FILL, stroke: null }, Core.newReport(0));
    assert.strictEqual(report.reason, 'unsupported');
    assert.strictEqual(order(child(l, 1)), 'rect fill');
});

test('a preset that fails leaves the layer as it was, and says so', () => {
    const l = layer(group('A', rect(), stroke(RED, 1), fill(RED)), stroke(GREEN, 2));
    const report = applyWith(l, { fill: GRADIENT_FILL, stroke: null }, { gradient() { throw new Error('no'); } });
    assert.strictEqual(report.refused, 1);
    assert.strictEqual(report.reason, 'preset');
    assert.strictEqual(report.layers, 0);
    assert.strictEqual(report.paints, 0);
    assert.strictEqual(order(l), 'group stroke');
    assert.strictEqual(order(child(l, 1)), 'rect stroke fill');
});

test('a second preset that fails takes the first gradient back with it', () => {
    const l = layer(group('A', rect(), fill(RED)));
    const e = env(l);
    const strokeOnly = Object.assign({}, e, {
        gradient(target, kind) {
            if (kind === 'fill') throw new Error('no');
            e.gradient(target, kind);
        }
    });
    const report = applyWith(l, { fill: GRADIENT_FILL, stroke: GRADIENT_STROKE }, strokeOnly);
    assert.strictEqual(report.reason, 'preset');
    assert.strictEqual(report.added, 0);
    assert.strictEqual(order(l), 'group');
    assert.strictEqual(order(child(l, 1)), 'rect fill');
});

test('a preset that brings the wrong paint is taken back', () => {
    const l = layer(group('A', rect(), fill(RED)));
    const report = applyWith(l, { fill: GRADIENT_FILL, stroke: null }, {
        gradient(target) { target.property(ae.names.ROOT).addProperty(ae.names.STROKE); }
    });
    assert.strictEqual(report.reason, 'preset');
    assert.strictEqual(order(l), 'group');
    assert.strictEqual(order(child(l, 1)), 'rect fill');
});

test('a preset that fails keeps the gradients of the last palette', () => {
    const l = layer(group('A', rect(), fill(RED)));
    applyWith(l, { fill: GRADIENT_FILL, stroke: GRADIENT_STROKE }, env(l));
    const report = applyWith(l, { fill: GRADIENT_FILL, stroke: null }, { gradient() { throw new Error('no'); } });
    assert.strictEqual(report.reason, 'preset');
    assert.strictEqual(order(l), 'group gstroke gfill');
    assert.strictEqual(child(l, 3).name, 'Copal Fill');
});

test('a preset that fails on one group leaves that group as it was', () => {
    const l = layer(group('A', rect(), fill(RED)), group('B', rect(), stroke(RED, 1), fill(GREEN)));
    child(l, 2).selected = true;
    const e = env(l);
    const broken = Object.assign({}, e, { gradient() { throw new Error('no'); } });
    const report = applyWith(l, { fill: GRADIENT_FILL, stroke: PALETTE.stroke }, broken);
    assert.strictEqual(report.refused, 1);
    assert.strictEqual(report.reason, 'preset');
    assert.strictEqual(report.layers, 0);
    assert.strictEqual(order(l), 'group group');
    assert.strictEqual(child(l, 2).name, 'B');
    assert.strictEqual(order(child(l, 2)), 'rect stroke fill');
});

test('the panel and After Effects agree on what is a gradient', () => {
    const g = extra => ({ color: RED, gradient: Object.assign({ type: 1 }, RGB, extra) });
    const cases = {
        'complete': g({}),
        'no alphas': g({ alphas: undefined }),
        'empty alphas': g({ alphas: [] }),
        'one colour stop': g({ colors: [[0, 1, 0, 0]] }),
        'a colour stop short of blue': g({ colors: [[0, 1, 0, 0], [1, 0, 0]] }),
        'a colour stop with text in it': g({ colors: [[0, 1, 0, 0], [1, 0, 0, '1']] }),
        'an alpha stop with no alpha': g({ alphas: [[0, 1], [1]] }),
        'colours that are not a list': g({ colors: 'red' }),
        'a gradient that is a list': { color: RED, gradient: [] },
        'no gradient': { color: RED },
        'no paint': null
    };
    for (const name of Object.keys(cases)) {
        assert.strictEqual(Core.isGradient(cases[name]), Gradient.isGradient(cases[name]), name);
    }
    assert.ok(Core.isGradient(cases.complete));
});

test('a gradient the panel cannot draw is applied as its solid colour', () => {
    const l = layer(group('A', rect(), fill(RED)));
    const e = env(l);
    const half = { color: GREEN, opacity: 100, gradient: { type: 1, colors: [[0, 1, 0, 0], [1, 0, 0, 1]] } };
    const report = applyWith(l, { fill: half, stroke: null }, e);
    assert.deepStrictEqual(e.made, []);
    assert.strictEqual(report.refused, 0);
    assert.strictEqual(order(child(l, 1)), 'rect fill');
    assert.deepStrictEqual(valueOf(child(l, 1, 2), FILL_COLOR), GREEN.concat([1]));
});

test('every reason a layer is left alone has words in the panel', () => {
    const core = source('jsx', 'lib', 'CopalCore.jsx');
    const main = source('js', 'main.js');
    const reasons = new Set();
    for (const m of core.matchAll(/reason = '(\w+)'/g)) reasons.add(m[1]);
    // applyAtTop and applyAtGroup hand theirs back as what they return.
    for (const name of ['applyAtTop', 'applyAtGroup']) {
        const body = core.slice(core.indexOf('function ' + name + '('));
        for (const m of body.slice(0, body.indexOf('\n    function ', 1)).matchAll(/return '(\w+)'/g)) reasons.add(m[1]);
    }
    assert.ok(reasons.has('preset') && reasons.has('wrap') && reasons.has('half'), [...reasons].join(' '));
    for (const reason of reasons) {
        assert.ok(new RegExp('\\n\\s+' + reason + ": '").test(main), 'main.js REFUSALS has no ' + reason);
    }
});

test('a selected gradient fill takes a solid palette beside it', () => {
    const l = layer(group('A', rect(), stroke(RED, 1), gradientFill()));
    child(l, 1, 3).selected = true;
    const report = apply(l, PALETTE);
    assert.strictEqual(report.failed, 0);
    assert.strictEqual(order(child(l, 1)), 'rect stroke (gfill) fill');
    assert.strictEqual(valueOf(child(l, 1, 2), STROKE_WIDTH), 1);
});

test('a selected gradient does not move a group selected after it', () => {
    const l = layer(group('G', rect(), gradientFill(), rect(), group('Inner', rect(), fill(RED))));
    child(l, 1, 2).selected = true;
    child(l, 1, 4).selected = true;
    const report = apply(l, PALETTE);
    assert.strictEqual(report.failed, 0);
    assert.strictEqual(order(child(l, 1)), 'rect (gfill) fill rect group');
    assert.strictEqual(child(l, 1, 5).name, 'Inner');
    assert.strictEqual(order(child(l, 1, 5)), 'rect stroke fill');
    assert.deepStrictEqual(valueOf(child(l, 1, 5, 3), FILL_COLOR), TEAL.concat([1]));
});

test('a selected gradient fill and gradient stroke in one group both give way', () => {
    const l = layer(group('G', rect(), gradientStroke(2), gradientFill()));
    child(l, 1, 2).selected = true;
    child(l, 1, 3).selected = true;
    const report = apply(l, PALETTE);
    assert.strictEqual(report.failed, 0);
    assert.strictEqual(order(child(l, 1)), 'rect (gstroke) stroke (gfill) fill');
    assert.deepStrictEqual(valueOf(child(l, 1, 3), STROKE_COLOR), INK.concat([1]));
    assert.deepStrictEqual(valueOf(child(l, 1, 5), FILL_COLOR), TEAL.concat([1]));
});

test('host.apply selects each layer alone for its preset and puts the selection back', () => {
    const a = layer(group('A', rect(), fill(RED)));
    const b = layer(group('B', rect(), fill(GREEN)));
    const other = new ae.Layer('Title', 'ADBE Text Layer');
    const app = { project: { activeItem: null, file: null }, beginUndoGroup() {}, endUndoGroup() {} };
    const { host, CompItem } = loadHost(app);
    const comp = Object.assign(new CompItem(), { time: 0 });
    const real = new ae.Comp([a, other, b]);
    Object.defineProperty(comp, 'selectedLayers', { get: () => real.selectedLayers });
    app.project.activeItem = comp;
    a.selected = b.selected = other.selected = true;

    const palette = JSON.stringify({ fill: GRADIENT_FILL, stroke: GRADIENT_STROKE });
    assert.strictEqual(host.apply(palette, 'C:\\tmp\\fill.ffx', 'C:\\tmp\\stroke.ffx'), 'OK|2|6|4|0|0|');
    assert.deepStrictEqual(a._presets, ['C:\\tmp\\stroke.ffx', 'C:\\tmp\\fill.ffx']);
    assert.deepStrictEqual(b._presets, ['C:\\tmp\\stroke.ffx', 'C:\\tmp\\fill.ffx']);
    assert.deepStrictEqual(other._presets, []);
    assert.strictEqual(order(a), 'group gstroke gfill');
    assert.strictEqual(order(b), 'group gstroke gfill');
    assert.ok(a.selected && b.selected && other.selected, 'the selection was not put back');
});

test('host.apply reports a layer it left alone, and why', () => {
    const a = layer(group('A', rect(), fill(RED)), group('B', rect(), fill(RED)));
    const app = { project: { activeItem: null, file: null }, beginUndoGroup() {}, endUndoGroup() {} };
    const { host, CompItem } = loadHost(app);
    const comp = Object.assign(new CompItem(), { time: 0 });
    const real = new ae.Comp([a]);
    Object.defineProperty(comp, 'selectedLayers', { get: () => real.selectedLayers });
    app.project.activeItem = comp;
    a.selected = true;
    child(a, 2).selected = true;
    // No executeCommand here, so After Effects "will not group".
    assert.strictEqual(host.apply(JSON.stringify({ fill: GRADIENT_FILL, stroke: null }), 'f.ffx', ''), 'OK|0|1|1|0|1|wrap');
    assert.strictEqual(order(a), 'group group');
    assert.strictEqual(order(child(a, 2)), 'rect fill');
});

test('host.apply wraps a selected group through the Group Shapes command', () => {
    const a = layer(group('A', rect(), fill(RED)), group('B', rect(), fill(GREEN)));
    const commands = [];
    const app = {
        project: { activeItem: null, file: null }, beginUndoGroup() {}, endUndoGroup() {},
        executeCommand(id) {
            commands.push(id);
            const picked = a.selectedProperties;
            // The command acts on the selection, and only if the layer alone is selected.
            assert.ok(a.selected, 'the layer was not selected for the command');
            if (id === 3741) a._groupShapes(picked.map(p => p.propertyIndex));
            else a._ungroup(picked[0]._raw);
        }
    };
    const { host, CompItem } = loadHost(app);
    const comp = Object.assign(new CompItem(), { time: 0 });
    const real = new ae.Comp([a]);
    Object.defineProperty(comp, 'selectedLayers', { get: () => real.selectedLayers });
    app.project.activeItem = comp;
    a.selected = true;
    child(a, 2).selected = true;

    const reply = host.apply(JSON.stringify({ fill: GRADIENT_FILL, stroke: null }), 'f.ffx', '');
    assert.strictEqual(reply.split('|').slice(0, 2).join('|'), 'OK|1');
    assert.strictEqual(reply.split('|')[5], '0');
    assert.deepStrictEqual(commands, [3741]);
    assert.strictEqual(order(a), 'group group');
    assert.strictEqual(order(child(a, 2)), 'group gfill');
    assert.strictEqual(order(child(a, 1)), 'rect fill');
    assert.ok(a.selected);
});

test('a gradient palette survives the palette file and is named for its ends', () => {
    const file = path.join(tempDir(), 'copal.json');
    const made = Store.create({ fill: JSON.parse(JSON.stringify(GRADIENT_FILL)), stroke: null });
    assert.strictEqual(made.name, 'FF0000-0000FF');
    Store.update(file, list => { list.push(made); });
    const back = Store.read(file).palettes[0];
    assert.deepStrictEqual(back.fill.gradient, GRADIENT_FILL.gradient);
    assert.ok(Gradient.isGradient(back.fill));
    assert.ok(fs.readFileSync(file, 'utf8').includes('"colors": [\n'), 'stops should be one per line');
});

/* ============================================================ picture */

const Picture = require(path.join(PANEL, 'js', 'picture.js'));

/* RGBA bytes for a picture drawn pixel by pixel. */
function picture(width, height, at) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const c = at(x, y);
            data.set([c[0], c[1], c[2], c.length > 3 ? c[3] : 255], (y * width + x) * 4);
        }
    }
    return data;
}

const bytes = colour => colour.map(v => Math.round(v * 255));
const blend = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const SEA = [31, 95, 139], SAND = [233, 211, 163], BOAT = [215, 38, 61], SNOW = [250, 250, 250], COAL = [15, 15, 15];

test('a picture gives its colours, commonest first', () => {
    const got = Picture.mainColors(picture(100, 100, (x, y) => y < 60 ? SEA : SAND), 8);
    assert.deepStrictEqual(got.map(c => bytes(c.color)), [SEA, SAND]);
    assert.deepStrictEqual(got.map(c => c.share), [0.6, 0.4]);
});

test('the soft edge between two colours is not a colour of its own', () => {
    const got = Picture.mainColors(picture(100, 100, x => x < 49 ? SEA : x > 50 ? SAND : blend(SEA, SAND, (x - 48) / 3)), 8);
    assert.deepStrictEqual(got.map(c => bytes(c.color)), [SEA, SAND]);
});

test('a small bright accent is kept', () => {
    const got = Picture.mainColors(picture(100, 100, (x, y) => y < 90 ? SNOW : (x < 70 ? COAL : BOAT)), 8);
    assert.deepStrictEqual(got.map(c => bytes(c.color)), [SNOW, COAL, BOAT]);
});

test('see-through pixels are background, and a picture of nothing has no colours', () => {
    const got = Picture.mainColors(picture(100, 100, x => x < 50 ? [0, 255, 0, 0] : BOAT), 8);
    assert.deepStrictEqual(got.map(c => bytes(c.color)), [BOAT]);
    assert.strictEqual(got[0].share, 1);
    assert.deepStrictEqual(Picture.mainColors(picture(10, 10, () => [0, 0, 0, 0]), 8), []);
});

test('two colours that look alike are one', () => {
    const got = Picture.mainColors(picture(100, 100, x => x < 50 ? BOAT : [BOAT[0] - 8, BOAT[1] + 6, BOAT[2]]), 8);
    assert.strictEqual(got.length, 1);
});

test('with more colours than wanted, the ones given are in the picture', () => {
    const colours = [];
    for (let i = 0; i < 12; i++) colours.push([(i * 67) % 256, (i * 151) % 256, (i * 29 + 40) % 256]);
    const got = Picture.mainColors(picture(120, 10, x => colours[Math.floor(x / 10)]), 8);
    assert.strictEqual(got.length, 8);
    for (const c of got) {
        assert.ok(colours.some(real => real.join() === bytes(c.color).join()), bytes(c.color) + ' is not in the picture');
    }
    assert.deepStrictEqual(Picture.mainColors(picture(120, 10, x => colours[Math.floor(x / 10)]), 8), got, 'not the same twice');
});

test('palettes from a picture are named for the file and numbered on', () => {
    assert.strictEqual(Picture.baseName('C:\\Jobs\\Sunset  Beach.final.png'), 'Sunset Beach.final');
    assert.strictEqual(Picture.baseName('/Users/me/brand.svg'), 'brand');
    assert.strictEqual(Picture.baseName('.png'), 'Image');
    assert.deepStrictEqual(Picture.names('sunset', ['sunset 1', 'sunset 3', 'Sunset 9', 'sunset 3b'], 2), ['sunset 4', 'sunset 5']);
    assert.deepStrictEqual(Picture.names('a (1)', ['a (1) 2'], 1), ['a (1) 3']);
});

test('a palette with its stroke left out keeps it left out in the file', () => {
    const file = path.join(tempDir(), 'copal.json');
    const made = Store.fromColor([0.1, 0.2, 0.3], 'sunset 1');
    assert.ok(!('stroke' in made));
    Store.update(file, list => { list.push(made, SAVED[0]); });
    assert.ok(!fs.readFileSync(file, 'utf8').split('"sunset 1"')[1].split('}')[1].includes('stroke'), 'stroke was written');
    const [back, other] = Store.read(file).palettes;
    assert.deepStrictEqual(back, made);
    assert.ok(!('stroke' in back));
    assert.strictEqual(other.stroke, null, 'a stroke that is null must stay null');
});

test('a palette with no stroke at all leaves strokes as they are', () => {
    const l = layer(group('A', rect(), stroke(RED, 1), fill(RED)), group('B', rect(), fill(GREEN)));
    const report = apply(l, { fill: { color: TEAL, opacity: 100 } });
    assert.strictEqual(report.refused, 0);
    assert.strictEqual(order(child(l, 1)), 'rect stroke fill');
    assert.deepStrictEqual(valueOf(child(l, 1, 2), STROKE_COLOR), RED.concat([1]));
    assert.deepStrictEqual(valueOf(child(l, 1, 3), FILL_COLOR), TEAL.concat([1]));
    assert.strictEqual(order(child(l, 2)), 'rect fill', 'no stroke should be added');
    assert.deepStrictEqual(valueOf(child(l, 2, 2), FILL_COLOR), TEAL.concat([1]));
});

test('a palette with no stroke at all, on a selected stroke, changes nothing and says so', () => {
    const l = layer(group('A', rect(), stroke(RED, 1), fill(RED)));
    child(l, 1, 2).selected = true;
    const report = apply(l, { fill: { color: TEAL, opacity: 100 } });
    assert.strictEqual(report.refused, 1);
    assert.strictEqual(report.reason, 'half');
    assert.strictEqual(report.layers, 0);
    assert.deepStrictEqual(valueOf(child(l, 1, 2), STROKE_COLOR), RED.concat([1]));
    assert.deepStrictEqual(valueOf(child(l, 1, 3), FILL_COLOR), RED.concat([1]));
});

test('a palette with no stroke at all, on a selected stroke and fill, paints the fill', () => {
    const l = layer(group('A', rect(), stroke(RED, 1), fill(RED), gradientStroke(2)));
    child(l, 1, 2).selected = true;
    child(l, 1, 3).selected = true;
    child(l, 1, 4).selected = true;
    const report = apply(l, { fill: { color: TEAL, opacity: 100 } });
    assert.strictEqual(report.refused, 0);
    assert.strictEqual(order(child(l, 1)), 'rect stroke fill gstroke');
    assert.deepStrictEqual(valueOf(child(l, 1, 2), STROKE_COLOR), RED.concat([1]));
    assert.deepStrictEqual(valueOf(child(l, 1, 3), FILL_COLOR), TEAL.concat([1]));
});

test('a gradient palette with no stroke at all leaves the strokes inside on', () => {
    const l = layer(group('A', rect(), stroke(RED, 1), fill(RED)));
    applyWith(l, { fill: GRADIENT_FILL }, env(l));
    assert.strictEqual(order(l), 'group gfill');
    assert.strictEqual(order(child(l, 1)), 'rect stroke (fill)');
});

test('host.apply hands a palette with no stroke on as one', () => {
    const a = layer(group('A', rect(), stroke(RED, 1), fill(RED)));
    const app = { project: { activeItem: null, file: null }, beginUndoGroup() {}, endUndoGroup() {} };
    const { host, CompItem } = loadHost(app);
    const comp = Object.assign(new CompItem(), { time: 0 });
    const real = new ae.Comp([a]);
    Object.defineProperty(comp, 'selectedLayers', { get: () => real.selectedLayers });
    app.project.activeItem = comp;
    a.selected = true;
    const palette = Store.fromColor(TEAL, 'sea 1');
    assert.strictEqual(host.apply(JSON.stringify({ fill: palette.fill, stroke: palette.stroke }), '', ''), 'OK|1|1|0|0|0|');
    assert.strictEqual(order(child(a, 1)), 'rect stroke fill');
    assert.deepStrictEqual(valueOf(child(a, 1, 2), STROKE_COLOR), RED.concat([1]));
});

/* ============================================================ replace */

const BRAND = [6 / 255, 108 / 255, 231 / 255];      // #066CE7
const DEEP = [4 / 255, 72 / 255, 154 / 255];        // #04489A
const sameHex = (got, want) => got.slice(0, 3).every((v, i) => Math.round(v * 255) === Math.round(want[i] * 255));
const replaceIn = (l, from, to) => Core.replaceColor(l._proxy, from, to, 1, Core.newReplaceReport());

test('a hex code reads as a colour, and nonsense does not', () => {
    assert.deepStrictEqual(Store.parseHex('#066ce7').map(v => Math.round(v * 255)), [6, 108, 231]);
    assert.deepStrictEqual(Store.parseHex(' 04489A ').map(v => Math.round(v * 255)), [4, 72, 154]);
    assert.deepStrictEqual(Store.parseHex('#0af'), [0, 0.6667, 1]);
    for (const bad of ['', '#12345', 'blue', '#ggg000', null]) assert.strictEqual(Store.parseHex(bad), null, String(bad));
});

test('replace changes every fill and stroke of that colour, in groups and switched off', () => {
    const l = layer(
        group('A', rect(), stroke(BRAND, 2), fill(BRAND)),
        group('B', group('Inner', rect(), fill(BRAND)), rect(), fill(RED)),
        fill(BRAND));
    child(l, 3).enabled = false;
    const report = replaceIn(l, BRAND, DEEP);
    assert.strictEqual(report.changed, 4);
    assert.strictEqual(report.layers, 1);
    assert.ok(sameHex(valueOf(child(l, 1, 2), STROKE_COLOR), DEEP));
    assert.ok(sameHex(valueOf(child(l, 1, 3), FILL_COLOR), DEEP));
    assert.ok(sameHex(valueOf(child(l, 2, 1, 2), FILL_COLOR), DEEP));
    assert.ok(sameHex(valueOf(child(l, 3), FILL_COLOR), DEEP));
    assert.strictEqual(valueOf(child(l, 3), FILL_COLOR).length, 4, 'alpha should stay');
    assert.deepStrictEqual(valueOf(child(l, 2, 3), FILL_COLOR), RED.concat([1]), 'another colour was touched');
    assert.strictEqual(order(l), 'group group (fill)', 'nothing should be added or moved');
});

test('replace matches a colour a rounding step off, and no further', () => {
    const l = layer(group('A', rect(), fill([7 / 255, 108 / 255, 231 / 255])), group('B', rect(), fill([9 / 255, 108 / 255, 231 / 255])));
    assert.strictEqual(replaceIn(l, BRAND, DEEP).changed, 1);
    assert.ok(sameHex(valueOf(child(l, 1, 2), FILL_COLOR), DEEP));
    assert.ok(!sameHex(valueOf(child(l, 2, 2), FILL_COLOR), DEEP));
});

test('replace changes the keyframes holding the colour and keeps the rest', () => {
    const l = layer(group('A', rect(), fill(BRAND)));
    const color = child(l, 1, 2, FILL_COLOR);
    color._keyframes([BRAND.concat([1]), RED.concat([1]), BRAND.concat([1])]);
    const report = replaceIn(l, BRAND, DEEP);
    assert.strictEqual(report.changed, 2);
    assert.ok(sameHex(color.keyValue(1), DEEP));
    assert.deepStrictEqual(color.keyValue(2), RED.concat([1]));
    assert.ok(sameHex(color.keyValue(3), DEEP));
    assert.strictEqual(color.numKeys, 3);
});

test('replace leaves gradients and colours set by an expression, and counts them', () => {
    const l = layer(group('A', rect(), fill(BRAND), gradientFill()), group('B', rect(), stroke(BRAND, 1)));
    const driven = child(l, 2, 2, STROKE_COLOR);
    driven.expression = 'thisComp.layer("Controls").effect("Brand")(1)';
    driven.expressionEnabled = true;
    const report = replaceIn(l, BRAND, DEEP);
    assert.strictEqual(report.changed, 1);
    assert.strictEqual(report.gradients, 1);
    assert.strictEqual(report.expressions, 1);
    assert.deepStrictEqual(valueOf(child(l, 2, 2), STROKE_COLOR), BRAND.concat([1]));
});

test('host.replace works across the comp or the project, past locked layers, as one undo step', () => {
    const a = layer(group('A', rect(), fill(BRAND)));
    const b = layer(group('B', rect(), stroke(BRAND, 1), fill(RED)));
    const shut = layer(group('C', rect(), fill(BRAND)));
    shut.locked = true;
    const elsewhere = layer(group('D', rect(), fill(BRAND)));
    const undo = [];
    const app = { project: { activeItem: null, file: null }, beginUndoGroup(n) { undo.push('begin ' + n); }, endUndoGroup() { undo.push('end'); } };
    const { host, CompItem } = loadHost(app);
    const compOf = layers => {
        const real = new ae.Comp(layers);
        const comp = Object.assign(new CompItem(), { time: 0 });
        Object.defineProperty(comp, 'selectedLayers', { get: () => real.selectedLayers });
        Object.defineProperty(comp, 'numLayers', { get: () => real.numLayers });
        comp.layer = i => real.layer(i);
        return comp;
    };
    const main = compOf([a, b, shut, new ae.Layer('Title', 'ADBE Text Layer')]);
    const other = compOf([elsewhere]);
    app.project.activeItem = main;
    app.project.numItems = 3;
    app.project.item = i => [main, {}, other][i - 1];

    const json = JSON.stringify;
    assert.strictEqual(host.replace(json(BRAND), json(DEEP), 'selection'), 'ERR|Select a layer first.');
    a.selected = true;
    assert.strictEqual(host.replace(json(BRAND), json(DEEP), 'selection'), 'OK|1|1|1|0|0|0|0');
    assert.ok(sameHex(valueOf(child(b, 1, 2), STROKE_COLOR), BRAND), 'an unselected layer changed');

    assert.strictEqual(host.replace(json(BRAND), json(DEEP), 'comp'), 'OK|1|1|1|0|0|1|0');
    assert.ok(sameHex(valueOf(child(b, 1, 2), STROKE_COLOR), DEEP));
    assert.deepStrictEqual(valueOf(child(shut, 1, 2), FILL_COLOR), BRAND.concat([1]), 'a locked layer changed');
    assert.ok(sameHex(valueOf(child(elsewhere, 1, 2), FILL_COLOR), BRAND), 'another comp changed');

    assert.strictEqual(host.replace(json(BRAND), json(DEEP), 'project'), 'OK|1|1|1|0|0|1|0');
    assert.ok(sameHex(valueOf(child(elsewhere, 1, 2), FILL_COLOR), DEEP));
    assert.deepStrictEqual(undo, ['begin Replace colour with Copal', 'end', 'begin Replace colour with Copal', 'end', 'begin Replace colour with Copal', 'end']);
});

/* ------------------------------------- replace in text, solids, effects */

const { textDocument, textLayer, textAnimator, colorProp, effect, solidLayer } = ae;
const sameRgbHex = (got, want) => got.every((v, i) => i > 2 || Math.round(v * 255) === Math.round(want[i] * 255));

test('replace changes the fill and stroke of text, every keyframe of it', () => {
    const t = textLayer(textDocument('Sale', { fill: BRAND, stroke: BRAND }));
    t._sourceText._keyframes([
        textDocument('Sale', { fill: BRAND }, true),
        textDocument('Sale', { fill: RED, stroke: BRAND }, true)
    ]);
    const report = replaceIn(t, BRAND, DEEP);
    assert.strictEqual(report.changed, 2);
    assert.strictEqual(report.layers, 1);
    assert.ok(t._sourceText.keyValue(1)._fills.every(c => sameRgbHex(c, DEEP)));
    assert.ok(t._sourceText.keyValue(2)._fills.every(c => c.join() === RED.join()), 'a red key changed');
    assert.ok(t._sourceText.keyValue(2)._strokes.every(c => sameRgbHex(c, DEEP)));
});

test('replace in text changes only the characters of that colour where it can reach them', () => {
    const mixed = [{ fill: RED }, { fill: BRAND }, { fill: BRAND }, { fill: RED }];
    const t = textLayer(textDocument('abcd', mixed, true));
    assert.strictEqual(replaceIn(t, BRAND, DEEP).changed, 1);
    const fills = t._sourceText.value._fills;
    assert.deepStrictEqual(fills[0], RED);
    assert.ok(sameRgbHex(fills[1], DEEP) && sameRgbHex(fills[2], DEEP));
    assert.deepStrictEqual(fills[3], RED);
    // Without character ranges only the first character can be read, so a
    // match there is taken for the whole text.
    const old = textLayer(textDocument('abcd', mixed, false));
    assert.strictEqual(replaceIn(old, BRAND, DEEP).changed, 0);
});

test('text with no fill, or a fill an expression decides, is left alone', () => {
    const bare = textLayer(textDocument('Hi', { stroke: RED }));
    const report = replaceIn(bare, BRAND, DEEP);
    assert.strictEqual(report.changed + report.failed, 0);
    const driven = textLayer(textDocument('Hi', { fill: BRAND }));
    driven._sourceText.expression = 'text.sourceText';
    driven._sourceText.expressionEnabled = true;
    const second = replaceIn(driven, BRAND, DEEP);
    assert.strictEqual(second.changed, 0);
    assert.strictEqual(second.expressions, 1);
    assert.ok(driven._sourceText.value._fills.every(c => c.join() === BRAND.join()));
});

test('replace changes the colours of text animators', () => {
    const fillColor = colorProp('ADBE Text Fill Color', BRAND);
    const strokeColor = colorProp('ADBE Text Stroke Color', RED);
    const t = textLayer(textDocument('Hi', { fill: RED }), textAnimator('Animator 1', fillColor, strokeColor));
    const report = replaceIn(t, BRAND, DEEP);
    assert.strictEqual(report.changed, 1);
    assert.ok(sameHex(fillColor._value, DEEP));
    assert.deepStrictEqual(strokeColor._value, RED.concat([1]));
});

test('replace changes a solid once, and leaves nulls and adjustment layers', () => {
    const shared = { mainSource: { color: BRAND.slice() } };
    const one = solidLayer(BRAND, shared);
    const two = solidLayer(BRAND, shared);
    const report = Core.newReplaceReport();
    Core.replaceColor(one._proxy, BRAND, DEEP, 1, report);
    Core.replaceColor(two._proxy, BRAND, DEEP, 1, report);
    assert.strictEqual(report.changed, 1, 'a shared solid was counted twice');
    assert.ok(sameHex(shared.mainSource.color, DEEP));
    assert.strictEqual(shared.mainSource.color.length, 3);

    const nothing = solidLayer(BRAND);
    nothing.nullLayer = true;
    const adjust = solidLayer(BRAND);
    adjust.adjustmentLayer = true;
    assert.strictEqual(replaceIn(nothing, BRAND, DEEP).changed, 0);
    assert.strictEqual(replaceIn(adjust, BRAND, DEEP).changed, 0);
    assert.deepStrictEqual(nothing.source.mainSource.color, BRAND);
});

test('replace changes the colours of effects, keyframes included, and passes hidden ones', () => {
    const tint = effect('ADBE Tint', 'Tint',
        colorProp('ADBE Tint-0001', [0, 0, 0]), colorProp('ADBE Tint-0002', BRAND), new ae.Prop('ADBE Tint-0003', 100));
    const tritone = effect('ADBE Tritone', 'Tritone',
        colorProp('ADBE Tritone-0001', BRAND), colorProp('ADBE Tritone-0002', RED), colorProp('ADBE Tritone-0003', BRAND, { hidden: true }));
    const fillFx = effect('ADBE Fill', 'Fill', colorProp('ADBE Fill-0002', BRAND));
    fillFx._children[0]._keyframes([BRAND.concat([1]), RED.concat([1])]);
    const l = layer(group('A', rect(), fill(BRAND)))._effects(tint, tritone, fillFx);

    const report = replaceIn(l, BRAND, DEEP);
    assert.strictEqual(report.changed, 4);
    assert.strictEqual(report.failed, 0, 'a hidden setting was tried');
    assert.strictEqual(report.layers, 1);
    assert.ok(sameHex(tint._children[1]._value, DEEP));
    assert.deepStrictEqual(tint._children[0]._value, [0, 0, 0, 1]);
    assert.strictEqual(tint._children[2]._value, 100);
    assert.ok(sameHex(tritone._children[0]._value, DEEP));
    assert.deepStrictEqual(tritone._children[2]._value, BRAND.concat([1]), 'a hidden setting changed');
    assert.ok(sameHex(fillFx._children[0].keyValue(1), DEEP));
    assert.deepStrictEqual(fillFx._children[0].keyValue(2), RED.concat([1]));
    assert.ok(sameHex(valueOf(child(l, 1, 2), FILL_COLOR), DEEP));
});

test('host.replace reaches text, solid and effect layers in the selection and the comp', () => {
    const app = { project: { activeItem: null, file: null }, beginUndoGroup() {}, endUndoGroup() {} };
    const { host, CompItem } = loadHost(app);
    const title = textLayer(textDocument('Title', { fill: BRAND }));
    const bg = solidLayer(BRAND);
    const graded = new ae.Layer('Footage', 'ADBE AV Layer')._effects(effect('ADBE Fill', 'Fill', colorProp('ADBE Fill-0002', BRAND)));
    const real = new ae.Comp([title, bg, graded]);
    const comp = Object.assign(new CompItem(), { time: 0 });
    Object.defineProperty(comp, 'selectedLayers', { get: () => real.selectedLayers });
    Object.defineProperty(comp, 'numLayers', { get: () => real.numLayers });
    comp.layer = i => real.layer(i);
    app.project.activeItem = comp;

    const json = JSON.stringify;
    title.selected = true;
    assert.strictEqual(host.replace(json(BRAND), json(DEEP), 'selection'), 'OK|1|1|1|0|0|0|0');
    assert.ok(sameHex(bg.source.mainSource.color, BRAND), 'an unselected solid changed');
    assert.strictEqual(host.replace(json(BRAND), json(DEEP), 'comp'), 'OK|2|2|1|0|0|0|0');
    assert.ok(sameHex(bg.source.mainSource.color, DEEP));
    assert.strictEqual(host.replace(json(RED), json(DEEP), 'comp'), 'OK|0|0|0|0|0|0|0');
    app.project.activeItem = Object.assign(new CompItem(), { numLayers: 0, selectedLayers: [], layer: () => null });
    assert.strictEqual(host.replace(json(BRAND), json(DEEP), 'comp'), 'ERR|This composition has no layers.');
});

/* ------------------------------------------- picking the colour to find */

const hexes = list => list.map(c => c.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join(''));

test('a shape layer gives its solid colours once each, in stacking order, gradients left out', () => {
    const l = layer(
        group('A', rect(), stroke(DEEP, 2), fill(BRAND)),
        group('B', group('Inner', rect(), fill(RED)), rect(), fill(BRAND)),
        gradientFill());
    assert.deepStrictEqual(hexes(Core.colorsOf(l._proxy)), ['04489a', '066ce7', 'ff0000']);
    assert.deepStrictEqual(Core.colorsOf(layer(rect(), gradientFill())._proxy), []);
});

test('a selected group, fill or colour narrows the colours to it', () => {
    const l = layer(group('A', rect(), fill(BRAND)), group('B', rect(), stroke(DEEP, 2), fill(RED)));
    child(l, 2).selected = true;
    assert.deepStrictEqual(hexes(Core.colorsOf(l._proxy)), ['04489a', 'ff0000']);
    child(l, 2).selected = false;
    child(l, 2, 3).selected = true;
    assert.deepStrictEqual(hexes(Core.colorsOf(l._proxy)), ['ff0000']);
    child(l, 2, 3).selected = false;
    const tint = effect('ADBE Tint', 'Tint', colorProp('ADBE Tint-0001', [0, 0, 0]), colorProp('ADBE Tint-0002', [1, 1, 1]));
    l._effects(tint);
    tint._children[1].selected = true;
    assert.deepStrictEqual(hexes(Core.colorsOf(l._proxy)), ['ffffff']);
});

test('text, solids and effects give their colours too', () => {
    const t = textLayer(textDocument('ab', [{ fill: BRAND }, { fill: RED, stroke: DEEP }], true),
        textAnimator('Animator 1', colorProp('ADBE Text Fill Color', [0, 1, 0])));
    assert.deepStrictEqual(hexes(Core.colorsOf(t._proxy)), ['066ce7', 'ff0000', '04489a', '00ff00']);
    const s = solidLayer(BRAND)._effects(effect('ADBE Fill', 'Fill', colorProp('ADBE Fill-0002', RED),
        colorProp('ADBE Fill-0003', DEEP, { hidden: true })));
    assert.deepStrictEqual(hexes(Core.colorsOf(s._proxy)), ['066ce7', 'ff0000']);
    const nothing = solidLayer(BRAND);
    nothing.nullLayer = true;
    assert.deepStrictEqual(Core.colorsOf(nothing._proxy), []);
});

test('host.pickColors joins the selected layers and says what is missing', () => {
    const app = { project: { activeItem: null, file: null } };
    const { host, CompItem } = loadHost(app);
    assert.strictEqual(host.pickColors(), 'ERR|Open a composition and select a layer.');
    const a = layer(group('A', rect(), fill(BRAND)));
    const b = solidLayer(BRAND);
    const c = layer(rect(), gradientFill());
    const real = new ae.Comp([a, b, c]);
    const comp = Object.assign(new CompItem(), { time: 0 });
    Object.defineProperty(comp, 'selectedLayers', { get: () => real.selectedLayers });
    app.project.activeItem = comp;
    assert.strictEqual(host.pickColors(), 'ERR|Select a layer first.');
    c.selected = true;
    assert.strictEqual(host.pickColors(), 'ERR|The selection has no solid colour to pick. Gradients cannot be read.');
    a.selected = true;
    b.selected = true;
    const reply = host.pickColors();
    assert.ok(reply.startsWith('OK|'), reply);
    assert.deepStrictEqual(hexes(JSON.parse(reply.slice(3))), ['066ce7'], 'a colour on two layers came twice');
});

/* -------------------------------------------------- the colour picker */

const ColorPicker = require(path.join(PANEL, 'js', 'colorpicker.js'));

test('the colour picker turns HSB into RGB and back', () => {
    const cases = [
        [[0, 1, 1], 'FF0000'], [[120, 1, 1], '00FF00'], [[240, 1, 1], '0000FF'],
        [[60, 1, 1], 'FFFF00'], [[300, 0.5, 0.5], '804080'], [[0, 0, 0], '000000'], [[0, 0, 1], 'FFFFFF'],
        [[160, 0.91, 0.73], '11BA82']
    ];
    for (const [hsb, hex] of cases) {
        assert.strictEqual(ColorPicker.toHex(ColorPicker.hsbToRgb(...hsb)), hex, hsb.join());
        const back = ColorPicker.rgbToHsb(ColorPicker.fromHex(hex));
        assert.strictEqual(ColorPicker.toHex(ColorPicker.hsbToRgb(...back)), hex, 'round trip of ' + hex);
    }
    assert.strictEqual(ColorPicker.toHex(ColorPicker.hsbToRgb(360, 1, 1)), 'FF0000', 'hue 360 is red again');
});

test('the colour picker keeps its hue through grey', () => {
    assert.deepStrictEqual(ColorPicker.rgbToHsb([0.5, 0.5, 0.5], 200), [200, 0, 0.5]);
    assert.deepStrictEqual(ColorPicker.rgbToHsb([0, 0, 0], 45), [45, 0, 0]);
    assert.strictEqual(ColorPicker.rgbToHsb([1, 0, 0], 200)[0], 0, 'a colour with a hue of its own keeps that one');
});

test('the colour picker reads hex codes and refuses the rest', () => {
    assert.strictEqual(ColorPicker.toHex(ColorPicker.fromHex('#10b981')), '10B981');
    assert.strictEqual(ColorPicker.toHex(ColorPicker.fromHex('0af')), '00AAFF');
    for (const bad of ['', 'red', '#12345', null]) assert.strictEqual(ColorPicker.fromHex(bad), null, String(bad));
    assert.strictEqual(ColorPicker.toHex([1.3, -0.2, 0.5]), 'FF0080', 'out of range must clamp');
});

/* ===================================================== swatches (.ase) */

const Swatches = require(path.join(PANEL, 'js', 'swatches.js'));

/* Reads an .ase file back, checking every length on the way. Written
 * apart from swatches.js, so the export is checked against something
 * other than its own reader. */
function readAse(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const text = (at, n) => String.fromCharCode(...bytes.slice(at, at + n));
    assert.strictEqual(text(0, 4), 'ASEF');
    assert.deepStrictEqual([view.getUint16(4), view.getUint16(6)], [1, 0]);
    const blocks = [];
    let at = 12;
    for (let b = 0; b < view.getUint32(8); b++) {
        const type = view.getUint16(at), length = view.getUint32(at + 2);
        const end = at + 6 + length;
        let p = at + 6;
        const entry = { type };
        if (type !== 0xC002) {
            const units = view.getUint16(p);
            entry.name = '';
            for (let i = 0; i < units - 1; i++) entry.name += String.fromCharCode(view.getUint16(p + 2 + i * 2));
            assert.strictEqual(view.getUint16(p + 2 + (units - 1) * 2), 0, 'name not closed by a zero');
            p += 2 + units * 2;
        }
        if (type === 0x0001) {
            entry.model = text(p, 4);
            entry.rgb = [0, 1, 2].map(c => Math.round(view.getFloat32(p + 4 + c * 4) * 255));
            entry.kind = view.getUint16(p + 16);
            p += 18;
        }
        assert.strictEqual(p, end, 'block ' + b + ' is not the length it says');
        blocks.push(entry);
        at = end;
    }
    assert.strictEqual(at, bytes.length, 'bytes left over after the last block');
    return blocks;
}

/* An .ase file of colour blocks in any model, as another application
 * would write it: [name, model, [channels]]. */
function makeAse(swatches) {
    const parts = [];
    const u16 = v => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
    const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
    const f32 = v => { const b = Buffer.alloc(4); b.writeFloatBE(v); return b; };
    const label = s => Buffer.concat([u16(s.length + 1), ...s.split('').map(c => u16(c.charCodeAt(0))), u16(0)]);
    const block = (type, data) => Buffer.concat([u16(type), u32(data.length), data]);
    const blocks = [block(0xC001, label('Brand'))];
    for (const [name, model, values] of swatches) {
        blocks.push(block(1, Buffer.concat([label(name), Buffer.from(model, 'ascii'), ...values.map(f32), u16(2)])));
    }
    blocks.push(block(0xC002, Buffer.alloc(0)));
    return new Uint8Array(Buffer.concat([Buffer.from('ASEF'), u16(1), u16(0), u32(blocks.length), ...blocks]));
}

const bytes255 = c => c.map(v => Math.round(v * 255));

test('palettes export as an .ase file of named swatches in one group', () => {
    const palettes = [
        { name: 'Brand', fill: { color: [6 / 255, 108 / 255, 231 / 255] }, stroke: { color: [0, 0, 0], width: 4 } },
        { name: 'Line', fill: null, stroke: { color: [1.4, -0.2, 0.5] } },
        { name: 'Sunset', fill: { color: [1, 0, 0], gradient: { colors: [[0, 1, 0, 0], [1, 0, 0, 1]], alphas: [[0, 1]] } } },
        { name: 'Café ✓', fill: { color: [1, 1, 1] } }
    ];
    const blocks = readAse(Swatches.ase(palettes, 'Copal All projects'));
    assert.deepStrictEqual(blocks[0], { type: 0xC001, name: 'Copal All projects' });
    assert.deepStrictEqual(blocks[blocks.length - 1], { type: 0xC002 });
    const colours = blocks.slice(1, -1);
    assert.deepStrictEqual(colours.map(c => c.name), ['Brand', 'Brand stroke', 'Line', 'Sunset 1', 'Sunset 2', 'Café ✓']);
    assert.ok(colours.every(c => c.type === 0x0001 && c.model === 'RGB ' && c.kind === 2));
    assert.deepStrictEqual(colours[0].rgb, [6, 108, 231]);
    assert.deepStrictEqual(colours[2].rgb, [255, 0, 128], 'channels past 0 to 1 must be clamped');
    assert.deepStrictEqual(colours[4].rgb, [0, 0, 255]);
});

test('an exported .ase file reads back with its names and colours', () => {
    const palettes = [{ name: 'Brand', fill: { color: [6 / 255, 108 / 255, 231 / 255] }, stroke: { color: [0, 0, 0] } }];
    const got = Swatches.read(Swatches.ase(palettes, 'Copal'));
    assert.strictEqual(got.skipped, 0);
    assert.deepStrictEqual(got.colours.map(c => c.name), ['Brand', 'Brand stroke']);
    assert.deepStrictEqual(got.colours.map(c => bytes255(c.color)), [[6, 108, 231], [0, 0, 0]]);
});

test('an .ase file in RGB, CMYK, Lab and grey reads as RGB, and other models are counted', () => {
    const got = Swatches.read(makeAse([
        ['Blue', 'RGB ', [0.0235, 0.4235, 0.9059]],
        ['Cyan', 'CMYK', [1, 0, 0, 0]],
        ['Ink', 'CMYK', [0, 0, 0, 1]],
        ['Paper', 'LAB ', [1, 0, 0]],
        ['Lab red', 'LAB ', [0.5, 80, 67]],
        ['Mid grey', 'Gray', [0.5]],
        ['Odd', 'XYZ ', [0.1, 0.2, 0.3]],
        ['  Spaced   name ', 'RGB ', [1, 1, 1]]
    ]));
    assert.strictEqual(got.skipped, 1);
    assert.deepStrictEqual(got.colours.map(c => c.name), ['Blue', 'Cyan', 'Ink', 'Paper', 'Lab red', 'Mid grey', 'Spaced name']);
    const rgb = got.colours.map(c => bytes255(c.color));
    assert.deepStrictEqual(rgb[0], [6, 108, 231]);
    assert.deepStrictEqual(rgb[1], [0, 255, 255]);
    assert.deepStrictEqual(rgb[2], [0, 0, 0]);
    assert.deepStrictEqual(rgb[3], [255, 255, 255], 'Lab white is not white');
    assert.ok(rgb[4][0] > 200 && rgb[4][1] < 60 && rgb[4][2] < 60, 'Lab red came in as ' + rgb[4]);
    assert.deepStrictEqual(rgb[5], [128, 128, 128]);
    assert.ok(got.colours.every(c => c.color.every(v => v >= 0 && v <= 1)));
});

test('a file that is not .ase, or stops short, is refused with a reason', () => {
    assert.throws(() => Swatches.read(new Uint8Array(Buffer.from('{"palettes": []}'))), /not an \.ase file/);
    const whole = makeAse([['Blue', 'RGB ', [0, 0, 1]]]);
    assert.throws(() => Swatches.read(whole.slice(0, whole.length - 10)), /stops short/);
});

test('colours come from a Coolors link, in any of its forms', () => {
    const want = [[38, 70, 83], [42, 157, 143], [233, 196, 106]];
    for (const link of [
        'https://coolors.co/264653-2a9d8f-e9c46a',
        'https://coolors.co/palette/264653-2a9d8f-e9c46a',
        'Look at this: coolors.co/264653-2a9d8f-e9c46a?ref=x thanks'
    ]) {
        const got = Swatches.fromText(link);
        assert.strictEqual(got.name, 'Coolors', link);
        assert.deepStrictEqual(got.colours.map(c => bytes255(c.color)), want, link);
    }
});

test('colours come from hex codes, and words that look like hex do not', () => {
    const list = Swatches.fromText('264653, #2a9d8f\n#E9C46A 264653');
    assert.strictEqual(list.name, 'Pasted');
    assert.deepStrictEqual(list.colours.map(c => bytes255(c.color)), [[38, 70, 83], [42, 157, 143], [233, 196, 106]], 'a repeat came twice');
    assert.deepStrictEqual(Swatches.fromText('264653-2a9d8f').colours.length, 2);
    assert.deepStrictEqual(Swatches.fromText('#0af').colours.map(c => bytes255(c.color)), [[0, 170, 255]]);
    assert.deepStrictEqual(Swatches.fromText('Brand is #066CE7, accent #04489a.').colours.map(c => bytes255(c.color)), [[6, 108, 231], [4, 72, 154]]);
    for (const none of ['', 'hello world', 'add bad fed', 'see coolors.co/generate', null]) {
        assert.strictEqual(Swatches.fromText(none), null, String(none));
    }
});

/* ========================================================== installer */

test('the installer elevates a script whose path has a space and an apostrophe', () => {
    if (process.platform !== 'win32') return;
    const { spawnSync } = require('child_process');
    const operator = fs.readFileSync(path.join(__dirname, '..', 'operator.ps1'), 'utf8');
    const helper = operator.match(/^function Get-ElevatedArguments[\s\S]*?^\}/m);
    assert.ok(helper, 'operator.ps1 has no Get-ElevatedArguments');

    // Laid out as %TEMP% is for a user called "John O'Neil".
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copal test o'neil "));
    const marker = path.join(dir, 'ran.txt');
    const launcher = path.join(dir, 'launcher.ps1');
    const quote = text => "'" + text.replace(/'/g, "''") + "'";
    fs.writeFileSync(launcher, 'Set-Content -LiteralPath ' + quote(marker) + ' -Value ok\n');
    const check = path.join(dir, 'check.ps1');
    fs.writeFileSync(check, helper[0] + '\n' +
        'Start-Process -FilePath powershell.exe -ArgumentList (Get-ElevatedArguments ' + quote(launcher) + ') -Wait -WindowStyle Hidden\n');

    const run = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', check], { encoding: 'utf8' });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.ok(fs.existsSync(marker), 'the elevated script never ran');
});

/* ============================================================= report */

for (const failure of failures) {
    console.log('\nFAIL  ' + failure.name);
    console.log('      ' + String(failure.error && failure.error.stack || failure.error).split('\n').slice(0, 6).join('\n      '));
}
console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
process.exit(failures.length ? 1 : 0);
