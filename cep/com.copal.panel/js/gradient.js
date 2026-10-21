/*
 * Gradients, on the panel's side.
 *
 * After Effects lets a script neither read nor set the colours of a shape
 * gradient, so this file holds both ways round that:
 *
 *   fit     turns the pixels After Effects sampled along a gradient into the
 *           colour stops that would draw them.
 *   preset  writes an animation preset holding a gradient's colours, which
 *           After Effects will apply where a script cannot set them.
 *
 * and css, which draws a gradient on a swatch.
 *
 * The Node test harness loads this file as it is.
 */

var CopalGradient = (function () {
    'use strict';

    /* -------------------------------------------------------------- fit */

    /* A sample from an 8 bit project is off by up to half a level, and a
     * straight run of them wobbles by one. Stops are added until the ramp
     * they draw is nowhere further from the samples than this. */
    var TOLERANCE = 1.6 / 255;
    var MAX_STOPS = 24;

    function round(v) {
        return Math.round(v * 10000) / 10000;
    }

    function clamp(v) {
        return Math.max(0, Math.min(1, v));
    }

    function lerp(a, b, f) {
        return a + (b - a) * f;
    }

    /* How far the point at k strays from a straight run between i and j. */
    function stray(points, i, j, k) {
        var f = (points[k].t - points[i].t) / (points[j].t - points[i].t);
        var worst = 0;
        for (var c = 0; c < points[k].v.length; c++) {
            worst = Math.max(worst, Math.abs(points[k].v[c] - lerp(points[i].v[c], points[j].v[c], f)));
        }
        return worst;
    }

    /* The fewest points that draw the same line to within eps: keep the two
     * ends, find the point between them that strays furthest, and if that is
     * too far, keep it and do the same on each side. */
    function simplify(points, eps) {
        var keep = [0, points.length - 1];
        var spans = [[0, points.length - 1]];
        while (spans.length) {
            var span = spans.pop();
            var worst = 0;
            var at = -1;
            for (var k = span[0] + 1; k < span[1]; k++) {
                var d = stray(points, span[0], span[1], k);
                if (d > worst) { worst = d; at = k; }
            }
            if (at !== -1 && worst > eps) {
                keep.push(at);
                spans.push([span[0], at], [at, span[1]]);
            }
        }
        return keep.sort(function (a, b) { return a - b; });
    }

    /*
     * A stop sits where two straight runs meet, and the samples only say that
     * it is somewhere between two pixels. Running the line on either side out
     * to where they cross finds it properly, so a stop saved at 50% comes
     * back at 50% and not at 49.8%, and pure green comes back pure.
     *
     * A knot is the one or two neighbouring samples kept for a single turn in
     * the ramp. prev and next are the last sample of the knot before and the
     * first sample of the knot after.
     */
    function sharpen(points, knot, prev, next) {
        var lo = knot[0], hi = knot[knot.length - 1];
        var plain = { t: (points[lo].t + points[hi].t) / 2, v: points[lo].v.map(function (v, i) { return (v + points[hi].v[i]) / 2; }) };
        if (lo - prev < 2 || next - hi < 2) return plain;

        var a = points[prev], b = points[lo - 1], c = points[hi + 1], d = points[next];
        var best = -1, gap = 1e-6, i, left, right;
        for (i = 0; i < a.v.length; i++) {
            left = (b.v[i] - a.v[i]) / (b.t - a.t);
            right = (d.v[i] - c.v[i]) / (d.t - c.t);
            if (Math.abs(left - right) > gap) { gap = Math.abs(left - right); best = i; }
        }
        if (best === -1) return plain;

        left = (b.v[best] - a.v[best]) / (b.t - a.t);
        right = (d.v[best] - c.v[best]) / (d.t - c.t);
        var t = ((c.v[best] - right * c.t) - (a.v[best] - left * a.t)) / (left - right);
        if (!(t >= b.t && t <= c.t)) return plain;

        var v = [];
        for (i = 0; i < a.v.length; i++) {
            var fromLeft = a.v[i] + (b.v[i] - a.v[i]) / (b.t - a.t) * (t - a.t);
            var fromRight = c.v[i] + (d.v[i] - c.v[i]) / (d.t - c.t) * (t - c.t);
            v.push(clamp((fromLeft + fromRight) / 2));
        }
        return { t: t, v: v };
    }

    /* Whether two neighbouring samples are close enough to be one turn seen
     * from both sides, and not the two sides of a hard edge. */
    function near(p, q) {
        for (var i = 0; i < p.v.length; i++) {
            if (Math.abs(p.v[i] - q.v[i]) > TOLERANCE * 3) return false;
        }
        return true;
    }

    function stops(points) {
        var eps = TOLERANCE;
        var kept = simplify(points, eps);
        while (kept.length > MAX_STOPS) {
            eps *= 1.5;
            kept = simplify(points, eps);
        }

        // A turn that falls between pixels gets the pixel on each side kept.
        var knots = [];
        kept.forEach(function (k, x) {
            var last = knots[knots.length - 1];
            var inner = x > 1 && x < kept.length - 1;
            if (inner && last.length === 1 && k - last[0] <= 3 && near(points[last[0]], points[k])) last.push(k);
            else knots.push([k]);
        });

        var found = knots.map(function (knot, x) {
            return x === 0 || x === knots.length - 1
                ? points[knot[0]]
                : sharpen(points, knot, knots[x - 1][knots[x - 1].length - 1], knots[x + 1][0]);
        });

        // Moving a stop to where it really is can leave the one kept beside
        // it with nothing to do. A stop goes if the ramp is as good without.
        for (var x = found.length - 2; x > 0; x--) {
            if (spare(points, found[x - 1], found[x + 1], eps * 1.5)) found.splice(x, 1);
        }
        return found.map(function (stop) { return [round(stop.t)].concat(stop.v.map(round)); });
    }

    /* Whether a straight run from one stop to another stays within eps of
     * every sample between them. */
    function spare(points, from, to, eps) {
        for (var k = 0; k < points.length; k++) {
            var p = points[k];
            if (p.t <= from.t || p.t >= to.t) continue;
            var f = (p.t - from.t) / (to.t - from.t);
            for (var c = 0; c < p.v.length; c++) {
                if (Math.abs(p.v[c] - lerp(from.v[c], to.v[c], f)) > eps) return false;
            }
        }
        return true;
    }

    /*
     * samples is one [red, green, blue, alpha] per pixel of the ramp, with
     * one extra at each end taken just off the ramp, where the first and the
     * last colour run on. Returns colour stops as [position, red, green,
     * blue] and alpha stops as [position, alpha], positions from 0 to 1.
     */
    function fit(samples) {
        var n = samples.length - 2;
        var position = function (i) { return i === 0 ? 0 : (i === n + 1 ? 1 : (i - 0.5) / n); };

        // Where nothing is painted a pixel has no colour to speak of, so it
        // borrows from the nearest pixel that has.
        var solid = [];
        samples.forEach(function (s, i) { if (s[3] > 0.004) solid.push(i); });
        var colourOf = function (i) {
            if (!solid.length) return [0, 0, 0];
            var best = solid[0];
            for (var x = 1; x < solid.length; x++) {
                if (Math.abs(solid[x] - i) < Math.abs(best - i)) best = solid[x];
            }
            return samples[best].slice(0, 3);
        };

        var colours = samples.map(function (s, i) {
            return { t: position(i), v: s[3] > 0.004 ? s.slice(0, 3) : colourOf(i) };
        });
        var alphas = samples.map(function (s, i) { return { t: position(i), v: [s[3]] }; });

        return { colors: stops(colours), alphas: stops(alphas) };
    }

    /*
     * Finishes a paint as After Effects sent it. A gradient arrives with the
     * samples of its ramp where its stops should be; this works the stops
     * out and drops the samples. The first colour is kept as the paint's
     * plain colour too, so anything that only understands solid paint still
     * has something to show.
     */
    function finish(paint) {
        if (!paint || !paint.gradient) return paint;
        var samples = paint.samples;
        delete paint.samples;
        delete paint.path;
        if (!Array.isArray(samples) || samples.length < 4) {
            delete paint.gradient;
            return paint;
        }
        var fitted = fit(samples);
        paint.gradient.colors = fitted.colors;
        paint.gradient.alphas = fitted.alphas;
        paint.color = fitted.colors[0].slice(1);
        return paint;
    }

    /* The colour, or the alpha, at a position along a list of stops. */
    function valueAt(list, t) {
        if (t <= list[0][0]) return list[0].slice(1);
        for (var i = 1; i < list.length; i++) {
            if (t <= list[i][0]) {
                var span = list[i][0] - list[i - 1][0];
                var f = span > 0 ? (t - list[i - 1][0]) / span : 1;
                return list[i].slice(1).map(function (v, c) { return lerp(list[i - 1][c + 1], v, f); });
            }
        }
        return list[list.length - 1].slice(1);
    }

    function isGradient(paint) {
        var g = paint && paint.gradient;
        var numbers = function (row, length) {
            return Array.isArray(row) && row.length >= length &&
                row.every(function (v) { return typeof v === 'number' && isFinite(v); });
        };
        return !!g && typeof g === 'object' &&
            Array.isArray(g.colors) && g.colors.length > 1 && g.colors.every(function (row) { return numbers(row, 4); }) &&
            Array.isArray(g.alphas) && g.alphas.length > 0 && g.alphas.every(function (row) { return numbers(row, 2); });
    }

    /* -------------------------------------------------------------- css */

    function hasPoint(p) {
        return Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number';
    }

    /*
     * The gradient as a CSS background for a square swatch.
     *
     * CSS draws a linear gradient across the whole box at an angle, with no
     * say over where it starts and ends, so each stop is moved to the place
     * along that line where the saved start and end points would put it.
     */
    function css(paint) {
        var g = paint.gradient;
        var opacity = typeof paint.opacity === 'number' ? clamp(paint.opacity / 100) : 1;
        var start = hasPoint(g.start) ? g.start : [0, 0.5];
        var end = hasPoint(g.end) ? g.end : [1, 0.5];
        var dx = end[0] - start[0], dy = end[1] - start[1];
        var length = Math.sqrt(dx * dx + dy * dy) || 1;

        var places = {};
        g.colors.concat(g.alphas).forEach(function (row) { places[clamp(row[0])] = true; });
        var list = Object.keys(places).map(Number).sort(function (a, b) { return a - b; });

        var radial = g.type === 2;
        var from = 0, to = 100;
        if (!radial) {
            // Where the start and end fall along the line CSS draws, which
            // runs through the middle of the box and spans its corners.
            var ux = dx / length, uy = dy / length;
            var span = Math.abs(ux) + Math.abs(uy);
            from = (((start[0] - 0.5) * ux + (start[1] - 0.5) * uy) / span + 0.5) * 100;
            to = (((end[0] - 0.5) * ux + (end[1] - 0.5) * uy) / span + 0.5) * 100;
        }

        var parts = list.map(function (t) {
            var c = valueAt(g.colors, t).map(function (v) { return Math.round(clamp(v) * 255); });
            var a = round(clamp(valueAt(g.alphas, t)[0]) * opacity);
            return 'rgba(' + c.join(',') + ',' + a + ') ' + round(lerp(from, to, t)) + '%';
        });

        if (radial) {
            var r = round(length * 100);
            return 'radial-gradient(ellipse ' + r + '% ' + r + '% at ' + round(start[0] * 100) + '% ' + round(start[1] * 100) + '%, ' + parts.join(', ') + ')';
        }
        var angle = round(Math.atan2(dx, -dy) * 180 / Math.PI);
        return 'linear-gradient(' + angle + 'deg, ' + parts.join(', ') + ')';
    }

    /* ----------------------------------------------------------- preset */

    /*
     * An animation preset is a RIFX file: chunks of a four letter name, a
     * length, and data, nested inside lists. The one written here says a
     * single thing: at the top of the layer's Contents, a gradient fill (or
     * stroke) whose Colors property has this value.
     *
     * It names the Colors property alone, which makes After Effects add a
     * new gradient paint to hold it and leave the rest of the layer as it
     * was. A preset holding the whole of Contents would replace everything
     * in the layer, so that form must never be written.
     *
     * These four are taken as they are from files After Effects wrote, and
     * describe things that do not change: the file version, the composition
     * the preset was notionally saved from, and the type of the Colors
     * property.
     */
    var HEAD = '000000030000005f0000000101020000';
    var SOURCE = '00000001000000010000000000005da8001df8520000000400010001078004383ff00000000000003ff000000000000000000000ffffffff';
    var COLORS_TYPE = 'db99000100070000ffffffff000060003f1a36e2eb1c432d3ff00000000000003ff00000000000003ff00000000000003ff0000000000000' +
        '0001000800000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000';
    var COLORS_DATA = '00000000';

    function bytesOf(text) {
        var out = new Uint8Array(text.length);
        for (var i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
        return out;
    }

    function fromHex(hex) {
        var out = new Uint8Array(hex.length / 2);
        for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
        return out;
    }

    function join(parts) {
        var length = parts.reduce(function (sum, p) { return sum + p.length; }, 0);
        var out = new Uint8Array(length);
        var at = 0;
        parts.forEach(function (p) { out.set(p, at); at += p.length; });
        return out;
    }

    function uint32(n) {
        return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
    }

    /* Data is padded to an even length, and the padding is not counted. */
    function chunk(id, data) {
        return join([bytesOf(id), uint32(data.length), data, new Uint8Array(data.length % 2)]);
    }

    function list(form, children) {
        return chunk('LIST', join([bytesOf(form)].concat(children)));
    }

    function matchName(name) {
        var data = new Uint8Array(40);
        data.set(bytesOf(name));
        return chunk('tdmn', data);
    }

    function label(text) {
        return chunk('tdsn', chunk('Utf8', bytesOf(text)));
    }

    /* One step of the way to a property. An index marks a child of a list
     * that can hold several of a kind; After Effects makes a new one for it. */
    function step(name, index) {
        return list('tdsi', [chunk('tdix', index === undefined ? fromHex('ffffffff') : uint32(index)), matchName(name)]);
    }

    function pathTo(steps) {
        return list('tdsp', [chunk('tdot', fromHex('ffffffff')), chunk('tdpl', uint32(steps.length))].concat(steps));
    }

    function number(v) {
        return String(Math.round(v * 1000000) / 1000000);
    }

    /* The colours the way After Effects writes them. A colour stop is its
     * position, the midpoint to the next stop, red, green, blue and a 1; an
     * alpha stop is its position, the midpoint and the alpha. */
    function colorsXml(gradient) {
        var stop = function (i, key, values) {
            return '<prop.pair>\n<key>Stop-' + i + '</key>\n<prop.list>\n<prop.pair>\n<key>' + key + '</key>\n' +
                '<array>\n<array.type><float/></array.type>\n' +
                values.map(function (v) { return '<float>' + number(v) + '</float>\n'; }).join('') +
                '</array>\n</prop.pair>\n</prop.list>\n</prop.pair>\n';
        };
        var block = function (name, key, rows) {
            return '<prop.pair>\n<key>' + name + '</key>\n<prop.list>\n<prop.pair>\n<key>Stops List</key>\n<prop.list>\n' +
                rows.map(function (row, i) { return stop(i, key, row); }).join('') +
                '</prop.list>\n</prop.pair>\n<prop.pair>\n<key>Stops Size</key>\n' +
                '<int type=\'unsigned\' size=\'32\'>' + rows.length + '</int>\n</prop.pair>\n</prop.list>\n</prop.pair>\n';
        };

        // After Effects wants at least two of each.
        var alphas = gradient.alphas.length > 1 ? gradient.alphas : [[0, gradient.alphas[0][1]], [1, gradient.alphas[0][1]]];
        return '<?xml version=\'1.0\'?>\n<prop.map version=\'4\'>\n<prop.list>\n<prop.pair>\n<key>Gradient Color Data</key>\n<prop.list>\n' +
            block('Alpha Stops', 'Stops Alpha', alphas.map(function (row) {
                return [clamp(row[0]), 0.5, clamp(row[1])];
            })) +
            block('Color Stops', 'Stops Color', gradient.colors.map(function (row) {
                return [clamp(row[0]), 0.5, clamp(row[1]), clamp(row[2]), clamp(row[3]), 1];
            })) +
            '</prop.list>\n</prop.pair>\n<prop.pair>\n<key>Gradient Colors</key>\n<string>1.0</string>\n</prop.pair>\n</prop.list>\n</prop.map>\n';
    }

    /* The bytes of a preset that adds a gradient fill, or a gradient stroke,
     * with these colours to the top of a shape layer's Contents. */
    function preset(kind, gradient) {
        var paint = kind === 'stroke' ? 'ADBE Vector Graphic - G-Stroke' : 'ADBE Vector Graphic - G-Fill';
        var colors = list('GCst', [
            list('tdbs', [chunk('tdsb', uint32(1)), label('-_0_/-'), chunk('tdb4', fromHex(COLORS_TYPE)), chunk('cdat', fromHex(COLORS_DATA))]),
            list('GCky', [chunk('Utf8', bytesOf(colorsXml(gradient)))])
        ]);
        var body = list('besc', [
            chunk('beso', fromHex(SOURCE)),
            pathTo([step('ADBE Root Vectors Group'), step(paint, 0), step('ADBE Vector Grad Colors')]),
            label('Colors'),
            pathTo([step('ADBE End of path sentinel')]),
            colors
        ]);
        return chunk('RIFX', join([bytesOf('FaFX'), chunk('head', fromHex(HEAD)), body]));
    }

    return {
        fit: fit,
        finish: finish,
        isGradient: isGradient,
        valueAt: valueAt,
        css: css,
        colorsXml: colorsXml,
        preset: preset
    };
})();

// Node.js test harness support. The panel loads this file as a plain script.
if (typeof module !== 'undefined' && module.exports) { module.exports = CopalGradient; }
