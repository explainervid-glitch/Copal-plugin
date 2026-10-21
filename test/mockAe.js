/*
 * A stand-in for the part of the After Effects object model that Copal
 * touches: a shape layer and the property tree under its Contents.
 *
 * It copies the behaviour that is easy to get wrong rather than everything
 * After Effects does:
 *
 *   - Adding, moving or removing a child of a Contents group kills every
 *     reference to the other children of that group. A dead reference throws
 *     on any use, as it does in After Effects, so code that holds on to a
 *     property across one of those calls fails here too.
 *   - The dashes of a stroke all exist from the start and stay hidden until
 *     added. A hidden property reports a value and refuses to be set.
 *   - Miter Limit is hidden unless the join is a miter.
 *   - setValue is refused on a property with keyframes.
 *   - The colours of a gradient cannot be read.
 */

'use strict';

const LAYER = 'ADBE Vector Layer';
const ROOT = 'ADBE Root Vectors Group';
const GROUP = 'ADBE Vector Group';
const CONTENTS = 'ADBE Vectors Group';
const FILL = 'ADBE Vector Graphic - Fill';
const STROKE = 'ADBE Vector Graphic - Stroke';
const GFILL = 'ADBE Vector Graphic - G-Fill';
const GSTROKE = 'ADBE Vector Graphic - G-Stroke';
const RECT = 'ADBE Vector Shape - Rect';
const ELLIPSE = 'ADBE Vector Shape - Ellipse';
const DASHES = 'ADBE Vector Stroke Dashes';

/* Every node is handed out behind this, so a dead one can refuse all use.
 * Names starting with an underscore are the mock's own and stay reachable.
 * Getters and methods run against the node itself, not the wrapper, so that
 * a node can find itself in its parent's list of children. */
const guard = {
    get(target, key) {
        if (target._dead && typeof key === 'string' && key[0] !== '_') {
            throw new Error('Object is invalid (stale reference to ' + target.matchName + ')');
        }
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, key, value) {
        if (target._dead && typeof key === 'string' && key[0] !== '_') {
            throw new Error('Object is invalid (stale reference to ' + target.matchName + ')');
        }
        return Reflect.set(target, key, value, target);
    }
};

let serial = 0;

class Node {
    constructor(matchName, name) {
        this._serial = ++serial;
        this.matchName = matchName;
        this.name = name || matchName;
        this.enabled = true;
        this.selected = false;
        this._parent = null;
        this._dead = false;
        this._proxy = new Proxy(this, guard);
    }

    get propertyDepth() {
        let depth = 0;
        for (let p = this._parent; p; p = p._parent) depth++;
        return depth;
    }

    get parentProperty() { return this._parent ? this._parent._proxy : null; }
    get _raw() { return this; }
    get propertyIndex() { return this._parent._children.indexOf(this) + 1; }

    moveTo(index) {
        const siblings = this._parent._children;
        if (!this._parent._indexed) throw new Error('moveTo is only valid inside an indexed group');
        if (index < 1 || index > siblings.length) throw new Error('moveTo index out of range');
        siblings.splice(siblings.indexOf(this), 1);
        siblings.splice(index - 1, 0, this);
        this._parent._invalidate(null);
    }

    remove() {
        const siblings = this._parent._children;
        siblings.splice(siblings.indexOf(this), 1);
        this._parent._invalidate(null);
        this._dead = true;
    }
}

class Prop extends Node {
    constructor(matchName, value, options) {
        super(matchName);
        this._value = value;
        this._hidden = !!(options && options.hidden);
        this._hiddenWhen = options && options.hiddenWhen;
        this._unreadable = !!(options && options.unreadable);
        this.numKeys = 0;
        this._keyed = [];
        this._setCount = 0;
    }

    get hidden() { return this._hiddenWhen ? this._hiddenWhen(this) : this._hidden; }
    get canSetExpression() { return !this.hidden; }

    get value() {
        if (this._unreadable) throw new Error('This property has no value a script can read');
        return this._value;
    }

    setValue(value) {
        this._verify();
        if (this.hidden) throw new Error('Can not "set value" with this property, because the property or a parent property is hidden');
        if (this.numKeys > 0) throw new Error('Can not setValue on a property with keyframes');
        this._value = value;
        this._setCount++;
    }

