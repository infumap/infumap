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

use clap::{Command, Arg, ArgMatches};
use infusdk::util::infu::InfuResult;
use crate::config::CONFIG_DATA_DIR;
use crate::setup::get_config;
use crate::storage::db::item_db::ItemDb;
use crate::storage::db::user_db::UserDb;


pub fn make_clap_subcommand() -> Command {
  Command::new("compact")
    .about("Compact a user's item database.")
    .arg(Arg::new("user_id")
      .short('i')
      .long("id")
      .help("The id of the user to compact the item database of.")
      .num_args(1)
      .required(true))
    .arg(Arg::new("settings_path")
      .short('s')
      .long("settings")
      .help(concat!("Path to a toml settings configuration file. If not specified, the default will be assumed."))
      .num_args(1)
      .required(false))
}

pub async fn execute(sub_matches: &ArgMatches) -> InfuResult<()> {
  let config = get_config(sub_matches.get_one::<String>("settings_path")).await?;
  let data_dir = config.get_string(&CONFIG_DATA_DIR).map_err(|e| e.to_string())?;

  let user_id = sub_matches.get_one::<String>("user_id").ok_or("no user_id")?;
  let user_db = UserDb::init(&data_dir).await?;
  let mut item_db = ItemDb::init(&data_dir);
  item_db.load_user_items(user_id, false).await?;
  let user = user_db.get(user_id).ok_or(format!("user with id '{}' does not exist.", user_id))?;

  item_db.compact(user).await?;

  Ok(())
}
