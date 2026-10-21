/*
 * Serves the panel to an ordinary browser, for working on how it looks
 * without restarting After Effects.
 *
 *     node tools/preview.js            then open http://localhost:4174
 *
 * The panel expects two things a browser does not have: Adobe's CSInterface
 * and Node's require. Both are replaced here with stand-ins. Files live in
 * memory, and After Effects is played by a few canned replies. Nothing the
 * preview does is saved, and nothing here ships with the panel.
 *
 * Add to the address to see other states:
 *     ?scope=project    start on the project's palettes
 *     ?unsaved          the project has never been saved
 *     ?empty            no palettes yet
 *     ?broken           a palette file that is not valid JSON
 *     ?light            the light After Effects theme
 */

'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');

var PORT = Number(process.env.PORT) || 4174;
var PANEL = path.join(__dirname, '..', 'cep', 'com.copal.panel');

var TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.woff2': 'font/woff2'
};

/* Runs in the browser, in place of CSInterface.js. */
function shim() {
    var query = window.location.search;
    function has(flag) { return new RegExp('[?&]' + flag + '(&|=|$)').test(query); }

    var SAMPLE = { format: 'copal', version: 1, palettes: [
        { id: 'a', name: 'Signal orange', fill: { color: [1, 0.3529, 0.2118], opacity: 100 }, stroke: null },
        { id: 'b', name: 'Lagoon', fill: { color: [0.0784, 0.6196, 0.6], opacity: 100 },
          stroke: { color: [0.0471, 0.1608, 0.1804], opacity: 100, width: 4, lineJoin: 1, dashes: [] } },
        { id: 'c', name: 'Outline', fill: null,
          stroke: { color: [0.9608, 0.9608, 0.9608], opacity: 100, width: 2, lineJoin: 1, dashes: [] } },
        { id: 'd', name: 'Highlighter', fill: { color: [1, 0.8745, 0.2], opacity: 55 },
          stroke: { color: [1, 0.8745, 0.2], opacity: 100, width: 3, lineJoin: 2, dashes: [8, 6] } },
        { id: 'e', name: 'Ink', fill: { color: [0.0627, 0.0627, 0.0706], opacity: 100 }, stroke: null },
        { id: 'f', name: 'Sticker', fill: { color: [1, 1, 1], opacity: 100 },
          stroke: { color: [0.8980, 0.1608, 0.2392], opacity: 100, width: 12, lineJoin: 2, dashes: [] } },
        { id: 'g', name: 'Guide', fill: null,
          stroke: { color: [0.2431, 0.5843, 1], opacity: 50, width: 20, lineJoin: 3, dashes: [] } },
        { id: 'h', name: 'Plum', fill: { color: [0.4196, 0.2196, 0.6588], opacity: 100 },
          stroke: { color: [0.1, 0.05, 0.16], opacity: 100, width: 6, lineJoin: 1, dashes: [] } },
        { id: 'i', name: 'Moss', fill: { color: [0.3804, 0.5098, 0.2314], opacity: 100 }, stroke: null },
        { id: 'j', name: 'Paper', fill: { color: [0.9529, 0.9333, 0.8824], opacity: 100 },
          stroke: { color: [0.2, 0.2, 0.2], opacity: 100, width: 1, lineJoin: 1, dashes: [] } },
        { id: 'k', name: 'Stitch', fill: null,
          stroke: { color: [1, 0.3529, 0.2118], opacity: 100, width: 5, lineJoin: 2, dashes: [10, 10] } },
        { id: 'm', name: 'Sunset', fill: { color: [1, 0.35, 0.2], opacity: 100, gradient: { type: 1, start: [0, 0], end: [1, 1], colors: [[0, 1, 0.8, 0.2], [0.5, 1, 0.35, 0.2], [1, 0.45, 0.1, 0.6]], alphas: [[0, 1], [1, 1]] } }, stroke: null },
        { id: 'n', name: 'Orb', fill: { color: [1, 1, 1], opacity: 100, gradient: { type: 2, start: [0.35, 0.35], end: [0.95, 0.35], colors: [[0, 1, 1, 1], [1, 0.1, 0.3, 0.8]], alphas: [[0, 1], [1, 1]] } }, stroke: null },
        { id: 'o', name: 'Fade', fill: { color: [0.2, 0.8, 0.7], opacity: 100, gradient: { type: 1, start: [0.5, 0], end: [0.5, 1], colors: [[0, 0.2, 0.8, 0.7], [1, 0.2, 0.8, 0.7]], alphas: [[0, 1], [1, 0]] } }, stroke: null },
        { id: 'p', name: 'Neon edge', fill: { color: [0.06, 0.06, 0.1], opacity: 100 },
          stroke: { color: [0, 1, 1], opacity: 100, width: 6, lineJoin: 1, dashes: [], gradient: { type: 1, start: [0, 0.5], end: [1, 0.5], colors: [[0, 0, 1, 1], [1, 1, 0, 1]], alphas: [[0, 1], [1, 1]] } } },
        { id: 'l', name: 'Glass', fill: { color: [0.6, 0.85, 1], opacity: 25 },
          stroke: { color: [1, 1, 1], opacity: 70, width: 2, lineJoin: 2, dashes: [] } }
    ] };

    var CAPTURES = [
        { fill: { color: [0.9608, 0.3098, 0.5294], opacity: 100 }, stroke: null, gradient: false },
        { fill: { color: [0.1255, 0.1647, 0.3059], opacity: 100 },
          stroke: { color: [1, 0.8, 0.3], opacity: 100, width: 3, lineJoin: 1, dashes: [] }, gradient: true },
        { fill: null, stroke: { color: [0.4, 1, 0.6], opacity: 100, width: 8, lineJoin: 2, dashes: [4, 4] }, gradient: false }
    ];

    var rampSamples = [];
    for (var r = 0; r <= 257; r++) {
        var rt = r === 0 ? 0 : (r === 257 ? 1 : (r - 0.5) / 256);
        rampSamples.push(rt < 0.5 ? [1 - rt * 2, rt * 2, 0, 1] : [0, 2 - rt * 2, rt * 2 - 1, 1]);
    }
    CAPTURES.unshift({ fill: { opacity: 100, gradient: { type: 1, start: [0, 0.5], end: [1, 0.5] }, samples: rampSamples }, stroke: null });

    var USER = '/user/Copal/copal.json';
    var PROJECT = '/project/copal.json';
    var clock = 1;
    var files = {};
    var dirs = { '/': true, '/user': true, '/user/Copal': true, '/project': true };

    function put(file, text) { files[file] = { text: text, mtime: clock++ }; }
    function missing(file) {
        var e = new Error('ENOENT: no such file, ' + file);
        e.code = 'ENOENT';
        return e;
    }

    if (has('broken')) {
        put(USER, '{ "palettes": [ oops');
    } else if (!has('empty')) {
        put(USER, JSON.stringify(SAMPLE));
        put(PROJECT, JSON.stringify({ format: 'copal', version: 1, palettes: SAMPLE.palettes.slice(0, 4) }));
    }

    var fakeFs = {
        readFileSync: function (file) { if (!files[file]) throw missing(file); return files[file].text; },
        writeFileSync: function (file, text) { put(file, text); },
        renameSync: function (from, to) { put(to, files[from].text); delete files[from]; },
        statSync: function (file) { if (!files[file]) throw missing(file); return { mtimeMs: files[file].mtime }; },
        existsSync: function (file) { return !!files[file] || dirs[file] === true; },
        mkdirSync: function (dir) { dirs[dir] = true; },
        unlinkSync: function (file) { delete files[file]; }
    };

    var fakePath = {
        join: function () { return Array.prototype.join.call(arguments, '/').replace(/\/+/g, '/'); },
        dirname: function (file) { return file.replace(/\/[^\/]*$/, '') || '/'; }
    };

    window.require = function (name) {
        if (name === 'fs') return fakeFs;
        if (name === 'path') return fakePath;
        if (name === 'os') return { tmpdir: function () { return '/tmp'; } };
        if (name === 'child_process') {
            return { spawn: function () { console.log('preview: would open', arguments[1]); return { on: function () {} }; } };
        }
        throw new Error('The preview has no stand-in for ' + name);
    };
    window.process = { platform: 'win32' };

    var captured = 0;
    function host(expression) {
        if (expression.indexOf('CopalHost.projectDir') === 0) return 'OK|' + (has('unsaved') ? '' : '/project');
        if (expression.indexOf('CopalHost.capture') === 0) {
            return 'OK|' + JSON.stringify(CAPTURES[captured++ % CAPTURES.length]);
        }
        if (expression.indexOf('CopalHost.apply') === 0) return 'OK|2|3|0|0|0|';
        return 'ERR|The preview does not know ' + expression;
    }

    window.SystemPath = { USER_DATA: 'userData', EXTENSION: 'extension' };

    function CSInterface() {}
    CSInterface.THEME_COLOR_CHANGED_EVENT = 'com.adobe.csxs.events.ThemeColorChanged';
    CSInterface.prototype.getSystemPath = function () { return '/user'; };
    CSInterface.prototype.addEventListener = function () {};
    CSInterface.prototype.getHostEnvironment = function () {
        var v = has('light') ? 214 : 29;
        return { appSkinInfo: { panelBackgroundColor: { color: { red: v, green: v, blue: v, alpha: 255 } } } };
    };
    CSInterface.prototype.evalScript = function (expression, callback) {
        setTimeout(function () { callback(host(expression)); }, 20);
    };
    window.CSInterface = CSInterface;

    var scope = /[?&]scope=(project|user)/.exec(query);
    if (scope) { try { localStorage.setItem('copal.scope', scope[1]); } catch (e) {} }
}

