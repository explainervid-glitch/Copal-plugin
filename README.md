# Copal

An After Effects panel that saves the fill and stroke of a shape layer as a
palette, and puts a saved palette onto any other shape layer with a double
click. Solid colours and gradients both work.

## Install

**From the package:** unzip `copal-<version>.zip`, run `install.bat`,
restart After Effects, then open **Window > Extensions > Copal**.

**For development:** `npm run link`, restart After Effects once. After that,
closing and reopening the panel picks up any change to the files.

Requires After Effects 2019 or later. The installer and the scripts under
`tools/` are for Windows.

## Using it

- **Save.** Select a shape layer, or a group, fill or stroke inside its
  Contents, and press **+**. The palette appears in the panel, named for
  its colour.
- **Apply.** Select one or more shape layers, or parts of their Contents, and
  double click a palette. The whole change is one undo step.
- **From a picture.** Drag an image from Explorer onto the panel, press
  Ctrl+V with a screenshot, a copied image or a copied image file on the
  clipboard, or right click and choose **Colours from a picture** or
  **Paste picture**. A pasted screenshot's palettes are named "Pasted". Its main colours, up to eight,
  appear in a tray above the palettes. Click a colour to leave it out, then
  press the **tick**: each colour kept becomes a fill palette named after the
  file ("sunset 1", "sunset 2"...). These palettes recolour fills and leave
  strokes as they are. PNG, JPEG, GIF, WebP, BMP and SVG all work.
- **Right click** a palette to rename it, replace it with the current
  selection, or delete it. Delete can be undone from the footer for a few
  seconds.
- **Keyboard**, with a palette selected: Enter applies, F2 renames, Delete
  removes, the arrow keys move.

### What a palette holds

| | |
|---|---|
| Fill | colour or gradient, opacity, fill rule, blend mode, composite order |
| Stroke | colour or gradient, opacity, width, line cap, line join, miter limit, blend mode, composite order, dashes and offset, taper, wave |

A missing fill or stroke is part of the palette. A palette saved from a shape
with no stroke switches the stroke off wherever it is applied, so the target
ends up looking like the source.

### What applying does

| Selected | Solid palette | Palette with a gradient |
|---|---|---|
| A layer | Every fill and stroke in its Contents is repainted | Paints the whole layer from the top level of Contents |
| A group at the top level | That group and the groups inside it | That group alone, wrapped in a new group with the gradient |
| A group inside another group | That group | Refused |
| A fill | That fill only | Gradient fill only, stroke left alone |
| A stroke | That stroke only | Refused for a gradient stroke |

Where a path has no fill or stroke and the palette has one, it is added. A
paint the palette leaves out is switched off, not deleted, so applying another
palette brings it back. An animated property gets a keyframe at the current
time.

### Gradients

After Effects lets a script neither read nor set a gradient's colours, so
gradients take a longer route.

- **Saving** renders the gradient in a temporary composition and reads the
  pixels. The saved gradient looks the same but is rebuilt: off-centre
  midpoints come back as extra stops.
- **Applying** writes a small animation preset to the temporary folder and
  applies it. A preset can only add a gradient at the top level of Contents.
- **On a whole layer**, the fills and strokes inside its groups are switched
  off and "Copal Fill" and "Copal Stroke" appear at the bottom of
  Contents, painting every shape.
- **On one group**, After Effects' own Group Shapes command wraps that group
  in a new one named after it ("Box 2 gradient"), holding the old group with
  the gradient below it. The old group keeps its place in the stacking and
  everything in it, keyframes included. An expression elsewhere that reaches
  the group by name, such as `content("Box 2")`, has to be pointed at its new
  home.
- The gradient is placed by the box round the shape. One saved running from
  the left edge to the right does the same on a shape of any size.
- Applying a solid palette afterwards removes the Copal gradients, switches
  the paints inside the groups back on, and takes a wrapper apart again.

A gradient made by hand on the target is switched off when a palette is
applied over it, not removed.

## Usage reporting

Copal counts how often it is used, for the team's zeploy dashboard: each
palette saved ("save"), replaced from the selection ("replace"), applied
("apply", with how long it took) and each set of palettes taken from a
picture ("picture"), plus an error when one of those fails in the panel or
in After Effects. Every use appends one line to
`%LOCALAPPDATA%\zeploy\usage\com.copal.panel.jsonl`; the zeploy agent
sends daily totals to the admin app and deletes the file.

- Only the plugin id, version, event name and duration are written: no
  palette, layer, project or user names.