    /*
     * The fault found in After Effects itself: the colour of a solid paint
     * cannot be set once that paint sits above an older gradient of its own
     * kind, which only a move can bring about.
     */
    _verify() {
        const paint = this._parent;
        const rival = { [FILL]: GFILL, [STROKE]: GSTROKE }[paint && paint.matchName];
        if (!rival || !/ Color$/.test(this.matchName) || !paint._parent) return;
        const siblings = paint._parent._children;
        const mine = siblings.indexOf(paint);
        if (siblings.some((c, i) => i > mine && c.matchName === rival && c._serial < paint._serial)) {
            throw new Error('After Effects error: internal verification failure, sorry! {stream at index matchName="' + rival +
                '" (mismatch with resultP, expected "' + paint.matchName + '")}');
        }
    }

    setValueAtTime(time, value) {
        this._verify();
        if (this.hidden) throw new Error('The property is hidden');
        this._keyed.push({ time: time, value: value });
        this._value = value;
    }
}

class Group extends Node {
    constructor(matchName, name, indexed) {
        super(matchName, name);
        this._children = [];
        this._indexed = !!indexed;
    }

    get numProperties() { return this._children.length; }

    property(key) {
        const child = typeof key === 'number'
            ? this._children[key - 1]
            : this._children.find(c => c.matchName === key || c.name === key);
        return child ? child._proxy : null;
    }

    _add(...children) {
        for (const child of children) {
            child._parent = this;
            this._children.push(child);
        }
        return this;
    }

    /* Replaces every child but keep with a fresh copy and kills the old one.
     * This is what makes a held reference go stale. */
    _invalidate(keep) {
        this._children = this._children.map(child => {
            if (child === keep) return child;
            const copy = Object.assign(Object.create(Object.getPrototypeOf(child)), child);
            copy._dead = false;
            copy._proxy = new Proxy(copy, guard);
            if (copy._children) copy._children.forEach(c => { c._parent = copy; });
            child._dead = true;
            return copy;
        });
    }

    canAddProperty(matchName) {
        return this._indexed && Object.prototype.hasOwnProperty.call(MAKERS, matchName);
    }

    addProperty(matchName) {
        if (!this.canAddProperty(matchName)) throw new Error('Can not add ' + matchName + ' here');
        const child = MAKERS[matchName]();
        this._add(child);
        this._invalidate(child);
        return child._proxy;
    }
}

/*
 * The six dashes and gaps, and the dash offset, are always children. Adding
 * one only reveals it.
 *
 * canAddProperty answers true whether or not the dash is showing, as it does
 * in After Effects, where it took a run of the real thing to find out. Code
 * that trusts it to mean "not added yet" reads every stroke as solid.
 */
class Dashes extends Group {
    canAddProperty(matchName) {
        return this._children.some(c => c.matchName === matchName);
    }

    addProperty(matchName) {
        const child = this._children.find(c => c.matchName === matchName);
        if (!child) throw new Error('Can not add ' + matchName);
        child._hidden = false;
        return child._proxy;
    }
}

class Dash extends Prop {
    remove() {
        if (this._hidden) throw new Error('This dash has not been added');
        this._hidden = true;
        this._value = this.matchName === 'ADBE Vector Stroke Offset' ? 0 : 10;
    }
}

class Layer extends Group {
    constructor(name, matchName) {
        super(matchName || LAYER, name || 'Shape Layer 1');
        this._root = new Group(ROOT, 'Contents', true);
        this._add(this._root, new Group('ADBE Transform Group', 'Transform')
            ._add(new Prop('ADBE Position', [0, 0])));
        this._box = { left: -150, top: -30, width: 300, height: 60 };
        this._comp = null;
        this._presets = [];
    }

    get selectedProperties() {
        const out = [];
        (function walk(node) {
            if (node.selected && node._parent) out.push(node._proxy);
            if (node._children) node._children.forEach(walk);
        })(this);
        return out;
    }

    /* The box round the layer's shapes. After Effects reports an empty one
     * for a layer with no paint switched on. */
    sourceRectAtTime() {
        return this._box;
    }

