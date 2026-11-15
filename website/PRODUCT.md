# Product

<!-- impeccable:product-schema 1 -->

Scope: this record serves the Infumap website (`website/`). The product facts apply to Infumap as a whole; move this
file to the repository root if the web app (`web/`) later gets design work, rather than keeping two copies.

## Platform

web

## Users

Two audiences, technical first:

- **Primary today:** technically comfortable individuals who are happy to run a local app or self-host. They
  typically arrive from GitHub or a link on a technical forum and are deciding whether Infumap is worth installing
  for their own information.
- **Wider audience the copy speaks to:** anyone who keeps notes, documents, images and links and is frustrated by
  having to pick an organizing system upfront. They are welcome, but the people who actually install it today are
  the technical group, so setup facts must stay accurate rather than be hidden.

The visitor's job on the site: understand what Infumap is, see that it is real, and get it running.

## Product Purpose

Infumap is a durable home for all of a person's information. After adding something, they can be confident it
won't be **lost**, that they will be able to **find** it again, and that nobody else can see it without their
**permission**. It is also a workspace: the author describes it as "how I have long imagined a computer desktop
should work".

Success for the website: a fitting visitor downloads a release (or self-hosts) and understands what they are
getting, including that it is still evolving.

## Positioning

The combination is the claim, with both halves equal:

- **A spatial workspace where structure develops as you work.** Notes, links, ratings, documents and images are all
  items in their own right, arranged on pages, in tables or in loose groups. Add structure only where it helps and
  fall back to search.
- **A durable, self-owned store.** It runs on the user's own computer or server, with their own storage and
  encrypted backups.

Hosted workspace tools can't make the second claim; local-file note tools don't make the first in this form.

## Operating Context

- Runs as a local server and is used in the browser. macOS ships as `Infumap.app` with a menu bar icon; Linux runs
  `./infumap web` and opens `localhost:8000`.
- Can be hosted on the user's own server (Raspberry Pi guides exist, for VPN-only or public access) for remote
  access and sharing.
- Navigation conventions visitors may meet: right-click goes back; Mac trackpad users are advised to turn off Smart
  zoom.

## Capabilities and Constraints

- Release platforms: macOS on Apple Silicon (macOS 11+); Linux on x86-64 and ARM64, including 64-bit Raspberry Pi.
  No Windows build. The site must not imply otherwise.
- Item types include notes, links, ratings, documents (including PDFs), images, tables, pages and groups.
- Search covers titles and content, including text extracted from PDFs and descriptions of images.
- Chats run in the Queries page and are kept as items. A Chrome extension (MVP, not in the Web Store) adds the
  current page as a note.
- Optional S3-compatible backups, encrypted with a user-held key.
- Status: actively developed with rough edges; releases are for everyday use, `master` contains work in progress.
- Free software under the GNU Affero General Public License v3.
- The site is a self-contained static page: plain HTML and CSS, no build step, no external dependencies, relative
  asset URLs so it works under a subpath.
- **Undecided:** whether the website presents the AI-assisted features (chats, image descriptions, PDF extraction).
  The current site does not mention them.

## Brand Commitments

- Name: Infumap. Tagline in use in both README and site: "A durable home for your information."
- Voice: plain, calm and warm; second person on the site. The README is written by a single author in the first
  person. The project is honest about being unfinished.
- Favicon: `web/src/assets/favicon.ico`, copied to `website/assets/favicon.ico`.

## Evidence on Hand

- Product screenshot: repository-root `screenshot.png`, copied to `website/assets/screenshot.png` (3440×1986, the
  Home page with a to-do list, bookmarks, work/life groups, photos, resources, a scratch space and a comparison
  table).
- README copy: the four principles (structure develops as you work; small details have a place; keep the thinking
  with the material; choose the form that fits).
- User docs in `docs/` (usage, configuration, CLI, deployment, development), linked on GitHub.
- **Absent, do not fabricate:** testimonials, user or download counts, press, benchmarks, company or team claims,
  pricing tiers, a hosted or cloud offering, a Windows or iOS/Android build.

## Product Principles

1. Truthful over impressive. State what Infumap does today and that it is still growing; never imply polish,
   scale or platforms that don't exist.
2. Both halves of the claim, every time. The workspace and the durable self-owned store are presented together;
   neither is a footnote to the other.
3. Respect the technical visitor. Installation facts (platforms, commands, self-hosting) are exact and close at
   hand, even while the copy welcomes a wider audience.
4. Show the real thing. The product screenshot and real material carry the argument rather than abstract claims.
