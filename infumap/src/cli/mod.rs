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

use std::path::PathBuf;

use infusdk::util::infu::InfuResult;
use log::debug;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use tokio::fs::File;
use tokio::fs::OpenOptions;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;

use crate::web::cookie::InfuSession;
use crate::util::fs::{expand_tilde, path_exists};

pub mod compact;
pub mod emergency;
pub mod keygen;
pub mod login;
pub mod logout;
pub mod ls;
pub mod migrate;
pub mod note;
pub mod reconcile;
pub mod restore;
pub mod upload;
pub mod pending;


#[derive(Deserialize, Serialize, Clone)]
pub struct NamedInfuSession {
  pub session: InfuSession,
  pub name: String,
  pub url: String
}


impl NamedInfuSession {
  pub fn _login_url(&self) -> InfuResult<Url> {
    login_url_from_base_url(&self.url)
  }

  pub fn logout_url(&self) -> InfuResult<Url> {
    logout_url_from_base_url(&self.url)
  }

  pub fn command_url(&self) -> InfuResult<Url> {
    command_url_from_base_url(&self.url)
  }

  pub fn list_pending_users_url(&self) -> InfuResult<Url> {
    list_pending_users_url_from_base_url(&self.url)
  }

  pub fn approve_pending_user_url(&self) -> InfuResult<Url> {
    approve_pending_user_url_from_base_url(&self.url)
  }

  pub async fn get(name: &str) -> InfuResult<Option<NamedInfuSession>> {
    let sessions = Self::read_sessions().await?;
    let session = sessions.iter().find(|s| s.name == name);
    match session {
      Some(s) => Ok(Some(s.clone())),
      None => Ok(None)
    }
  }

  async fn read_sessions() -> InfuResult<Vec<NamedInfuSession>> {
    let session_file_path = Self::get_cli_sessions_path().await?;
    if !path_exists(&session_file_path).await { return Ok(vec![]); }
    let mut f = File::open(&session_file_path).await
      .map_err(|e| format!("Could not open CLI sessions.json file for reading: {}", e))?;
    let mut buffer = vec![0; tokio::fs::metadata(&session_file_path).await?.len() as usize];
    f.read_exact(&mut buffer).await
      .map_err(|e| format!("Could not read contents of the CLI sessions.json file: {}", e))?;
    let sessions: Vec<NamedInfuSession> = serde_json::from_str(
      &String::from_utf8(buffer)
        .map_err(|e| format!("Could not interpret the CLI sessions.json file as utf8: {}", e))?)
          .map_err(|e| format!("Could not deserialize CLI sessions.json file: {}", e))?;
    Ok(sessions)
  }

  async fn write_sessions(sessions: &Vec<&NamedInfuSession>) -> InfuResult<()> {
    let session_file_path = Self::get_cli_sessions_path().await?;
    let mut file = OpenOptions::new()
      .create(true)
      .truncate(true)
      .write(true)
      .open(session_file_path).await?;
    let sessions_str = serde_json::to_string(&sessions)?;
    file.write_all(&sessions_str.as_bytes()).await?;
    file.flush().await?;
    Ok(())
  }

  async fn get_cli_sessions_path() -> InfuResult<PathBuf> {
    let dot_infumap_path = PathBuf::from(
      expand_tilde("~/.infumap").ok_or(format!("Could not determine ~/.infumap path."))?);
    if !path_exists(&dot_infumap_path).await {
      debug!("Creating ~/.infumap directory.");
      tokio::fs::create_dir(&dot_infumap_path).await
        .map_err(|e| format!("Could not create .infumap directory: {}", e))?;
    }
    let mut cli_dir_path = PathBuf::from(dot_infumap_path);
    cli_dir_path.push("cli");
    if !path_exists(&cli_dir_path).await {
      debug!("Creating ~/.infumap/cli directory.");
      tokio::fs::create_dir(&cli_dir_path).await
        .map_err(|e| format!("Could not create cli directory: {}", e))?;
    }
    let mut session_file_path = PathBuf::from(cli_dir_path);
    session_file_path.push("sessions.json");
    Ok(session_file_path)
  }

}


fn logout_url_from_base_url(base_url: &str) -> InfuResult<Url> {
  let base_url = Url::parse(base_url)
    .map_err(|e| format!("Could not parse URL: {}", e))?;
  base_url.join("/account/logout").map_err(|e| e.to_string().into())
}

fn login_url_from_base_url(base_url: &str) -> InfuResult<Url> {
  let base_url = Url::parse(base_url)
    .map_err(|e| format!("Could not parse URL: {}", e))?;
  base_url.join("/account/login").map_err(|e| e.to_string().into())
}

fn command_url_from_base_url(base_url: &str) -> InfuResult<Url> {
  let base_url = Url::parse(base_url)
    .map_err(|e| format!("Could not parse URL: {}", e))?;
  base_url.join("/command").map_err(|e| e.to_string().into())
}

fn list_pending_users_url_from_base_url(base_url: &str) -> InfuResult<Url> {
  let base_url = Url::parse(base_url)
    .map_err(|e| format!("Could not parse URL: {}", e))?;
  base_url.join("/admin/list-pending").map_err(|e| e.to_string().into())
}

fn approve_pending_user_url_from_base_url(base_url: &str) -> InfuResult<Url> {
  let base_url = Url::parse(base_url)
    .map_err(|e| format!("Could not parse URL: {}", e))?;
  base_url.join("/admin/approve-pending").map_err(|e| e.to_string().into())
}