    /* Group Shapes: the children of Contents at these positions become one
     * new group, which sits where the first of them was. */
    _groupShapes(indices) {
        const root = this._root;
        const sorted = indices.slice().sort((a, b) => a - b);
        const picked = sorted.map(i => root._children[i - 1]);
        const wrapper = group('Group ' + root._children.length);
        const contents = wrapper._children[0];
        root._children.splice(sorted[0] - 1, 0, wrapper);
        wrapper._parent = root;
        root._children = root._children.filter(c => !picked.includes(c));
        picked.forEach(c => { c._parent = contents; contents._children.push(c); });
        root._invalidate(null);
    }

    /* Ungroup Shapes: a group gives way to what it held. */
    _ungroup(node) {
        const parent = node._parent;
        const held = node._children[0]._children;
        parent._children.splice(parent._children.indexOf(node), 1, ...held);
        held.forEach(c => { c._parent = parent; });
        node._dead = true;
        parent._invalidate(null);
    }

    /* The node at a path of steps, as the code under test writes them. */
    _at(path) {
        let node = this;
        for (const step of path) {
            node = typeof step === 'number' ? node._children[step - 1] : node._children.find(c => c.matchName === step);
        }
        return node;
    }

    /*
     * Stands in for an animation preset that carries gradient colours, and
     * keeps the three habits of the real call that a caller has to work
     * round: it acts on the selected layers and not on the one it is called
     * on, it does nothing while a property is selected, and what it adds
     * arrives at the bottom of Contents with a default name.
     */
    applyPreset(file) {
        const selected = this._comp ? this._comp._layers.filter(l => l.selected) : (this.selected ? [this] : []);
        if (!selected.length) throw new Error('applyPreset with no layer selected would make a new solid');
        for (const layer of selected) {
            layer._presets.push(file.fsName);
            if (layer.selectedProperties.length) continue;
            const made = layer._root._proxy.addProperty(/stroke/.test(file.fsName) ? GSTROKE : GFILL);
            made.property('ADBE Vector Grad Colors')._fromPreset = file.fsName;
        }
    }
}

/* A composition, as far as selection goes. */
class Comp {
    constructor(layers, time) {
        this._layers = layers;
        this.time = time || 0;
        layers.forEach(l => { l._comp = this; });
    }

    get selectedLayers() { return this._layers.filter(l => l.selected).map(l => l._proxy); }
}

/* ------------------------------------------------------------ builders */

function fill(color, opacity) {
    return new Group(FILL, 'Fill 1')._add(
        new Prop('ADBE Vector Blend Mode', 1),
        new Prop('ADBE Vector Composite Order', 1),
        new Prop('ADBE Vector Fill Rule', 1),
        new Prop('ADBE Vector Fill Color', (color || [1, 0, 0]).concat([1])),
        new Prop('ADBE Vector Fill Opacity', opacity === undefined ? 100 : opacity));
}

/* What a solid stroke and a gradient stroke have in common. */
function strokeParts(width) {
    const join = new Prop('ADBE Vector Stroke Line Join', 1);
    const dashes = new Dashes(DASHES, 'Dashes');
    ['Dash 1', 'Gap 1', 'Dash 2', 'Gap 2', 'Dash 3', 'Gap 3', 'Offset'].forEach(name => {
        dashes._add(new Dash('ADBE Vector Stroke ' + name, name === 'Offset' ? 0 : 10, { hidden: true }));
    });
    return [
        new Prop('ADBE Vector Stroke Width', width === undefined ? 2 : width),
        new Prop('ADBE Vector Stroke Line Cap', 1),
        join,
        new Prop('ADBE Vector Stroke Miter Limit', 4, { hiddenWhen: () => join._value !== 1 }),
        dashes,
        new Group('ADBE Vector Stroke Taper', 'Taper')._add(
            new Prop('ADBE Vector Taper Start Length', 0),
            new Prop('ADBE Vector Taper End Length', 0)),
        new Group('ADBE Vector Stroke Wave', 'Wave')._add(
            new Prop('ADBE Vector Taper Wave Amount', 0))
    ];
}

function stroke(color, width) {
    return new Group(STROKE, 'Stroke 1')._add(
        new Prop('ADBE Vector Blend Mode', 1),
        new Prop('ADBE Vector Composite Order', 1),
        new Prop('ADBE Vector Stroke Color', (color || [1, 1, 1]).concat([1])),
        new Prop('ADBE Vector Stroke Opacity', 100),
        ...strokeParts(width));
}

