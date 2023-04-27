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
use serde_json::Map;
use serde_json::Value;

use crate::storage::db::item::ItemType;
use crate::util::geometry::GRID_SIZE;
use crate::web::routes::command::SendRequest;
use crate::web::routes::command::SendResponse;
use crate::{util::{infu::InfuResult, uid::is_uid}, cli::NamedInfuSession};


pub fn make_clap_subcommand<'a, 'b>() -> App<'a> {
  App::new("note")
    .about("Add a note to an Infumap container.")
    .arg(Arg::new("container_id")
      .short('c')
      .long("container-id")
      .help("The id of the container to add the note to. If omitted, the note will be added to the root container of the session user.")
      .takes_value(true)
      .multiple_values(false)
      .required(false))
    .arg(Arg::new("session")
      .short('s')
      .long("session")
      .help("The name of the Infumap session to use. 'default' will be used if not specified.")
      .takes_value(true)
      .multiple_values(false)
      .required(false))
    .arg(Arg::new("note")
      .short('n')
      .long("note")
      .help("The note.")
      .takes_value(true)
      .required(true))
}

pub async fn execute<'a>(sub_matches: &ArgMatches) -> InfuResult<()> {
  let note = match sub_matches.value_of("note") {
    None => { return Err("Note text was not present.".into()) },
    Some(n) => n
  };

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

  // validate container.
  let container_id_maybe = match sub_matches.value_of("container_id").map(|v| v.to_string()) {
    Some(uid_maybe) => {
      if !is_uid(&uid_maybe) {
        return Err(format!("Invalid container id: '{}'.", uid_maybe).into());
      }
      Some(uid_maybe)
    },
    None => { None }
  };

  let session_cookie_value = serde_json::to_string(&named_session.session)?;
  let mut request_headers = reqwest::header::HeaderMap::new();
  request_headers.insert(
    reqwest::header::COOKIE,
    reqwest::header::HeaderValue::from_str(&format!("infusession={}", session_cookie_value)).unwrap());

  let mut item: Map<String, Value> = Map::new();
  item.insert("itemType".to_owned(), Value::String(ItemType::Note.as_str().to_owned()));
  match container_id_maybe {
    Some(container_id) => {
      item.insert("parentId".to_owned(), Value::String(container_id.clone()));
    },
    None => {}
  }
  item.insert("title".to_owned(), Value::String(note.to_owned()));
  item.insert("spatialWidthGr".to_owned(), Value::Number((GRID_SIZE * 8).into()));
  item.insert("url".to_owned(), Value::String("".to_owned()));

  let add_item_request = serde_json::to_string(&item)?;
  let send_reqest = SendRequest {
    command: "add-item".to_owned(),
    json_data: add_item_request,
    base64_data: None,
  };

  let add_item_response: SendResponse = reqwest::ClientBuilder::new()
    .default_headers(request_headers.clone()).build().unwrap()
    .post(named_session.command_url()?.clone())
    .json(&send_reqest)
    .send()
    .await.map_err(|e| format!("{}", e))?
    .json()
    .await.map_err(|e| format!("{}", e))?;

  if !add_item_response.success {
    println!("Infumap rejected the add-item command. Has your session expired?");
  } else {
    println!("Success!");
  }

  Ok(())
}
