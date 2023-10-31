# Data Integrations

There are various ways of getting data in and out of Infumap.

## Chrome Extension

Note: This is an MVP. More / better functionality is planned.

The Chrome extension allows you to bookmark pages by clicking a button in the Chrome toolbar. Doing so will create a note item in the top left of your home level page. The button will only work if you are logged in.

This extension is not (yet) available in the Chrome Web Store.

You can install it as follows:
1. Obtain the Infumap source from github.
2. Copy the Chrome folder from the git repo somewhere else.
3. Edit the `option.js` and `background.js` files to point to your Infumap instance. By default, they point to the default `localhost:8000` endpoint.
4. Navigate to "Settings / Extensions" in Chrome.
5. Enable "Developer mode" (top right).
6. Click "Load unpacked" and add the extension.
7. Edit the extension details and select "Pin to toolbar"


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