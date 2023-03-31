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

use std::io::{BufRead, Write};

use clap::{App, Arg, ArgMatches};
use rpassword::read_password;

use crate::cli::login_url_from_base_url;
use crate::util::infu::InfuResult;
use crate::web::cookie::InfuSession;
use crate::web::routes::account::{LoginRequest, LoginResponse};

use super::NamedInfuSession;
use super::logout::logout;


pub fn make_clap_subcommand<'a, 'b>() -> App<'a> {
  App::new("login")
    .about("Create a new Infumap session. If session name is not specified, '\"default\"' will be assumed. If there is an existing session with the same name, this will be closed/removed before creating the new session.")
    .arg(Arg::new("session")
      .short('s')
      .long("session")
      .help("The session name.")
      .takes_value(true)
      .multiple_values(false)
      .required(false))
}


pub async fn execute<'a>(sub_matches: &ArgMatches) -> InfuResult<()> {
  let session_name = match sub_matches.value_of("session") {
    Some(name) => name,
    None => "default"
  };

  let sessions = match NamedInfuSession::read_sessions().await {
    Ok(s) => s,
    Err(_e) => vec![]
  };

  let session_names = sessions.iter().map(|s| s.name.as_str()).collect::<Vec<&str>>();
  if session_names.contains(&session_name) {
    match logout(session_name).await {
      Ok(_) => {},
      Err(e) => {
        println!("An error occurred logging out existing session (ignoring): {}.", e);
      }
    };
  }

  let mut other_sessions = sessions.iter().filter(|s| s.name != session_name).collect::<Vec<&NamedInfuSession>>();

  let stdin = std::io::stdin();
  let mut iterator = stdin.lock().lines();
  print!("Base URL: ");
  std::io::stdout().lock().flush().unwrap();
  let url = iterator.next().unwrap().unwrap();
  let login_url = match login_url_from_base_url(&url) {
    Ok(url) => url,
    Err(e) => {
      println!("Invalid URL: {}", e);
      return Ok(())
    }
  };
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
    .post(login_url.clone())
    .json(&login_request)
    .send()
    .await.map_err(|e| format!("{}", e))?
    .json()
    .await.map_err(|e| format!("{}", e))?;
  if !login_response.success {
    println!("Login failed: {}", login_response.err.unwrap());
    return Ok(());
  }

  let session = InfuSession {
    username,
    user_id: login_response.user_id.unwrap(),
    session_id: login_response.session_id.unwrap(),
  };

  let named_session = NamedInfuSession {
    name: session_name.to_string(),
    session,
    url: url.to_string()
  };

  let mut sessions = vec![&named_session];
  sessions.append(&mut other_sessions);

  NamedInfuSession::write_sessions(&sessions).await?;

  Ok(())
}
