/*
 * Minimal JSON for the ExtendScript engine, which has no JSON object.
 *
 * Reading follows Crockford's json2: reject anything that is not well formed
 * JSON with a set of regular expressions, then let the engine evaluate what
 * is left. The guard matters because eval on unchecked text would run
 * whatever it contained, and a palette comes out of a file on disk that
 * anyone could have edited.
 *
 * Writing only has to cover what a captured palette holds: plain objects,
 * arrays, numbers, strings, booleans and null.
 */

var CopalJson = (function () {

    var ESCAPES = /\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g;
    var VALUES = /"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g;
    var STRUCTURE = /(?:^|:|,)(?:\s*\[)+/g;
    var ALLOWED = /^[\],:{}\s]*$/;

    function parse(text) {
        if (typeof text !== 'string') throw new Error('JSON input is not a string.');

        var probe = text
            .replace(ESCAPES, '@')
            .replace(VALUES, ']')
            .replace(STRUCTURE, '');

        if (!ALLOWED.test(probe)) {
            throw new Error('Palette is not valid JSON.');
        }

        return eval('(' + text + ')');
    }

    /* Characters are escaped one at a time rather than with a character
     * class, because the ExtendScript regular expression engine is unreliable
     * with unicode ranges. */
    function quote(text) {
        var out = '"';
        for (var i = 0; i < text.length; i++) {
            var ch = text.charAt(i);
            var code = text.charCodeAt(i);
            if (ch === '"') out += '\\"';
            else if (ch === '\\') out += '\\\\';
            else if (ch === '\n') out += '\\n';
            else if (ch === '\r') out += '\\r';
            else if (ch === '\t') out += '\\t';
            else if (code < 0x20 || code === 0x2028 || code === 0x2029) {
                var hex = code.toString(16);
                while (hex.length < 4) hex = '0' + hex;
                out += '\\u' + hex;
            } else out += ch;
        }
        return out + '"';
    }

    function stringify(value) {
        if (value === null || value === undefined) return 'null';

        var type = typeof value;
        if (type === 'number') return isFinite(value) ? String(value) : 'null';
        if (type === 'boolean') return value ? 'true' : 'false';
        if (type === 'string') return quote(value);

        var parts = [];
        if (value instanceof Array) {
            for (var i = 0; i < value.length; i++) parts.push(stringify(value[i]));
            return '[' + parts.join(',') + ']';
        }

        for (var key in value) {
            if (!value.hasOwnProperty(key)) continue;
            if (value[key] === undefined || typeof value[key] === 'function') continue;
            parts.push(quote(key) + ':' + stringify(value[key]));
        }
        return '{' + parts.join(',') + '}';
    }

    return { parse: parse, stringify: stringify };
})();

// Node.js test harness support. ExtendScript ignores this branch.
if (typeof module !== 'undefined' && module.exports) { module.exports = CopalJson; }
