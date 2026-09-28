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

use clap::{Arg, ArgMatches, Command};
use infusdk::util::infu::InfuResult;
use infusdk::util::uid::is_uid;

use crate::web::routes::command::{CommandRequest, CommandResponse};

use super::{NamedInfuSession, build_http_client, build_session_headers};

pub fn make_clap_subcommand() -> Command {
  Command::new("reprocess")
    .about("Ask a running Infumap server to discard an item's generated search text and fragments, then regenerate and reindex them. Location output is kept.")
    .arg(
      Arg::new("item_id")
        .short('i')
        .long("id")
        .help("The id of the item to reprocess.")
        .num_args(1)
        .required(true),
    )
    .arg(
      Arg::new("session")
        .short('s')
        .long("session")
        .help("The name of the Infumap session to use. 'default' will be used if not specified.")
        .num_args(1)
        .default_value("default")
        .required(false),
    )
}

pub async fn execute(sub_matches: &ArgMatches) -> InfuResult<()> {
  let session_name = sub_matches.get_one::<String>("session").unwrap().as_str();
  let item_id = sub_matches.get_one::<String>("item_id").unwrap();
  if !is_uid(item_id) {
    return Err(format!("Invalid item id: '{}'.", item_id).into());
  }

  let mut named_session = NamedInfuSession::get(session_name)
    .await
    .map_err(|e| format!("A problem occurred getting session '{}': {}.", session_name, e))?
    .ok_or("Session does not exist - use the login CLI command to create one.")?;

  let client = build_http_client(Some(build_session_headers(&named_session.session)?)).await?;
  let send_request = CommandRequest {
    command: "reprocess-item".to_owned(),
    json_data: serde_json::json!({ "id": item_id }).to_string(),
    base64_data: None,
  };
  let response =
    client.post(named_session.command_url()?.clone()).json(&send_request).send().await.map_err(|e| format!("{}", e))?;
  named_session.update_from_response(&response).await?;
  let response: CommandResponse = response.json().await.map_err(|e| format!("{}", e))?;
  if !response.success {
    return Err(
      format!(
        "Infumap rejected the reprocess-item command ({}). Check the item id and that your session has not expired.",
        response.fail_reason.unwrap_or_default()
      )
      .into(),
    );
  }

  println!("Queued item '{}' for search reprocessing.", item_id);
  Ok(())
}
