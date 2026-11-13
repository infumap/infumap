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

use clap::Command;
use infumap::{cli, init_logger, web};

#[tokio::main]
async fn main() {
  let arg_matches = Command::new("Infumap")
    .version("0.10.0")
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
    .subcommand(cli::rekey::make_clap_subcommand())
    .subcommand(cli::reprocess::make_clap_subcommand())
    .subcommand(cli::restore::make_clap_subcommand())
    .subcommand(cli::rebuild_search_index::make_clap_subcommand())
    .subcommand(cli::extract::make_clap_subcommand())
    .subcommand(cli::fragment::make_clap_subcommand())
    .subcommand(cli::geo::make_clap_subcommand())
    .subcommand(cli::stats::make_clap_subcommand())
    .subcommand(cli::tool::make_clap_subcommand())
    .subcommand(cli::upload::make_clap_subcommand())
    .subcommand(web::make_clap_subcommand())
    .about("Infumap")
    .get_matches();

  let command_result = match arg_matches.subcommand() {
    Some(("web", arg_sub_matches)) => web::execute(&arg_sub_matches).await,
    Some((command, arg_sub_matches)) => match init_logger(None) {
      Err(e) => Err(e),
      Ok(()) => match command {
        "compact" => cli::compact::execute(&arg_sub_matches).await,
        "emergency" => cli::emergency::execute(&arg_sub_matches).await,
        "keygen" => cli::keygen::execute(&arg_sub_matches),
        "login" => cli::login::execute(&arg_sub_matches).await,
        "logout" => cli::logout::execute(&arg_sub_matches).await,
        "ls" => cli::ls::execute(&arg_sub_matches).await,
        "migrate" => cli::migrate::execute(&arg_sub_matches).await,
        "note" => cli::note::execute(&arg_sub_matches).await,
        "pending" => cli::pending::execute(&arg_sub_matches).await,
        "reconcile" => cli::reconcile::execute(&arg_sub_matches).await,
        "rekey" => cli::rekey::execute(&arg_sub_matches),
        "reprocess" => cli::reprocess::execute(&arg_sub_matches).await,
        "restore" => cli::restore::execute(&arg_sub_matches).await,
        "rebuild-search-index" => cli::rebuild_search_index::execute(&arg_sub_matches).await,
        "extract" => cli::extract::execute(&arg_sub_matches).await,
        "fragment" => cli::fragment::execute(&arg_sub_matches).await,
        "geo" => cli::geo::execute(&arg_sub_matches).await,
        "stats" => cli::stats::execute(&arg_sub_matches).await,
        "tool" => cli::tool::execute(&arg_sub_matches).await,
        "upload" => cli::upload::execute(&arg_sub_matches).await,
        _ => {
          println!(".. --help for help.");
          Ok(())
        }
      },
    },
    _ => {
      println!(".. --help for help.");
      Ok(())
    }
  };

  match command_result {
    Ok(_) => {}
    Err(e) => {
      if arg_matches.subcommand_name() == Some("tool") {
        eprintln!("{}", e);
        std::process::exit(1);
      }
      // Not using logger here, as the error may have been in initializing the logger.
      eprintln!("{}", e);
    }
  }
}
