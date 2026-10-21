/*
 * Panel logic for the Copal extension.
 *
 * The panel owns the palette file and everything on screen. After Effects is
 * asked for three things only: where the project is saved, what paint the
 * selection carries, and to put a palette's paint onto the selection.
 */

/* global CSInterface, SystemPath, CopalStore, CopalGradient, CopalPicture, CopalSwatches */

(function () {
    'use strict';

    var csInterface = new CSInterface();
    var Store = CopalStore;
    var Gradient = CopalGradient;
    var Picture = CopalPicture;
    var Swatches = CopalSwatches;
    var fs = require('fs');
    var nodePath = require('path');

    /*
     * Usage for zeploy, the team's plugin deployer: counts "save", "replace",
     * "apply", "picture", "recolor", "import" and "export" once each
     * succeeds, and an error when one fails
     * on the panel's or After Effects' side. One line per use goes to
     * %LOCALAPPDATA%\zeploy\usage on PCs with zeploy, nothing elsewhere; no
     * palette, layer or file names. The version is read from the manifest, so
     * it never needs changing here.
     */
    function bundleVersion() {
        try {
            var xml = fs.readFileSync(nodePath.join(csInterface.getSystemPath(SystemPath.EXTENSION), 'CSXS', 'manifest.xml'), 'utf8');
            var m = /ExtensionBundleVersion="([^"]+)"/.exec(xml);
            return m ? m[1] : '';
        } catch (e) {
            return '';
        }
    }
    var usage = window.zeployUsageV1
        ? window.zeployUsageV1('com.copal.panel', bundleVersion(), 'aftereffects')
        : { action: function () {}, error: function () {} };

    var SCOPE_KEY = 'copal.scope';
    var USER_FILE = Store.userFile(csInterface.getSystemPath(SystemPath.USER_DATA));

    var el = {
        app: document.getElementById('app'),
        scope: document.getElementById('scope'),
        save: document.getElementById('save'),
        grid: document.getElementById('grid'),
        empty: document.getElementById('empty'),
        foot: document.getElementById('foot'),
        name: document.getElementById('name'),
        rename: document.getElementById('rename'),
        detail: document.getElementById('detail'),
        status: document.getElementById('status'),
        undo: document.getElementById('undo'),
        menu: document.getElementById('menu'),
        tray: document.getElementById('tray'),
        fromPicture: document.getElementById('from-picture'),
        replace: document.getElementById('replace'),
        swap: document.getElementById('swap'),
        swapFrom: document.getElementById('swap-from'),
        swapTo: document.getElementById('swap-to'),
        swapFromChip: document.getElementById('swap-from-chip'),
        swapToChip: document.getElementById('swap-to-chip'),
        swapWhere: document.getElementById('swap-where'),
        swapGo: document.getElementById('swap-go'),
        swapCancel: document.getElementById('swap-cancel'),
        trayChips: document.getElementById('tray-chips'),
        traySave: document.getElementById('tray-save'),
        trayCancel: document.getElementById('tray-cancel'),
        picker: document.getElementById('picker'),
        asePicker: document.getElementById('ase-picker')
    };

    var state = {
        scope: 'user',      // 'project' keeps palettes beside the .aep
        projectDir: '',     // empty while the project is unsaved
        file: '',           // empty when there is nowhere to keep palettes
        palettes: [],
        error: null,        // why the file on disk could not be used
        stamp: 0,           // its modified time when last read
        selected: null,
        undo: null,         // the last deleted palette and where it was
        tray: null          // colours from a picture, waiting to be saved
    };

    var renaming = null;
    var menuFor = null;
    var statusKind = '';
    var statusTimer = null;

    /* ------------------------------------------------------------ host */

    /* evalScript takes a single string, so anything crossing into
     * ExtendScript has to survive being embedded in a string literal. A JSON
     * string is one already, apart from two line separators that JSON allows
     * bare and a script does not. */
    var LINE_SEPARATORS = new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');

    function literal(text) {
        return JSON.stringify(String(text)).replace(LINE_SEPARATORS, function (ch) {
            return '\\' + 'u' + ch.charCodeAt(0).toString(16);
        });
    }

    function callHost(expression) {
        return new Promise(function (resolve) {
            csInterface.evalScript(expression, function (result) {
                if (result === 'EvalScript error.') {
                    resolve({ ok: false, threw: true, payload: 'ExtendScript threw. Check host.jsx.' });
                    return;
                }
                var split = String(result).indexOf('|');
                var head = split === -1 ? String(result) : String(result).substr(0, split);
                var body = split === -1 ? '' : String(result).substr(split + 1);
                resolve({ ok: head === 'OK', payload: body });
            });
        });
    }

    function parse(text) {
        try { return JSON.parse(text); } catch (e) { return null; }
    }

    /* ----------------------------------------------------------- theme */

    function shade(rgb, amount) {
        var target = amount < 0 ? 0 : 255;
        var t = Math.abs(amount);
        return 'rgb(' + rgb.map(function (v) {
            return Math.round(v + (target - v) * t);
        }).join(',') + ')';
    }

    /* The panel takes its greys from the colour After Effects gives its own
     * panels, so it follows the brightness set under Appearance. */
    function applyTheme() {
        var skin, color;
        try {
            skin = csInterface.getHostEnvironment().appSkinInfo;
            color = skin.panelBackgroundColor.color;
        } catch (e) {
            return;
        }

        // The face After Effects sets its own panels in, ahead of the
        // fallbacks. A name is only used if it is plain enough to quote.
        var face = skin.baseFontFamily;
        if (typeof face === 'string' && /^[\w .\-]+$/.test(face)) {
            document.documentElement.style.setProperty('--ui',
                '"' + face + '", "Adobe Clean", "Segoe UI", -apple-system, system-ui, sans-serif');
        }
        if (!color) return;

        var rgb = [color.red, color.green, color.blue];
        var light = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) > 140;
        var root = document.documentElement;
        root.setAttribute('data-theme', light ? 'light' : 'dark');

        root.style.setProperty('--bg', shade(rgb, 0));
        root.style.setProperty('--inset', shade(rgb, light ? -0.09 : -0.32));
        root.style.setProperty('--raised', shade(rgb, light ? 0.55 : 0.11));
        root.style.setProperty('--raised-hot', shade(rgb, light ? 0.8 : 0.17));
        root.style.setProperty('--line', shade(rgb, light ? -0.12 : 0.06));
        root.style.setProperty('--line-strong', shade(rgb, light ? -0.25 : 0.17));
    }

    /* ---------------------------------------------------------- status */

    /*
     * The footer shows the selected palette until there is news, then the
     * news. Plain news clears itself. A warning stays until the next thing
     * the user does, because it usually says what to do next.
     */
    function say(message, kind) {
        clearTimeout(statusTimer);
        statusKind = message ? (kind || '') : '';
        if (statusKind !== 'undo') state.undo = null;

        el.status.textContent = message || '';
        el.status.title = message || '';
        el.status.className = 'status' + (statusKind === 'warn' ? ' is-warn' : '');
        el.foot.classList.toggle('is-status', !!message);
        el.undo.classList.toggle('hidden', statusKind !== 'undo');

        if (message && statusKind !== 'warn') {
            statusTimer = setTimeout(function () { say(''); }, statusKind === 'undo' ? 8000 : 3500);
        }
    }

    function count(n, noun) {
        return n + ' ' + noun + (n === 1 ? '' : 's');
    }

    /* ---------------------------------------------------------- drawing */

    function find(id) {
        for (var i = 0; i < state.palettes.length; i++) {
            if (state.palettes[i].id === id) return state.palettes[i];
        }
        return null;
    }

    function swatchNode(id) {
        var nodes = el.grid.children;
        for (var i = 0; i < nodes.length; i++) {
            if (nodes[i].getAttribute('data-id') === id) return nodes[i];
        }
        return null;
    }

    function rgba(paint) {
        var c = paint.color.slice(0, 3).map(function (v) {
            return Math.round(Math.max(0, Math.min(1, v)) * 255);
        });
        var alpha = typeof paint.opacity === 'number'
            ? Math.max(0, Math.min(100, paint.opacity)) / 100 : 1;
        return 'rgba(' + c.join(',') + ',' + alpha + ')';
    }

    /* How thick to draw a stroke on a chip. The square root keeps a hairline
     * visible and stops a heavy stroke swallowing the fill, while a 2 pixel
     * stroke still looks thinner than a 10 pixel one. */
    function edge(width) {
        var px = Math.sqrt(Math.max(0, width)) * 1.6;
        return Math.round(Math.max(1.5, Math.min(8, px)) * 2) / 2;
    }

    function buildSwatch(palette) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'swatch';
        button.title = palette.name;
        button.tabIndex = -1;
        button.setAttribute('role', 'option');
        button.setAttribute('data-id', palette.id);

        var chip = document.createElement('span');
        chip.className = 'chip' + (palette.fill ? '' : ' no-fill');
        var paint = document.createElement('span');
        paint.className = 'chip-paint';

        if (palette.fill) {
            paint.style.setProperty('--fill', Gradient.isGradient(palette.fill) ? Gradient.css(palette.fill) : rgba(palette.fill));
        }

        var stroke = palette.stroke;
        if (stroke) {
            var px = edge(typeof stroke.width === 'number' ? stroke.width : 1);
            paint.style.setProperty('--stroke', rgba(stroke));
            paint.style.setProperty('--stroke-w', px + 'px');
            if (stroke.dashes && stroke.dashes.length) paint.style.setProperty('--stroke-style', 'dashed');
            // A border can only be one colour, so a gradient stroke is drawn
            // as a border image, which has square corners and no dashes.
            if (Gradient.isGradient(stroke)) paint.style.borderImage = Gradient.css(stroke) + ' 1';
        }

        chip.appendChild(paint);
        button.appendChild(chip);
        return button;
    }

    function trimNumber(n) {
        return String(Math.round(n * 100) / 100);
    }

    function describe(label, paint, isStroke) {
        var part = document.createElement('span');
        part.className = 'detail-part';
        if (paint === undefined) {
            part.textContent = label + ' unchanged';
            return part;
        }
        if (!paint) {
            part.textContent = 'No ' + label.toLowerCase();
            return part;
        }

        var gradient = Gradient.isGradient(paint);
        part.appendChild(document.createTextNode(label + (gradient ? ' gradient ' : ' ')));
        var value = document.createElement('b');
        value.textContent = Store.paintName(paint);
        part.appendChild(value);

        var rest = '';
        if (isStroke && typeof paint.width === 'number') rest += ' ' + trimNumber(paint.width) + ' px';
        if (isStroke && paint.dashes && paint.dashes.length) rest += ' dashed';
        if (typeof paint.opacity === 'number' && paint.opacity < 100) rest += ' ' + Math.round(paint.opacity) + '%';
        if (rest) part.appendChild(document.createTextNode(rest));
        return part;
    }

    function renderFoot() {
        var palette = find(state.selected);
        el.name.textContent = palette ? palette.name : '';
        el.detail.textContent = '';
        if (palette) {
            el.detail.appendChild(describe('Fill', palette.fill, false));
            el.detail.appendChild(describe('Stroke', palette.stroke, true));
        } else if (state.palettes.length) {
            el.detail.textContent = 'Double click a palette to apply it.';
        }
    }

    function renderEmpty() {
        var lead, body, link = false;
        if (!state.file) {
            lead = 'This project is not saved yet';
            body = 'Save it, and its palettes are kept in ' + Store.FILE_NAME + ' beside the .aep.';
        } else if (state.error) {
            lead = Store.FILE_NAME + ' could not be read';
            body = state.error + ' Fix the file or delete it, then come back.';
            link = true;
        } else {
            lead = 'No palettes here yet';
            body = 'Select a shape layer, then press +. Or drop a picture here for its colours.';
        }

        el.empty.textContent = '';
        var leadNode = document.createElement('div');
        leadNode.className = 'empty-lead';
        leadNode.textContent = lead;
        var bodyNode = document.createElement('div');
        bodyNode.textContent = body;
        el.empty.appendChild(leadNode);
        el.empty.appendChild(bodyNode);

        if (link) {
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'empty-link';
            button.textContent = 'Show palette file';
            button.addEventListener('click', reveal);
            el.empty.appendChild(button);
        }
    }

    /* Only one swatch is in the tab order at a time. The arrow keys move
     * between them, so Tab leaves the grid in one press however full it is. */
    function markSelected() {
        var nodes = el.grid.children;
        for (var i = 0; i < nodes.length; i++) {
            var on = nodes[i].getAttribute('data-id') === state.selected;
            nodes[i].classList.toggle('is-selected', on);
            nodes[i].setAttribute('aria-selected', on ? 'true' : 'false');
            nodes[i].tabIndex = on ? 0 : -1;
        }
        if (!state.selected && nodes.length) nodes[0].tabIndex = 0;
    }

    function render() {
        el.grid.textContent = '';
        state.palettes.forEach(function (palette) {
            el.grid.appendChild(buildSwatch(palette));
        });
        if (!find(state.selected)) state.selected = null;
        markSelected();

        var isEmpty = !state.palettes.length;
        el.grid.classList.toggle('hidden', isEmpty);
        el.empty.classList.toggle('hidden', !isEmpty);
        if (isEmpty) renderEmpty();

        el.save.disabled = !state.file || !!state.error;
        el.fromPicture.disabled = el.save.disabled;

        // The buttons are icons, so the tooltip says which place is which,
        // and where its file is.
        var buttons = el.scope.children;
        for (var i = 0; i < buttons.length; i++) {
            var scope = buttons[i].getAttribute('data-scope');
            buttons[i].classList.toggle('is-active', scope === state.scope);
            buttons[i].setAttribute('aria-pressed', scope === state.scope ? 'true' : 'false');
            buttons[i].title = scope === 'user' ? 'All projects\n' + USER_FILE
                : 'This project\n' + (state.projectDir ? Store.projectFile(state.projectDir)
                                                       : 'Kept beside the .aep once the project is saved');
        }

        renderFoot();
    }

    function select(id, focus) {
        state.selected = id;
        markSelected();
        renderFoot();
        var node = id ? swatchNode(id) : null;
        if (node && focus) node.focus();
        if (node && node.scrollIntoViewIfNeeded) node.scrollIntoViewIfNeeded(false);
    }

    /* ------------------------------------------------------------ file */

    function fileFor(projectDir) {
        if (state.scope === 'user') return USER_FILE;
        return projectDir ? Store.projectFile(projectDir) : '';
    }

    function load() {
        state.file = fileFor(state.projectDir);
        var result = state.file ? Store.read(state.file) : { palettes: [], error: null, mtime: 0 };
        state.palettes = result.palettes;
        state.error = result.error;
        state.stamp = result.mtime;
        render();
    }

    /*
     * Picks up a different project, or a palette file somebody else changed.
     * After Effects does not tell a panel when the project changes, so this
     * runs whenever the pointer comes back to the panel, which is always
     * before anything in it can be clicked.
     */
    var refreshing = false;
    function refresh() {
        if (refreshing || renaming) return;
        refreshing = true;
        callHost('CopalHost.projectDir()').then(function (reply) {
            refreshing = false;
            var dir = reply.ok ? reply.payload : '';
            var file = fileFor(dir);
            var same = dir === state.projectDir && file === state.file &&
                (file ? Store.mtime(file) : 0) === state.stamp;
            state.projectDir = dir;
            if (!same) load();
        });
    }

    /* Changes the list on disk and redraws from the result. Returns false,
     * having said why, when the file could not be changed. */
    function mutate(change) {
        if (!state.file) return false;
        try {
            var result = Store.update(state.file, change);
            state.palettes = result.palettes;
            state.stamp = result.mtime;
            state.error = null;
            render();
            return true;
        } catch (e) {
            load();
            say(e.code ? 'The palette file could not be written (' + e.code + ').' : e.message, 'warn');
            return false;
        }
    }

    function withPalette(list, id, change) {
        for (var i = 0; i < list.length; i++) {
            if (list[i].id === id) { change(list[i], i); return; }
        }
    }

    /* --------------------------------------------------------- actions */

    function capture(feature) {
        return callHost('CopalHost.capture()').then(function (reply) {
            if (!reply.ok) {
                if (reply.threw) usage.error(feature);
                say(reply.payload, 'warn');
                return null;
            }
            var captured = parse(reply.payload);
            if (captured) {
                // A gradient arrives as samples of its ramp. Its colour stops
                // are worked out here.
                Gradient.finish(captured.fill);
                Gradient.finish(captured.stroke);
            }
            var palette = captured ? Store.create(captured) : null;
            if (!palette || (!palette.fill && !palette.stroke)) {
                say('After Effects sent back nothing that could be saved.', 'warn');
                return null;
            }
            return palette;
        });
    }

    function saveFromSelection() {
        if (el.save.disabled) return;
        capture('save').then(function (palette) {
            if (!palette) return;
            if (!mutate(function (list) { list.push(palette); })) { usage.error('save'); return; }
            usage.action('save');
            select(palette.id);
            say('Saved ' + palette.name + '.');
        });
    }

    function replaceFromSelection(id) {
        capture('replace').then(function (fresh) {
            if (!fresh) return;
            var name = '';
            var done = mutate(function (list) {
                withPalette(list, id, function (palette) {
                    // A name nobody typed follows the colour it was made from.
                    if (palette.name === Store.nameFor(palette)) palette.name = fresh.name;
                    palette.fill = fresh.fill;
                    palette.stroke = fresh.stroke;
                    name = palette.name;
                });
            });
            if (!done) { usage.error('replace'); return; }
            if (name) usage.action('replace');
            select(id);
            say(name ? 'Replaced ' + name + ' with the selection.' : 'That palette is no longer in the file.',
                name ? '' : 'warn');
        });
    }

    /*
     * After Effects takes a gradient's colours only from an animation preset,
     * so one is written to the temporary folder for each gradient in the
     * palette, and removed again once it has been applied.
     */
    function writePresets(palette) {
        var files = { fill: '', stroke: '' };
        ['fill', 'stroke'].forEach(function (kind) {
            if (!Gradient.isGradient(palette[kind])) return;
            var bytes = Gradient.preset(kind, palette[kind].gradient);
            var file = nodePath.join(require('os').tmpdir(),
                'copal-' + kind + '-' + Date.now().toString(36) + '.ffx');
            fs.writeFileSync(file, typeof Buffer === 'undefined' ? bytes : Buffer.from(bytes));
            files[kind] = file;
        });
        return files;
    }

    function removePresets(files) {
        [files.fill, files.stroke].forEach(function (file) {
            if (file) { try { fs.unlinkSync(file); } catch (e) {} }
        });
    }

    /* Why a layer was left alone, in the user's terms. */
    var REFUSALS = {
        part: 'A gradient goes on a whole layer or on a group at the top of its Contents, not on a group inside another group.',
        wrap: 'After Effects would not group the shapes, so the gradient was left off. Click the timeline once, then try again.',
        preset: 'After Effects would not apply the gradient preset, so the gradient was left off.',
        stroke: 'A gradient stroke cannot go on a stroke alone. Select the layer or the group instead.',
        half: 'This palette leaves the selected kind of paint as it is, so there was nothing to change.',
        unsupported: 'This palette has a gradient, which could not be applied here.'
    };

    function applyPalette(id) {
        var palette = find(id);
        if (!palette) return;
        var started = Date.now();

        var files;
        try {
            files = writePresets(palette);
        } catch (e) {
            usage.error('apply');
            say('The gradient could not be prepared (' + (e.code || e.message) + ').', 'warn');
            return;
        }

        var json = JSON.stringify({ fill: palette.fill, stroke: palette.stroke });
        var call = 'CopalHost.apply(' + literal(json) + ', ' + literal(files.fill) + ', ' + literal(files.stroke) + ')';
        callHost(call).then(function (reply) {
            removePresets(files);
            if (!reply.ok) {
                if (reply.threw) usage.error('apply');
                say(reply.payload, 'warn');
                return;
            }

            // layers painted, paints changed, paints added, settings refused,
            // layers left alone, and why
            var parts = reply.payload.split('|');
            var n = parts.slice(0, 5).map(Number);
            var refusal = n[4] ? (REFUSALS[parts[5]] || REFUSALS.unsupported) : '';
            if (!n[0] && refusal) { say(refusal, 'warn'); return; }
            if (!n[1]) {
                say('Nothing in the selection takes a fill or stroke.', 'warn');
                return;
            }

            usage.action('apply', Date.now() - started);
            var text = 'Applied ' + palette.name + ' to ' + count(n[0], 'layer') + '.';
            if (n[3]) text += ' After Effects refused ' + count(n[3], 'setting') + '.';
            if (refusal) text += ' ' + count(n[4], 'layer') + ' left alone: ' + refusal;
            say(text, n[3] || refusal ? 'warn' : '');
        });
    }

    function deletePalette(id) {
        var removed = null;
        var index = -1;
        var done = mutate(function (list) {
            withPalette(list, id, function (palette, i) {
                removed = list.splice(i, 1)[0];
                index = i;
            });
        });
        if (!done || !removed) return;

        var next = state.palettes[Math.min(index, state.palettes.length - 1)];
        select(next ? next.id : null, true);
        state.undo = { file: state.file, palette: removed, index: index };
        say('Deleted ' + removed.name + '.', 'undo');
    }

    function undoDelete() {
        var undo = state.undo;
        say('');
        if (!undo || undo.file !== state.file) return;
        var done = mutate(function (list) {
            list.splice(Math.min(undo.index, list.length), 0, undo.palette);
        });
        if (done) select(undo.palette.id, true);
    }

    function startRename(id) {
        var palette = find(id);
        if (!palette) return;
        say('');
        select(id);
        renaming = id;
        el.foot.classList.add('is-renaming');
        el.rename.classList.remove('hidden');
        el.rename.value = palette.name;
        el.rename.focus();
        el.rename.select();
    }

    function endRename(commit) {
        if (!renaming) return;
        var id = renaming;
        renaming = null;
        var value = el.rename.value.trim();
        el.rename.classList.add('hidden');
        el.foot.classList.remove('is-renaming');

        var palette = find(id);
        if (commit && value && palette && value !== palette.name) {
            mutate(function (list) {
                withPalette(list, id, function (entry) { entry.name = value; });
            });
            select(id);
        }
        var node = swatchNode(id);
        if (node) node.focus();
    }

    function reveal() {
        var file = state.file;
        if (!file) { say('Save the project first.', 'warn'); return; }

        var exists = fs.existsSync(file);
        var dir = nodePath.dirname(file);
        if (!exists && !fs.existsSync(dir)) {
            say('Nothing has been saved here yet.', 'warn');
            return;
        }

        var spawn = require('child_process').spawn;
        var child;
        if (process.platform === 'win32') {
            // Explorer reads its own command line, and wants the quotes round
            // the path alone, not round the whole argument as Node puts them.
            child = spawn('explorer.exe', [exists ? '/select,"' + file + '"' : '"' + dir + '"'],
                { windowsVerbatimArguments: true });
        } else {
            child = spawn('open', exists ? ['-R', file] : [dir]);
        }
        child.on('error', function () { say('The folder could not be opened.', 'warn'); });
    }

    function setScope(scope) {
        if (scope === state.scope) return;
        state.scope = scope;
        state.selected = null;
        try { localStorage.setItem(SCOPE_KEY, scope); } catch (e) {}
        say('');
        load();
        refresh();
    }

    /* --------------------------------------------------------- picture */

    /*
     * A picture dropped on the panel, or picked from the menu, is drawn
     * small and boiled down to its main colours, which wait in a tray above
     * the palettes. Clicking one leaves it out. Nothing is written until
     * Save, which makes one fill-only palette of each colour kept.
     */
    var PICTURE_SIDE = 200;
    var PICTURE_COLOURS = 8;
    var PICTURE_FILE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

    /* Why there is nowhere to save palettes just now, or '' if there is. */
    function whyNoFile() {
        if (!state.file) return 'Save the project first, or switch to All projects.';
        if (state.error) return Store.FILE_NAME + ' could not be read. Fix it or delete it first.';
        return '';
    }

    /* name, when given, is what the palettes are called after in place of
     * the file's own name, which for a pasted picture means nothing. */
    function readPicture(file, name) {
        if (!file) return;
        if (!/^image\//.test(file.type) && !PICTURE_FILE.test(file.name)) {
            say('That is not a picture. Drop a PNG, JPEG, GIF, WebP, BMP or SVG.', 'warn');
            return;
        }
        var why = whyNoFile();
        if (why) { say(why, 'warn'); return; }

        var url = URL.createObjectURL(file);
        var picture = new window.Image();
        picture.onload = function () {
            URL.revokeObjectURL(url);
            // A drawing with no size of its own is given one.
            var width = picture.naturalWidth || PICTURE_SIDE;
            var height = picture.naturalHeight || PICTURE_SIDE;
            var scale = Math.min(1, PICTURE_SIDE / Math.max(width, height));
            var canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(width * scale));
            canvas.height = Math.max(1, Math.round(height * scale));
            var context = canvas.getContext('2d');
            context.drawImage(picture, 0, 0, canvas.width, canvas.height);
            var pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            var colours = Picture.mainColors(pixels, PICTURE_COLOURS);
            if (!colours.length) {
                say('That picture is see-through all over, so it has no colours to keep.', 'warn');
                return;
            }
            openTray(name || Picture.baseName(file.name), colours);
        };
        picture.onerror = function () {
            URL.revokeObjectURL(url);
            say('That picture could not be read.', 'warn');
        };
        picture.src = url;
    }

    /* The same, for anyone who would rather pick the file than drag it. */
    function pickPicture() {
        el.picker.value = '';
        el.picker.click();
    }

    /*
     * A picture on the clipboard. A screenshot or an image copied from a
     * browser or Photoshop arrives as a picture, named "Pasted"; an image
     * file copied in Explorer arrives as that file, under its own name.
     */
    var PASTED = 'Pasted';
    // What the browser calls a picture pasted from anywhere but a file.
    var NAMELESS = /^image\.(png|jpe?g|gif|bmp)$/i;

    function pictureFrom(data) {
        var i;
        var files = data ? data.files : null;
        for (i = 0; files && i < files.length; i++) {
            if (/^image\//.test(files[i].type) || PICTURE_FILE.test(files[i].name)) {
                return { file: files[i], name: NAMELESS.test(files[i].name) ? PASTED : '' };
            }
        }
        var items = data ? data.items : null;
        for (i = 0; items && i < items.length; i++) {
            if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
                return { file: items[i].getAsFile(), name: PASTED };
            }
        }
        return null;
    }

    /* A picture on the clipboard, or failing that colours in its text: a
     * Coolors link or hex codes. data is a paste event's clipboard, or null
     * when nothing usable was found some other way. */
    function pasteFrom(data) {
        var found = pictureFrom(data);
        if (found) { readPicture(found.file, found.name); return; }
        var text = data && data.getData ? data.getData('text/plain') : '';
        if (!pasteColours(text)) say('The clipboard holds no picture or colours. Copy an image, a Coolors link or hex codes first.', 'warn');
    }

    /* Colours in a piece of copied text, into the tray. False when the text
     * holds none. */
    function pasteColours(text) {
        var found = Swatches.fromText(text);
        if (!found) return false;
        var why = whyNoFile();
        if (why) { say(why, 'warn'); return true; }
        openTray(found.name, found.colours, 'import');
        return true;
    }

    /*
     * Paste in the menu, where there is no paste event to read. The browser
     * inside older versions of After Effects cannot read the clipboard on
     * its own, so on Windows PowerShell is asked instead: it hands back an
     * image file copied in Explorer, saves a copied image to the temporary
     * folder for the panel to read, or hands back copied text, in base 64 so
     * that it stays on one line.
     */
    var CLIPBOARD_SCRIPT = [
        'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
        '$files = [Windows.Forms.Clipboard]::GetFileDropList()',
        'if ($files.Count) { "file|" + $files[0]; exit }',
        '$image = [Windows.Forms.Clipboard]::GetImage()',
        'if ($image) { $image.Save($env:COPAL_CLIP, [Drawing.Imaging.ImageFormat]::Png); "image|"; exit }',
        '$text = [Windows.Forms.Clipboard]::GetText()',
        'if ($text) { "text|" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)); exit }',
        '"none|"'
    ].join('\n');

    function pasteFromMenu() {
        if (navigator.clipboard && navigator.clipboard.read) {
            navigator.clipboard.read().then(function (items) {
                var i, j, type;
                for (i = 0; i < items.length; i++) {
                    for (j = 0; j < items[i].types.length; j++) {
                        type = items[i].types[j];
                        if (!/^image\//.test(type)) continue;
                        return items[i].getType(type).then(function (blob) {
                            readPicture(new File([blob], 'pasted.png', { type: blob.type }), PASTED);
                        });
                    }
                }
                for (i = 0; i < items.length; i++) {
                    if (Array.prototype.indexOf.call(items[i].types, 'text/plain') === -1) continue;
                    return items[i].getType('text/plain').then(function (blob) { return blob.text(); }).then(function (text) {
                        if (!pasteColours(text)) pasteFrom(null);
                    });
                }
                pasteFrom(null);
            }, function () { pasteWithPowerShell(); });
            return;
        }
        pasteWithPowerShell();
    }

    function pasteWithPowerShell() {
        if (process.platform !== 'win32') { pasteFrom(null); return; }
        var clip = nodePath.join(require('os').tmpdir(), 'copal-clip-' + Date.now().toString(36) + '.png');
        var env = {};
        Object.keys(process.env).forEach(function (key) { env[key] = process.env[key]; });
        env.COPAL_CLIP = clip;
        var out = '';
        var child = require('child_process').spawn('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-STA', '-Command', CLIPBOARD_SCRIPT], { env: env, windowsHide: true });
        child.stdout.on('data', function (chunk) { out += chunk; });
        child.on('error', function () { say('The clipboard could not be read.', 'warn'); });
        child.on('close', function () {
            var line = out.trim().split(/\r?\n/).pop() || '';
            var kind = line.split('|')[0];
            var copied = line.slice(kind.length + 1);
            // Copied into the page's own array: a Buffer comes from Node's
            // side of the panel, which the page's File may not take.
            try {
                if (kind === 'file') {
                    readPicture(new File([new Uint8Array(fs.readFileSync(copied))], nodePath.basename(copied), { type: '' }));
                } else if (kind === 'image') {
                    var bytes = new Uint8Array(fs.readFileSync(clip));
                    try { fs.unlinkSync(clip); } catch (e) {}
                    readPicture(new File([bytes], 'pasted.png', { type: 'image/png' }), PASTED);
                } else if (kind === 'text') {
                    if (!pasteColours(Buffer.from(copied, 'base64').toString('utf8'))) pasteFrom(null);
                } else {
                    pasteFrom(null);
                }
            } catch (e2) {
                say('The clipboard could not be read (' + (e2.code || e2.message) + ').', 'warn');
            }
        });
    }

    /* kind is 'picture' for the main colours of a picture, each with its
     * share of it, or 'import' for colours read from a swatch file or
     * pasted text, each with a name of its own where it has one. */
    function openTray(name, colours, kind) {
        closeSwap();
        say('');
        state.tray = {
            name: name,
            kind: kind || 'picture',
            colours: colours.map(function (c) { return { color: c.color, share: c.share, name: c.name || '', keep: true }; })
        };
        el.trayChips.textContent = '';
        state.tray.colours.forEach(function (colour, i) {
            var chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'tray-chip';
            chip.style.background = rgba({ color: colour.color });
            chip.setAttribute('role', 'option');
            chip.setAttribute('data-index', String(i));
            el.trayChips.appendChild(chip);
        });
        el.tray.classList.remove('hidden');
        el.app.classList.add('has-tray');
        markTray();
        if (el.trayChips.firstChild) el.trayChips.firstChild.focus();
    }

    /* The chips are only marked, never redrawn, so focus stays put while
     * they are clicked through with the keyboard. */
    function markTray() {
        var kept = 0;
        var chips = el.trayChips.children;
        state.tray.colours.forEach(function (colour, i) {
            if (colour.keep) kept++;
            chips[i].classList.toggle('is-kept', colour.keep);
            chips[i].setAttribute('aria-selected', colour.keep ? 'true' : 'false');
            var about = colour.share
                ? ', ' + Math.max(1, Math.round(colour.share * 100)) + '% of ' + state.tray.name
                : (colour.name ? ', ' + colour.name : '');
            chips[i].title = '#' + Store.hex(colour.color) + about + '\n' +
                (colour.keep ? 'Click to leave out' : 'Left out. Click to keep');
        });
        el.traySave.disabled = !kept;
        el.traySave.title = kept ? 'Save ' + count(kept, 'colour') + ' from ' + state.tray.name + ' as palettes'
            : 'Every colour is left out';
    }

    function closeTray() {
        state.tray = null;
        el.tray.classList.add('hidden');
        el.app.classList.remove('has-tray');
        el.trayChips.textContent = '';
    }

    function saveTray() {
        var tray = state.tray;
        if (!tray) return;
        var colours = tray.colours.filter(function (c) { return c.keep; });
        if (!colours.length) return;
        var made = [];
        var done = mutate(function (list) {
            // A swatch keeps its own name; the rest are numbered after the
            // picture, the file or the link they came from.
            var unnamed = colours.filter(function (c) { return !c.name; }).length;
            var names = Picture.names(tray.name, list.map(function (p) { return p.name; }), unnamed);
            var n = 0;
            colours.forEach(function (colour) {
                var palette = Store.fromColor(colour.color, colour.name || names[n++]);
                made.push(palette);
                list.push(palette);
            });
        });
        // Left open when the file could not be written, to try again.
        if (!done) { usage.error(tray.kind); return; }
        usage.action(tray.kind);
        closeTray();
        select(made[0].id, true);
        say('Saved ' + count(made.length, 'palette') + ' from ' + tray.name + '.');
    }

    /* -------------------------------------------------------- swatches */

    var ASE_FILE = /\.ase$/i;

    /*
     * An .ase file from Illustrator, Photoshop, InDesign or a colour site,
     * picked from the menu or dropped on the panel. Its colours wait in the
     * tray, under their own names, like the colours of a picture.
     */
    function readSwatches(file) {
        if (!file) return;
        var why = whyNoFile();
        if (why) { say(why, 'warn'); return; }
        var reader = new FileReader();
        reader.onload = function () {
            var found;
            try {
                found = Swatches.read(new Uint8Array(reader.result));
            } catch (e) {
                usage.error('import');
                say(file.name + ' could not be read. ' + e.message, 'warn');
                return;
            }
            if (!found.colours.length) {
                say(file.name + ' holds no colours to keep.', 'warn');
                return;
            }
            openTray(Picture.baseName(file.name), found.colours, 'import');
            if (found.skipped) say(swatchCount(found.skipped) + ' in a colour model Copal does not know left out.', 'warn');
        };
        reader.onerror = function () { say(file.name + ' could not be opened.', 'warn'); };
        reader.readAsArrayBuffer(file);
    }

    function pickSwatches() {
        el.asePicker.value = '';
        el.asePicker.click();
    }

    /*
     * The palettes here as an .ase file for the Swatches panels of
     * Illustrator, Photoshop and InDesign. Where it goes is asked with the
     * system's own save dialog; where that is missing, as in the preview,
     * the file goes beside the palette file.
     */
    function exportSwatches() {
        if (!state.palettes.length) { say('There are no palettes here to export.', 'warn'); return; }
        var place = state.scope === 'user' ? 'All projects' : nodePath.basename(state.projectDir) || 'This project';
        var dir = nodePath.dirname(state.file || USER_FILE);
        var target = askWhere(dir, 'Copal ' + place + '.ase');
        if (!target) return;
        if (!ASE_FILE.test(target)) target += '.ase';

        var bytes = Swatches.ase(state.palettes, 'Copal ' + place);
        try {
            fs.writeFileSync(target, typeof Buffer === 'undefined' ? bytes : Buffer.from(bytes));
        } catch (e) {
            usage.error('export');
            say('The swatches could not be written (' + (e.code || e.message) + ').', 'warn');
            return;
        }
        usage.action('export');
        say('Exported ' + swatchCount(Swatches.swatches(state.palettes).length) + ' to ' + nodePath.basename(target) + '.');
    }

    function swatchCount(n) {
        return n + (n === 1 ? ' swatch' : ' swatches');
    }

    function askWhere(dir, fileName) {
        var dialog = window.cep && window.cep.fs && window.cep.fs.showSaveDialogEx;
        if (!dialog) return nodePath.join(dir, fileName);
        var result = window.cep.fs.showSaveDialogEx('Export swatches', dir, ['ase'], fileName);
        return result && !result.err && result.data ? String(result.data) : '';
    }

    /* --------------------------------------------------------- replace */

    /*
     * One solid colour into another across layers: shape fills and strokes,
     * text, solids and effect colours. The strip takes two
     * hex codes; clicking a palette while it is open puts that palette's
     * colour in the field last used, and moves on to the other one, so two
     * clicks fill both. Gradients are left alone.
     */
    var swapTarget = 'from';

    function paletteColor(palette) {
        var paint = palette && (palette.fill || palette.stroke);
        return paint ? paint.color.slice(0, 3) : null;
    }

    function markSwap() {
        [['from', el.swapFrom, el.swapFromChip], ['to', el.swapTo, el.swapToChip]].forEach(function (f) {
            var color = Store.parseHex(f[1].value);
            f[2].style.background = color ? rgba({ color: color }) : 'transparent';
            f[1].parentNode.classList.toggle('is-target', swapTarget === f[0]);
        });
        var from = Store.parseHex(el.swapFrom.value);
        var to = Store.parseHex(el.swapTo.value);
        var ready = !!from && !!to && Store.hex(from) !== Store.hex(to);
        el.swapGo.disabled = !ready;
        el.swapGo.title = ready
            ? 'Replace #' + Store.hex(from) + ' with #' + Store.hex(to) + ' in ' + el.swapWhere.options[el.swapWhere.selectedIndex].text.toLowerCase()
            : 'Give two different colours';
    }

    function openSwap() {
        if (state.tray) closeTray();
        say('');
        el.swap.classList.remove('hidden');
        el.replace.classList.add('is-on');
        el.app.classList.add('has-swap');
        var color = paletteColor(find(state.selected));
        if (color && !el.swapFrom.value) el.swapFrom.value = '#' + Store.hex(color);
        swapTarget = Store.parseHex(el.swapFrom.value) ? 'to' : 'from';
        markSwap();
        (swapTarget === 'to' ? el.swapTo : el.swapFrom).focus();
    }

    function closeSwap() {
        el.swap.classList.add('hidden');
        el.replace.classList.remove('is-on');
        el.app.classList.remove('has-swap');
    }

    function fillSwap(palette) {
        var color = paletteColor(palette);
        if (!color) return;
        (swapTarget === 'from' ? el.swapFrom : el.swapTo).value = '#' + Store.hex(color);
        swapTarget = swapTarget === 'from' ? 'to' : 'from';
        markSwap();
    }

    function runSwap() {
        var from = Store.parseHex(el.swapFrom.value);
        var to = Store.parseHex(el.swapTo.value);
        if (!from || !to || el.swapGo.disabled) return;
        var where = el.swapWhere.value;
        var started = Date.now();
        var call = 'CopalHost.replace(' + literal(JSON.stringify(from)) + ', ' +
            literal(JSON.stringify(to)) + ', ' + literal(where) + ')';
        // Tracked as 'recolor': 'replace' is already the menu's "Replace
        // with selection".
        callHost(call).then(function (reply) {
            if (!reply.ok) {
                if (reply.threw) usage.error('recolor');
                say(reply.payload, 'warn');
                return;
            }
            usage.action('recolor', Date.now() - started);
            // colours changed, layers, comps, gradients not looked at,
            // colours left to an expression, locked layers, refusals
            var n = reply.payload.split('|').map(Number);
            var place = { selection: 'the selected layers', comp: 'this comp', project: 'the project' }[where];
            var notes = [];
            if (n[4]) notes.push(count(n[4], 'colour') + ' set by an expression left alone');
            if (n[5]) notes.push(count(n[5], 'locked layer') + ' skipped');
            if (n[6]) notes.push('After Effects refused ' + count(n[6], 'change'));
            if (!n[0]) {
                say('Nothing in ' + place + ' is #' + Store.hex(from) + '.' +
                    (notes.length ? ' ' + notes.join(', ') + '.' : ''), 'warn');
                return;
            }
            var text = 'Changed ' + count(n[0], 'colour') + ' in ' + count(n[1], 'layer') +
                (where === 'project' ? ', ' + count(n[2], 'comp') : '') + '.';
            if (notes.length) text += ' ' + notes.join(', ') + '.';
            closeSwap();
            say(text, notes.length ? 'warn' : '');
        });
    }

    /* ------------------------------------------------------------ menu */

    function closeMenu() {
        el.menu.classList.add('hidden');
        menuFor = null;
    }

    function openMenu(x, y, id) {
        menuFor = id || null;
        var items = el.menu.children;
        for (var i = 0; i < items.length; i++) {
            var needsPalette = items[i].getAttribute('data-needs') === 'palette';
            items[i].classList.toggle('hidden', needsPalette && !menuFor);
        }
        el.menu.classList.remove('hidden');

        // Kept inside the panel, which is often narrower than the menu is far
        // from its right edge.
        var box = el.menu.getBoundingClientRect();
        el.menu.style.left = Math.max(2, Math.min(x, window.innerWidth - box.width - 2)) + 'px';
        el.menu.style.top = Math.max(2, Math.min(y, window.innerHeight - box.height - 2)) + 'px';
    }

    function runMenu(action) {
        var id = menuFor;
        closeMenu();
        if (action === 'reveal') reveal();
        else if (action === 'picture') pickPicture();
        else if (action === 'paste') pasteFromMenu();
        else if (action === 'ase-in') pickSwatches();
        else if (action === 'ase-out') exportSwatches();
        else if (!id) return;
        else if (action === 'apply') applyPalette(id);
        else if (action === 'replace') replaceFromSelection(id);
        else if (action === 'rename') startRename(id);
        else if (action === 'delete') deletePalette(id);
    }

    /* -------------------------------------------------------- keyboard */

    function columns() {
        var nodes = el.grid.children;
        if (!nodes.length) return 1;
        var top = nodes[0].offsetTop;
        var n = 0;
        while (n < nodes.length && nodes[n].offsetTop === top) n++;
        return n || 1;
    }

    function step(delta) {
        if (!state.palettes.length) return;
        var index = -1;
        for (var i = 0; i < state.palettes.length; i++) {
            if (state.palettes[i].id === state.selected) { index = i; break; }
        }
        var next = index === -1 ? 0 : index + delta;
        if (next < 0 || next >= state.palettes.length) return;
        select(state.palettes[next].id, true);
    }

    function onGridKey(event) {
        var key = event.key;
        if (key === 'ArrowRight') step(1);
        else if (key === 'ArrowLeft') step(-1);
        else if (key === 'ArrowDown') step(columns());
        else if (key === 'ArrowUp') step(-columns());
        else if (key === 'Enter' && state.selected) applyPalette(state.selected);
        else if ((key === 'Delete' || key === 'Backspace') && state.selected) deletePalette(state.selected);
        else if (key === 'F2' && state.selected) startRename(state.selected);
        else return;
        event.preventDefault();
    }

    /* ---------------------------------------------------------- wiring */

    function swatchId(event) {
        var node = event.target.closest ? event.target.closest('.swatch') : null;
        return node ? node.getAttribute('data-id') : null;
    }

    /* Selection only swaps classes on the existing buttons. Redrawing the
     * grid here would replace the button between the two clicks of a double
     * click, and the second click would land on a stranger. */
    el.grid.addEventListener('click', function (event) {
        var id = swatchId(event);
        if (!id) return;
        if (statusKind === 'warn') say('');
        select(id);
        // Only the first click of a double click fills a field, or the
        // second would put the same colour in the other one.
        if (!el.swap.classList.contains('hidden') && event.detail < 2) fillSwap(find(id));
    });

    // While the replace strip is open, clicking a palette picks its colour,
    // so a double click must not also paint the selected layers with it.
    el.grid.addEventListener('dblclick', function (event) {
        var id = swatchId(event);
        if (id && el.swap.classList.contains('hidden')) applyPalette(id);
    });

    el.grid.addEventListener('keydown', onGridKey);

    el.save.addEventListener('click', saveFromSelection);
    el.fromPicture.addEventListener('click', pickPicture);

    el.replace.addEventListener('click', function () {
        if (el.swap.classList.contains('hidden')) openSwap(); else closeSwap();
    });
    [['from', el.swapFrom], ['to', el.swapTo]].forEach(function (f) {
        f[1].addEventListener('focus', function () { swapTarget = f[0]; markSwap(); });
        f[1].addEventListener('input', markSwap);
        f[1].addEventListener('keydown', function (event) {
            if (event.key === 'Enter') runSwap();
            else if (event.key === 'Escape') closeSwap();
            // Typing in the fields must not reach the grid's shortcuts.
            event.stopPropagation();
        });
    });
    el.swapWhere.addEventListener('change', markSwap);
    el.swapGo.addEventListener('click', runSwap);
    el.swapCancel.addEventListener('click', closeSwap);
    el.undo.addEventListener('click', undoDelete);

    el.scope.addEventListener('click', function (event) {
        var button = event.target.closest ? event.target.closest('[data-scope]') : null;
        var scope = button ? button.getAttribute('data-scope') : null;
        if (scope) setScope(scope);
    });

    el.name.addEventListener('dblclick', function () {
        if (state.selected) startRename(state.selected);
    });

    el.rename.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') endRename(true);
        else if (event.key === 'Escape') endRename(false);
        event.stopPropagation();
    });
    el.rename.addEventListener('blur', function () { endRename(true); });

    el.menu.addEventListener('click', function (event) {
        var action = event.target.getAttribute('data-action');
        if (action) runMenu(action);
    });

    // The browser's own menu offers Back and Reload, which mean nothing here.
    document.addEventListener('contextmenu', function (event) {
        event.preventDefault();
        if (event.target === el.rename) return;
        var id = swatchId(event);
        if (id) select(id);
        openMenu(event.clientX, event.clientY, id);
    });

    document.addEventListener('mousedown', function (event) {
        if (!el.menu.contains(event.target)) closeMenu();
    });
    document.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape') return;
        if (!el.menu.classList.contains('hidden')) closeMenu();
        else if (state.tray) closeTray();
        else if (!el.swap.classList.contains('hidden')) closeSwap();
    });
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);

    el.trayChips.addEventListener('click', function (event) {
        var chip = event.target.closest ? event.target.closest('.tray-chip') : null;
        if (!chip || !state.tray) return;
        var colour = state.tray.colours[Number(chip.getAttribute('data-index'))];
        colour.keep = !colour.keep;
        markTray();
    });
    el.traySave.addEventListener('click', saveTray);
    el.trayCancel.addEventListener('click', closeTray);
    el.picker.addEventListener('change', function () {
        readPicture(el.picker.files && el.picker.files[0]);
    });
    el.asePicker.addEventListener('change', function () {
        readSwatches(el.asePicker.files && el.asePicker.files[0]);
    });

    // Ctrl+V anywhere in the panel but a text box, which takes text.
    document.addEventListener('paste', function (event) {
        if (event.target && event.target.tagName === 'INPUT') return;
        event.preventDefault();
        pasteFrom(event.clipboardData);
    });

    // After Effects keeps Ctrl+V for its own Paste unless the panel asks for
    // it. The call is missing from older versions, where the key reaches
    // the panel anyway.
    try {
        if (window.__adobe_cep__ && window.__adobe_cep__.registerKeyEventsInterest) {
            window.__adobe_cep__.registerKeyEventsInterest(JSON.stringify([
                { keyCode: 86, ctrlKey: true },
                { keyCode: 86, metaKey: true }
            ]));
        }
    } catch (e) {}

    /*
     * A picture or an .ase file dragged in from Explorer. Every drag is
     * caught, even one that is not a file: left to itself the panel would
     * open a dropped file or link as a page, and lose itself until reopened.
     */
    var dragDepth = 0;
    function carriesFiles(event) {
        var types = event.dataTransfer ? event.dataTransfer.types : null;
        return !!types && Array.prototype.indexOf.call(types, 'Files') !== -1;
    }
    document.addEventListener('dragenter', function (event) {
        event.preventDefault();
        if (!carriesFiles(event)) return;
        dragDepth++;
        el.app.classList.add('is-dropping');
    });
    document.addEventListener('dragover', function (event) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = carriesFiles(event) ? 'copy' : 'none';
    });
    document.addEventListener('dragleave', function (event) {
        if (!carriesFiles(event)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) el.app.classList.remove('is-dropping');
    });
    document.addEventListener('drop', function (event) {
        event.preventDefault();
        dragDepth = 0;
        el.app.classList.remove('is-dropping');
        var files = event.dataTransfer ? event.dataTransfer.files : null;
        if (!files || !files.length) return;
        if (ASE_FILE.test(files[0].name)) readSwatches(files[0]);
        else readPicture(files[0]);
    });

    window.addEventListener('focus', refresh);
    document.documentElement.addEventListener('mouseenter', refresh);

    /* ------------------------------------------------------------ start */

    applyTheme();
    csInterface.addEventListener(CSInterface.THEME_COLOR_CHANGED_EVENT, applyTheme);

    try {
        if (localStorage.getItem(SCOPE_KEY) === 'project') state.scope = 'project';
    } catch (e) {}

    // Drawn straight away from what is known, then again once After Effects
    // has said where the project is.
    load();
    refresh();
})();
