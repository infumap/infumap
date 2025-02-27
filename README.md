# Infumap

The traditional computer desktop is very transient — launch an app, open a file manager, do some work, then close everything. There is no lasting visual structure. What if your desktop could be more like a giant workspace that persists over time?

I have wondered this for as long as I can remember, and finally built Infumap as a way of exploring the idea. It's still a bit rough around the edges, but it's clear that the concept works - Infumap has become the platform I run my life off of and I wouldn't have it any other way.

The high level concept is not novel, for example [Muse](https://museapp.com/) and [Kosmik](https://www.kosmik.app/) are two relatively recent projects with similar goals. Infumap differs in that it is "less spatial" and (amenable to be) "more computational". Its design aligns much more closely with my own requirements. It is also open source - something I consider table stakes for the system I'm trusting to store all of my personal information.

![alt screenshot](screenshot.png "Screen shot")


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

- Turn off "Smart zoom". If enabled, the system needs to wait to know if a two finger tap was a double tap. Since navigation in Infumap makes frequent use of right clicking (two finger tapping), your experience will be more fluid with this disabled.
- Turn off "Swipe between pages".
