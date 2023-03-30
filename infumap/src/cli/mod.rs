// Copyright (C) 2022-2023 The Infumap Authors
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

use log::debug;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use tokio::fs::File;
use tokio::fs::OpenOptions;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;

use crate::web::cookie::InfuSession;
use crate::util::fs::{expand_tilde, path_exists};
use crate::util::infu::InfuResult;

pub mod keygen;
pub mod login;
pub mod logout;
pub mod migrate;
pub mod note;
pub mod repair;
pub mod restore;
pub mod upload;


#[derive(Deserialize, Serialize, Clone)]
pub struct NamedInfuSession {
  pub session: InfuSession,
  pub name: String,
  pub url: String
}

impl NamedInfuSession {
  pub fn _login_url(&self) -> InfuResult<Url> {
    let base_url = Url::parse(&self.url)
      .map_err(|e| format!("Could not parse URL: {}", e))?;
    Ok(base_url.join("/account/login").map_err(|e| e.to_string())?)
  }

  pub fn command_url(&self) -> InfuResult<Url> {
    let base_url = Url::parse(&self.url)
      .map_err(|e| format!("Could not parse URL: {}", e))?;
    Ok(base_url.join("/command").map_err(|e| e.to_string())?)
  }

  pub async fn get(name: &str) -> InfuResult<NamedInfuSession> {
    let sessions = Self::read_sessions().await?;
    let session = sessions.iter().find(|s| s.name == name);
    match session {
      Some(s) => Ok(s.clone()),
      None => Err(format!("Session '{}' does not exist.", name).into())
    }
  }
  
  async fn read_sessions() -> InfuResult<Vec<NamedInfuSession>> {
    let session_file_path = Self::get_cli_sessions_path().await?;
    let mut f = File::open(&session_file_path).await?;
    let mut buffer = vec![0; tokio::fs::metadata(&session_file_path).await?.len() as usize];
    f.read_exact(&mut buffer).await?;
    let sessions: Vec<NamedInfuSession> = serde_json::from_str(
      &String::from_utf8(buffer).map_err(|e| format!("{}", e))?)?;
    Ok(sessions)
  }

  async fn write_sessions(sessions: &Vec<&NamedInfuSession>) -> InfuResult<()> {
    let session_file_path = Self::get_cli_sessions_path().await?;
    let mut file = OpenOptions::new()
      .create(true)
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
      tokio::fs::create_dir(&dot_infumap_path).await?;
    }
    let mut cli_dir_path = PathBuf::from(dot_infumap_path);
    cli_dir_path.push("cli");
    if !path_exists(&cli_dir_path).await {
      debug!("Creating ~/.infumap/cli directory.");
      tokio::fs::create_dir(&cli_dir_path).await?;
    }
    let mut session_file_path = PathBuf::from(cli_dir_path);
    session_file_path.push("sessions.json");
    Ok(session_file_path)
  }

}
