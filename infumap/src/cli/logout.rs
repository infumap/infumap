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

use clap::{App, ArgMatches, Arg};

use crate::util::infu::InfuResult;
use crate::web::routes::account::LogoutResponse;

use super::NamedInfuSession;


pub fn make_clap_subcommand<'a, 'b>() -> App<'a> {
  App::new("logout")
    .about("Logout of an Infumap session. If session name is not specified, '\"default\"' will be assumed.")
    .arg(Arg::new("name")
      .short('n')
      .long("name")
      .help("The session name.")
      .takes_value(true)
      .multiple_values(false)
      .required(false))
}

pub async fn execute<'a>(sub_matches: &ArgMatches) -> InfuResult<()> {
  let session_name = match sub_matches.value_of("name") {
    Some(name) => name,
    None => "default"
  };

  match logout(session_name).await {
    Err(e) => {
      println!("There was a problem logging out of session '{}': {}.", session_name, e);
    }
    Ok(_) => {
      println!("Successfully logged out of session '{}'.", session_name);
    }
  };

  Ok(())
}

pub async fn logout(session_name: &str) -> InfuResult<()> {
  let sessions = NamedInfuSession::read_sessions().await?;
  let named_session = match sessions.iter().find(|s| s.name == session_name) {
    Some(s) => s,
    None => {
      return Err(format!("No session found with name '{}'.", session_name).into());
    }
  };

  let session_cookie_value = serde_json::to_string(&named_session.session)?;
  let mut request_headers = reqwest::header::HeaderMap::new();
  request_headers.insert(
    reqwest::header::COOKIE,
    reqwest::header::HeaderValue::from_str(&format!("infusession={}", session_cookie_value)).unwrap());

  let logout_response: LogoutResponse = reqwest::ClientBuilder::new()
    .default_headers(request_headers.clone()).build().unwrap()
    .post(named_session.url.clone())
    .send()
    .await.map_err(|e| e.to_string())?
    .json()
    .await.map_err(|e| e.to_string())?;

  let remaining_sessions = sessions.iter()
    .filter(|s| s.name != session_name).collect::<Vec<&NamedInfuSession>>();
  NamedInfuSession::write_sessions(&remaining_sessions).await?;

  if !logout_response.success {
    return Err(format!(
      "Server logout request failed for server/user: {}/{}.",
      named_session.url, named_session.session.username).into());
  }

  Ok(())
}
