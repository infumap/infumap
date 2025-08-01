# Copyright (C) The Infumap Authors
# This file is part of Infumap.
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

import os
import datetime

directory = "./dist/assets"

js_files = []
css_files = []
ico_files = []
png_files = []

for filename in os.listdir(directory):
    if not os.path.isfile(os.path.join(directory, filename)):
        continue
    if filename.endswith(".css"):
        css_files.append(filename)
    elif filename.endswith(".js"):
        js_files.append(filename)
    elif filename.endswith(".png"):
        png_files.append(filename)
    elif filename.endswith(".ico"):
        ico_files.append(filename)
    elif filename.endswith(".map"):
        # Skip source map files
        continue
    else:
        raise Exception("unknown filetype: " + filename)

output = """// Copyright (C) The Infumap Authors
// This file is part of Infumap.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

// this file was auto-generated on """ + datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S") + """ - do not modify.

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use hyper::{Request, Response, Method};
use super::serve::full_body;

pub fn serve_dist_routes(req: &Request<hyper::body::Incoming>) -> Option<Response<BoxBody<Bytes, hyper::Error>>> {
  match (req.method(), req.uri().path()) {
    (&Method::GET, "/") => Some(Response::builder().header(hyper::header::CACHE_CONTROL, "no-cache").header(hyper::header::CONTENT_TYPE, "text/html").body(full_body(include_str!("../../dist/index.html"))).unwrap()),
    (&Method::GET, "/login") => Some(Response::builder().header(hyper::header::CACHE_CONTROL, "no-cache").header(hyper::header::CONTENT_TYPE, "text/html").body(full_body(include_str!("../../dist/index.html"))).unwrap()),
    (&Method::GET, "/setup") => Some(Response::builder().header(hyper::header::CACHE_CONTROL, "no-cache").header(hyper::header::CONTENT_TYPE, "text/html").body(full_body(include_str!("../../dist/index.html"))).unwrap()),
    (&Method::GET, "/signup") => Some(Response::builder().header(hyper::header::CACHE_CONTROL, "no-cache").header(hyper::header::CONTENT_TYPE, "text/html").body(full_body(include_str!("../../dist/index.html"))).unwrap()),
    (&Method::GET, "/add") => Some(Response::builder().header(hyper::header::CACHE_CONTROL, "no-cache").header(hyper::header::CONTENT_TYPE, "text/html").body(full_body(include_str!("../../dist/add.html"))).unwrap()),
"""

for f in js_files:
    output += "    (&Method::GET, \"/assets/" + f + "\") => Some(Response::builder().header(hyper::header::CACHE_CONTROL, \"max-age=31536000\").header(hyper::header::CONTENT_TYPE, \"text/javascript\").body(full_body(include_str!(\"../../dist/assets/" + f + "\"))).unwrap()),\n"

for f in css_files:
    output += "    (&Method::GET, \"/assets/" + f + "\") => Some(Response::builder().header(hyper::header::CACHE_CONTROL, \"max-age=31536000\").header(hyper::header::CONTENT_TYPE, \"text/css\").body(full_body(include_str!(\"../../dist/assets/" + f + "\"))).unwrap()),\n"

for f in png_files:
    output += "    (&Method::GET, \"/assets/" + f + "\") => Some(Response::builder().header(hyper::header::CACHE_CONTROL, \"max-age=31536000\").header(hyper::header::CONTENT_TYPE, \"image/png\").body(full_body(include_bytes!(\"../../dist/assets/" + f + "\").as_slice())).unwrap()),\n"

for f in ico_files:
    output += "    (&Method::GET, \"/assets/" + f + "\") => Some(Response::builder().header(hyper::header::CACHE_CONTROL, \"max-age=31536000\").header(hyper::header::CONTENT_TYPE, \"image/ico\").body(full_body(include_bytes!(\"../../dist/assets/" + f + "\").as_slice())).unwrap()),\n"

output += """    _ => None
  }
}

pub fn serve_index() -> Response<BoxBody<Bytes, hyper::Error>> {
  Response::builder().header(hyper::header::CACHE_CONTROL, "no-cache").header(hyper::header::CONTENT_TYPE, "text/html").body(full_body(include_str!("../../dist/index.html"))).unwrap()
}
"""

with open("../infumap/src/web/dist_handlers.rs", "w") as rs_file:
    rs_file.write(output)
