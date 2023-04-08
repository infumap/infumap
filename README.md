# Infumap

The computer desktop reimagined.

A safe, secure and accessible home for all of your information.

**Status:** Now useful in a very basic way, if you know what you're doing (there is no documentation), and if you avoid the quirks and bugs. No release yet.

## Running

Everything is provided in a self contained executable. To start Infumap, simply download the latest release and run it from the command line:

```
./infumap
```

Then point your web browser at `http://localhost:8000`.

Default configuration and data directories will be created automatically. The default setup is fine for many people, but you
might like to consult [CONFIGURATION.md](CONFIGURATION.md) for the various configuration options.

You can use Infumap locally, or install it on a server on the internet in order to:
- Access your information from anywhere.
- Integrate with other services.
- Share content or reference content authored by others.

## MacOS Settings

Infumap is developed on an Apple Mac, and as such probably works best on this platform (hasn't been tested on others). However,
there are some settings which you should tweak for optional experience:

In System Preferences / Trackpad:

- Turn off "Smart zoom". If enabled, the system needs to wait to know if a two finger tap was a double tap. Since navigation in Infumap makes frequenty use of right clicking (two finger tapping), your experience will be more fluid with this disabled.
- Turn off "Swipe between pages".
