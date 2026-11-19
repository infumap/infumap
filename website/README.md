# Infumap website

A self-contained static site. Open `index.html` in a browser, or serve this directory with any static web server. No dependencies or build step are required.

To publish, use `website/` as the document root. All local asset URLs are relative, so the site also works under a subpath.

The Spatial panel uses a resized version of `assets/img/page_spatial.png`. The List panel uses a crop of the repository's root `screenshot.png`. Refresh `assets/screenshot.png` when the root screenshot changes. Run these commands from `website/assets` to regenerate the WebP files.

```sh
cd website/assets
ffmpeg -y -i img/page_spatial.png -vf "scale=1600:-1:flags=lanczos" -c:v libwebp -quality 85 img/page_spatial.webp
ffmpeg -y -i screenshot.png -vf "crop=843:1024:370:120" -c:v libwebp -quality 85 img/crop-lists.webp
```

Adjust the List crop rectangle if a new screenshot has a different layout. The other item type and arrangement panels use text descriptions.

Colours, table tints and the font stack in `styles.css` are taken from the web app (`web/src/style.ts`, `web/src/index.css`). The favicon comes from `web/src/assets/favicon.ico`.