/* The panel at several sizes at once, and one frame that can be dragged to
 * any size, for seeing where the layout changes. */
function sizesPage() {
    var sizes = [[320, 300, 'Docked wide'], [240, 300, 'Stacked bar'], [180, 280, 'Narrow'],
                 [140, 260, 'Stacked switch'], [110, 100, 'Sliver'], [72, 300, 'Strip'], [45, 300, 'Thin strip']];
    var frames = sizes.map(function (s) {
        return '<figure><figcaption>' + s[2] + ' <span>' + s[0] + ' x ' + s[1] + '</span></figcaption>' +
            '<iframe src="/?scope=user" style="width:' + s[0] + 'px;height:' + s[1] + 'px"></iframe></figure>';
    }).join('');
    return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Copal sizes</title><style>' +
        'body{margin:0;padding:20px;background:#111;color:#bbb;font:12px/1.4 "Segoe UI",system-ui,sans-serif}' +
        'h1{margin:0 0 4px;font-size:14px;font-weight:600;color:#fff}p{margin:0 0 18px;max-width:60ch}' +
        '.row{display:flex;flex-wrap:wrap;align-items:flex-start;gap:18px;margin-bottom:26px}' +
        'figure{margin:0}figcaption{margin-bottom:6px;color:#ddd}figcaption span{color:#777;margin-left:6px}' +
        'iframe{display:block;border:1px solid #3a3a3a;background:#1e1e1e}' +
        '.free{display:inline-block;resize:both;overflow:hidden;width:260px;height:240px;min-width:110px;min-height:80px;' +
        'border:1px solid #666}.free iframe{width:100%;height:100%;border:0}' +
        '#size{color:#777;margin-left:6px}' +
        '</style></head><body><h1>Copal panel, by size</h1>' +
        '<p>Each frame is the real panel, running on stand-in data. Click, double click and right click work.</p>' +
        '<div class="row">' + frames + '</div>' +
        '<figure><figcaption>Drag the bottom right corner<span id="size"></span></figcaption>' +
        '<div class="free" id="free"><iframe src="/?scope=user"></iframe></div></figure>' +
        '<script>var f=document.getElementById("free"),s=document.getElementById("size");' +
        'function show(){s.textContent=f.clientWidth+" x "+f.clientHeight}' +
        'if(window.ResizeObserver)new ResizeObserver(show).observe(f);show();</script></body></html>';
}

var server = http.createServer(function (request, response) {
    var url = request.url.split('?')[0];

    if (url === '/sizes') {
        response.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
        response.end(sizesPage());
        return;
    }

    if (url === '/__shim.js') {
        response.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store' });
        response.end('(' + shim.toString() + ')();');
        return;
    }

    var file = path.normalize(path.join(PANEL, url === '/' ? 'index.html' : decodeURIComponent(url)));
    if (file.indexOf(PANEL) !== 0) {
        response.writeHead(403);
        response.end();
        return;
    }

    fs.readFile(file, function (error, data) {
        if (error) {
            response.writeHead(404);
            response.end('Not found');
            return;
        }
        if (path.basename(file) === 'index.html') {
            data = String(data).replace('js/CSInterface.js', '/__shim.js');
        }
        response.writeHead(200, {
            'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
            'Cache-Control': 'no-store'
        });
        response.end(data);
    });
});

server.listen(PORT, function () {
    console.log('Copal preview at http://localhost:' + PORT);
});
