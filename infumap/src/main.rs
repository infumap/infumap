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

mod config;
mod storage;
mod util;
mod web;
mod cli;
mod setup;
use clap::{App, Arg};
use log::error;


#[tokio::main]
async fn main() {
  pretty_env_logger::init();

  let arg_matches = App::new("Infumap")
    .version("0.1.0")
    .subcommand(cli::keygen::make_clap_subcommand())
    .subcommand(cli::login::make_clap_subcommand())
    .subcommand(cli::logout::make_clap_subcommand())
    .subcommand(cli::migrate::make_clap_subcommand())
    .subcommand(cli::note::make_clap_subcommand())
    .subcommand(cli::repair::make_clap_subcommand())
    .subcommand(cli::restore::make_clap_subcommand())
    .subcommand(cli::upload::make_clap_subcommand())
    .about("Infumap")
    .arg(Arg::new("settings_path")
      .short('s')
      .long("settings")
      .help(concat!("Path to a toml settings configuration file. If not specified and env_only config is not specified ",
                    "via env vars, ~/.infumap/settings.toml will be used. If it does not exist, it will created with ",
                    "default values. On-disk data directories will also be created in ~/.infumap."))
      .takes_value(true)
      .multiple_values(false)
      .required(false))
    .get_matches();

  let command_result = match arg_matches.subcommand() {
    Some(("keygen", arg_sub_matches)) => {
      cli::keygen::execute(arg_sub_matches)
    },
    Some(("login", arg_sub_matches)) => {
      cli::login::execute(arg_sub_matches).await
    },
    Some(("logout", arg_sub_matches)) => {
      cli::logout::execute(arg_sub_matches).await
    },
    Some(("migrate", arg_sub_matches)) => {
      cli::migrate::execute(arg_sub_matches)
    },
    Some(("note", arg_sub_matches)) => {
      cli::note::execute(arg_sub_matches).await
    },
    Some(("repair", arg_sub_matches)) => {
      cli::repair::execute(arg_sub_matches).await
    }
    Some(("restore", arg_sub_matches)) => {
      cli::restore::execute(arg_sub_matches).await
    },
    Some(("upload", arg_sub_matches)) => {
      cli::upload::execute(arg_sub_matches).await
    },
    Some((_, _arg_sub_matches)) => {
      println!(".. --help for help.");
      Ok(())
    },
    _ => {
      web::execute(&arg_matches).await
    }
  };

  match command_result {
    Ok(_) => {},
    Err(e) => { error!("{}", e); }
  }
}
