---
name: Infumap website
description: The product's own UI worn as a website, so the page a visitor reads is the kind of page they will make.
colors:
  page-blue: "#395176"
  page-red: "#76393a"
  page-orange: "#764f39"
  page-yellow: "#767139"
  page-green: "#3b7639"
  page-purple: "#6f3976"
  page-grey: "#767676"
  page-blue-deep: "#2e4262"
  ground: "#ffffff"
  chrome: "#f3f5f8"
  ink: "#1d2128"
  text: "#333333"
  muted: "#586070"
  item-border: "#a6a6a6"
  item-line: "#c9d5e2"
  chrome-line: "#e1e3e1"
  table-head: "#e7eaef"
  table-line: "#bac2cf"
  row-hover: "#f5f7fa"
  selected: "#d4d9e1"
  hover: "#e8e8e8"
  focus: "rgb(0 82 255 / 0.9)"
  tile-frame: "#2c3442"
  command-text: "#e8ecf2"
  command-prompt: "#9aa6b8"
  copy-ground: "#2a303a"
  copy-border: "#4a5363"
typography:
  display:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Oxygen, Ubuntu, Cantarell, Fira Sans, Droid Sans, Helvetica, Arial, sans-serif"
    fontSize: "clamp(38px, 6.6vw, 88px)"
    fontWeight: 700
    lineHeight: 1.02
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Oxygen, Ubuntu, Cantarell, Fira Sans, Droid Sans, Helvetica, Arial, sans-serif"
    fontSize: "clamp(28px, 3.2vw, 38px)"
    fontWeight: 700
    lineHeight: 1.12
    letterSpacing: "-0.02em"
  tile-label:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Oxygen, Ubuntu, Cantarell, Fira Sans, Droid Sans, Helvetica, Arial, sans-serif"
    fontSize: "clamp(18px, 2vw, 26px)"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.01em"
  brand:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Oxygen, Ubuntu, Cantarell, Fira Sans, Droid Sans, Helvetica, Arial, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    letterSpacing: "-0.01em"
  title:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Oxygen, Ubuntu, Cantarell, Fira Sans, Droid Sans, Helvetica, Arial, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    letterSpacing: "-0.005em"
  lede:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Oxygen, Ubuntu, Cantarell, Fira Sans, Droid Sans, Helvetica, Arial, sans-serif"
    fontSize: "clamp(18px, 1.6vw, 21px)"
    fontWeight: 400
    lineHeight: 1.5
  body:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Oxygen, Ubuntu, Cantarell, Fira Sans, Droid Sans, Helvetica, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Oxygen, Ubuntu, Cantarell, Fira Sans, Droid Sans, Helvetica, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 600
  mono:
    fontFamily: "ui-monospace, SF Mono, Menlo, Monaco, Consolas, Liberation Mono, monospace"
    fontSize: "15px"
    fontWeight: 400
rounded:
  item: "2px"
  code: "3px"
  control: "4px"
  mark: "50%"
spacing:
  hairline: "1px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  gutter: "clamp(16px, 4vw, 48px)"
  section: "clamp(64px, 9vw, 112px)"
  max-width: "1280px"
components:
  titlebar:
    backgroundColor: "{colors.chrome}"
    textColor: "{colors.page-blue}"
    typography: "{typography.brand}"
    height: "56px"
    padding: "8px {spacing.gutter}"
  tool:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    height: "34px"
    padding: "0 12px"
  tool-hover:
    backgroundColor: "{colors.hover}"
  tool-primary:
    backgroundColor: "{colors.page-blue}"
    textColor: "{colors.ground}"
    rounded: "{rounded.control}"
    height: "34px"
    padding: "0 12px"
  tool-primary-hover:
    backgroundColor: "{colors.page-blue-deep}"
  button-primary:
    backgroundColor: "{colors.page-blue}"
    textColor: "{colors.ground}"
    rounded: "{rounded.control}"
    height: "48px"
    padding: "8px 18px 8px 14px"
  button-primary-hover:
    backgroundColor: "{colors.page-blue-deep}"
  item:
    backgroundColor: "{colors.ground}"
    rounded: "{rounded.item}"
  item-titlebar:
    backgroundColor: "{colors.chrome}"
    textColor: "{colors.page-blue}"
    typography: "{typography.title}"
    padding: "10px 16px"
  table-head-cell:
    backgroundColor: "{colors.table-head}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    padding: "8px 16px"
  table-row-head:
    textColor: "{colors.page-blue}"
    typography: "{typography.label}"
    padding: "14px 16px"
  table-cell:
    textColor: "{colors.text}"
    typography: "{typography.body}"
    padding: "14px 16px"
  table-row-hover:
    backgroundColor: "{colors.row-hover}"
  page-tile-blue:
    backgroundColor: "{colors.page-blue}"
    textColor: "{colors.ground}"
    typography: "{typography.tile-label}"
    padding: "16px"
  page-tile-green:
    backgroundColor: "{colors.page-green}"
    textColor: "{colors.ground}"
    typography: "{typography.tile-label}"
    padding: "16px"
  page-tile-yellow:
    backgroundColor: "{colors.page-yellow}"
    textColor: "{colors.ground}"
    typography: "{typography.tile-label}"
    padding: "16px"
  page-tile-purple:
    backgroundColor: "{colors.page-purple}"
    textColor: "{colors.ground}"
    typography: "{typography.tile-label}"
    padding: "16px"
  command:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.command-text}"
    typography: "{typography.mono}"
    rounded: "{rounded.control}"
    padding: "6px 6px 6px 14px"
  copy-button:
    backgroundColor: "{colors.copy-ground}"
    textColor: "{colors.command-text}"
    rounded: "{rounded.code}"
    height: "36px"
    padding: "0 12px"
  inline-code:
    backgroundColor: "{colors.table-head}"
    textColor: "{colors.ink}"
    typography: "{typography.mono}"
    rounded: "{rounded.code}"
    padding: "0.05em 0.35em"
  placeholder:
    backgroundColor: "{colors.chrome}"
    textColor: "{colors.muted}"
    rounded: "{rounded.item}"
    padding: "24px"