- Nothing is written on a PC without zeploy (no `%LOCALAPPDATA%\zeploy`
  folder), and Copal sends nothing over the network.
- Messages such as "select a shape layer" are not counted, and neither are
  renaming, deleting or opening the panel.

`js/zeploy-usage.js` is zeploy's helper, copied unchanged; the counting is in
`js/main.js` (search for `usage.`). The version it reports is read from
`CSXS/manifest.xml`. The contract is `docs/plugin-usage.md` in the zeploy
repository.

### Installing with zeploy

In the zeploy admin app, **Add package** and choose
`cep\com.copal.panel`. zeploy reads the name and version from the
manifest and installs the panel as `CEP\extensions\com.copal.panel`,
like `install.bat`; a new version is picked up with the refresh button on
its column.

## Where palettes are kept

The switch at the top of the panel chooses between two files with the same
name and format.

| | File | For |
|---|---|---|
| **This project** | `copal.json` beside the `.aep` | A job's own colours, travelling with the project folder |
| **All projects** | `%APPDATA%\Copal\copal.json` | Colours wanted everywhere |

The project file is named for the folder and not for the `.aep`, so Increment
and Save does not leave it behind. Every project saved in that folder shares
it. Right click in the panel and choose **Show palette file** to find it.

The file is JSON, which opens in any editor and can be handed to someone else
as it is.

```json
{
  "format": "copal",
  "version": 1,
  "palettes": [
    {
      "id": "mb2k1x9a4f",
      "name": "Brand",
      "fill": {
        "color": [1, 0.3529, 0.2118],
        "opacity": 100
      },
      "stroke": {
        "color": [0.0471, 0.1608, 0.1804],
        "opacity": 100,
        "width": 4,
        "dashes": [10, 6]
      }
    }
  ]
}
```

Colours are 0 to 1, as After Effects stores them. `dashes` lists dash, gap,
dash, gap in order. `fill` or `stroke` may be `null`, which switches that
paint off where the palette is applied, or left out altogether, which leaves
it as it is. Palettes taken from a picture have no `stroke`. A gradient adds a
`gradient` object to the paint, holding its type, its start and end as
fractions of the shape's box, and its colour and alpha stops.

A file the panel cannot read is never overwritten. The panel says so and waits
for it to be fixed or deleted.

## The panel

The panel takes its greys and its typeface from After Effects. Its buttons
are icons in one thin row; hover one to see what it does, and hover the
project switch to see where its palette file is. Docked as a thin strip
beside the timeline, the icons wrap and the swatches run down in one or two
columns.

## Development

```
npm run link       link the panel into Adobe's extensions folder
npm run unlink     remove the link
npm run preview    the panel in a browser, at http://localhost:4174
npm test           logic tests, no After Effects needed
npm run package    dist/copal-<version>.zip, with an installer
```

`npm run preview` serves the real panel files with stand-ins for After
Effects. http://localhost:4174/sizes shows it at several panel sizes at once.
While the panel is open in After Effects it can be inspected at
http://localhost:8096.

`npm test` runs the ExtendScript files against a stand-in for the After
Effects property tree. It cannot check After Effects itself. For that, run
`test/ae-smoke.jsx` from **File > Scripts > Run Script File** in a scratch
project. It builds a few shape layers in a temporary composition, saves and
applies between them, removes the composition and reports what passed.

The version number lives in `cep/com.copal.panel/CSXS/manifest.xml`, and
the package is named from it (keep `package.json` in step).

### Layout

```
cep/com.copal.panel/
  CSXS/manifest.xml           extension manifest
  index.html, css/            the panel
  js/main.js                  everything on screen
  js/store.js                 reads and writes copal.json
  js/gradient.js              gradient stops, presets and swatches
  js/picture.js               the main colours of a dropped picture
  js/zeploy-usage.js          zeploy's usage helper (unchanged copy)
  jsx/host.jsx                entry points After Effects runs
  jsx/lib/CopalCore.jsx    reads and writes shape layer paint
  jsx/lib/CopalSampler.jsx reads a gradient's colours by sampling
tools/                        link, preview and package scripts
test/                         Node tests and the After Effects smoke test
install.bat, operator.ps1     installer shipped inside the package
```

### Two things After Effects does that the code works round

- A solid fill or stroke moved above an older gradient of its own kind can no
  longer have its colour set; After Effects fails an internal check and shows
  a dialog. New paints are therefore placed below such a gradient, never
  above.
- `applyPreset` takes After Effects down when it runs without its interface,
  so anything that applies a gradient has to be tested with the interface
  showing.
