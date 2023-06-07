// Copyright (C) The Infumap Authors
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

use clap::{App, ArgMatches};

use crate::util::{infu::InfuResult, crypto::generate_key};


pub fn make_clap_subcommand<'a, 'b>() -> App<'a> {
  App::new("keygen")
    .about("Create a new hex encoded 32 byte key suitable for use as a backup_encryption_key.")
}

pub fn execute<'a>(_sub_matches: &ArgMatches) -> InfuResult<()> {
  println!("{}", generate_key());
  Ok(())
}
