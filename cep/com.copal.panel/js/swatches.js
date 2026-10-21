/*
 * Swatches in and out: palettes as Adobe Swatch Exchange, the .ase file
 * that the Swatches panels of Illustrator, Photoshop and InDesign load and
 * save, and colours read from a Coolors link or a list of hex codes.
 *
 * An .ase file is big-endian: the letters ASEF, version 1.0, a count of
 * blocks, then the blocks. Each block is a type, a length, and its data. A
 * colour block holds a name in UTF-16 ending in a zero, the colour model,
 * the channels as 32 bit floats, and whether the swatch is global, spot or
 * normal. A group is a start block with a name and an end block with none,
 * round the colours it holds.
 *
 * An .ase swatch is one solid colour. A palette gives one swatch for its
 * fill and one for its stroke, and a gradient one for each colour stop.
 * Opacity, stroke width and the rest have nowhere to go and are left out.
 *
 * The Node test harness loads this file as it is.
 */

var CopalSwatches = (function () {
    'use strict';

    var GROUP_START = 0xC001;
    var GROUP_END = 0xC002;
    var COLOR = 0x0001;
    var NORMAL = 2;

    function clamp(v) {
        return Math.max(0, Math.min(1, v));
    }

    /* Rounded as a typed hex code is, so a colour read in and saved has the
     * same digits as one typed in. */
    function tidy(v) {
        return Math.round(clamp(v) * 10000) / 10000;
    }

    /* ---------------------------------------------------------- export */

    /* A name as .ase writes it: its length in UTF-16 units counting the
     * closing zero, then the units, big-endian. */
    function name(text) {
        var units = String(text);
        var out = new Uint8Array(2 + (units.length + 1) * 2);
        var view = new DataView(out.buffer);
        view.setUint16(0, units.length + 1);
        for (var i = 0; i < units.length; i++) view.setUint16(2 + i * 2, units.charCodeAt(i));
        return out;
    }

    function block(type, data) {
        var out = new Uint8Array(6 + data.length);
        var view = new DataView(out.buffer);
        view.setUint16(0, type);
        view.setUint32(2, data.length);
        out.set(data, 6);
        return out;
    }

    function colorBlock(label, rgb) {
        var title = name(label);
        var data = new Uint8Array(title.length + 4 + 12 + 2);
        var view = new DataView(data.buffer);
        data.set(title, 0);
        var at = title.length;
        'RGB '.split('').forEach(function (ch, i) { data[at + i] = ch.charCodeAt(0); });
        for (var c = 0; c < 3; c++) view.setFloat32(at + 4 + c * 4, clamp(rgb[c]));
        view.setUint16(at + 16, NORMAL);
        return block(COLOR, data);
    }

    function isColor(c) {
        return Array.isArray(c) && c.length >= 3 && c.slice(0, 3).every(function (v) { return typeof v === 'number' && isFinite(v); });
    }

    /* The swatches one paint gives, as [name, colour]: its colour, or for a
     * gradient each of its colour stops, numbered. */
    function swatchesOf(paint, label) {
        if (!paint) return [];
        var stops = paint.gradient && paint.gradient.colors;
        if (Array.isArray(stops) && stops.length > 1 && stops.every(function (s) { return isColor(s.slice(1)); })) {
            return stops.map(function (s, i) { return [label + ' ' + (i + 1), s.slice(1, 4)]; });
        }
        return isColor(paint.color) ? [[label, paint.color.slice(0, 3)]] : [];
    }

    /* Every swatch a list of palettes gives, in order. A fill takes the
     * palette's name, and a stroke the name and "stroke", unless it is the
     * palette's only paint. */
    function swatches(palettes) {
        var out = [];
        palettes.forEach(function (palette) {
            var fill = swatchesOf(palette.fill, palette.name);
            var stroke = swatchesOf(palette.stroke, fill.length ? palette.name + ' stroke' : palette.name);
            out.push.apply(out, fill.concat(stroke));
        });
        return out;
    }

    /* The bytes of an .ase file holding the palettes' swatches in one group
     * called group. */
    function ase(palettes, group) {
        var blocks = [block(GROUP_START, name(group))];
        swatches(palettes).forEach(function (s) { blocks.push(colorBlock(s[0], s[1])); });
        blocks.push(block(GROUP_END, new Uint8Array(0)));

        var length = blocks.reduce(function (sum, b) { return sum + b.length; }, 12);
        var out = new Uint8Array(length);
        var view = new DataView(out.buffer);
        'ASEF'.split('').forEach(function (ch, i) { out[i] = ch.charCodeAt(0); });
        view.setUint16(4, 1);
        view.setUint16(6, 0);
        view.setUint32(8, blocks.length);
        var at = 12;
        blocks.forEach(function (b) { out.set(b, at); at += b.length; });
        return out;
    }

    /* ---------------------------------------------------------- import */

    /* CIE Lab, as .ase keeps it (L from 0 to 1, a and b from -128 to 127,
     * white point D50), to sRGB. */
    function labToRgb(l, a, b) {
        var fy = (l * 100 + 16) / 116;
        var fx = fy + a / 500;
        var fz = fy - b / 200;
        var inverse = function (t) { return t > 6 / 29 ? t * t * t : 3 * (6 / 29) * (6 / 29) * (t - 4 / 29); };
        var x = 0.96422 * inverse(fx);
        var y = inverse(fy);
        var z = 0.82521 * inverse(fz);
        var linear = [
            3.1338561 * x - 1.6168667 * y - 0.4906146 * z,
            -0.9787684 * x + 1.9161415 * y + 0.0334540 * z,
            0.0719453 * x - 0.2289914 * y + 1.4052427 * z
        ];
        return linear.map(function (v) {
            v = clamp(v);
            return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
        });
    }

    /* A colour block's channels as sRGB from 0 to 1, or null for a model
     * not known here. CMYK is turned to RGB the plain way, with no colour
     * profile, so a print colour comes in near but not exact. */
    function toRgb(model, values) {
        if (model === 'RGB ') return values.slice(0, 3);
        if (model === 'Gray') return [values[0], values[0], values[0]];
        if (model === 'CMYK') {
            return [0, 1, 2].map(function (c) { return (1 - values[c]) * (1 - values[3]); });
        }
        if (model === 'LAB ') return labToRgb(values[0], values[1], values[2]);
        return null;
    }

    var CHANNELS = { 'RGB ': 3, 'Gray': 1, 'CMYK': 4, 'LAB ': 3 };

    /*
     * The colours of an .ase file, in order, as { name, color: [red, green,
     * blue] from 0 to 1 }, and how many swatches it held that could not be
     * read. Groups are flattened; a swatch with no name of its own is given
     * none, so it is named after the file. Throws on a file that is not an
     * .ase file or stops short.
     */
    function read(bytes) {
        var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        var text = function (at, n) {
            var out = '';
            for (var i = 0; i < n; i++) out += String.fromCharCode(bytes[at + i]);
            return out;
        };
        if (bytes.length < 12 || text(0, 4) !== 'ASEF') throw new Error('It is not an .ase file.');

        var count = view.getUint32(8);
        var colours = [];
        var skipped = 0;
        var at = 12;
        for (var b = 0; b < count; b++) {
            if (at + 6 > bytes.length) throw new Error('The file stops short.');
            var type = view.getUint16(at);
            var length = view.getUint32(at + 2);
            var start = at + 6;
            var end = start + length;
            if (end > bytes.length) throw new Error('The file stops short.');
            at = end;
            if (type !== COLOR) continue;

            var units = view.getUint16(start);
            var label = '';
            for (var i = 0; i < units - 1; i++) label += String.fromCharCode(view.getUint16(start + 2 + i * 2));
            var p = start + 2 + units * 2;
            var model = text(p, 4);
            var channels = CHANNELS[model];
            if (!channels || p + 4 + channels * 4 > end) { skipped++; continue; }
            var values = [];
            for (var c = 0; c < channels; c++) values.push(view.getFloat32(p + 4 + c * 4));
            var rgb = toRgb(model, values);
            if (!rgb || !rgb.every(function (v) { return isFinite(v); })) { skipped++; continue; }
            colours.push({ name: label.replace(/\s+/g, ' ').trim().slice(0, 60), color: rgb.map(tidy) });
        }
        return { colours: colours, skipped: skipped };
    }

    /* ------------------------------------------------------------ text */

    function fromHex(digits) {
        if (digits.length === 3) digits = digits.replace(/./g, '$&$&');
        return [0, 2, 4].map(function (at) {
            return Math.round(parseInt(digits.substr(at, 2), 16) / 255 * 10000) / 10000;
        });
    }

    var COOLORS = /coolors\.co\/(?:[a-z]+\/)*([0-9a-f]{6}(?:-[0-9a-f]{6})*)(?![0-9a-z])/i;
    // Three digits only with a #, or any short word made of a to f would do.
    var BARE = /^(?:#?([0-9a-f]{6})|#([0-9a-f]{3}))$/i;
    var MARKED = /#([0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-z])/gi;

    /*
     * Colours in a piece of text: a Coolors link
     * (coolors.co/264653-2a9d8f-e9c46a, with or without /palette/), text
     * that is nothing but hex codes ("264653, 2a9d8f", "264653-2a9d8f" or
     * "#264653 #2a9d8f"),
     * or else every hex code marked with a # in it. A colour given twice
     * comes once. Returns { name, colours }, or null when there are none.
     */
    function fromText(text) {
        var source = String(text || '');
        var digits = [];
        var name = 'Pasted';
        var coolors = COOLORS.exec(source);
        if (coolors) {
            digits = coolors[1].split('-');
            name = 'Coolors';
        } else {
            var tokens = source.trim().split(/[\s,;-]+/).filter(function (t) { return t; });
            if (tokens.length && tokens.every(function (t) { return BARE.test(t); })) {
                digits = tokens.map(function (t) { var m = BARE.exec(t); return m[1] || m[2]; });
            } else {
                var match;
                MARKED.lastIndex = 0;
                while ((match = MARKED.exec(source))) digits.push(match[1]);
            }
        }
        var seen = {};
        var colours = [];
        digits.forEach(function (d) {
            var color = fromHex(d);
            var key = color.join();
            if (seen[key]) return;
            seen[key] = true;
            colours.push({ color: color });
        });
        return colours.length ? { name: name, colours: colours } : null;
    }

    return { ase: ase, swatches: swatches, read: read, fromText: fromText };
})();

// Node.js test harness support. The panel loads this file as a plain script.
if (typeof module !== 'undefined' && module.exports) { module.exports = CopalSwatches; }
