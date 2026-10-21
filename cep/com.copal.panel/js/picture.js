/*
 * The main colours of a picture.
 *
 * The panel draws a dropped image small onto a canvas and hands its pixels
 * here. They are counted into a coarse histogram, grouped by k-means in
 * OKLab, where a step of the same size looks like the same amount of change
 * whatever the colour, and the groups are tidied: two that look alike
 * become one, and a sliver of pixels on the way from one colour to another
 * goes, since that is the soft edge between two shapes and not a colour of
 * its own.
 *
 * Nothing here touches the page, so the Node test harness loads this file
 * as it is.
 */

var CopalPicture = (function () {
    'use strict';

    /* Bits kept of each channel when counting. 32 levels a channel is far
     * finer than any two colours worth telling apart. */
    var BITS = 5;
    var ROUNDS = 16;
    /* Closer than this in OKLab, two colours are the same colour. */
    var SAME = 0.05;
    /* A group lying this close, in RGB from 0 to 1, to the line between two
     * bigger ones is the blend at the edge between them. */
    var BLEND = 0.04;
    /* A group smaller than this share of the picture is noise. */
    var SLIVER = 0.005;
    /* Pixels less opaque than this are background. */
    var SOLID = 128;

    function linear(c) {
        c /= 255;
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }

    function oklab(rgb) {
        var r = linear(rgb[0]), g = linear(rgb[1]), b = linear(rgb[2]);
        var l = Math.pow(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b, 1 / 3);
        var m = Math.pow(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b, 1 / 3);
        var s = Math.pow(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b, 1 / 3);
        return [
            0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
        ];
    }

    function distance2(p, q) {
        var a = p[0] - q[0], b = p[1] - q[1], c = p[2] - q[2];
        return a * a + b * b + c * c;
    }

    /* How far p lies from the line segment between a and b. */
    function offLine(p, a, b) {
        var ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        var length2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
        var t = length2 ? ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / length2 : 0;
        t = Math.max(0, Math.min(1, t));
        return Math.sqrt(distance2(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]));
    }

    /* The opaque pixels, counted into bins. Each bin keeps its pixel count
     * and the sum of its pixels' colours, so the average is exact. */
    function histogram(pixels) {
        var size = 1 << (BITS * 3);
        var shift = 8 - BITS;
        var weight = new Float64Array(size);
        var sum = new Float64Array(size * 3);
        var total = 0;
        for (var i = 0; i + 3 < pixels.length; i += 4) {
            if (pixels[i + 3] < SOLID) continue;
            var r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
            var bin = ((r >> shift) << (BITS * 2)) | ((g >> shift) << BITS) | (b >> shift);
            weight[bin]++;
            sum[bin * 3] += r;
            sum[bin * 3 + 1] += g;
            sum[bin * 3 + 2] += b;
            total++;
        }

        var points = [];
        for (var k = 0; k < size; k++) {
            if (!weight[k]) continue;
            var w = weight[k];
            var mean = [sum[k * 3] / w, sum[k * 3 + 1] / w, sum[k * 3 + 2] / w];
            points.push({ w: w, sum: [sum[k * 3], sum[k * 3 + 1], sum[k * 3 + 2]], lab: oklab(mean) });
        }
        return { points: points, total: total };
    }

    /* Starting places for the groups: the commonest colour, then each time
     * the colour that is both common and far from every place so far, so a
     * small bright accent gets a group of its own. */
    function seed(points, k) {
        var first = 0;
        for (var i = 1; i < points.length; i++) {
            if (points[i].w > points[first].w) first = i;
        }
        var centres = [points[first].lab];
        var near = points.map(function (p) { return distance2(p.lab, centres[0]); });
        while (centres.length < k) {
            var best = -1, score = 0;
            for (i = 0; i < points.length; i++) {
                var s = near[i] * points[i].w;
                if (s > score) { score = s; best = i; }
            }
            if (best === -1) break;
            centres.push(points[best].lab);
            for (i = 0; i < points.length; i++) {
                near[i] = Math.min(near[i], distance2(points[i].lab, points[best].lab));
            }
        }
        return centres;
    }

    function nearest(lab, centres) {
        var best = 0, gap = Infinity;
        for (var c = 0; c < centres.length; c++) {
            var d = distance2(lab, centres[c]);
            if (d < gap) { gap = d; best = c; }
        }
        return best;
    }

    /* The points gathered into groups round the centres, each with its
     * weight, its colour summed, and its centre in OKLab. Empty ones go. */
    function gather(points, centres) {
        var groups = centres.map(function () { return { w: 0, sum: [0, 0, 0], lab: [0, 0, 0] }; });
        points.forEach(function (p) {
            var g = groups[nearest(p.lab, centres)];
            g.w += p.w;
            for (var c = 0; c < 3; c++) {
                g.sum[c] += p.sum[c];
                g.lab[c] += p.lab[c] * p.w;
            }
        });
        return groups.filter(function (g) { return g.w > 0; }).map(function (g) {
            return { w: g.w, sum: g.sum, lab: [g.lab[0] / g.w, g.lab[1] / g.w, g.lab[2] / g.w] };
        });
    }

    function join(a, b) {
        var w = a.w + b.w;
        return {
            w: w,
            sum: [a.sum[0] + b.sum[0], a.sum[1] + b.sum[1], a.sum[2] + b.sum[2]],
            lab: [0, 1, 2].map(function (c) { return (a.lab[c] * a.w + b.lab[c] * b.w) / w; })
        };
    }

    /* Two groups that look alike are one colour. */
    function mergeAlike(groups) {
        for (;;) {
            var pair = null, gap = SAME * SAME;
            for (var i = 0; i < groups.length; i++) {
                for (var j = i + 1; j < groups.length; j++) {
                    var d = distance2(groups[i].lab, groups[j].lab);
                    if (d < gap) { gap = d; pair = [i, j]; }
                }
            }
            if (!pair) return groups;
            groups[pair[0]] = join(groups[pair[0]], groups[pair[1]]);
            groups.splice(pair[1], 1);
        }
    }

    function rgb(group) {
        return [group.sum[0] / group.w / 255, group.sum[1] / group.w / 255, group.sum[2] / group.w / 255];
    }

    /* A group much smaller than two others, sitting on the line between
     * them, is the soft edge where they meet. The line is drawn in RGB,
     * not OKLab, because that is the space a canvas blends pixels in when
     * it draws the picture small. */
    function dropBlends(groups) {
        return groups.filter(function (g) {
            for (var i = 0; i < groups.length; i++) {
                for (var j = i + 1; j < groups.length; j++) {
                    var a = groups[i], b = groups[j];
                    if (a === g || b === g || a.w < g.w * 3 || b.w < g.w * 3) continue;
                    if (offLine(rgb(g), rgb(a), rgb(b)) < BLEND) return false;
                }
            }
            return true;
        });
    }

    /* count of the groups: the commonest, then each time the one that is
     * both common and unlike those already picked, as in seed. Picking from
     * more groups than are wanted gives colours that are in the picture,
     * where grouping straight into count would average unlike colours
     * into ones that are not. */
    function pick(groups, count) {
        var picked = [];
        var near = groups.map(function () { return Infinity; });
        while (picked.length < count && picked.length < groups.length) {
            var best = -1, score = -1;
            for (var i = 0; i < groups.length; i++) {
                if (near[i] === 0) continue;
                var s = picked.length ? near[i] * groups[i].w : groups[i].w;
                if (s > score) { score = s; best = i; }
            }
            picked.push(groups[best]);
            for (i = 0; i < groups.length; i++) {
                near[i] = Math.min(near[i], distance2(groups[i].lab, groups[best].lab));
            }
            near[best] = 0;
        }
        return picked;
    }

    function round(v) {
        return Math.round(v * 10000) / 10000;
    }

    /*
     * Up to count main colours of a picture, commonest first. pixels is
     * RGBA bytes, as a canvas gives them. Each colour comes back as
     * { color: [red, green, blue] from 0 to 1, share: of the opaque
     * pixels }. A picture with nothing opaque in it has none.
     */
    function mainColors(pixels, count) {
        var counted = histogram(pixels);
        var points = counted.points;
        if (!points.length || count < 1) return [];

        var centres = seed(points, Math.min(count * 2, points.length));
        var groups = gather(points, centres);
        for (var pass = 1; pass < ROUNDS; pass++) {
            var next = gather(points, groups.map(function (g) { return g.lab; }));
            var settled = next.length === groups.length && next.every(function (g, i) {
                return distance2(g.lab, groups[i].lab) < 1e-12;
            });
            groups = next;
            if (settled) break;
        }

        groups = dropBlends(mergeAlike(groups));
        var big = groups.filter(function (g) { return g.w >= counted.total * SLIVER; });
        if (big.length) groups = big;

        groups = pick(groups, count);
        groups.sort(function (a, b) { return b.w - a.w; });
        return groups.map(function (g) {
            return { color: rgb(g).map(round), share: g.w / counted.total };
        });
    }

    /* What palettes from a file are called after: its name without the
     * folder or the extension. */
    function baseName(fileName) {
        var name = String(fileName || '').replace(/^.*[\\\/]/, '').replace(/\.[^.]*$/, '');
        name = name.replace(/\s+/g, ' ').trim();
        return (name || 'Image').slice(0, 50);
    }

    /* count names in the form "sunset 3", numbered on from the highest of
     * that form already taken, so a second drop of the same picture does
     * not repeat the first one's names. */
    function names(base, taken, count) {
        var pattern = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' (\\d+)$');
        var start = 0;
        taken.forEach(function (name) {
            var match = pattern.exec(name);
            if (match) start = Math.max(start, Number(match[1]));
        });
        var out = [];
        for (var i = 1; i <= count; i++) out.push(base + ' ' + (start + i));
        return out;
    }

    return {
        mainColors: mainColors,
        baseName: baseName,
        names: names
    };
})();

// Node.js test harness support. The panel loads this file as a plain script.
if (typeof module !== 'undefined' && module.exports) { module.exports = CopalPicture; }
