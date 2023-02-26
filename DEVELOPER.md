# Building

Execute the build script in the repo root:

```
./build.sh
```

This will create the various client side artifacts as well as Rust code for route handlers to serve them (using the `web/generate_dist_handlers.py` script) before building the server. You need to do this at least once in order to successfully build the server.

You will find the self contained `infumap` executable here: `./infumap/target/release/infumap`

# Iterative Development

From the repo `infumap` directory:

```
cargo run
```

This will start a server listening on port `8000` that handles API requests and serves embedded resources from the previous build.


From the repo `web` directory:

```
npm run start
```

This will start a vite development server listening on port `3000`, serving the current state of `web`, with hot reload. Requests to the API (but not requests for client resources) will be forwarded to port `8000`.
