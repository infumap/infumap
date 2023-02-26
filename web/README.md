
```
npm install
```

```
npm start
```

```
build.sh ->

npm run build
python generate_dist_handlers.py
```

vite.config.ts is set up to proxy requests to the backend. So for front end dev, use npm start -> fe hotloading and run the backend.


notes:

This is how to set up tailwind withe solidjs template:
https://blog.logrocket.com/styling-solidjs-applications-using-tailwind-css/

example project with tsx:
https://github.com/MrDesjardins/gym-water-app/blob/main/src/sensors/context/SensorsContext.tsx

https://html2canvas.hertzen.com/

send password in session, rather than as command line arg. still never persisted on server.

TOTP "time based one time passwords"
https://crates.io/crates/totp-rs
Can be used with Authy.

// different lib, instructions on use.
https://pythonhosted.org/otpauth/
beginners guide on OTP. good, tells me what i need to know:
https://medium.com/@nicola88/two-factor-authentication-with-totp-ccc5f828b6df

## Coordinate Systems

Px -> pixels.
Bl -> block.
Co -> page coordinates.
