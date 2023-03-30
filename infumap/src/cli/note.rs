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
use reqwest::Url;

use crate::util::{infu::InfuResult, uid::is_uid};


pub fn make_clap_subcommand<'a, 'b>() -> App<'a> {
  App::new("note")
    .about("Add a note to an Infumap container. WORK IN PROGRESS.")
    .arg(Arg::new("container_id")
      .short('c')
      .long("container_id")
      .help("The id of the container to add the note to. If omitted, the note will be added to the root container.")
      .takes_value(true)
      .multiple_values(false)
      .required(false))
    .arg(Arg::new("url")
      .short('u')
      .long("url")
      .help("URL of the Infumap instance. Should include the protocol (http/https), and trailing / if the URL path is not empty.")
      .takes_value(true)
      .multiple_values(false)
      .required(true))
    .arg(Arg::new("note")
      .short('n')
      .long("note")
      .help("The note.")
      .takes_value(true)
      .required(true))
}

pub async fn execute<'a>(sub_matches: &ArgMatches) -> InfuResult<()> {
  let note = match sub_matches.value_of("note") {
    None => { return Err("".into()) },
    Some(n) => n
  };

  // validate container.
  let _container_id = match sub_matches.value_of("container_id").map(|v| v.to_string()) {
    Some(uid_maybe) => {
      if !is_uid(&uid_maybe) {
        return Err(format!("Invalid container id: '{}'.", uid_maybe).into());
      }
      Some(uid_maybe)
    },
    None => None
  };

  // validate URL and construct sub URLs.
  let url = match sub_matches.value_of("url").map(|v| v.to_string()) {
    Some(url) => url,
    None => { return Err("Infumap base URL must be specified.".into()); }
  };
  let base_url = Url::parse(&url)
    .map_err(|e| format!("Could not parse URL: {}", e))?;
  if base_url.path() != "/" && !url.ends_with("/") {
    return Err("Specified URL must have no path, or the path must end with a '/' to signify it is not a file.".into());
  }
  let _login_url = base_url.join("/account/login").map_err(|e| e.to_string())?;
  let _command_url = base_url.join("/command").map_err(|e| e.to_string())?;

  println!("{}", note);

  Ok(())
}
