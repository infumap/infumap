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
use std::io::Cursor;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use base64::{Engine as _, engine::general_purpose};
use clap::{App, Arg, ArgMatches};
use image::io::Reader;
use log::debug;
use reqwest::Url;
use rpassword::read_password;
use serde_json::Map;
use serde_json::Value;
use tokio::fs;
use tokio::fs::File;
use tokio::fs::OpenOptions;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;

use crate::storage::db::item::ITEM_TYPE_FILE;
use crate::storage::db::item::ITEM_TYPE_IMAGE;
use crate::storage::db::item::RelationshipToParent;
use crate::util::fs::expand_tilde;
use crate::util::fs::path_exists;
use crate::util::geometry::Dimensions;
use crate::util::geometry::GRID_SIZE;
use crate::util::geometry::Vector;
use crate::util::image::adjust_image_for_exif_orientation;
use crate::util::image::get_exif_orientation;
use crate::util::infu::InfuResult;
use crate::util::json;
use crate::util::ordering::new_ordering;
use crate::util::ordering::new_ordering_after;
use crate::util::uid::is_uid;
use crate::util::uid::new_uid;
use crate::web::cookie::InfuSession;
use crate::web::routes::account::LoginRequest;
use crate::web::routes::account::LoginResponse;
use crate::web::routes::command::GetChildrenRequest;
use crate::web::routes::command::SendRequest;
use crate::web::routes::command::SendResponse;


pub fn make_clap_subcommand<'a, 'b>() -> App<'a> {
  // TODO (MEDIUM): cache session in ~/.infumap.
  App::new("upload")
    .about("Bulk upload all files in a local directory to an Infumap container.")
    .arg(Arg::new("container_id")
      .short('c')
      .long("container_id")
      .help("The id of the container to upload files to. If the resume flag is not set, this container must be empty.")
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
      .help("URL of the Infumap instance to upload files to. Should include the protocol (http/https), and trailing / if the URL path is not empty.")
      .takes_value(true)
      .multiple_values(false)
      .required(true))
    .arg(Arg::new("resume")
      .short('r')
      .long("resume")
      .help("If specified, it is not enforced that the Infumap container is empty, and files already present in the container will be skipped.")
      .takes_value(false)
      .required(false))
}


