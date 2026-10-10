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
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

use clap::{Arg, ArgMatches, Command, value_parser};
use infusdk::util::infu::InfuResult;
use serde_json::{Value, json};

use super::{NamedInfuSession, build_http_client, build_session_headers};

pub fn make_clap_subcommand() -> Command {
  Command::new("tool")
    .about("Call a built-in read-only chat tool without invoking an LLM; print its JSON result.")
    .subcommand_required(true)
    .arg_required_else_help(true)
    .arg(
      Arg::new("session")
        .short('s')
        .long("session")
        .global(true)
        .default_value("default")
        .help("The name of the Infumap CLI session to use."),
    )
    .arg(Arg::new("scope").long("scope").global(true).help("Scope id limiting what the tool can search or read."))
    .subcommand(
      Command::new("lexical_search")
        .about("Search item titles and indexed document text.")
        .arg(Arg::new("text").required(true).help("Search words; quote queries containing spaces."))
        .arg(Arg::new("within").long("within").help("Page or table link (or bare id) to search within."))
        .arg(
          Arg::new("num-results")
            .long("num-results")
            .value_parser(value_parser!(i64).range(1..=20))
            .help("Maximum results, 1–20 (default: 8)."),
        )
        .arg(
          Arg::new("page-num")
            .long("page-num")
            .value_parser(value_parser!(i64).range(1..))
            .help("One-based results page (default: 1)."),
        ),
    )
    .subcommand(
      Command::new("get_fragment")
        .about("Read an item's text or contents, a fragment at a time.")
        .arg(Arg::new("link").required(true).help("Item infumap:// link or bare id."))
        .arg(
          Arg::new("fragment-ordinal")
            .long("fragment-ordinal")
            .value_parser(value_parser!(i64).range(0..))
            .help("Zero-based starting fragment (default: 0)."),
        )
        .arg(
          Arg::new("count")
            .long("count")
            .value_parser(value_parser!(i64).range(1..=3))
            .help("Consecutive fragments, 1–3 (default: 1)."),
        )
        .arg(Arg::new("version").long("version").help("Version from an earlier response, to detect changes.")),
    )
}

pub async fn execute(matches: &ArgMatches) -> InfuResult<()> {
  let (name, arguments_matches) = matches.subcommand().ok_or("A tool name is required.")?;
  let mut arguments = serde_json::Map::new();
  let (string_args, number_args): (&[(&str, &str)], &[(&str, &str)]) = match name {
    "lexical_search" => {
      (&[("text", "text"), ("within", "within")], &[("num-results", "numResults"), ("page-num", "pageNum")])
    }
    "get_fragment" => {
      (&[("link", "link"), ("version", "version")], &[("fragment-ordinal", "fragmentOrdinal"), ("count", "count")])
    }
    _ => return Err(format!("Unknown built-in tool '{name}'.").into()),
  };
  for &(flag, key) in string_args {
    if let Some(value) = arguments_matches.get_one::<String>(flag) {
      arguments.insert(key.to_owned(), json!(value));
    }
  }
  for &(flag, key) in number_args {
    if let Some(value) = arguments_matches.get_one::<i64>(flag) {
      arguments.insert(key.to_owned(), json!(value));
    }
  }

  let session_name = matches.get_one::<String>("session").unwrap();
  let mut named_session = NamedInfuSession::get(session_name)
    .await?
    .ok_or("Session does not exist - use the login CLI command to create one.")?;
  let client = build_http_client(Some(build_session_headers(&named_session.session)?)).await?;
  let url = named_session.command_url()?.join("/chat/tool").map_err(|e| format!("Could not build tool URL: {e}"))?;
  let mut request = json!({ "name": name, "arguments": arguments });
  if let Some(scope) = matches.get_one::<String>("scope") {
    request["scopeId"] = json!(scope);
  }
  let response = client.post(url).json(&request).send().await.map_err(|e| format!("Could not call tool: {e}"))?;
  named_session.update_from_response(&response).await?;
  let status = response.status();
  let result: Value = response.json().await.map_err(|e| format!("Invalid tool response (HTTP {status}): {e}"))?;
  println!("{}", serde_json::to_string_pretty(&result)?);
  if !status.is_success() || result.get("error").is_some() {
    return Err(format!("Tool '{name}' failed (HTTP {status}); see the JSON result on stdout.").into());
  }
  Ok(())
}
