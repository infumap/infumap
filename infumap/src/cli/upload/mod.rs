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

use std::io::BufRead;
use std::io::Write;
use std::path::PathBuf;

use clap::{App, Arg, ArgMatches};
use rpassword::read_password;

use crate::util::infu::InfuResult;
use crate::web::cookie::InfuSession;
use crate::web::routes::account::LoginRequest;
use crate::web::routes::account::LoginResponse;


pub fn make_clap_subcommand<'a, 'b>() -> App<'a> {
  App::new("upload")
    .about("Bulk upload all files in a local directory to an Infumap container.")
    .arg(Arg::new("container_id")
      .short('c')
      .long("container_id")
      .help("The container id to upload files to.")
      .takes_value(true)
      .multiple_values(false)
      .required(true))
    .arg(Arg::new("directory")
      .short('d')
      .long("directory")
      .help("The local directory path from which to source all files to upload.")
      .takes_value(true)
      .multiple_values(false)
      .required(true))
    .arg(Arg::new("url")
      .short('u')
      .long("url")
      .help("URL of the Infumap instance to upload files to. Should include the protocol (http/https), and not include trailing /.")
      .takes_value(true)
      .multiple_values(false)
      .required(true))
}


pub async fn execute<'a>(sub_matches: &ArgMatches) -> InfuResult<()> {
  let local_path = match sub_matches.value_of("directory").map(|v| v.to_string()) {
    Some(p) => p,
    None => { return Err("Upload directory path must be specified.".into()); }
  };
  let container_id = match sub_matches.value_of("container_id").map(|v| v.to_string()) {
    Some(c) => c,
    None => { return Err("Container id must be specified.".into()); }
  };
  let url = match sub_matches.value_of("url").map(|v| v.to_string()) {
    Some(c) => c,
    None => { return Err("Infumap URL must be specified.".into()); }
  };

  let path = PathBuf::from(local_path);

  let stdin = std::io::stdin();
  let mut iterator = stdin.lock().lines();
  print!("Username: ");
  std::io::stdout().lock().flush().unwrap();
  let username = iterator.next().unwrap().unwrap();
  print!("Password: ");
  std::io::stdout().lock().flush().unwrap();
  let password = read_password().unwrap();
  print!("Authenticator code (if any)>: ");
  std::io::stdout().lock().flush().unwrap();
  let totp = iterator.next().unwrap().unwrap();
  let totp_token = if totp == "" { None } else { Some(totp) };

  let login_request = LoginRequest { username: username.clone(), password, totp_token };

  let login_response: LoginResponse = reqwest::Client::new()
      .post(format!("{}/account/login", url))
      .json(&login_request)
      .send()
      .await.map_err(|e| format!("{}", e))?
      .json()
      .await.map_err(|e| format!("{}", e))?;

  if !login_response.success {
    println!("Login failed: {}", login_response.err.unwrap());
    return Ok(());
  }

  let session_cookie_value = serde_json::to_string(&InfuSession {
    username,
    user_id: login_response.user_id.unwrap(),
    session_id: login_response.session_id.unwrap(),
    root_page_id: login_response.root_page_id.unwrap(),
  })?;

  // get container contents. 
  // add to end orderings.. 
  // 

  Ok(())
}
