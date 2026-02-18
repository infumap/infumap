# Infumap

Infumap is the platform I built to run my life off.

It’s a giant workspace that provides a powerful set of building blocks that can be pieced together to match a wide variety of needs.

It has an API which allows data to be pulled in from various sources.

It's built to handle a large amount of information (an entire life's worth) securely, and durably.

<kbd>
  <img src="screenshot.png" />
</kbd>

## Development Status

I use Infumap to manage all of my personal information and spend a significant part of almost every day using it. Time I spend developing it is generally directed towards features or bug fixes that I will personally benefit from.

My goals in developing Infumap, in order, are:

1. Make something I want to use.
2. Explore new ideas that I think are valuable.
3. Hopefully end up with something that other people want to use as well.

The first two goals mean that I've often been more inclined to add features than completely polish existing ones. As a result, there are many things that are currently a bit broken or not completely implemented. But nothing you can't work around. Also, I haven't cut corners in places where corners cannot be cut (in particular security) - the current implementation is more than just a demo.

Going forward, I will continue to add features and polish existing ones as this aligns with my own needs. If I start to see other people finding value here (the simplest way you can demonstrate your interest is give the project a github star!), I'll be motivated to give the project a lot more time and prioritize more general purpose goals in addition to my own.


## Running

For detailed information on deploying Infumap, refer to the [docs](/docs). Currently you need to build Infumap from source. Having done this, everything is provided in a self contained executable. To start Infumap, simple run it from the command line:

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
- Consider turning off "Swipe between pages".