---

# Design System: Infumap website

## Overview

**Creative North Star: "The Page Is an Infumap Page"**

The website does not have a marketing look of its own. It wears the product's UI: white ground, a pale blue-grey title bar, items drawn as thin grey outlines with a soft shadow and a resize mark in the lower right corner, tables with page-tinted headings, and the seven page colours. A visitor who downloads Infumap should recognise what they just read. Every surface on the site is one of the things you can make in Infumap: the hero is a note, the comparison is a table page, the screenshot is an embedded page, the forms are page tiles that open in place, and the download steps are two items side by side.

Density is that of a working tool, not a brochure. Type is the system UI sans the app uses, set large and tight only for the hero headline and section heads. Colour is either quiet (slate blue for titles and actions) or committed at region scale (solid page-colour tiles). There is no middle register of decorative accent.

The tokens mirror the web app. Page colours come from the `Colors` array in `web/src/style.ts`; table heading and line tints follow `tableHeaderBackgroundColor` and `tablePageLineColor` there (12% and 35% of the page colour over white); item border, item line, chrome line, control text, hover, selection and focus come from `web/src/index.css`, as does the sans stack. When the app changes one of these, change `website/styles.css` with it.

**Key Characteristics:**
- Product UI as the visual language; no separate brand layer.
- Every block is an item: 1px grey outline, 2px corners, soft shadow, resize mark.
- Slate blue (page blue) carries titles, row heads, links and primary actions.
- Page colours appear as solid fills at region scale, with white bold labels.
- One authored motion: a page opening from its tile.

## Colors

A white tool surface with a single slate-blue voice, and six more page colours held in reserve for full-strength fills.

### Primary
- **Page Blue** (`page-blue`): the app's default page colour. Page and table titles, row heads in the table, link colour, list markers, header icons, and the fill of every primary action. Hover deepens to **Page Blue Deep** (`page-blue-deep`), a site-only value.

### Secondary
- **Page Colours** (`page-red`, `page-orange`, `page-yellow`, `page-green`, `page-purple`, `page-grey`): the rest of the app's palette, all at the same muted depth. Used solid behind white labels on page tiles, and as 9% / 35% tints for the title bar and its rule of an opened page of that colour. Yellow's 9% tint also backs the status banner. Red, orange and grey are part of the token set but no current surface uses them.

### Neutral
- **Ground** (`ground`): page and item background.
- **Chrome** (`chrome`): title bars (site and item), footer, and placeholder fill; the app's faint blue tint.
- **Ink** (`ink`): headlines, table heading text, the brand mark, and the command block's ground.
- **Text** (`text`): body copy; the app's control text.
- **Muted** (`muted`): secondary lines, captions, tips, status notes, cell labels.
- **Item Border** (`item-border`): the 1px outline of every item and control, and the resize mark.
- **Item Line** (`item-line`): rules under the site title bar and over the footer; inline code border.
- **Chrome Line** (`chrome-line`): light dividers inside items (table row rules, tips, screenshot caption rule).
- **Table Head / Table Line** (`table-head`, `table-line`): page blue at 12% and 35%; table heading fill and the lines around headings and between columns.
- **Selected** (`selected`): text selection, as in the app.
- **Hover** (`hover`): hover fill for neutral toolbar controls.
- **Focus** (`focus`): the app's focus blue, used as a 2px outline at 2px offset.

