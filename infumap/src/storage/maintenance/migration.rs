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

use std::fs::File;
use std::io::{BufReader, BufWriter, Write};
use std::path::Path;

use infusdk::util::infu::InfuResult;
use serde_json::de::IoRead;
use serde_json::{Map, StreamDeserializer, Value};

use super::{LogDescriptor, LogKind, parse_descriptor, read_log_descriptor};
use crate::storage::db::{item_db, pending_user_db, user_db};

type Records<'de> = StreamDeserializer<'de, IoRead<BufReader<File>>, Value>;
type Migration = fn(&Path, &Map<String, Value>, &mut Records<'_>) -> InfuResult<()>;

/// Write one migration step to a separate output, leaving installation and retention to the caller.
/// The output is overwritten, matching the existing migrate command's temporary-file behavior.
pub fn migrate_log_step(source: &Path, output: &Path) -> InfuResult<LogDescriptor> {
  if source == output || (output.exists() && source.canonicalize()? == output.canonicalize()?) {
    return Err("Migration output must differ from its source.".into());
  }
  let file = File::open(source)?;
  let mut records = serde_json::Deserializer::from_reader(BufReader::new(file)).into_iter::<Value>();
  let first = records.next().ok_or("Log has no records.")??;
  let descriptor = parse_descriptor(&first)?;
  if descriptor.version == descriptor.kind.current_version() {
    return Err("Log is already at the latest version.".into());
  }
  let mut updated = first.as_object().unwrap().clone();
  updated.insert("version".to_owned(), (descriptor.version + 1).into());
  migration_for(descriptor)?(output, &updated, &mut records)?;
  let migrated = read_log_descriptor(output)?;
  if migrated.kind != descriptor.kind || migrated.version != descriptor.version + 1 {
    return Err(format!("Migration of '{}' did not advance by one version.", source.display()).into());
  }
  Ok(migrated)
}

pub(super) fn validate_source_version(descriptor: LogDescriptor) -> InfuResult<()> {
  if descriptor.version < descriptor.kind.current_version() {
    migration_for(descriptor)?;
  }
  Ok(())
}

// Inspection and conversion share this dispatch so support checks cannot drift from actual migrations.
fn migration_for(descriptor: LogDescriptor) -> InfuResult<Migration> {
  let migration: Migration = match descriptor.kind {
    LogKind::Item => match descriptor.version {
      1 => |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v1_to_v2),
      2 => |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v2_to_v3),
      3 => |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v3_to_v4),
      4 => |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v4_to_v5),
      5 => |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v5_to_v6),
      6 => |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v6_to_v7),
      7 => |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v7_to_v8),
      8 => |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v8_to_v9),
      9 => {
        |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v9_to_v10)
      }
      10 => {
        |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v10_to_v11)
      }
      11 => {
        |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v11_to_v12)
      }
      12 => {
        |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v12_to_v13)
      }
      13 => {
        |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v13_to_v14)
      }
      14 => {
        |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v14_to_v15)
      }
      15 => {
        |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v15_to_v16)
      }
      16 => {
        |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v16_to_v17)
      }
      17 => {
        |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v17_to_v18)
      }
      18 => {
        |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v18_to_v19)
      }
      19 => {
        |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v19_to_v20)
      }
      20 => {
        |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v20_to_v21)
      }
      21 => {
        |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v21_to_v22)
      }
      22 => {
        |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v22_to_v23)
      }
      23 => {
        |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v23_to_v24)
      }
      24 => {
        |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v24_to_v25)
      }
      25 => {
        |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v25_to_v26)
      }
      26 => {
        |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v26_to_v27)
      }
      27 => {
        |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v27_to_v28)
      }
      28 => |output, descriptor, records| {
        let mut state = std::collections::HashMap::new();
        let mut stats = item_db::MimeTypeMigrationStats::default();
        migrate_records(output, descriptor, records, |record| {
          item_db::migrate_record_v28_to_v29(record, &mut state, &mut stats)
        })?;
        for line in stats.render_summary() {
          println!("{}", line);
        }
        Ok(())
      },
      29 => |output, descriptor, records| {
        let migrated = item_db::migrate_records_v29_to_v30(&read_records(records)?)?;
        write_log(output, descriptor, &migrated)
      },
      30 => {
        |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v30_to_v31)
      }
      31 => |output, descriptor, records| {
        let (descriptor, migrated) = item_db::migrate_records_v31_to_v32(descriptor, &read_records(records)?)?;
        write_log(output, &descriptor, &migrated)
      },
      32 => {
        |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v32_to_v33)
      }
      33 => {
        |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v33_to_v34)
      }
      34 => {
        |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v34_to_v35)
      }
      35 => |output, descriptor, records| {
        let (descriptor, migrated) = item_db::migrate_records_v35_to_v36(descriptor, &read_records(records)?)?;
        write_log(output, &descriptor, &migrated)
      },
      36 => {
        |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v36_to_v37)
      }
      37 => {
        |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v37_to_v38)
      }
      38 => {
        |output, descriptor, records| migrate_records(output, descriptor, records, item_db::migrate_record_v38_to_v39)
      }
      39 => |output, descriptor, records| {
        let mut state = std::collections::HashMap::new();
        migrate_records(output, descriptor, records, |record| item_db::migrate_record_v39_to_v40(record, &mut state))
      },
      _ => return Err(format!("Unsupported item log migration from version {}.", descriptor.version).into()),
    },
    LogKind::User => match descriptor.version {
      1 => |output, descriptor, records| {
        migrate_records(output, descriptor, records, pending_user_db::migrate_record_v1_to_v2)
      },
      5 => |output, descriptor, records| migrate_records(output, descriptor, records, user_db::migrate_record_v5_to_v6),
      6 => |output, descriptor, records| migrate_records(output, descriptor, records, user_db::migrate_record_v6_to_v7),
      7 => |output, descriptor, records| migrate_records(output, descriptor, records, user_db::migrate_record_v7_to_v8),
      8 => |output, descriptor, records| migrate_records(output, descriptor, records, user_db::migrate_record_v8_to_v9),
      _ => return Err(format!("Unsupported user log migration from version {}.", descriptor.version).into()),
    },
  };
  Ok(migration)
}

fn object_record(record: Value) -> InfuResult<Map<String, Value>> {
  match record {
    Value::Object(record) => Ok(record),
    _ => Err("Log record must be a JSON object.".into()),
  }
}

fn read_records(records: &mut Records<'_>) -> InfuResult<Vec<Map<String, Value>>> {
  records.map(|record| object_record(record?)).collect()
}

fn write_record(writer: &mut BufWriter<File>, record: &Map<String, Value>) -> InfuResult<()> {
  serde_json::to_writer(&mut *writer, record)?;
  writer.write_all(b"\n")?;
  Ok(())
}

fn migrate_records(
  output: &Path,
  descriptor: &Map<String, Value>,
  records: &mut Records<'_>,
  mut migrate: impl FnMut(&Map<String, Value>) -> InfuResult<Map<String, Value>>,
) -> InfuResult<()> {
  let mut writer = BufWriter::new(File::create(output)?);
  write_record(&mut writer, descriptor)?;
  for record in records {
    write_record(&mut writer, &migrate(&object_record(record?)?)?)?;
  }
  writer.flush()?;
  Ok(())
}

fn write_log(output: &Path, descriptor: &Map<String, Value>, records: &[Map<String, Value>]) -> InfuResult<()> {
  let mut writer = BufWriter::new(File::create(output)?);
  write_record(&mut writer, descriptor)?;
  for record in records {
    write_record(&mut writer, record)?;
  }
  writer.flush()?;
  Ok(())
}
