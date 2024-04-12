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

use clap::{App, Arg, ArgMatches};
use infusdk::util::infu::InfuResult;

use crate::web::routes::admin::{ListPendingUsersResponse, ApprovePendingUserRequest, ApprovePendingUserResponse};
use super::NamedInfuSession;


pub fn make_clap_subcommand<'a, 'b>() -> App<'a> {
  App::new("pending")
    .about("List / approve pending users.")
    .arg(Arg::new("session")
      .short('s')
      .long("session")
      .help("The name of the Infumap session to use. 'default' will be used if not specified.")
      .takes_value(true)
      .multiple_values(false)
      .required(false))
    .subcommand(make_list_subcommand())
    .subcommand(make_approve_subcommand())
}

fn make_list_subcommand<'a, 'b>() -> App<'a> {
  App::new("list")
}

fn make_approve_subcommand<'a, 'b>() -> App<'a> {
  App::new("approve")
    .arg(Arg::new("username")
      .short('u')
      .long("username")
      .help(concat!("The pending username to approve."))
      .takes_value(true)
      .multiple_values(false)
      .required(true))
}


pub async fn execute<'a>(sub_matches: &ArgMatches) -> InfuResult<()> {
  let session_name = match sub_matches.value_of("session") {
    Some(name) => name,
    None => "default"
  };

  let named_session = match NamedInfuSession::get(session_name).await {
    Ok(s) => {
      match s {
        Some(s) => s,
        None => {
          return Err("Session does not exist - use the login CLI command to create one.".into());
        }
      }
    },
    Err(e) => { return Err(format!("A problem occurred getting session '{}': {}.", session_name, e).into()); }
  };

  match sub_matches.subcommand() {
    Some(("list", arg_sub_matches)) => {
      execute_list(arg_sub_matches, &named_session).await
    },
    Some(("approve", arg_sub_matches)) => {
      execute_approve(arg_sub_matches, &named_session).await
    },
    _ => return Err("Sub command was not recognized or specified.".into())
  }
}


pub async fn execute_list<'a>(_sub_matches: &ArgMatches, named_session: &NamedInfuSession) -> InfuResult<()> {
  let session_cookie_value = serde_json::to_string(&named_session.session)?;
  let mut request_headers = reqwest::header::HeaderMap::new();
  request_headers.insert(
    reqwest::header::COOKIE,
    reqwest::header::HeaderValue::from_str(&format!("infusession={}", session_cookie_value)).unwrap());

  match reqwest::ClientBuilder::new()
      .default_headers(request_headers.clone()).build().unwrap()
      .post(named_session.list_pending_users_url()?.clone())
      .send()
      .await.map_err(|e| e.to_string()) {
    Ok(r) => {
      let logout_response: Result<ListPendingUsersResponse, String> = r.json().await.map_err(|e| e.to_string());
      match logout_response {
        Ok(rr) => {
          for username in rr.usernames {
            println!("{}", username);
          }
          Ok(())
        },
        Err(e) => {
          Err(format!("An error occurred getting the list pending users JSON content: {}", e).into())
        }
      }
    },
    Err(e) => {
      Err(format!("There was a problem sending the list pending users server request: {}", e).into())
    }
  }
}


pub async fn execute_approve<'a>(sub_matches: &ArgMatches, named_session: &NamedInfuSession) -> InfuResult<()> {
  let session_cookie_value = serde_json::to_string(&named_session.session)?;
  let mut request_headers = reqwest::header::HeaderMap::new();
  request_headers.insert(
    reqwest::header::COOKIE,
    reqwest::header::HeaderValue::from_str(&format!("infusession={}", session_cookie_value)).unwrap());

  let username = match sub_matches.value_of("username") {
    Some(u) => u,
    None => return Err("Username was not specified.".into())
  };

  let approve_request = &ApprovePendingUserRequest {
    username: username.to_owned()
  };

  match reqwest::ClientBuilder::new()
      .default_headers(request_headers.clone()).build().unwrap()
      .post(named_session.approve_pending_user_url()?.clone())
      .json(&approve_request)
      .send()
      .await.map_err(|e| e.to_string()) {
    Ok(r) => {
      let approve_response: Result<ApprovePendingUserResponse, String> = r.json().await.map_err(|e| e.to_string());
      match approve_response {
        Ok(rr) => {
          if !rr.success {
            Err(format!("Approve pending user request failed: {:?}", rr.err).into())
          } else {
            println!("done");
            Ok(())
          }
        },
        Err(e) => {
          Err(format!("An error occurred getting the approve pending user JSON content: {}", e).into())
        }
      }
    },
    Err(e) => {
      Err(format!("There was a problem sending the approve pending user server request: {}", e).into())
    }
  }
}
