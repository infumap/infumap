# Infumap website

A self-contained static site. Open `index.html` in a browser, or serve this directory with any static web server. No dependencies or build step are required.

To publish, use `website/` as the document root. All local asset URLs are relative, so the site also works under a subpath.

The product screenshot is copied from the repository's root `screenshot.png`. Refresh `assets/screenshot.png` when that image changes, then regenerate the sizes and crops in `assets/img/` that the page uses:

```sh
cd website/assets
for w in 800 1600 2400; do ffmpeg -y -i screenshot.png -vf scale=$w:-1 -c:v libwebp -quality 82 img/home-$w.webp; done
ffmpeg -y -i screenshot.png -vf "crop=963:637:1273:120" -c:v libwebp -quality 85 img/crop-areas.webp
ffmpeg -y -i screenshot.png -vf "crop=843:1024:370:120" -c:v libwebp -quality 85 img/crop-lists.webp
```

The crop rectangles match the current screenshot's layout; adjust them if the new one is arranged differently. The Tables and Loose groups panels show placeholders until screenshots of those exist.

Colours, table tints and the font stack in `styles.css` are taken from the web app (`web/src/style.ts`, `web/src/index.css`). The favicon comes from `web/src/assets/favicon.ico`.