### Named Rules
**The Mirror Rule.** A colour that exists in the web app is copied from it, not tuned for the site. Site-only values (page-blue-deep, row-hover, the command block greys) are limited to states and the dark command surface the app has no equivalent for.

**The Region Scale Rule.** Page colours other than blue are never used as small accents (text, icons, borders on white). They appear as solid fills large enough to read as a page, or as the light title-bar tint of a page of that colour.

## Typography

**Display Font:** system UI sans (ui-sans-serif, -apple-system, Segoe UI, Roboto, ...), the app's own stack
**Body Font:** the same stack
**Label/Mono Font:** ui-monospace stack, only for commands and inline code

**Character:** One family throughout, because the app uses one. Hierarchy comes from size, weight and tight negative tracking on the large roles, never from a second face.

### Hierarchy
- **Display** (700, clamp 38 to 88px, 1.02): the hero headline only. Balanced wrapping.
- **Headline** (700, clamp 28 to 38px, 1.12): section heads ("Choose the form that fits.", Download).
- **Tile Label** (700, clamp 18 to 26px, 1.15): white labels on page tiles.
- **Brand** (600, 24px; 20px under 720px; 18px in the footer): the "Infumap" page title in the title bar.
- **Title** (600, 20px; 22px for an opened panel): item title bars, in page blue or the page's darkened colour.
- **Lede** (400, clamp 18 to 21px, 1.5, max 62ch): the hero paragraph. Section intros use 18px at 60ch; panel copy 17px at 46ch.
- **Body** (400, 16px, 1.55): table cells, steps, banners.
- **Label** (600, 15px): table column heads and row heads. Captions, tips and footer text are 14 to 15px at 400 in muted.
- **Mono** (400, 15px in commands, 0.92em inline): shell commands and file names.

### Named Rules
**The One Family Rule.** The app's system sans is the display face as well as the body face. This is the world's native type, not a fallback; do not introduce a webfont for headlines.

**The Commands Only Rule.** Monospace marks something you type. It is not used for labels, numbers or decoration.

## Layout

A single centred column, max 1280px plus a fluid gutter (clamp 16 to 48px). The title bar is sticky, full width, min 56px tall (52px under 720px); anchor targets clear it with a 72px scroll padding.

The page is a vertical sequence of full-width items: hero note, table page, embedded screenshot, a field of page tiles with one opened panel beneath, then two download items. Item-to-item spacing is fluid: 20 to 32px between the hero and the table, 48 to 88px before the screenshot, 64 to 112px before each major section. Inside items the rhythm is 16px horizontal padding on title bars and cells, 10px vertical on title bars, 14px on table cells.

The hero is a two-column grid: headline across the top, lede left, download actions bottom-right aligned to the lede's last line; the note icon sits in a wide left inset (52 to 96px).

Responsive rules:
- **Under 900px:** the hero, opened panels and download items each collapse to one column.
- **Under 720px:** the table stacks; each row becomes a block, the column head is hidden and each cell gets a small muted label naming its column. Tiles become a 2 by 2 grid. Hero buttons go full width; the note icon moves into flow. The screenshot swaps to a cropped mobile image.
- **Under 380px:** neutral toolbar controls are hidden; only Download remains.
- Targets in lists and the footer keep a 44px minimum height.

## Elevation & Depth

Depth is the app's: items float a little off a white ground. One ambient shadow is shared by every item and the tile field; nothing stacks deeper. Title bars and table headings separate by tint and a 1px rule, not by shadow.

### Shadow Vocabulary
- **Item** (`box-shadow: 0 2px 6px rgb(40 48 60 / 0.10), 0 10px 24px -12px rgb(40 48 60 / 0.22)`): every item at rest, and the tile field.
- **Primary press** (`box-shadow: 0 3px 8px -2px rgb(30 34 40 / 0.28)`): primary button on hover only.
- **Selected tile** (`box-shadow: inset 0 -5px 0 rgb(255 255 255 / 0.85)`): a white bar along the foot of the tile whose page is open.

### Named Rules
**The One Lift Rule.** Every item sits at the same height. Do not raise a block to make it more important; make it bigger or put it first.

## Shapes

Nearly square. Items and the tile field have 2px corners, controls and banners 4px, inline code and the copy button 3px. The only round shape is the brand mark, a 30px circle outlined in ink around "IM". Borders are 1px hairlines everywhere except the placeholder's 1.5px dashed outline.

The resize mark is the recurring signature: a 9px right-triangle in item-border grey, inset 2px into the lower right corner of every item (10px, white at 55%, on tiles). It is drawn as a 135-degree hard-stop gradient.

