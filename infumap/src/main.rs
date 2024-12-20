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

mod config;
mod storage;
mod util;
mod web;
mod cli;
mod setup;
mod tokiort;
use std::str::FromStr;

use clap::Command;
use infusdk::util::infu::InfuResult;
use std::env;


#[tokio::main]
async fn main() {
  let arg_matches = Command::new("Infumap")
    .version("0.1.0")
    .subcommand(cli::compact::make_clap_subcommand())
    .subcommand(cli::emergency::make_clap_subcommand())
    .subcommand(cli::keygen::make_clap_subcommand())
    .subcommand(cli::login::make_clap_subcommand())
    .subcommand(cli::logout::make_clap_subcommand())
    .subcommand(cli::ls::make_clap_subcommand())
    .subcommand(cli::migrate::make_clap_subcommand())
    .subcommand(cli::note::make_clap_subcommand())
    .subcommand(cli::pending::make_clap_subcommand())
    .subcommand(cli::reconcile::make_clap_subcommand())
    .subcommand(cli::restore::make_clap_subcommand())
    .subcommand(cli::upload::make_clap_subcommand())
    .subcommand(web::make_clap_subcommand())
    .about("Infumap")
    .get_matches();

  let command_result = match arg_matches.subcommand() {
    Some(("web", arg_sub_matches)) => {
      web::execute(&arg_sub_matches).await
    },
    Some((command, arg_sub_matches)) => {
      match init_logger(None) {
        Err(e) => Err(e),
        Ok(()) => {
          match command {
            "compact" => {
              cli::compact::execute(&arg_sub_matches).await
            },
            "emergency" => {
              cli::emergency::execute(&arg_sub_matches).await
            },
            "keygen" => {
              cli::keygen::execute(&arg_sub_matches)
            },
            "login" => {
              cli::login::execute(&arg_sub_matches).await
            },
            "logout" => {
              cli::logout::execute(&arg_sub_matches).await
            },
            "ls" => {
              cli::ls::execute(&arg_sub_matches).await
            },
            "migrate" => {
              cli::migrate::execute(&arg_sub_matches).await
            },
            "note" => {
              cli::note::execute(&arg_sub_matches).await
            },
            "pending" => {
              cli::pending::execute(&arg_sub_matches).await
            },
            "reconcile" => {
              cli::reconcile::execute(&arg_sub_matches).await
            },
            "restore" => {
              cli::restore::execute(&arg_sub_matches).await
            },
            "upload" => {
              cli::upload::execute(&arg_sub_matches).await
            },
            _ => {
              println!(".. --help for help.");
              Ok(())
            }
          }
        }
      }
    },
    _ => {
      println!(".. --help for help.");
      Ok(())
    }
  };

  match command_result {
    Ok(_) => {},
    Err(e) => {
      // Not using logger here, as the error may have been in initializing the logger.
      println!("{}", e);
    }
  }
}


fn init_logger(level: Option<String>) -> InfuResult<()> {
  // pretty_env_logger::init();
  let level = if let Some(level) = level {
    log::LevelFilter::from_str(&level).map_err(|e| format!("Could not parse log level: {}", e))?
  } else {
    let key = "INFUMAP_LOG_LEVEL";
    let log_level_str = match env::var(key) {
      Err(_) => "info".to_owned(),
      Ok(v) => v
    };
    log::LevelFilter::from_str(&log_level_str).map_err(|e| format!("Could not parse log level: {}", e))?
  };
  pretty_env_logger::formatted_timed_builder()
    .format_timestamp_secs()
    .filter_module("infumap", level)
    .init();
  Ok(())
}
