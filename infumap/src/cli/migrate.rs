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

use crate::storage::maintenance::{create_log_temporary, install_log_candidate, migrate_log_step, read_log_descriptor};
use crate::util::fs::expand_tilde;
use clap::{Arg, ArgMatches, Command};
use infusdk::util::infu::InfuResult;
use log::warn;

pub fn make_clap_subcommand() -> Command {
  Command::new("migrate")
    .about("Migrates a single user or item log file to the next version, if it is not already at the latest. The existing log is retained with a postfix .vX where X is the existing version number. Note that generally it should not be necessary to migrate log files by hand, because this is done automatically on web server startup (TODO).")
    .arg(Arg::new("log_path")
      .short('p')
      .long("log-path")
      .help(concat!("Path to the user or item log file to migrate."))
      .num_args(1)
      .required(true))
}

pub async fn execute(sub_matches: &ArgMatches) -> InfuResult<()> {
  let log_path = sub_matches.get_one::<String>("log_path").unwrap();
  migrate_log(&log_path).await
}

async fn migrate_log(log_path: &str) -> InfuResult<()> {
  let expanded_log_path = expand_tilde(log_path).ok_or("Could not interpret log path.")?;
  let candidate = create_log_temporary(&expanded_log_path)?;
  let result = (|| -> InfuResult<()> {
    let migrated = migrate_log_step(&expanded_log_path, &candidate)?;
    let from_version = migrated.version - 1;
    let previous = expanded_log_path.with_extension(format!("v{}", from_version));
    if previous.try_exists()? {
      return Err(format!("Log file already migrated to version {}.", from_version).into());
    }
    install_log_candidate(&expanded_log_path, &candidate, &previous, true, |path| {
      // Conversion has parsed every record; check its descriptor again before installing the result.
      let descriptor = read_log_descriptor(path)?;
      if descriptor.kind != migrated.kind || descriptor.version != migrated.version {
        return Err("Migration candidate has an unexpected descriptor.".into());
      }
      Ok(())
    })
  })();
  if let Err(e) = std::fs::remove_file(&candidate) {
    if e.kind() != std::io::ErrorKind::NotFound {
      warn!("Could not remove migration temporary '{}': {}", candidate.display(), e);
    }
  }
  result
}
