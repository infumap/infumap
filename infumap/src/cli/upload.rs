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

use std::io::Cursor;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;
use std::time::UNIX_EPOCH;

use base64::{Engine as _, engine::general_purpose};
use clap::ArgAction;
use clap::{Command, Arg, ArgMatches};
use image::ImageReader;
use infusdk::item::ItemType;
use infusdk::util::json;
use infusdk::util::geometry::Dimensions;
use infusdk::util::geometry::GRID_SIZE;
use infusdk::util::infu::InfuResult;
use infusdk::util::uid::is_uid;
use log::debug;
use serde_json::Map;
use serde_json::Value;
use tokio::fs;
use tokio::fs::File;
use tokio::io::AsyncReadExt;

use crate::util::fs::expand_tilde;
use crate::util::image::adjust_image_for_exif_orientation;
use crate::util::image::get_exif_orientation;
use crate::web::routes::command::GetItemsRequest;
use crate::web::routes::command::GetItemsMode;
use crate::web::routes::command::CommandRequest;
use crate::web::routes::command::CommandResponse;

use super::NamedInfuSession;


pub fn make_clap_subcommand() -> Command {
  Command::new("upload")
    .about("Bulk upload all files in a local directory to an Infumap container.")
    .arg(Arg::new("container_id")
      .short('c')
      .long("container_id")
      .help("The id of the container to upload files to.")
      .num_args(1)
      .required(true))
    .arg(Arg::new("directory")
      .short('d')
      .long("directory")
      .help("The path of the directory to upload all files from. This directory must only contain regular files (no links or directories).")
      .num_args(1)
      .required(true))
    .arg(Arg::new("session")
      .short('s')
      .long("session")
      .help("The name of the Infumap session to use. 'default' will be used if not specified.")
      .num_args(1)
      .default_value("default")
      .required(false))
    .arg(Arg::new("resume")
      .short('r')
      .long("resume")
      .help(concat!("By default, if the Infumap container has a file or image with the same name as a file in the local directory, ",
                    "the bulk upload operation will not start. If this flag is set, these files will be skipped instead."))
      .num_args(0)
      .action(ArgAction::SetTrue)
      .required(false))
    .arg(Arg::new("additional")
      .short('a')
      .long("additional")
      .help(concat!("By default, an attempt to upload files to an Infumap container that contains files with names other than those ",
                    "in the local directory will fail. Setting this flag disables this check."))
      .num_args(0)
      .action(ArgAction::SetTrue)
      .required(false))
}


