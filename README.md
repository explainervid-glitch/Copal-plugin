# Copal

An After Effects panel that saves the fill and stroke of a shape layer as a
palette, and puts a saved palette onto any other shape layer with a double
click. Solid colours and gradients both work.

It also replaces one colour with another across shapes, text, solids and
effects, takes palettes from a picture, an `.ase` swatch file, a Coolors
link or a list of hex codes, and exports palettes as `.ase` swatches for
Illustrator, Photoshop and InDesign.

## Install

**From the package:** unzip `copal-<version>.zip`, run `install.bat`,
restart After Effects, then open **Window > Extensions > Copal**.

**For development:** `npm run link`, restart After Effects once. After that,
closing and reopening the panel picks up any change to the files.

Requires After Effects 2019 or later. The installer and the scripts under
`tools/` are for Windows.

## Using it

- **Save.** Select a shape layer, or a group, fill or stroke inside its
  Contents, and press the **eyedropper** at the right of the top bar.
  The palette appears in the panel, named for
  its colour.
- **Apply.** Select one or more shape layers, or parts of their Contents, and
  double click a palette. The whole change is one undo step.
- **From a picture.** Drag an image onto the panel, or paste one. See
  [Colours from a picture](#colours-from-a-picture).
- **Replace a colour.** Press the two-arrow icon. See
  [Replacing a colour](#replacing-a-colour).
- **Swatches in and out.** Import an `.ase` file, paste a Coolors link or
  hex codes, or export the palettes as an `.ase` file. See
  [Swatches](#swatches).
- **Right click** a palette to rename it, replace it with the current
  selection, or delete it. Delete can be undone from the footer for a few
  seconds.
- **Keyboard**, with a palette selected: Enter applies, F2 renames, Delete
  removes, the arrow keys move. Escape closes the menu, the tray or the
  replace strip.

### The right-click menu

| Item | Does |
|---|---|
| Apply | Applies the palette clicked on |
| Replace with selection | Overwrites the palette with the paint of the selected shape layer |
| Rename | Renames the palette (also F2, or double click its name in the footer) |
| Delete | Deletes the palette; Undo in the footer brings it back for a few seconds |
| Colours from a picture… | Picks a picture file and takes its main colours |
| Paste picture or colours | Reads the clipboard: a picture first, then a Coolors link or hex codes |
| Import swatches (.ase)… | Picks an `.ase` file and takes its colours |
| Export swatches (.ase)… | Saves the palettes shown as an `.ase` file |
| Show palette file | Opens the folder holding the palette file in Explorer |

The first four only show when the menu is opened on a palette.

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

## Colours from a picture

Drag an image from Explorer onto the panel, press Ctrl+V with a screenshot,
a copied image or a copied image file on the clipboard, or right click and
choose **Colours from a picture** or **Paste picture or colours**. PNG,
JPEG, GIF, WebP, BMP and SVG all work.

The picture's main colours, up to eight, appear in a tray above the
palettes, commonest first. Hover a colour to see its hex code and its share
of the picture. Click a colour to leave it out, then press the **tick**:
each colour kept becomes a fill palette named after the file ("sunset 1",
"sunset 2"...). A pasted screenshot's palettes are named "Pasted". A second
drop of the same picture numbers on from the first ("sunset 3"...).

These palettes have no stroke, so applying one recolours fills and leaves
strokes as they are.

How the colours are found: the picture is drawn small and its pixels are
grouped by how alike they look. Two groups that look alike become one. A
thin line of in-between pixels round a shape is the soft edge between two
colours and is dropped. Pixels that are mostly see-through count as
background. A picture that is see-through all over has no colours to keep.

## Replacing a colour

Press the two-arrow icon. A strip opens above the palettes:

1. Type the colour to find in **From** and the colour to put in its place in
   **To**, as hex codes (`#066CE7`, `066ce7` or `#0af`). Or click a palette
   for each: a click fills the field marked with a brighter border, and the
   next click fills the other one. When the strip opens with a palette
   selected and **From** empty, that palette's colour goes in **From**.

   Or double click **From** or **To** to open Copal's colour picker over
   the panel: a square of saturation and brightness, a hue bar, and
   **Cancel** and **OK**. Drag in the square or the bar; the dot in the
   square is filled with the colour **OK** will give. The arrow keys move
   the dot or the hue by one step, ten with Shift. **OK** or Enter puts the
   colour in the field as a hex code; **Cancel**, Escape or a click outside
   leaves the field as it was. To type a colour, type it in the field
   itself. In a short panel the square gets smaller.

   The picker is drawn by the panel itself on purpose. Opening After
   Effects' own picker from a script can take After Effects down.

   Or take either colour straight from the comp: select a layer and press
   the **eyedropper** at the end of **From** or **To**. A layer with several
   colours gives its first; press the eyedropper again for the next, round
   and round. The
   footer says which one it is ("colour 2 of 4"). Each field counts on its
   own, so **From** can stay on one colour while **To** goes through the
   rest. Select one layer for **From** and another for **To** to swap a
   colour for one used elsewhere. The colours come in the
   order a replace meets them: shape fills and strokes in stacking order,
   then text, the solid, and effect colours. Each colour comes once, even
   across several selected layers. To narrow the choice, select a group,
   fill or stroke inside a shape layer's Contents, or a colour setting such
   as an effect's colour, in the timeline. Gradients have no colour a
   script can read and are passed over. Colours are read at the current
   time.
2. Choose where: **This comp** (the default), **Selected layers** or
   **Whole project**.
3. Press the **tick**, which sits in the middle of the top bar while the
   strip is open, or Enter in either field.

While the strip is open, clicking a palette only picks its colour; double
clicking does not apply it to the layers. Escape or the cross beside the
tick closes the
strip.

### What changes

The whole replace is one undo step. Keyframes are included: every keyframe
that holds the colour changes, and the others are left as they are.

| Layer | What is looked at |
|---|---|
| Shape layer | Every solid fill and stroke, inside every group, switched on or off |
| Text layer | The fill and stroke of the text, and the fill and stroke colours of its animators |
| Solid layer | The colour of the solid itself |
| Any layer | Every colour setting of every effect on it: Fill, Tint, Tritone, Stroke, Drop Shadow, Gradient Ramp and the rest |

Nothing is added, moved or removed; only colour values change. A paint that
is switched off changes too, so it matches the rest when it is switched back
on.

### Matching

Colours are compared in steps of 1 in 255, the steps a hex code counts in.
A colour one step off in any channel matches too, so `#066CE6` and
`#076CE7` are taken for `#066CE7`. That covers the rounding After Effects
does when it stores a colour. The **tick** stays disabled until both
fields hold a colour and the two differ.

### What is left alone

The message after a replace says how many colours changed in how many
layers (and comps, for the whole project), and counts what was left alone:

- **Gradients.** No script can read or set a gradient's colours.
- **Colours set by an expression.** The expression would go on overriding
  whatever was set underneath, so the colour is counted and left.
- **Locked layers.** After Effects refuses to change them. Unlock them first.
- **Changes After Effects refused.**

These are passed over without a count:

- **Effect settings After Effects keeps hidden**, which some effects do
  until a menu above them calls for them.
- **Null and adjustment layers.** They are solids too, but their colour is
  never seen.

### Solids are shared

A solid's colour belongs to the solid in the Project panel, not to the
layer. Every layer that uses that solid changes with it, even with
**Selected layers** chosen and the other layers not selected.

### Text and After Effects versions

- **After Effects 24.3 and later:** text is looked at one character at a
  time. Only the characters of the colour found change, so a word in
  another colour keeps it.
- **Older versions:** a script can read only the first character's colour,
  and setting a text's colour gives every character that colour. When the
  first character matches, the whole text layer takes the new colour,
  including characters that were a different colour. When it does not, the
  text is left alone even if later characters match.

Text with no fill (or no stroke) is passed over for that paint.

### Not reached yet

- Layers inside a precomp, when **This comp** is chosen. Choose **Whole
  project** to reach them, or open the precomp.
- Layer styles (Drop Shadow, Stroke and the rest under Layer Styles).
- The colour of a light.
- Colours set inside a gradient.

## Swatches

### Swatches in

Three ways in. The colours all wait in the same tray as a picture's, where
a click leaves one out and the **tick** saves the rest, each as a fill
palette.

- **An `.ase` file** from Illustrator, Photoshop, InDesign or a colour site:
  right click and choose **Import swatches (.ase)**, or drag the file onto
  the panel.
- **A Coolors link**, copied, then Ctrl+V in the panel or **Paste picture
  or colours** in the menu. Any of these forms works, also inside a longer
  piece of text:
  - `https://coolors.co/264653-2a9d8f-e9c46a`
  - `https://coolors.co/palette/264653-2a9d8f-e9c46a`
- **Hex codes**, copied the same way:
  - Text that is nothing but hex codes, with or without `#`, separated by
    spaces, commas, semicolons, dashes or new lines: `264653, 2a9d8f`,
    `264653-2a9d8f`, `#264653 #2a9d8f`.
  - Otherwise every code marked with a `#` in the text:
    `Brand is #066CE7, accent #04489A.`
  - Three-digit codes (`#0af`) only count with the `#`, so short words made
    of the letters a to f are not taken for colours.

A colour given twice comes in once.

**Names.** A swatch from an `.ase` file keeps its own name, with extra
spaces taken out. Colours with no name are numbered after the file ("Brand
kit 1"), "Coolors" or "Pasted", on from the highest number already used.

**Colour models.** `.ase` files can hold RGB, CMYK, Lab and grey swatches;
all come in as RGB. CMYK is converted the plain way, with no colour
profile, so print colours come in close but not exact. Lab is read with
the D50 white point Adobe uses. A swatch in any other model is left out,
and the message says how many were. Groups inside the file are flattened.

A file that is not an `.ase` file, or one that stops short, is refused with
a message, and nothing is saved.

Ctrl+V tries a picture first and then text. In the menu, **Paste picture or
colours** reads the clipboard through the browser where it can and, where
it cannot (older versions of After Effects), through PowerShell, which hands
back a copied file, a copied image or copied text.

### Swatches out

Right click and choose **Export swatches (.ase)**. The system's save dialog
asks where, offering `Copal All projects.ase` or `Copal <project
folder>.ase` beside the palette file. Load the file from the Swatches panel
of Illustrator, Photoshop or InDesign.

- The palettes shown are exported, from **This project** or **All
  projects**, whichever is chosen.
- Everything goes in one swatch group named like the file.
- Each fill becomes a swatch named after its palette, and each stroke one
  named after the palette and "stroke" ("Brand stroke"). A palette with
  only a stroke gives one swatch under its own name.
- A gradient gives one swatch per colour stop, numbered ("Sunset 1",
  "Sunset 2").
- Swatches are RGB and of the normal kind (not global or spot).
- Opacity, widths, dashes and the other settings have no place in an `.ase`
  file and are left out.
- Colours past 0 to 1, as a 32-bit project can hold, are clamped.

An `.ase` file exported by Copal imports back with the same names and
colours.

## Usage reporting

Copal counts how often it is used, for the team's zeploy dashboard. Each of
these is counted once it succeeds, and as an error when it fails in the
panel or in After Effects:

| Event | Counted when |
|---|---|
| `save` | A palette is saved from the selection |
| `replace` | A palette is replaced from the selection (right-click menu) |
| `apply` | A palette is applied, with how long it took |
| `picture` | Palettes are saved from a picture |
| `import` | Palettes are saved from an `.ase` file, a Coolors link or hex codes |
| `recolor` | A colour is replaced across layers, with how long it took |
| `export` | Palettes are exported as an `.ase` file |

Every use appends one line to
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
An unsaved project has no folder yet, so **This project** waits until the
project is saved.

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
it as it is. Palettes taken from a picture, an `.ase` file or pasted
colours have no `stroke`. A gradient adds a `gradient` object to the paint,
holding its type, its start and end as fractions of the shape's box, and
its colour and alpha stops.

### Safe to share

A project folder is often on a shared drive, so the file is never held in
memory and written back later. Every change reads the file again first,
alters what it finds, and writes the result, so somebody else's new
palettes are not overwritten by a stale copy.

Each save is written to a temporary file of its own beside the real one
(`copal.json.<random>.tmp`) and then renamed over it. A crash halfway
leaves the old file whole, and two people saving at the same moment never
write into the same temporary file. If Windows refuses the rename, for
example while a sync tool holds the file, the temporary file is removed and
the panel says the save failed.

A file the panel cannot read is never overwritten. The panel says so and waits
for it to be fixed or deleted.

### Coming from Colosave

Copal was called Colosave before. Its palettes lived in
`%APPDATA%\Colosave\colosave.json` and in `colosave.json` beside projects.
Copal does not read those. To keep them, copy the user file to
`%APPDATA%\Copal\copal.json`, and rename each project file to
`copal.json`. The `"format"` line inside may stay `"colosave"`; Copal reads
the palettes either way and writes `"copal"` on the next change.

## The panel

The panel takes its greys and its typeface from After Effects. Its buttons
are icons in one thin row; hover one to see what it does, and hover the
project switch to see where its palette file is. Docked as a thin strip
beside the timeline, the icons wrap and the swatches run down in one or two
columns.

| Icon | Does |
|---|---|
| Page / stack | Switches between **This project** and **All projects** |
| Two arrows | Opens the replace strip |
| Picture | Picks a picture to take colours from |
| Eyedropper | Saves the paint of the selected shape layer as a palette |
| Tick and cross (middle, while replacing) | Replace, and close the replace strip |

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
Effects property tree (`test/mockAe.js`): shape layers, text layers with
per-character colours, solids, effects and keyframes. It cannot check After
Effects itself. For that, run `test/ae-smoke.jsx` from **File > Scripts >
Run Script File** in a scratch project. It builds a few shape layers in a
temporary composition, saves and applies between them, removes the
composition and reports what passed.

The ExtendScript files (`jsx/`) run in the engine inside After Effects,
which is ECMAScript 3: no `let`, `const`, arrow functions, `forEach` and
the like. A test fails if one slips in.

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
  js/swatches.js              .ase export and import, Coolors links, hex codes
  js/colorpicker.js           the colour picker the replace fields open
  js/zeploy-usage.js          zeploy's usage helper (unchanged copy)
  jsx/host.jsx                entry points After Effects runs
  jsx/lib/CopalCore.jsx       reads and writes shape layer paint, replaces colours
  jsx/lib/CopalSampler.jsx    reads a gradient's colours by sampling
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

## Changes

### 0.6.0

- The replace strip's tick and cross sit in the middle of the top bar.
- Every **+** icon is now an eyedropper: Save, and the From and To
  fields.
- **This comp** is where a replace looks unless changed.
- The replace strip's **To** field has an eyedropper too, to take the new
  colour from the selected layer.
- Double clicking **From** or **To** opens a colour picker drawn in the
  panel: a saturation and brightness square, a hue bar, Cancel and OK.

### 0.5.0

- An eyedropper in the replace strip's **From** field takes the colour to find
  from the selected layer, and gives its next colour on each further press.

### 0.4.0

- Replace a colour now reaches text (fill, stroke and animators), solid
  layers and the colour settings of effects, on layers of any kind.
- Swatches in: `.ase` files (RGB, CMYK, Lab, grey), Coolors links and hex
  codes, by menu, drop or Ctrl+V.
- Swatches out: palettes export as an `.ase` file.
- **Paste picture** in the menu is now **Paste picture or colours**.

### 0.3.0

- Replace one solid colour with another across shape layers, in the
  selection, the comp or the whole project, as one undo step.
- Double clicking a palette while the replace strip is open no longer fills
  both fields with the same colour, or applies the palette.
- Colour replace is counted in usage reporting as `recolor`.
- Each save writes its own temporary file, so two people saving to one
  shared folder at once no longer collide.
