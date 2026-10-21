/*
 * The palette file.
 *
 * Palettes are kept as JSON in a file called copal.json, in one of two
 * places: beside the project, or in the user's own settings folder. The file
 * beside the project is named for the folder rather than for the .aep,
 * because Increment and Save gives the project a new name every time and a
 * file tied to the old name would be left behind.
 *
 * A project folder is often on a shared drive, so the file is never held in
 * memory and written back later. Every change reads it again first, alters
 * what it finds, and writes the result, which keeps somebody else's palettes
 * from being overwritten by a copy that has gone stale.
 *
 * Reading and writing run in the panel's Node context. The Node test harness
 * loads this file as it is.
 */

var CopalStore = (function () {
    'use strict';

    var fs = require('fs');
    var nodePath = require('path');

    var FILE_NAME = 'copal.json';
    var FORMAT = 'copal';
    var VERSION = 1;

    function userFile(userDataDir) {
        return nodePath.join(userDataDir, 'Copal', FILE_NAME);
    }

    function projectFile(projectDir) {
        return nodePath.join(projectDir, FILE_NAME);
    }

    /* ----------------------------------------------------------- colour */

    function isColor(c) {
        return Array.isArray(c) && c.length >= 3 &&
            c.slice(0, 3).every(function (v) { return typeof v === 'number' && isFinite(v); });
    }

    /* Components are 0..1 in After Effects and can run past 1 in a 32 bit
     * project, which a hex code cannot say, so they are clamped for display. */
    function hex(color) {
        return color.slice(0, 3).map(function (v) {
            var n = Math.round(Math.max(0, Math.min(1, v)) * 255);
            return (n < 16 ? '0' : '') + n.toString(16);
        }).join('').toUpperCase();
    }

    /* A colour typed as a hex code, with or without the #, in six digits or
     * three, as [red, green, blue] from 0 to 1; null if it is not one. */
    function parseHex(text) {
        var digits = String(text || '').trim().replace(/^#/, '');
        if (/^[0-9a-f]{3}$/i.test(digits)) digits = digits.replace(/./g, '$&$&');
        if (!/^[0-9a-f]{6}$/i.test(digits)) return null;
        return [0, 2, 4].map(function (at) {
            return Math.round(parseInt(digits.substr(at, 2), 16) / 255 * 10000) / 10000;
        });
    }

    /* A palette is named for its fill, or for its stroke when it has none.
     * Nobody is asked for a name on saving; it can be changed afterwards. */
    function nameFor(palette) {
        if (palette.fill) return paintName(palette.fill);
        if (palette.stroke) return paintName(palette.stroke);
        return 'Empty';
    }

    /* A gradient is named for the colours it runs between. */
    function paintName(paint) {
        var stops = paint.gradient && paint.gradient.colors;
        if (Array.isArray(stops) && stops.length > 1 &&
            isColor(stops[0].slice(1)) && isColor(stops[stops.length - 1].slice(1))) {
            return hex(stops[0].slice(1)) + '-' + hex(stops[stops.length - 1].slice(1));
        }
        return hex(paint.color);
    }

    /* ---------------------------------------------------------- reading */

    function cleanPaint(paint) {
        if (!paint || typeof paint !== 'object' || Array.isArray(paint)) return null;
        return isColor(paint.color) ? paint : null;
    }

    function newId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    /* Keeps what can be used from an entry and returns null for one that
     * holds no paint at all. Fields this version does not know about are
     * left in place, so a file written by a newer panel survives a round
     * trip through an older one. */
    function cleanPalette(entry, taken) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;

        var fill = cleanPaint(entry.fill);
        var stroke = cleanPaint(entry.stroke);
        if (!fill && !stroke) return null;

        // A paint left out, as opposed to null, is one the palette leaves
        // alone wherever it is applied, so it stays left out.
        var palette = {};
        Object.keys(entry).forEach(function (key) { palette[key] = entry[key]; });
        if ('fill' in entry) palette.fill = fill;
        if ('stroke' in entry) palette.stroke = stroke;

        // Two entries with one id would be selected and deleted together.
        var id = typeof entry.id === 'string' && entry.id && !taken[entry.id] ? entry.id : newId();
        taken[id] = true;
        palette.id = id;

        palette.name = typeof entry.name === 'string' && entry.name.trim()
            ? entry.name.trim() : nameFor(palette);
        return palette;
    }

    function mtime(file) {
        try { return fs.statSync(file).mtimeMs; } catch (e) { return 0; }
    }

    /*
     * Returns { palettes, error, mtime }. A missing file is an empty list and
     * no error. A file that cannot be understood is an error, and the caller
     * must not write over it: it may be a palette file with one stray comma,
     * and saving an empty list on top would throw the rest away.
     */
    function read(file) {
        var text;
        try {
            text = fs.readFileSync(file, 'utf8');
        } catch (e) {
            if (e.code === 'ENOENT') return { palettes: [], error: null, mtime: 0 };
            return { palettes: [], error: 'It could not be opened (' + e.code + ').', mtime: 0 };
        }

        var stamp = mtime(file);
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        if (!text.trim()) return { palettes: [], error: null, mtime: stamp };

        var doc;
        try {
            doc = JSON.parse(text);
        } catch (e2) {
            return { palettes: [], error: 'It is not valid JSON.', mtime: stamp };
        }
        if (!doc || typeof doc !== 'object' || !Array.isArray(doc.palettes)) {
            return { palettes: [], error: 'It is not a Copal palette file.', mtime: stamp };
        }

        var taken = {};
        var palettes = doc.palettes
            .map(function (entry) { return cleanPalette(entry, taken); })
            .filter(function (palette) { return palette !== null; });
        return { palettes: palettes, error: null, mtime: stamp };
    }

    /* ---------------------------------------------------------- writing */

    function isPlain(v) {
        return v === null || typeof v !== 'object';
    }

    /* JSON.stringify with an indent puts every number of a colour on its own
     * line. A list of plain values is kept on one line here instead, so the
     * file stays short enough to read and to compare between versions. */
    function format(value, indent) {
        if (isPlain(value)) return JSON.stringify(value);

        var inner = indent + '  ';
        if (Array.isArray(value)) {
            if (!value.length) return '[]';
            if (value.every(isPlain)) return '[' + value.map(function (v) { return JSON.stringify(v); }).join(', ') + ']';
            return '[\n' + value.map(function (v) { return inner + format(v, inner); }).join(',\n') + '\n' + indent + ']';
        }

        var keys = Object.keys(value).filter(function (key) { return value[key] !== undefined; });
        if (!keys.length) return '{}';
        return '{\n' + keys.map(function (key) {
            return inner + JSON.stringify(key) + ': ' + format(value[key], inner);
        }).join(',\n') + '\n' + indent + '}';
    }

    /* The recursive option of mkdirSync is missing from the Node that older
     * versions of After Effects ship, where it is silently ignored. */
    function ensureDir(dir) {
        if (fs.existsSync(dir)) return;
        ensureDir(nodePath.dirname(dir));
        fs.mkdirSync(dir);
    }

    /* Written beside the real file and renamed over it, so a crash halfway
     * through leaves the old file whole instead of half a new one. The
     * temporary name is new each time: two people saving to one shared
     * folder at once must not write into the same temporary file. */
    function write(file, palettes) {
        var text = format({ format: FORMAT, version: VERSION, palettes: palettes }, '') + '\n';
        ensureDir(nodePath.dirname(file));
        var temp = file + '.' + newId() + '.tmp';
        fs.writeFileSync(temp, text, 'utf8');
        try {
            fs.renameSync(temp, file);
        } catch (e) {
            try { fs.unlinkSync(temp); } catch (e2) {}
            throw e;
        }
        return mtime(file);
    }

    /* Reads the file, lets change alter the list, and writes it back. Throws
     * rather than writing when the file on disk cannot be understood. */
    function update(file, change) {
        var current = read(file);
        if (current.error) throw new Error(FILE_NAME + ' was left alone. ' + current.error);
        change(current.palettes);
        return { palettes: current.palettes, mtime: write(file, current.palettes) };
    }

    /* Turns what After Effects read off a layer into a palette entry. */
    function create(captured) {
        var palette = {
            id: newId(),
            name: '',
            fill: cleanPaint(captured.fill),
            stroke: cleanPaint(captured.stroke)
        };
        palette.name = nameFor(palette);
        return palette;
    }

    /* A palette of one solid fill, for a colour taken from a picture. It
     * has no stroke at all, not even null, so applying it recolours fills
     * and leaves strokes as they are. */
    function fromColor(color, name) {
        return { id: newId(), name: name, fill: { color: color, opacity: 100 } };
    }

    return {
        FILE_NAME: FILE_NAME,
        userFile: userFile,
        projectFile: projectFile,
        hex: hex,
        parseHex: parseHex,
        nameFor: nameFor,
        paintName: paintName,
        mtime: mtime,
        read: read,
        write: write,
        update: update,
        create: create,
        fromColor: fromColor
    };
})();

// Node.js test harness support. The panel loads this file as a plain script.
if (typeof module !== 'undefined' && module.exports) { module.exports = CopalStore; }
