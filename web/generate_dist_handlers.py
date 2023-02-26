# Copyright (C) 2022 The Infumap Authors
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
    else:
        raise Exception("unknown filetype: " + filename)

output = """// Copyright (C) 2022 The Infumap Authors
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

use rocket::http::ContentType;
use rocket::{Build, Rocket};
use rocket::response::content::{RawJavaScript, RawCss, RawHtml};
use super::responders::FileResponse;


#[get("/")] fn index() -> RawHtml<&'static str> { RawHtml(include_str!("../../../web/dist/index.html")) }
"""

def fn_name(filename):
    return filename.replace(".", "_").replace("-", "_")

for f in js_files:
    output += "#[get(\"/" + f + "\")] fn " + fn_name(f) + "() -> RawJavaScript<&'static str> { RawJavaScript(include_str!(\"../../../web/dist/assets/" + f + "\")) }\n"

for f in css_files:
    output += "#[get(\"/" + f + "\")] fn " + fn_name(f) + "() -> RawCss<&'static str> { RawCss(include_str!(\"../../../web/dist/assets/" + f + "\")) }\n"

for f in png_files:
    output += "#[get(\"/" + f + "\")] fn " + fn_name(f) + "() -> FileResponse<&'static [u8]> { FileResponse { mime_type: ContentType::PNG, data: include_bytes!(\"../../../web/dist/assets/" + f + "\") } }\n"

for f in ico_files:
    output += "#[get(\"/" + f + "\")] fn " + fn_name(f) + "() -> FileResponse<&'static [u8]> { FileResponse { mime_type: ContentType::Icon, data: include_bytes!(\"../../../web/dist/assets/" + f + "\") } }\n"

output += """
pub fn mount(build: Rocket<Build>) -> Rocket<Build> {
  build
    .mount("/", routes![index])
"""

for f in js_files:
    output += "    .mount(\"/assets\", routes![" + fn_name(f) + "])\n"

for f in css_files:
    output += "    .mount(\"/assets\", routes![" + fn_name(f) + "])\n"

for f in png_files:
    output += "    .mount(\"/assets\", routes![" + fn_name(f) + "])\n"

for f in ico_files:
    output += "    .mount(\"/assets\", routes![" + fn_name(f) + "])\n"

output += """}
"""

with open("../infumap/src/web/dist_handlers.rs", "w") as rs_file:
    rs_file.write(output)
