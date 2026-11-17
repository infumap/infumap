# Infumap website

A self-contained static site. Open `index.html` in a browser, or serve this directory with any static web server. No dependencies or build step are required.

To publish, use `website/` as the document root. All local asset URLs are relative, so the site also works under a subpath.

The Spatial and List page arrangement panels use crops of the repository's root `screenshot.png`. Refresh `assets/screenshot.png` when that image changes, then regenerate the crops in `assets/img/`:

```sh
cd website/assets
ffmpeg -y -i screenshot.png -vf "crop=963:637:1273:120" -c:v libwebp -quality 85 img/crop-areas.webp
ffmpeg -y -i screenshot.png -vf "crop=843:1024:370:120" -c:v libwebp -quality 85 img/crop-lists.webp
```

The crop rectangles match the current screenshot's layout; adjust them if the new one is arranged differently. The other item type and arrangement panels use text descriptions.

Colours, table tints and the font stack in `styles.css` are taken from the web app (`web/src/style.ts`, `web/src/index.css`). The favicon comes from `web/src/assets/favicon.ico`.
