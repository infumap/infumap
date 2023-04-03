# Security and Data 

Infumap was designed as a place to store all of your information.

You can run Infumap on your local machine, but it's much more useful if you host it remotely to allow access to your information from anywhere, integrate with services such as email and your phone, and to enable automatic replication so you can be confident a system failure won't result in loss of data.

One motivation for development of Infumap was the potential for innovation in terms of user experience.

However, this is our third development priority - the first two are:

1. Do everything possible to ensure information isn't lost.
1. Do everything possible to ensure information is secure. 

We are not security experts, but we have thought a lot about it. If you notice anything we can be doing better, please let us know!

## Security through obscurity

### Infumap Isn't Widely Used

If you host a popular open source application such as WordPress, you need to worry that people gone looking for vulnerabilities, have found them, and have created bot nets trawling the web looking for instances to take advantage of.

Because Infumap isn't widely used, this isn't going to be a problem (yet!?).


### Non obvious URL

Don't host your Infumap instance somewhere obvious. A suitable base URL might be something like: mypersonaldomain.com/obscurename.

## Password

Choose a strong password.

(TODO) suggestions on how.

## Login Throttling

(WIP) It is enforced that only one login attempt per username is allowed at a time, and attempts are throttled.

## TOTP

Supported by Infumap, strongly suggested.

Enter your password anywhere, don't need to worry about security cameras so much.

## HTTPS

(TODO) Instructions on Custom certificate.

(TODO) Encrypt password with TOTP, in case bad actors (governments?!) are able to snoop on HTTPS. Doesn't protect everything, but your password is the key to everything.

## Key loggers.

Use little snitch.
Virus Checker.

(TODO) use mouse click to enter password.

## Rust

Infumap is written in Rust.  Lessens risk of memory safety vulnerabilities, language encourages good error handling, considerations of all cases.

## Reverse-proxy setup

- Use a different HTTP stack.
- Use a different server for the proxy and Infumap server, and do not h
- Caddy written in go, not C (which is more prone to memory safety vulnerabilities).

## Encrypted object store

Implemented.


## SSH keys.

- Don't run anything else on the cloud VM running Infumap.
- Use an encrypted volume.

