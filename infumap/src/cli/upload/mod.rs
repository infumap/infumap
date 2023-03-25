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

use base64::{Engine as _, engine::general_purpose};
use clap::{App, Arg, ArgMatches};
use reqwest::Url;
use rpassword::read_password;
use serde_json::Map;
use serde_json::Value;
use tokio::fs;
use tokio::fs::File;
use tokio::io::AsyncReadExt;

use crate::util::fs::expand_tilde;
use crate::util::infu::InfuResult;
use crate::util::uid::is_uid;
use crate::web::cookie::InfuSession;
use crate::web::routes::account::LoginRequest;
use crate::web::routes::account::LoginResponse;
use crate::web::routes::command::GetChildrenRequest;
use crate::web::routes::command::SendRequest;
use crate::web::routes::command::SendResponse;


pub fn make_clap_subcommand<'a, 'b>() -> App<'a> {
  App::new("upload")
    .about("Bulk upload all files in a local directory to an Infumap container.")
    .arg(Arg::new("container_id")
      .short('c')
      .long("container_id")
      .help("The id of the container to upload files to. This container must be empty.")
      .takes_value(true)
      .multiple_values(false)
      .required(true))
    .arg(Arg::new("directory")
      .short('d')
      .long("directory")
      .help("The path of the directory to upload all files from. This directory must only contain regular files (no links or directories).")
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

  // 1. validate directory
  let local_path = match sub_matches.value_of("directory").map(|v| v.to_string()) {
    Some(path) => path,
    None => { return Err("Path to directory to upload contents of must be specified.".into()); }
  };
  let local_path = PathBuf::from(
    expand_tilde(local_path).ok_or(format!("Could not interpret path."))?);
  let mut iter = fs::read_dir(&local_path).await?;
  while let Some(entry) = iter.next_entry().await? {
    if entry.file_type().await?.is_dir() {
      return Err("Source directory must not contain other directories.".into());
    }
    if entry.file_type().await?.is_symlink() {
      return Err("Source directory contains a symlink. It must only contain regular files.".into());
    }
    if !entry.file_type().await?.is_file() {
      return Err("Source directory must only contain regular files.".into());
    }
    if entry.file_name().to_str().is_none() {
      return Err(format!("Could not interpret filename: {:?}", entry.file_name()).into());
    }
  }

  // 2. validate container.
  let container_id = match sub_matches.value_of("container_id").map(|v| v.to_string()) {
    Some(uid_maybe) => {
      if !is_uid(&uid_maybe) {
        return Err(format!("Invalid container id: '{}'.", uid_maybe).into());
      }
      uid_maybe
    },
    None => { return Err("Id of container to upload files into must be specified.".into()); }
  };

  // 3. validate URL and construct sub URLs.
  let url = match sub_matches.value_of("url").map(|v| v.to_string()) {
    Some(url) => url,
    None => { return Err("Infumap base URL must be specified.".into()); }
  };
  let base_url = Url::parse(&url)
    .map_err(|e| format!("Could not parse URL: {}", e))?;
  if base_url.path() != "/" && !url.ends_with("/") {
    return Err("Specified URL must have no path, or the path must end with a '/' to signify it is not a file.".into());
  }
  let login_url = base_url.join("/account/login").map_err(|e| e.to_string())?;
  let command_url = base_url.join("/command").map_err(|e| e.to_string())?;

  // 4. read login credentials from stdin.
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

  // 5. login.
  let login_request = LoginRequest { username: username.clone(), password, totp_token };
  let login_response: LoginResponse = reqwest::Client::new()
    .post(login_url)
    .json(&login_request)
    .send()
    .await.map_err(|e| format!("{}", e))?
    .json()
    .await.map_err(|e| format!("{}", e))?;
  if !login_response.success {
    println!("Login failed: {}", login_response.err.unwrap());
    return Ok(());
  }

  // 6. construct the session cookie header.
  let session_cookie_value = serde_json::to_string(&InfuSession {
    username,
    user_id: login_response.user_id.unwrap(),
    session_id: login_response.session_id.unwrap(),
    root_page_id: login_response.root_page_id.unwrap(),
  })?;
  let mut request_headers = reqwest::header::HeaderMap::new();
  request_headers.insert(
    reqwest::header::COOKIE,
    reqwest::header::HeaderValue::from_str(&format!("infusession={}", session_cookie_value)).unwrap());

  // 7. get children of container.
  let get_children_request = serde_json::to_string(&GetChildrenRequest { parent_id: container_id.clone() }).unwrap();
  let send_reqest = SendRequest {
    command: "get-children-with-their-attachments".to_owned(),
    json_data: get_children_request,
    base64_data: None,
  };
  let container_children_response: SendResponse = reqwest::ClientBuilder::new()
    .default_headers(request_headers.clone()).build().unwrap()
    .post(command_url)
    .json(&send_reqest)
    .send()
    .await.map_err(|e| e.to_string())?
    .json()
    .await.map_err(|e| e.to_string())?;
  if !container_children_response.success {
    println!("Query for container contents failed.");
  }

  // 8. enforce that the container is empty.
  let json_data = container_children_response.json_data.ok_or("Request for children yielded no data.")?;
  let json = serde_json::from_str::<Map<String, Value>>(&json_data).map_err(|e| e.to_string())?;
  let children = json.get("children").ok_or("Request for children yielded an unexpected result (no children property).")?;
  let children = children.as_array().ok_or("Request for children yielded an unexpected result (children property is not an array).")?;
  if children.len() != 0 {
    println!("Specified container '{}' is not empty.", container_id);
    return Ok(());
  }

  // 9. add items.
  let mut iter = fs::read_dir(&local_path).await?;
  while let Some(entry) = iter.next_entry().await? {
    let mut f = File::open(&entry.path()).await?;
    let mut buffer = vec![0; tokio::fs::metadata(&entry.path()).await?.len() as usize];
    f.read_exact(&mut buffer).await?;
    let base_64_encoded = general_purpose::STANDARD.encode(buffer);

    println!("{:?} {}", entry.path(), base_64_encoded.len());
  }

  Ok(())
}
