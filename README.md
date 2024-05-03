# Infumap

Infumap:

1. Is the perfect place to hoard all of your information safely (you aren't going to loose it) and securely (no one else is going to be able to access it).
2. Provides a powerful set of graphical building blocks for progressively adding structure/organizing/working with this information as the need arises.

It's the computer deskop I always wanted. I built it as a tool to run my life off of, have been doing so for a long time now (this is a re-write/think of the original project I started in 2016), and wouldn't have it any other way. Prioritization of work has been completely driven by what I get the most value out of. This often means being expansionary (continually adding features in a very basic/buggy way) rather than making something polished. I'm getting sick of the rough edges though, and have been polishing it up a bit more recently.


**Status:** Now useful in a very basic way, if you know what you're doing ([docs](/docs) are a work-in-progress), and if you avoid the quirks and bugs. No release yet.

## Running

Everything is provided in a self contained executable. To start Infumap, simply download the latest release and run it from the command line:

```
./infumap web
```

Then point your web browser at `http://localhost:8000`.

Default configuration and data directories will be created automatically.

You can use Infumap locally, or install it on a server on the internet in order to:
- Access your information from anywhere.
- Integrate with other services.
- Share content or reference content authored by others.

## MacOS Settings

Infumap is developed on an Apple Mac, and as such probably works best on this platform (hasn't been tested on others). However,
there are some settings which you should tweak for optimal experience:

In System Preferences / Trackpad:

- Turn off "Smart zoom". If enabled, the system needs to wait to know if a two finger tap was a double tap. Since navigation in Infumap makes frequenty use of right clicking (two finger tapping), your experience will be more fluid with this disabled.
- Turn off "Swipe between pages".
