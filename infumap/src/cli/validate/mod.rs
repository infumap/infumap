// Copyright (C) 2023 The Infumap Authors
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

use clap::{App, Arg, ArgMatches};

use crate::util::infu::InfuResult;


pub fn make_clap_subcommand<'a, 'b>() -> App<'a> {
  App::new("validate")
    .about("Runs various data validation checks.")
    .arg(Arg::new("settings_path")
      .short('s')
      .long("settings")
      .help(concat!("Path to a toml settings configuration file. If not specified, the default will be assumed."))
      .takes_value(true)
      .multiple_values(false)
      .required(false))
}

pub fn execute<'a>(_sub_matches: &ArgMatches) -> InfuResult<()> {  
  // 1. get all the files we expect to see.
  // 2. go through all the object stores and get lists of:
  // 3.   all the files we have but don't want.
  // 4.   all the files we want but don't have.
  Ok(())
}
