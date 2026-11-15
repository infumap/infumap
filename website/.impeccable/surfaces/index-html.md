---
version: 1
slug: "index-html"
primary_target: "index.html"
related_targets: []
---

# Surface: Infumap website landing page (index.html)

Mode: Persuade. Build path: code-led (no image generation available).

## Strategy
- Audience: technical individuals first (GitHub/HN), copy readable by a wider audience.
- Job: understand what Infumap is, see the real product, download a release.
- Belief to earn: Infumap is both a workspace where structure grows as you work and a durable store you run yourself. Neither half is a footnote.
- Proof: the real product screenshot and crops of it; exact platform and install facts; the AGPL licence. No testimonials, counts or invented claims.
- Constraints: plain HTML/CSS, no build step, no external requests, relative URLs. macOS Apple Silicon and Linux only. AI features not mentioned (undecided in PRODUCT.md).
- Placeholders: further product screenshots (a table, a page arrangement, a list) are marked placeholders until the user supplies them.

## Direction contract
THESIS: The page is an Infumap page. Its first screen is an Infumap table whose two column groups, Workspace and Store, carry the two halves of the claim row by row (Add, Arrange, Find, Keep, Share), so the positioning is equal by construction. Refuses the split hero (copy left, product image right) and the row of feature cards.
OWN-WORLD: The product's own UI: white ground, page title bar with slate-blue (#395176) title text, 1px #a6a6a6 item outlines with resize-corner marks, table header tinted 12% and lines 35% of the page colour, the seven page colours (blue, red, orange, yellow, green, purple, grey) as solid tiles with white bold labels, selection #d4d9e1, the system UI sans the app uses, monospace only for commands. Authored SVG icons in one stroke.
STORY: The visitor reads the headline, sees both halves laid side by side, sees the real Home page, opens the forms (table, page, list, group) like opening pages in Infumap, then downloads knowing it is still growing.
FIRST VIEWPORT: Title bar across the top (IM mark, "Infumap" title, Docs/GitHub/Download controls in toolbar style). Below it a full-width note block: headline "A durable home for your information." with the lost/find/permission line and the two download actions (macOS, Linux) plus a one-line status note. The Workspace | Store table starts inside the first viewport at 1440x900, its header row and first rows visible.
FORM: Infumap table page as the landing page (position 5 on the ranked list; dealt lead). seed:8364fa90b832b2c4. Raises: from Du Bois data portraits and Studio Dumbar, colour committed at region scale (the forms section is a field of solid page-colour tiles, not accents). Signature interaction: tiles open their page in place, as pages open in Infumap.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
