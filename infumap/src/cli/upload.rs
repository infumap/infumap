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

use std::io::Cursor;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;
use std::time::UNIX_EPOCH;

use base64::{Engine as _, engine::general_purpose};
use clap::{App, Arg, ArgMatches};
use image::io::Reader;
use log::debug;
use serde_json::Map;
use serde_json::Value;
use tokio::fs;
use tokio::fs::File;
use tokio::io::AsyncReadExt;

use crate::storage::db::item::ITEM_TYPE_FILE;
use crate::storage::db::item::ITEM_TYPE_IMAGE;
use crate::util::fs::expand_tilde;
use crate::util::geometry::Dimensions;
use crate::util::geometry::GRID_SIZE;
use crate::util::image::adjust_image_for_exif_orientation;
use crate::util::image::get_exif_orientation;
use crate::util::infu::InfuResult;
use crate::util::json;
use crate::util::uid::is_uid;
use crate::web::routes::command::GetChildrenRequest;
use crate::web::routes::command::SendRequest;
use crate::web::routes::command::SendResponse;

use super::NamedInfuSession;


pub fn make_clap_subcommand<'a, 'b>() -> App<'a> {
  App::new("upload")
    .about("Bulk upload all files in a local directory to an Infumap container.")
    .arg(Arg::new("container_id")
      .short('c')
      .long("container_id")
      .help("The id of the container to upload files to.")
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
    .arg(Arg::new("session")
      .short('s')
      .long("session")
      .help("The name of the Infumap session to use. 'default' will be used if not specified.")
      .takes_value(true)
      .multiple_values(false)
      .required(false))
    .arg(Arg::new("resume")
      .short('r')
      .long("resume")
      .help(concat!("By default, if the Infumap container has a file or image with the same name as a file in the local directory, ",
                    "the bulk upload operation will not start. If this flag is set, these files will be skipped instead."))
      .takes_value(false)
      .required(false))
    .arg(Arg::new("additional")
      .short('a')
      .long("additional")
      .help(concat!("By default, an attempt to upload files to an Infumap container that contains files with names other than those ",
                    "in the local directory will fail. Setting this flag disables this check."))
      .takes_value(false)
      .required(false))
}


pub async fn execute<'a>(sub_matches: &ArgMatches) -> InfuResult<()> {
  let resuming = sub_matches.is_present("resume");
  let additional = sub_matches.is_present("additional");

  // Validate directory.
  let local_path = match sub_matches.value_of("directory").map(|v| v.to_string()) {
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

  // Validate container.
  let container_id = match sub_matches.value_of("container_id").map(|v| v.to_string()) {
    Some(uid_maybe) => {
      if !is_uid(&uid_maybe) {
        return Err(format!("Invalid container id: '{}'.", uid_maybe).into());
      }
      uid_maybe
    },
    None => { return Err("Id of container to upload files into must be specified.".into()); }
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

  let session_cookie_value = serde_json::to_string(&named_session.session)?;
  let mut request_headers = reqwest::header::HeaderMap::new();
  request_headers.insert(
    reqwest::header::COOKIE,
    reqwest::header::HeaderValue::from_str(&format!("infusession={}", session_cookie_value)).unwrap());

  // Get children of container.
  let get_children_request = serde_json::to_string(&GetChildrenRequest { parent_id_maybe: Some(container_id.clone()) }).unwrap();
  let send_reqest = SendRequest {
    command: "get-children-with-their-attachments".to_owned(),
    json_data: get_children_request,
    base64_data: None,
  };
  let container_children_response: SendResponse = reqwest::ClientBuilder::new()
    .default_headers(request_headers.clone()).build().unwrap()
    .post(named_session.command_url()?.clone())
    .json(&send_reqest)
    .send()
    .await.map_err(|e| e.to_string())?
    .json()
    .await.map_err(|e| e.to_string())?;
  if !container_children_response.success {
    println!("Query for container contents failed.");
  }

  let json_data = container_children_response.json_data.ok_or("Request for children yielded no data.")?;
  let json = serde_json::from_str::<Map<String, Value>>(&json_data).map_err(|e| e.to_string())?;
  let children = json.get("children").ok_or("Request for children yielded an unexpected result (no children property).")?;
  let container_children = children.as_array().ok_or("Request for children yielded an unexpected result (children property is not an array).")?;
  if container_children.len() != 0 && !resuming && !additional {
    println!("Specified container '{}' is not empty. Either the 'additional' or 'resuming' flag must be set", container_id.clone());
    return Ok(());
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

  for i in 1..local_filenames.len() {
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
          print!("Adding image '{}' {}/{}... ", filename, i, local_filenames.len());
          std::io::stdout().flush()?;
        },
        Err(_e) => {
          item.insert("itemType".to_owned(), Value::String(ITEM_TYPE_FILE.to_owned()));
          print!("Could not interpret file '{}' as an image, adding as an item of type file {}/{}... ", filename, i, local_filenames.len());
          std::io::stdout().flush()?;
        }
      }
    } else {
      item.insert("itemType".to_owned(), Value::String(ITEM_TYPE_FILE.to_owned()));
      print!("Adding file '{}' {}/{}... ", filename, i, local_filenames.len());
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
        .post(named_session.command_url()?.clone())
        .json(&send_reqest)
        .send()
        .await;
      match add_item_response {
        Ok(r) => {
          let json_response: SendResponse = r.json().await.map_err(|e| e.to_string())?;
          if !json_response.success {
            println!("Infumap rejected the add-item command - skipping.");
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

  Ok(())
}
