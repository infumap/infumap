# Data Integrations

There are various ways of getting data in and out of Infumap.

## Chrome Extension

Note: This is an MVP. More / better functionality is planned.

The Chrome extension lets you add the current page from the Chrome toolbar. It creates a note item in the top-left of your home level page, with the page title and URL.

This extension is not (yet) available in the Chrome Web Store.

You can install it as follows:
1. Obtain the Infumap source from GitHub.
2. Navigate to "Settings / Extensions" in Chrome.
3. Enable "Developer mode" (top right).
4. Click "Load unpacked" and select the `chrome` folder from the Infumap repo.
5. Open the extension options page and set your Infumap base URL (for example `https://myserver.example/`).
6. In Infumap, while logged in, open `User Settings -> Ingest` and mint a one-time pairing code.
7. In extension options, paste the pairing code (and optional device name), then click "Pair Extension".
8. Pin the extension to the toolbar.

You can disconnect from extension options ("Disconnect") or revoke sessions in `User Settings -> Ingest`.


## iOS

Infumap provides an "add" page (*https://<www.myserver.com>/add*) which allows you to easily add notes or upload images from your iOS device.

For easy access, create an icon on your iOS home page that links to this page. To do that, navigate to the add page in Safari, select the "share" icon then scroll down and select "Add to Home Screen" ([instructions](https://www.youtube.com/watch?v=BOQfN3QA_wU)).


You'll be prompted to log in if you aren't already.

The main Infumap interface is also usable on your iOS device (if a little small).


## Drag / Drop

You can drag and drop images or files from your computer desktop onto an Infumap page. Item type (image or file) will be determined automatically. You can drop more than one file at a time, but it's not recommended to drop too many at once, or drop large files. Instead, consider using the CLI `upload` command.


## CLI

Bulk images or files using the `upload` command.

Add notes using the `note` command.