Icons are authored inline SVG on a 16px grid, a single 1.5 to 1.7 stroke in currentColor, round joins: note, page, disk, download, external, copy.

## Components

### Title Bar
The app's page chrome. Chrome fill, item-line rule below, sticky. Left: brand mark and "Infumap" in page blue at brand size. Right: toolbar of controls.

### Buttons and Toolbar Controls
- **Shape:** gently squared (4px).
- **Toolbar control:** 34px tall, 12px side padding, 14px text, ground fill with item-border outline; hover fills with the app's hover grey (120ms).
- **Toolbar primary:** page blue fill and border, white text; hover to page-blue-deep.
- **Primary button:** 48px min height, 600 weight 16px label with an 18px icon on the left and an optional second line (13px, 400, 85% opacity) for platform detail. Page blue fill; hover deepens and adds the primary press shadow. Focus outline offset grows to 3px.
- A neutral (outlined) large button exists in the stylesheet but no surface uses it; it is not part of the system yet.

### Item
The base container. Ground fill, 1px item-border outline, 2px corners, item shadow, resize mark. Used for the hero note, the table page, the screenshot, opened panels and download platforms.

### Item Title Bar
Chrome fill, 1px table-line rule below, 10px by 16px padding. Title in page blue at title size; an optional muted 15px subtitle sits on the same baseline and wraps beneath. For an opened page of another colour the fill becomes that colour at 9% over white, the rule that colour at 35%, and the title that colour darkened 15% toward black (needed for yellow to clear 4.5:1).

### Table Page
Fixed layout, collapsed borders. Heading row in table-head with a table-line rule; column heads in ink at label size with a page-blue icon. A 120px empty corner cell. Row heads in page blue at label weight; cells in body text. Columns are divided by table-line, rows by chrome-line. Rows tint to row-hover on hover (120ms). Under 720px it stacks as described in Layout.

### Page Tiles and Opened Panel
The signature. A single framed field (1px tile-frame outline, 2px corners, item shadow) of equal tiles, four across (2 by 2 on phones), divided by 1px black-at-35% lines. Each tile is a solid page colour with a centred white tile label and a white resize mark. Hover brightens the fill 12%; the open tile carries the selected-tile bar; keyboard focus is a white 3px outline inset 6px over a focus-blue ring.

Beneath, the opened page is an item with a page-tinted title bar and a 5:7 two-column body (copy left, image or placeholder right; one column under 900px). Images sit in a chrome-line hairline frame, contained, top-left aligned, max 460px tall. Without script, all panels show in sequence and tiles are inert labels.

### Command Block
A dark strip in ink with command-text, a muted-grey "$" prompt that cannot be selected, the command in 15px mono, and a copy button at the right: 36px, copy-ground fill, copy-border outline, 3px corners, copy icon plus label; hover lightens slightly; focus outline switches to a light blue for contrast on the dark ground.

### Placeholder
A stand-in for a missing screenshot: chrome fill, 1.5px dashed item-border outline, 2px corners, min 280px tall, centred two-line text (first line ink 600, second muted). Exposed as an image with a descriptive label.

### Status Banner
A single-line notice: yellow page colour at 9% fill with a 35% border, 4px corners, ink text, max 860px.

### Motion
One authored moment: when a tile opens its page, the panel scales from 0.97 and unclips from the top (clip inset from 60% to 0) while fading in, over 380ms on `cubic-bezier(0.16, 1, 0.3, 1)`, with its transform origin set at the horizontal centre of the tile that opened it. Everything else is a 120 to 160ms colour or filter transition on hover. Reduced motion removes the panel animation, smooth scrolling and all transitions.

## Do's and Don'ts

### Do:
- **Do** build every new block as an item: 1px item-border outline, 2px corners, the item shadow, the resize mark.
- **Do** take colour, tint and font values from `web/src/style.ts` and `web/src/index.css`, and keep the site in step when they change.
- **Do** derive tints from a page colour the way the app does: 9% for an opened page's title bar, 12% for table headings, 35% for lines.
- **Do** use page colours as solid fills with white bold labels when a colour carries meaning.
- **Do** keep monospace for commands and file names only.
- **Do** keep the panel-open animation the only entrance motion on the page.

### Don't:
- **Don't** add a marketing layer on top of the product UI: no gradients, glass, hero illustrations or a separate brand palette.
- **Don't** use red, orange, yellow, green or purple as text, icon or border accents on white; they belong at region scale.
- **Don't** raise one block above another with a heavier shadow.
- **Don't** introduce a second typeface or a webfont for display.
- **Don't** animate content in on scroll; nothing but an opening page moves.