pub async fn execute(sub_matches: &ArgMatches) -> InfuResult<()> {
  let resuming = sub_matches.get_flag("resume");
  let additional = sub_matches.get_flag("additional");

  // Validate directory.
  let local_path = match sub_matches.get_one::<String>("directory") {
    Some(path) => path,
    None => { return Err("Path to directory to upload contents of must be specified.".into()); }
  };
  let local_path = PathBuf::from(
    expand_tilde(local_path).ok_or(format!("Could not interpret path."))?);
  let mut iter = fs::read_dir(&local_path).await?;
  let mut local_filenames = vec![];
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
    let filename = match entry.file_name().to_str() {
      None => return Err(format!("Could not interpret filename: {:?}", entry.file_name()).into()),
      Some(filename) => filename.to_owned()
    };
    local_filenames.push(filename);
  }
  local_filenames.sort();

  // Validate container.
  let container_id = match sub_matches.get_one::<String>("container_id") {
    Some(uid_maybe) => {
      if !is_uid(&uid_maybe) {
        return Err(format!("Invalid container id: '{}'.", uid_maybe).into());
      }
      uid_maybe
    },
    None => { return Err("Id of container to upload files into must be specified.".into()); }
  };

  let session_name = sub_matches.get_one::<String>("session").unwrap();

  let named_session = NamedInfuSession::get(session_name).await
    .map_err(|e| format!("A problem occurred getting session '{}': {}.", session_name, e))?
    .ok_or("Session does not exist - use the login CLI command to create one.")?;

  let session_cookie_value = serde_json::to_string(&named_session.session)?;
  let mut request_headers = reqwest::header::HeaderMap::new();
  request_headers.insert(
    reqwest::header::COOKIE,
    reqwest::header::HeaderValue::from_str(&format!("infusession={}", session_cookie_value)).unwrap());

  // Get children of container.
  let get_children_request = serde_json::to_string(&GetItemsRequest {
    id: container_id.clone(),
    mode: String::from(GetItemsMode::ChildrenAndTheirAttachmentsOnly.as_str())
  }).unwrap();
  let send_reqest = CommandRequest {
    command: "get-items".to_owned(),
    json_data: get_children_request,
    base64_data: None,
  };
  let container_children_response: CommandResponse = reqwest::ClientBuilder::new()
    .default_headers(request_headers.clone()).build().unwrap()
    .post(named_session.command_url()?.clone())
    .json(&send_reqest)
    .send()
    .await.map_err(|e| e.to_string())?
    .json()
    .await.map_err(|e| e.to_string())?;
  if !container_children_response.success {
    if let Some(reason) = container_children_response.fail_reason {
      if reason == "invalid-session" {
        return Err("Invalid session. Note that sessions do not survive server a restart - perhaps the server was restarted.".into());
      } else {
        return Err(format!("Query for container contents failed. Reason: {}", reason).into());
      }
    } else {
      return Err("Query for container contents failed.".into());
    }
  }

  let json_data = container_children_response.json_data.ok_or("Request for children yielded no data.")?;
  let json = serde_json::from_str::<Map<String, Value>>(&json_data).map_err(|e| e.to_string())?;
  let children = json.get("children").ok_or("Request for children yielded an unexpected result (no children property).")?;
  let container_children = children.as_array().ok_or("Request for children yielded an unexpected result (children property is not an array).")?;
  if container_children.len() != 0 && !resuming && !additional {
    return Err(format!("Specified container '{}' is not empty. Either the 'additional' or 'resuming' flag must be set", container_id.clone()).into());
  }
  let container_children_titles = container_children.iter().map(|child| -> InfuResult<String> {
    Ok(child
        .as_object().ok_or("item is not an object")?
        .get("title").ok_or("item does not have title property.")?
        .as_str().ok_or("Title property is not of type string.")?.to_owned())
  }).collect::<InfuResult<Vec<String>>>()?;

  // 'resuming' flag validation.
  for filename in &local_filenames {
    if container_children_titles.contains(filename) && !resuming {
      return Err(format!("Infumap container has existing item with name '{}', and resume flag is not set.", filename).into());
    }
  }

  // 'additional' flag check.
  for item_name in &container_children_titles {
    if !local_filenames.contains(item_name) && !additional {
      return Err(format!("Infumap container has an existing item '{}' that is not present in the local directory, and the 'additional' flag is not set.", item_name).into());
    }
  }

  let mut num_skipped = 0;
  for i in 0..local_filenames.len() {
    let filename = &local_filenames[i];
    let mut path = local_path.clone();
    path.push(filename);

    if container_children_titles.contains(filename) {
      println!("File '{}' is already present in the container, skipping.", filename);
      continue;
    }

    let mime_type = match mime_guess::from_path(filename).first_raw() {
      Some(mime_type) => mime_type,
      None => "application/octet-stream"
    };

    let mut f = File::open(&path).await?;
    let metadata = tokio::fs::metadata(&path).await?;
    let mut buffer = vec![0; metadata.len() as usize];
    f.read_exact(&mut buffer).await?;
    let base_64_encoded = general_purpose::STANDARD.encode(&buffer);

    let mut item: Map<String, Value> = Map::new();
    item.insert("parentId".to_owned(), Value::String(container_id.clone()));
    item.insert("title".to_owned(), Value::String(filename.clone()));
    item.insert("spatialWidthGr".to_owned(), Value::Number((GRID_SIZE * 6).into()));
    item.insert("originalCreationDate".to_owned(),
      Value::Number(metadata.created().map_err(|e| e.to_string())?.duration_since(UNIX_EPOCH)?.as_secs().into()));
    item.insert("mimeType".to_owned(), Value::String(mime_type.to_owned()));
    item.insert("fileSizeBytes".to_owned(), Value::Number(metadata.len().into()));

    if filename.to_lowercase().ends_with(".png") || filename.to_lowercase().ends_with(".jpg") || filename.to_lowercase().ends_with(".jpeg") {
      let file_cursor = Cursor::new(buffer.clone());
      let file_reader = ImageReader::new(file_cursor).with_guessed_format()?;
      match file_reader.decode() {
        Ok(img) => {
          let exif_orientation = get_exif_orientation(buffer.clone(), filename);
          let img = adjust_image_for_exif_orientation(img, exif_orientation, filename);
          item.insert("itemType".to_owned(), Value::String(ItemType::Image.as_str().to_owned()));
          item.insert("imageSizePx".to_owned(),
            json::dimensions_to_object(&Dimensions { w: img.width().into(), h: img.height().into() }));
          item.insert("thumbnail".to_owned(), Value::String("".to_owned())); // set on the server.
          if exif_orientation > 1 {
            debug!("Note: image has exif orientation type of: {}", exif_orientation);
          }
          print!("Adding image '{}' {}/{}... ", filename, i+1, local_filenames.len());
          std::io::stdout().flush()?;
        },
        Err(_e) => {
          item.insert("itemType".to_owned(), Value::String(ItemType::File.as_str().to_owned()));
          print!("Could not interpret file '{}' as an image, adding as an item of type file {}/{}... ", filename, i, local_filenames.len());
          std::io::stdout().flush()?;
        }
      }
    } else {
      item.insert("itemType".to_owned(), Value::String(ItemType::File.as_str().to_owned()));
      print!("Adding file '{}' {}/{}... ", filename, i+1, local_filenames.len());
      std::io::stdout().flush()?;
    }

    let add_item_request = serde_json::to_string(&item)?;
    let send_reqest = CommandRequest {
      command: "add-item".to_owned(),
      json_data: add_item_request,
      base64_data: Some(base_64_encoded),
    };

    loop {
      let add_item_response = reqwest::ClientBuilder::new()
        .default_headers(request_headers.clone()).build().unwrap()
        .post(named_session.command_url()?.clone())
        .json(&send_reqest)
        .send()
        .await;
      match add_item_response {
        Ok(r) => {
          let json_response: CommandResponse = r.json().await.map_err(|e| e.to_string())?;
          if !json_response.success {
            println!("Infumap rejected the add-item command - skipping.");
            num_skipped += 1;
          } else {
            println!("success!");
          }
          break;
        },
        Err(e) => {
          println!("there was a connection issue sending the add-item request - retrying: {}", e);
          tokio::time::sleep(Duration::from_secs(2)).await;
        }
      }
    }
  }
  println!("Number skipped: {}", num_skipped);

  Ok(())
}