pub async fn execute<'a>(sub_matches: &ArgMatches) -> InfuResult<()> {
  let resuming = sub_matches.is_present("resume");

  // validate directory
  let local_path = match sub_matches.value_of("directory").map(|v| v.to_string()) {
    Some(path) => path,
    None => { return Err("Path to directory to upload contents of must be specified.".into()); }
  };
  let local_path = PathBuf::from(
    expand_tilde(local_path).ok_or(format!("Could not interpret path."))?);
  let mut iter = fs::read_dir(&local_path).await?;
  let mut num_files = 0;
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
    num_files += 1;
  }

  // validate container.
  let container_id = match sub_matches.value_of("container_id").map(|v| v.to_string()) {
    Some(uid_maybe) => {
      if !is_uid(&uid_maybe) {
        return Err(format!("Invalid container id: '{}'.", uid_maybe).into());
      }
      uid_maybe
    },
    None => { return Err("Id of container to upload files into must be specified.".into()); }
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
  let login_url = base_url.join("/account/login").map_err(|e| e.to_string())?;
  let command_url = base_url.join("/command").map_err(|e| e.to_string())?;

  // get session / login.
  let session = match read_session().await {
    Ok(s) => s,
    Err(_) => {
      login(&login_url).await?;
      read_session().await?
    }
  };
  let session_cookie_value = serde_json::to_string(&session)?;
  let mut request_headers = reqwest::header::HeaderMap::new();
  request_headers.insert(
    reqwest::header::COOKIE,
    reqwest::header::HeaderValue::from_str(&format!("infusession={}", session_cookie_value)).unwrap());

  // get children of container.
  let get_children_request = serde_json::to_string(&GetChildrenRequest { parent_id: container_id.clone() }).unwrap();
  let send_reqest = SendRequest {
    command: "get-children-with-their-attachments".to_owned(),
    json_data: get_children_request,
    base64_data: None,
  };
  let container_children_response: SendResponse = reqwest::ClientBuilder::new()
    .default_headers(request_headers.clone()).build().unwrap()
    .post(command_url.clone())
    .json(&send_reqest)
    .send()
    .await.map_err(|e| e.to_string())?
    .json()
    .await.map_err(|e| e.to_string())?;
  if !container_children_response.success {
    println!("Query for container contents failed.");
  }

  // enforce that the container is empty.
  let json_data = container_children_response.json_data.ok_or("Request for children yielded no data.")?;
  let json = serde_json::from_str::<Map<String, Value>>(&json_data).map_err(|e| e.to_string())?;
  let children = json.get("children").ok_or("Request for children yielded an unexpected result (no children property).")?;
  let container_children = children.as_array().ok_or("Request for children yielded an unexpected result (children property is not an array).")?;
  if container_children.len() != 0 && !resuming {
    println!("Specified container '{}' is not empty.", container_id.clone());
    return Ok(());
  }
  let container_children_titles = container_children.iter().map(|child| -> InfuResult<String> {
    Ok(child
        .as_object().ok_or("item is not an object")?
        .get("title").ok_or("item does not have title property.")?
        .as_str().ok_or("Title property is not of type string.")?.to_owned())
  }).collect::<InfuResult<Vec<String>>>()?;

  // add items.
  let mut current_ordering = new_ordering();
  let mut iter = fs::read_dir(&local_path).await?;
  let mut current_file = 0;
  while let Some(entry) = iter.next_entry().await? {
    current_file += 1;
    let unix_time_now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();

    let os_filename = entry.file_name();
    let filename = os_filename.to_str().ok_or(format!("Could not interpret filename '{:?}'.", entry.file_name()))?;
    if resuming && container_children_titles.contains(&filename.to_owned()) {
      println!("File '{}' is already present in the container, skipping.", filename);
      continue;
    }

    let mime_type = match mime_guess::from_path(&filename).first_raw() {
      Some(mime_type) => mime_type,
      None => "application/octet-stream"
    };

    let mut f = File::open(&entry.path()).await?;
    let metadata = tokio::fs::metadata(&entry.path()).await?;
    let mut buffer = vec![0; metadata.len() as usize];
    f.read_exact(&mut buffer).await?;
    let base_64_encoded = general_purpose::STANDARD.encode(&buffer);

    let mut item: Map<String, Value> = Map::new();
    item.insert("ownerId".to_owned(), Value::String(session.user_id.clone()));
    item.insert("id".to_owned(), Value::String(new_uid()));
    item.insert("parentId".to_owned(), Value::String(container_id.clone()));
    item.insert("relationshipToParent".to_owned(), Value::String(RelationshipToParent::Child.as_str().to_owned()));
    item.insert("creationDate".to_owned(), Value::Number(unix_time_now.into()));
    item.insert("lastModifiedDate".to_owned(), Value::Number(unix_time_now.into()));
    item.insert("ordering".to_owned(),
      Value::Array(current_ordering.iter().map(|v| Value::Number((*v).into())).collect::<Vec<_>>()));
    item.insert("title".to_owned(), Value::String(filename.to_owned()));
    item.insert("spatialPositionGr".to_owned(), json::vector_to_object(&Vector { x: 0, y: 0 }));
    item.insert("spatialWidthGr".to_owned(), Value::Number((GRID_SIZE * 6).into()));
    item.insert("originalCreationDate".to_owned(),
      Value::Number(metadata.created().map_err(|e| e.to_string())?.duration_since(UNIX_EPOCH)?.as_secs().into()));
    item.insert("mimeType".to_owned(), Value::String(mime_type.to_owned()));
    item.insert("fileSizeBytes".to_owned(), Value::Number(metadata.len().into()));

    let os_filename = entry.file_name();
    let filename = os_filename.to_str().ok_or("err")?;
    if filename.to_lowercase().ends_with(".png") || filename.to_lowercase().ends_with(".jpg") || filename.to_lowercase().ends_with(".jpeg") {
      let file_cursor = Cursor::new(buffer.clone());
      let file_reader = Reader::new(file_cursor).with_guessed_format()?;
      match file_reader.decode() {
        Ok(img) => {
          let exif_orientation = get_exif_orientation(buffer.clone(), filename);
          let img = adjust_image_for_exif_orientation(img, exif_orientation, filename);
          item.insert("itemType".to_owned(), Value::String(ITEM_TYPE_IMAGE.to_owned()));
          item.insert("imageSizePx".to_owned(),
            json::dimensions_to_object(&Dimensions { w: img.width().into(), h: img.height().into() }));
          item.insert("thumbnail".to_owned(), Value::String("".to_owned())); // set on the server.
          if exif_orientation > 1 {
            debug!("Note: image has exif orientation type of: {}", exif_orientation);
          }
          print!("Adding image '{}' {}/{}... ", filename, current_file, num_files);
          std::io::stdout().flush()?;
        },
        Err(_e) => {
          item.insert("itemType".to_owned(), Value::String(ITEM_TYPE_FILE.to_owned()));
          print!("Could not interpret file '{}' as an image, adding as an item of type file {}/{}... ", filename, current_file, num_files);
          std::io::stdout().flush()?;
        }
      }
    } else {
      item.insert("itemType".to_owned(), Value::String(ITEM_TYPE_FILE.to_owned()));
      print!("Adding file '{}' {}/{}... ", filename, current_file, num_files);
      std::io::stdout().flush()?;
    }

    let add_item_request = serde_json::to_string(&item)?;
    let send_reqest = SendRequest {
      command: "add-item".to_owned(),
      json_data: add_item_request,
      base64_data: Some(base_64_encoded),
    };

    loop {
      let add_item_response = reqwest::ClientBuilder::new()
        .default_headers(request_headers.clone()).build().unwrap()
        .post(command_url.clone())
        .json(&send_reqest)
        .send()
        .await;
      match add_item_response {
        Ok(r) => {
          let json_response: SendResponse = r.json().await.map_err(|e| e.to_string())?;
          if !json_response.success {
            println!("infumap rejected the add-item command - skipping.");
          } else {
            println!("success!");
          }
          break;
        },
        Err(e) => {
          println!(" there was a connection issue sending the add-item request - retrying: {}", e);
          tokio::time::sleep(Duration::from_secs(2)).await;
        }
      }
    }

    current_ordering = new_ordering_after(&current_ordering);
  }

  Ok(())
}


