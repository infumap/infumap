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

mod dist_handlers;
mod responders;
mod prometheus;
mod rocket_config;
pub mod routes;
pub mod cookie;
pub mod session;

use std::sync::Mutex;

use rocket::response::content::RawHtml;
use rocket::{Rocket, Build};
use rocket::fairing::AdHoc;
use clap::ArgMatches;
use crate::config::*;
use crate::storage::cache::FileCache;
use crate::storage::file::FileStore;
use crate::storage::db::Db;
use crate::setup::init_fs_and_config;
use crate::util::infu::InfuResult;


pub async fn execute<'a>(arg_matches: &ArgMatches) -> InfuResult<()> {
  let config_and_path = init_fs_and_config(
    arg_matches.value_of("settings_path").map(|a| a.to_string()))?;
  let config = config_and_path.config.clone();

  let data_dir = config.get_string(CONFIG_DATA_DIR)?;
  let init_db = |rocket: Rocket<Build>| async move {
    rocket.manage(Mutex::new(
      match Db::new( &data_dir) {
        Ok(db) => db,
        Err(e) => {
          println!("{}", e);
          panic!();
        }
      }))
  };

  let data_dir = config.get_string(CONFIG_DATA_DIR)?;
  let init_file_store = |rocket: Rocket<Build>| async move {
    rocket.manage(Mutex::new(
      match FileStore::new(&data_dir) {
        Ok(file_store) => file_store,
        Err(e) => {
          println!("Failed to initialize file store: {}", e);
          panic!();
        }
      }))
  };

  let cache_dir = config.get_string(CONFIG_CACHE_DIR)?;
  let cache_max_mb = usize::try_from(config.get_int(CONFIG_CACHE_MAX_MB)?)?;
  let init_cache = move |rocket: Rocket<Build>| async move {
    rocket.manage(Mutex::new(
      match FileCache::new(&cache_dir, cache_max_mb) {
        Ok(file_cache) => file_cache,
        Err(e) => {
          println!("Failed to initialize config: {}", e);
          panic!();
        }
      }))
  };

  let init_config = move |rocket: Rocket<Build>| async move {
    rocket.manage(Mutex::new(config_and_path))
  };

  #[get("/<_..>")]
  fn catchall() -> RawHtml<&'static str> { RawHtml(include_str!("../../../web/dist/index.html")) }

  _ = dist_handlers::mount(prometheus::mount(&config, rocket_config::update(&config, rocket::build())))
      .mount("/", routes![
        routes::files::get,
        routes::command::command,
        routes::account::login, routes::account::logout,
        routes::account::register, routes::account::totp,
        routes::admin::installation_state,
      ])
      .attach(AdHoc::on_ignite("Initialize Config", init_config))
      .attach(AdHoc::on_ignite("Initialize Db", init_db))
      .attach(AdHoc::on_ignite("Initialize Cache", init_cache))
      .attach(AdHoc::on_ignite("Initialize File Store", init_file_store))
      .mount("/", routes![catchall])
      .launch().await;

  Ok(())
}
