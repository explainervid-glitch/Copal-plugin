/*
 * A colour picker drawn in the panel itself: a square of saturation and
 * brightness, a hue bar beside it, and Cancel and OK. Nothing to type; the
 * field it was opened from already takes a hex code. It opens over the
 * panel and nothing else, so After Effects is never asked to show a dialog
 * of its own.
 *
 * The colour is held as hue, saturation and brightness, so the hue stays
 * where it was put while the colour passes through grey, white or black.
 *
 * The colour arithmetic runs in Node too, for the tests; the part that
 * draws only runs where there is a page.
 */

var CopalColorPicker = (function () {
    'use strict';

    /* ----------------------------------------------------------- colour */

    function clamp(v, low, high) {
        return Math.max(low, Math.min(high, v));
    }

    /* Hue from 0 to 360, saturation and brightness from 0 to 1, to red,
     * green and blue from 0 to 1. */
    function hsbToRgb(h, s, b) {
        var sector = ((h % 360) + 360) % 360 / 60;
        var i = Math.floor(sector);
        var f = sector - i;
        var p = b * (1 - s);
        var q = b * (1 - s * f);
        var t = b * (1 - s * (1 - f));
        return [[b, t, p], [q, b, p], [p, b, t], [p, q, b], [t, p, b], [b, p, q]][i];
    }

    /* Red, green and blue from 0 to 1 to [hue, saturation, brightness]. A
     * grey has no hue of its own; keep, when given, is the one it keeps. */
    function rgbToHsb(rgb, keep) {
        var r = rgb[0], g = rgb[1], b = rgb[2];
        var max = Math.max(r, g, b);
        var min = Math.min(r, g, b);
        var d = max - min;
        var h = keep || 0;
        if (d > 0) {
            if (max === r) h = 60 * (((g - b) / d) % 6);
            else if (max === g) h = 60 * ((b - r) / d + 2);
            else h = 60 * ((r - g) / d + 4);
            if (h < 0) h += 360;
        }
        return [h, max ? d / max : 0, max];
    }

    function toHex(rgb) {
        return rgb.map(function (v) {
            var n = Math.round(clamp(v, 0, 1) * 255);
            return (n < 16 ? '0' : '') + n.toString(16);
        }).join('').toUpperCase();
    }

    /* Six digits, or three, with or without the #; null if not a colour. */
    function fromHex(text) {
        var digits = String(text || '').trim().replace(/^#/, '');
        if (/^[0-9a-f]{3}$/i.test(digits)) digits = digits.replace(/./g, '$&$&');
        if (!/^[0-9a-f]{6}$/i.test(digits)) return null;
        return [0, 2, 4].map(function (at) { return parseInt(digits.substr(at, 2), 16) / 255; });
    }

    var api = { hsbToRgb: hsbToRgb, rgbToHsb: rgbToHsb, toHex: toHex, fromHex: fromHex };
    if (typeof document === 'undefined') return api;

    /* --------------------------------------------------------- the page */

    var el = null;
    var hsb = [0, 0, 1];
    var done = null;
    var returnFocus = null;

    function make(tag, className, parent) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (parent) parent.appendChild(node);
        return node;
    }

    function build() {
        el = {};
        el.backdrop = make('div', 'cp-backdrop hidden', document.body);
        el.dialog = make('div', 'cp', el.backdrop);
        el.dialog.setAttribute('role', 'dialog');
        el.dialog.setAttribute('aria-modal', 'true');
        el.title = make('div', 'cp-title', el.dialog);

        var main = make('div', 'cp-main', el.dialog);
        el.square = make('div', 'cp-square', main);
        el.square.tabIndex = 0;
        el.square.setAttribute('aria-label', 'Saturation and brightness');
        el.dot = make('div', 'cp-dot', el.square);
        el.hue = make('div', 'cp-hue', main);
        el.hue.tabIndex = 0;
        el.hue.setAttribute('aria-label', 'Hue');
        el.hueMark = make('div', 'cp-hue-mark', el.hue);

        var actions = make('div', 'cp-actions', el.dialog);
        el.cancel = make('button', 'cp-button', actions);
        el.cancel.type = 'button';
        el.cancel.textContent = 'Cancel';
        el.ok = make('button', 'cp-button is-primary', actions);
        el.ok.type = 'button';
        el.ok.textContent = 'OK';

        wire();
    }

    function rgb() {
        return hsbToRgb(hsb[0], hsb[1], hsb[2]);
    }

    function css(color) {
        return '#' + toHex(color);
    }

    /* The square, its dot and the hue mark from the colour held. The dot
     * is filled with the colour, so it shows what OK will give. */
    function draw() {
        el.square.style.backgroundColor = css(hsbToRgb(hsb[0], 1, 1));
        el.dot.style.left = (hsb[1] * 100) + '%';
        el.dot.style.top = ((1 - hsb[2]) * 100) + '%';
        el.dot.style.backgroundColor = css(rgb());
        el.hueMark.style.top = ((1 - hsb[0] / 360) * 100) + '%';
    }

    /* A drag on the square or the hue bar, from the press to the release,
     * wherever the pointer goes meanwhile. */
    function dragOn(area, move) {
        area.addEventListener('mousedown', function (event) {
            if (event.button !== 0) return;
            event.preventDefault();
            area.focus();
            var at = function (e) {
                var box = area.getBoundingClientRect();
                move(clamp((e.clientX - box.left) / box.width, 0, 1), clamp((e.clientY - box.top) / box.height, 0, 1));
                draw();
            };
            var up = function () {
                document.removeEventListener('mousemove', at);
                document.removeEventListener('mouseup', up);
            };
            document.addEventListener('mousemove', at);
            document.addEventListener('mouseup', up);
            at(event);
        });
    }

    function wire() {
        dragOn(el.square, function (x, y) { hsb[1] = x; hsb[2] = 1 - y; });
        // Red at both ends, as on After Effects' bar; the top is taken as 0.
        dragOn(el.hue, function (x, y) { hsb[0] = y === 0 ? 0 : (1 - y) * 360; });

        el.square.addEventListener('keydown', function (event) {
            var step = event.shiftKey ? 0.1 : 0.01;
            var moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
            var m = moves[event.key];
            if (!m) return;
            event.preventDefault();
            hsb[1] = clamp(hsb[1] + m[0], 0, 1);
            hsb[2] = clamp(hsb[2] + m[1], 0, 1);
            draw();
        });
        el.hue.addEventListener('keydown', function (event) {
            var step = event.shiftKey ? 10 : 1;
            var d = { ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step }[event.key];
            if (!d) return;
            event.preventDefault();
            hsb[0] = (hsb[0] + d + 360) % 360;
            draw();
        });

        el.ok.addEventListener('click', function () { close(true); });
        el.cancel.addEventListener('click', function () { close(false); });
        el.backdrop.addEventListener('mousedown', function (event) {
            if (event.target === el.backdrop) close(false);
        });

        // Keys stay in here: the panel's own shortcuts must not see them.
        el.dialog.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') { event.preventDefault(); close(false); }
            else if (event.key === 'Enter') { event.preventDefault(); close(true); }
            else if (event.key === 'Tab') keepFocus(event);
            event.stopPropagation();
        });
    }

    /* Tab goes round the picker and never out of it. */
    function keepFocus(event) {
        var stops = [el.square, el.hue, el.cancel, el.ok];
        var at = stops.indexOf(document.activeElement);
        var next = (at + (event.shiftKey ? -1 : 1) + stops.length) % stops.length;
        event.preventDefault();
        stops[next].focus();
    }

    function close(keep) {
        if (!done) return;
        var finish = done;
        done = null;
        el.backdrop.classList.add('hidden');
        if (returnFocus && returnFocus.focus) returnFocus.focus();
        finish(keep ? toHex(rgb()) : null);
    }

    /*
     * Opens the picker on hex (six digits, with or without #; white when it
     * is not a colour). title names what is being chosen. finish is called
     * once, with the six digits chosen on OK, or null on Cancel.
     */
    function open(hex, title, finish) {
        if (!el) build();
        if (done) close(false);
        hsb = rgbToHsb(fromHex(hex) || [1, 1, 1], 0);
        done = finish;
        returnFocus = document.activeElement;
        el.title.textContent = title || 'Colour';
        el.backdrop.classList.remove('hidden');
        draw();
        el.square.focus();
    }

    api.open = open;
    api.isOpen = function () { return !!done; };
    return api;
})();

// Node.js test harness support. The panel loads this file as a plain script.
if (typeof module !== 'undefined' && module.exports) { module.exports = CopalColorPicker; }
