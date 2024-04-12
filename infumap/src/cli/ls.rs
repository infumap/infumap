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
use infusdk::util::uid::is_uid;
use serde_json::Map;
use serde_json::Value;

use crate::storage::db::item::ItemType;
use crate::web::routes::command::{CommandRequest, CommandResponse};

use super::NamedInfuSession;


pub fn make_clap_subcommand<'a, 'b>() -> App<'a> {
  App::new("ls")
    .about("List the children and/or attachments of an item.")
    .arg(Arg::new("item_id")
      .short('i')
      .long("id")
      .help("The id of the item. If omitted, children of root container of the session user will be listed.")
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

  let mut request_data: Map<String, Value> = Map::new();
  let _item_id_maybe = match sub_matches.value_of("item_id").map(|v| v.to_string()) {
    Some(uid_maybe) => {
      if !is_uid(&uid_maybe) {
        return Err(format!("Invalid item id: '{}'.", uid_maybe).into());
      }
      request_data.insert("parentId".to_owned(), Value::String(uid_maybe.to_owned()));
      request_data.insert("childrenAndTheirAttachmentsOnly".to_owned(), Value::Bool(true));
      Some(uid_maybe)
    },
    None => {
      None
    }
  };

  let session_cookie_value = serde_json::to_string(&named_session.session)?;
  let mut request_headers = reqwest::header::HeaderMap::new();
  request_headers.insert(
    reqwest::header::COOKIE,
    reqwest::header::HeaderValue::from_str(&format!("infusession={}", session_cookie_value)).unwrap());

  let get_children_request = serde_json::to_string(&request_data)?;
  let send_reqest = CommandRequest {
    command: "get-items".to_owned(),
    json_data: get_children_request,
    base64_data: None,
  };

  let get_children_response: CommandResponse = reqwest::ClientBuilder::new()
    .default_headers(request_headers.clone()).build().unwrap()
    .post(named_session.command_url()?.clone())
    .json(&send_reqest)
    .send()
    .await.map_err(|e| format!("{}", e))?
    .json()
    .await.map_err(|e| format!("{}", e))?;

  if !get_children_response.success {
    return Err("Infumap rejected the get-items command. Has your session expired?".into());
  }
  let children_json = match get_children_response.json_data {
    Some(json) => json,
    None => return Err("Unexpected get-items response.".into())
  };

  let deserializer = serde_json::Deserializer::from_str(&children_json);
  let mut iterator = deserializer.into_iter::<serde_json::Value>();
  let result_map_maybe = iterator.next().ok_or("get-items response had no value.")??;
  let result_map = result_map_maybe.as_object().ok_or("get-items response is not a JSON object.")?;
  let children_value = result_map.get("children").ok_or("get-items response has no 'children' field.")?;
  let children_array = children_value.as_array().ok_or("get-items response has a 'children' field that is not an array.")?;

  let get_attachments_request = serde_json::to_string(&request_data)?;
  let send_reqest = CommandRequest {
    command: "get-attachments".to_owned(),
    json_data: get_attachments_request,
    base64_data: None,
  };

  let get_attachments_response: CommandResponse = reqwest::ClientBuilder::new()
    .default_headers(request_headers.clone()).build().unwrap()
    .post(named_session.command_url()?.clone())
    .json(&send_reqest)
    .send()
    .await.map_err(|e| format!("{}", e))?
    .json()
    .await.map_err(|e| format!("{}", e))?;

  if !get_attachments_response.success {
    println!("Infumap rejected the get-attachments command.");
    return Ok(());
  }

  let attachments_json = match get_attachments_response.json_data {
    Some(json) => json,
    None => return Err("Unexpected get-attachments response.".into())
  };

  let deserializer = serde_json::Deserializer::from_str(&attachments_json);
  let mut iterator = deserializer.into_iter::<serde_json::Value>();
  let result_array_maybe = iterator.next().ok_or("get-attachments response had no value.")??;
  let attachments_array = result_array_maybe.as_array().ok_or("get-attachments response is not a JSON array.")?;

  fn print_item_value(item: &Value) -> InfuResult<()> {
    let child_map = item.as_object().ok_or("child is not an object.")?;
    let id = child_map.get("id").ok_or("item has no id.")?.as_str().ok_or("item id is not of type string.")?;
    let item_type_str = child_map.get("itemType").ok_or("item has no type.")?.as_str().ok_or("item type is not of type string.")?;
    let item_type = ItemType::from_str(item_type_str)?;
    let item_type_short = match item_type {
      ItemType::Page => "P",
      ItemType::Table => "T",
      ItemType::Composite => "C",
      ItemType::Note => "N",
      ItemType::File => "F",
      ItemType::Password => "W",
      ItemType::Rating => "R",
      ItemType::Link => "L",
      ItemType::Image => "I",
      ItemType::Placeholder => "H",
      ItemType::Expression => "E",
    };
    let title_str = match child_map.get("title") {
      Some(s) => s.as_str().ok_or("Item title is not of type string.")?,
      None => ""
    };
    println!(" {} {} {}", item_type_short, id, title_str);
    Ok(())
  }

  println!("Children:");
  if children_array.len() == 0 {
    println!(" (none)");
  }
  for child in children_array {
    print_item_value(child)?;
  }

  println!("\nAttachments:");
  if attachments_array.len() == 0 {
    println!(" (none)");
  }
  for attachment in attachments_array {
    print_item_value(attachment)?;
  }

  Ok(())
}