async fn login(login_url: &Url) -> InfuResult<()> {
  let session_file_path = get_cli_session_path().await?;
  if path_exists(&session_file_path).await {
    // TODO (MEDIUM): attempt to logout to remove session resource server side.
    debug!("Removing existing session file.");
    tokio::fs::remove_file(&session_file_path).await?;
  }

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
  let owner_id = login_response.user_id.unwrap().clone();

  let session_cookie_value = serde_json::to_string(&InfuSession {
    username,
    user_id: owner_id.clone(),
    session_id: login_response.session_id.unwrap(),
    root_page_id: login_response.root_page_id.unwrap(),
  })?;

  let mut file = OpenOptions::new()
    .create_new(true)
    .write(true)
    .open(session_file_path).await?;
  file.write_all(&session_cookie_value.as_bytes()).await?;
  file.flush().await?;

  Ok(())
}


async fn read_session() -> InfuResult<InfuSession> {
  let session_file_path = get_cli_session_path().await?;
  let mut f = File::open(&session_file_path).await?;
  let mut buffer = vec![0; tokio::fs::metadata(&session_file_path).await?.len() as usize];
  f.read_exact(&mut buffer).await?;
  let session: InfuSession = serde_json::from_str(
    &String::from_utf8(buffer).map_err(|e| format!("{}", e))?)?;
  Ok(session)
}


async fn get_cli_session_path() -> InfuResult<PathBuf> {
  let dot_infumap_path = PathBuf::from(
    expand_tilde("~/.infumap").ok_or(format!("Could not determine ~/.infumap path."))?);
  if !path_exists(&dot_infumap_path).await {
    debug!("Creating ~/.infumap directory.");
    tokio::fs::create_dir(&dot_infumap_path).await?;
  }
  let mut cli_dir_path = PathBuf::from(dot_infumap_path);
  cli_dir_path.push("cli");
  if !path_exists(&cli_dir_path).await {
    debug!("Creating ~/.infumap/cli directory.");
    tokio::fs::create_dir(&cli_dir_path).await?;
  }
  let mut session_file_path = PathBuf::from(cli_dir_path);
  session_file_path.push("session.json");
  Ok(session_file_path)
}
