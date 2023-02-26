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

use std::any::Any;
use clap::{ArgMatches, App, Arg};
use crate::util::infu::InfuResult;
use std::fs::File;
use std::io::{BufReader, BufWriter, Write};
use serde_json::Value::Object;


pub fn make_clap_subcommand<'a, 'b>() -> App<'a> {
  App::new("migrate")
    .about("Migrates db log files to the latest version.")
    .arg(Arg::new("settings_path")
      .short('s')
      .long("settings")
      .help(concat!("Path to a toml settings configuration file. If not specified, the default will be assumed."))
      .takes_value(true)
      .multiple_values(false)
      .required(false))
}

pub fn execute<'a>(_sub_matches: &ArgMatches) -> InfuResult<()> {
  if false {
    let in_path = "<in file here>";
    let out_path = "<out file here>";

    let file = File::create(out_path)?;
    let mut writer = BufWriter::new(file);

    let f = BufReader::new(File::open(in_path)?);
    let deserializer = serde_json::Deserializer::from_reader(f);
    let iterator = deserializer.into_iter::<serde_json::Value>();

    for item in iterator {
      match item? {
        Object(kvs) => {
          let migrated = crate::storage::db::pending_user_db::migrate_record_v1_to_v2(&kvs)?;
          writer.write_all(serde_json::to_string(&migrated)?.as_bytes())?;
          writer.write_all("\n".as_bytes())?;
        },
        unexpected_type => {
          return Err(format!("Log record has JSON type '{:?}', but 'Object' was expected.", unexpected_type.type_id()).into());
        }
      }
    }
  }

  if false {
    let in_path = "<in file here>";
    let out_path = "<out file here>";

    let file = File::create(out_path)?;
    let mut writer = BufWriter::new(file);

    let f = BufReader::new(File::open(in_path)?);
    let deserializer = serde_json::Deserializer::from_reader(f);
    let iterator = deserializer.into_iter::<serde_json::Value>();

    for item in iterator {
      match item? {
        Object(kvs) => {
          let migrated = crate::storage::db::item_db::migrate_record_v1_to_v2(&kvs)?;
          writer.write_all(serde_json::to_string(&migrated)?.as_bytes())?;
          writer.write_all("\n".as_bytes())?;
        },
        unexpected_type => {
          return Err(format!("Log record has JSON type '{:?}', but 'Object' was expected.", unexpected_type.type_id()).into());
        }
      }
    }
  }

  Ok(())
}
