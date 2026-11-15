# Infumap

Infumap is a durable home for all of your information. Once you’ve stored something, you can be confident it won’t be lost, that you’ll be able to find it again, and that other people won’t have access to it without your permission.

Infumap is more than a store - it's the how I have long imagined a computer desktop should work.

- **Structure that develops as you work.**
  Start with a few loose notes and documents with little or no organization. Structure is optional; add it only where it helps - you can always fall back to search. Group related items, arrange a page, or organize details into a table as the work takes shape.

- **Small details have a place.**
  A note, a link or a rating are items in their own right, alongside a document or an image. You can keep these small pieces of information where they belong without having to create a separate file for each one.

- **Keep the thinking with the material.**
  The documents are only part of the work. There are also questions, comparisons, decisions and things you want to remember. Infumap gives those a place alongside the material they refer to, so you can return to both what you collected and what you made of it.

- **Choose the form that fits.**
  Different information calls for different arrangements. You might use a table to compare places to stay, arrange documents and notes together on a page, or leave a few items loosely grouped until you know what to do with them.

- **Organizing without deciding everything upfront.**
  You don’t need to decide how everything should be organized before you start. Add a document, jot down a thought or rate an option, then arrange and connect those pieces as your understanding develops. The structure can grow with the work.

<kbd>
  <img src="screenshot.png" />
</kbd>

## Get started

[Download the latest release](https://github.com/infumap/infumap/releases/latest) for your platform:

- **macOS (Apple Silicon, macOS 11 or later):** Unzip the download, move `Infumap.app` to Applications, and open it. Use the Infumap menu bar icon to open Infumap in your browser.
- **Linux (Intel/AMD x86-64 or ARM64, including 64-bit Raspberry Pi):** Extract the download, open a terminal in the extracted directory, and run:

  ```sh
  ./infumap web
  ```

  Then open [localhost:8000](http://localhost:8000) in your browser.

Configuration and data directories are created automatically. You can run Infumap on your own computer or host it on a server for remote access and sharing.

**Navigation:** Right-click to go back. On a Mac trackpad, use a two-finger tap and turn off **Smart zoom** for more responsive navigation. See [macOS trackpad settings](docs/macos.md#trackpad-settings).

## Documentation

- [Using and running Infumap](docs/readme.md)
- [Configuration](docs/configuration.md) and [server deployment](docs/deployment/raspberry-pi.md)
- [Building from source and development](docs/developer.md)

## Feedback

Infumap is actively developed, and some rough edges remain. [Bug reports and suggestions](https://github.com/infumap/infumap/issues) are welcome. For everyday use, choose a release; `master` includes work in progress.

Infumap is free software under the [GNU Affero General Public License v3](LICENSE.txt).
