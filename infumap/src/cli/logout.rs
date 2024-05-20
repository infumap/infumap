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

use clap::{Command, ArgMatches, Arg};
use infusdk::util::infu::InfuResult;

use crate::web::routes::account::LogoutResponse;

use super::NamedInfuSession;


pub fn make_clap_subcommand() -> Command {
  Command::new("logout")
    .about("Logout of an Infumap session. If a session name is not specified, '\"default\"' will be assumed.")
    .arg(Arg::new("session")
      .short('s')
      .long("session")
      .help("The session name.")
      .num_args(1)
      .default_value("default")
      .required(false))
}

pub async fn execute(sub_matches: &ArgMatches) -> InfuResult<()> {
  let session_name = sub_matches.get_one::<String>("session").unwrap().as_str();

  match logout(session_name).await {
    Err(e) => {
      println!("A problem was encountered logging out of session '{}': {}.", session_name, e);
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
      return Err(format!("No session found with name '{}'", session_name).into());
    }
  };

  let session_cookie_value = serde_json::to_string(&named_session.session)?;
  let mut request_headers = reqwest::header::HeaderMap::new();
  request_headers.insert(
    reqwest::header::COOKIE,
    reqwest::header::HeaderValue::from_str(&format!("infusession={}", session_cookie_value)).unwrap());

  let logout_url = named_session.logout_url()?;

  let error_msg = match reqwest::ClientBuilder::new()
      .default_headers(request_headers.clone()).build().unwrap()
      .post(logout_url)
      .send()
      .await.map_err(|e| e.to_string()) {
    Ok(r) => {
      let logout_response: Result<LogoutResponse, String> = r.json().await.map_err(|e| e.to_string());
      match logout_response {
        Ok(rr) => {
          if rr.success { None } else { Some(format!("There was a server side error logging out user {}", named_session.session.username)) }
        },
        Err(e) => {
          Some(format!("An error occurred getting the logout response JSON content: {}", e))
        }
      }
    },
    Err(e) => {
      Some(format!("There was a problem sending the logout server request: {}", e))
    }
  };

  // Even if there was a problem logging the user out remotely, remove the session locally.
  let remaining_sessions = sessions.iter()
    .filter(|s| s.name != session_name).collect::<Vec<&NamedInfuSession>>();
  NamedInfuSession::write_sessions(&remaining_sessions).await?;

  if let Some(msg) = error_msg {
    return Err(msg.into());
  }

  Ok(())
}