function gradientParts() {
    const type = new Prop('ADBE Vector Grad Type', 1);
    return [
        type,
        new Prop('ADBE Vector Grad Start Pt', [0, 0]),
        new Prop('ADBE Vector Grad End Pt', [100, 0]),
        new Prop('ADBE Vector Grad HiLite Length', 0, { hiddenWhen: () => type._value !== 2 }),
        new Prop('ADBE Vector Grad HiLite Angle', 0, { hiddenWhen: () => type._value !== 2 }),
        new Prop('ADBE Vector Grad Colors', null, { unreadable: true })
    ];
}

function gradientFill() {
    return new Group(GFILL, 'Gradient Fill 1')._add(
        new Prop('ADBE Vector Blend Mode', 1),
        new Prop('ADBE Vector Composite Order', 1),
        new Prop('ADBE Vector Fill Rule', 1),
        ...gradientParts(),
        new Prop('ADBE Vector Fill Opacity', 100));
}

function gradientStroke(width) {
    return new Group(GSTROKE, 'Gradient Stroke 1')._add(
        new Prop('ADBE Vector Blend Mode', 1),
        new Prop('ADBE Vector Composite Order', 1),
        ...gradientParts(),
        new Prop('ADBE Vector Stroke Opacity', 100),
        ...strokeParts(width));
}

function rect() { return new Group(RECT, 'Rectangle Path 1'); }
function ellipse() { return new Group(ELLIPSE, 'Ellipse Path 1'); }

function group(name, ...children) {
    const contents = new Group(CONTENTS, 'Contents', true)._add(...children);
    return new Group(GROUP, name)._add(contents,
        new Group('ADBE Vector Transform Group', 'Transform')
            ._add(new Prop('ADBE Vector Position', [0, 0])));
}

function layer(...children) {
    const made = new Layer();
    made._root._add(...children);
    return made;
}

const MAKERS = {};
MAKERS[FILL] = () => fill();
MAKERS[STROKE] = () => stroke();
MAKERS[GFILL] = gradientFill;
MAKERS[GSTROKE] = gradientStroke;
MAKERS[GROUP] = () => group('Group 1');
MAKERS[RECT] = rect;
MAKERS[ELLIPSE] = ellipse;

/* ------------------------------------------------------------- reading */

/* Always walks from the top, so it never trips over a reference the code
 * under test has made stale. */
function contentsOf(node) {
    if (node instanceof Layer) return node._root;
    return node._children.find(c => c.matchName === CONTENTS);
}

function child(node, ...steps) {
    let at = node;
    for (const step of steps) {
        const holder = at._indexed ? at : (contentsOf(at) || at);
        at = typeof step === 'number'
            ? holder._children[step - 1]
            : holder._children.find(c => c.matchName === step || c.name === step);
        if (!at) throw new Error('Nothing at ' + steps.join(' > '));
    }
    return at;
}

function valueOf(node, matchName) {
    return node._children.find(c => c.matchName === matchName)._value;
}

/* A container's children as short words, in order: "rect stroke fill". A
 * switched-off child is in brackets. */
function order(node) {
    const short = {
        [FILL]: 'fill', [STROKE]: 'stroke', [GFILL]: 'gfill', [GSTROKE]: 'gstroke',
        [RECT]: 'rect', [ELLIPSE]: 'ellipse', [GROUP]: 'group'
    };
    return (node._indexed ? node : contentsOf(node))._children
        .map(c => c.enabled ? short[c.matchName] : '(' + short[c.matchName] + ')')
        .join(' ');
}

function liveDashes(strokeNode) {
    return strokeNode._children.find(c => c.matchName === DASHES)._children
        .filter(c => c instanceof Dash && !c._hidden && c.matchName !== 'ADBE Vector Stroke Offset')
        .map(c => c._value);
}

module.exports = {
    Layer, Prop, Group, Comp,
    layer, group, rect, ellipse, fill, stroke, gradientFill, gradientStroke,
    child, valueOf, order, liveDashes,
    names: { LAYER, ROOT, GROUP, CONTENTS, FILL, STROKE, GFILL, GSTROKE, DASHES }
};
