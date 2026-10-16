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

use serde_json::{Map, Value};

use crate::item::{TableColumn, TableColumnAlign};

use super::{
  geometry::{Dimensions, Vector},
  infu::InfuResult,
};

pub fn get_string_field(map: &Map<String, Value>, field: &str) -> InfuResult<Option<String>> {
  let v = match map.get(field) {
    None => return Ok(None),
    Some(s) => s,
  };
  if v.is_null() {
    return Ok(None);
  }
  Ok(Some(String::from(v.as_str().ok_or(format!("'{}' field was not of type 'string'.", field))?)))
}

pub fn get_integer_field(map: &Map<String, Value>, field: &str) -> InfuResult<Option<i64>> {
  let v = match map.get(field) {
    None => return Ok(None),
    Some(s) => s,
  };
  if v.is_null() {
    return Ok(None);
  }
  Ok(Some(v.as_i64().ok_or(format!("'{}' field was not of type 'i64'.", field))?))
}

pub fn get_float_field(map: &Map<String, Value>, field: &str) -> InfuResult<Option<f64>> {
  let v = match map.get(field) {
    None => return Ok(None),
    Some(s) => s,
  };
  if v.is_null() {
    return Ok(None);
  }
  Ok(Some(v.as_f64().ok_or(format!("'{}' field was not of type 'f64'.", field))?))
}

pub fn _get_bool_field(map: &Map<String, Value>, field: &str) -> InfuResult<Option<bool>> {
  let v = match map.get(field) {
    None => return Ok(None),
    Some(s) => s,
  };
  if v.is_null() {
    return Ok(None);
  }
  Ok(Some(v.as_bool().ok_or(format!("'{}' field was not of type 'bool'.", field))?))
}

pub fn get_vector_field(map: &Map<String, Value>, field: &str) -> InfuResult<Option<Vector<i64>>> {
  let v = match map.get(field) {
    None => return Ok(None),
    Some(s) => s,
  };
  if v.is_null() {
    return Ok(None);
  }
  let o = v.as_object().ok_or(format!("'{}' field was not of type 'object'.", field))?;
  Ok(Some(Vector {
    x: get_integer_field(o, "x")?.ok_or("Vector field 'x' was missing.")?,
    y: get_integer_field(o, "y")?.ok_or("Vector field 'y' was missing.")?,
  }))
}

pub fn get_float_vector_field(map: &Map<String, Value>, field: &str) -> InfuResult<Option<Vector<f64>>> {
  let v = match map.get(field) {
    None => return Ok(None),
    Some(s) => s,
  };
  if v.is_null() {
    return Ok(None);
  }
  let o = v.as_object().ok_or(format!("'{}' field was not of type 'object'.", field))?;
  Ok(Some(Vector {
    x: get_float_field(o, "x")?.ok_or("Vector field 'x' was missing.")?,
    y: get_float_field(o, "y")?.ok_or("Vector field 'y' was missing.")?,
  }))
}

pub fn get_dimensions_field(map: &Map<String, Value>, field: &str) -> InfuResult<Option<Dimensions<i64>>> {
  let v = match map.get(field) {
    None => return Ok(None),
    Some(s) => s,
  };
  let o = v.as_object().ok_or(format!("'{}' field was not of type 'object'.", field))?;
  Ok(Some(Dimensions {
    w: get_integer_field(o, "w")?.ok_or("Dimensions field 'w' was missing.")?,
    h: get_integer_field(o, "h")?.ok_or("Dimensions field 'h' was missing.")?,
  }))
}

pub fn get_table_columns_field(map: &Map<String, Value>, field: &str) -> InfuResult<Option<Vec<TableColumn>>> {
  let v = match map.get(field) {
    None => return Ok(None),
    Some(s) => s,
  };
  let a = v.as_array().ok_or(format!("'{}' field was not of type 'array'.", field))?;
  let mut result = vec![];
  for tc in a {
    let o = tc.as_object().ok_or("item in table column array was not of type 'object'.")?;
    result.push(TableColumn {
      width_gr: get_integer_field(o, "widthGr")?.ok_or("TableColumn field 'widthGr' was missing.")?,
      name: get_string_field(o, "name")?.ok_or("TableColumn field 'name' was missing.")?,
      align: match get_string_field(o, "align")? {
        Some(s) => Some(TableColumnAlign::from_str(&s)?),
        None => None,
      },
    });
  }
  Ok(Some(result))
}

pub fn vector_to_object(v: &Vector<i64>) -> Value {
  let mut vec: Map<String, Value> = Map::new();
  vec.insert(String::from("x"), Value::Number(v.x.into()));
  vec.insert(String::from("y"), Value::Number(v.y.into()));
  Value::Object(vec)
}

pub fn float_vector_to_object(v: &Vector<f64>) -> Value {
  let mut vec: Map<String, Value> = Map::new();
  vec.insert(String::from("x"), Value::Number(serde_json::Number::from_f64(v.x).unwrap()));
  vec.insert(String::from("y"), Value::Number(serde_json::Number::from_f64(v.y).unwrap()));
  Value::Object(vec)
}

pub fn dimensions_to_object(v: &Dimensions<i64>) -> Value {
  let mut dim: Map<String, Value> = Map::new();
  dim.insert(String::from("w"), Value::Number(v.w.into()));
  dim.insert(String::from("h"), Value::Number(v.h.into()));
  Value::Object(dim)
}

pub fn table_column_to_object(v: &TableColumn) -> Value {
  let mut result: Map<String, Value> = Map::new();
  result.insert(String::from("widthGr"), Value::Number(v.width_gr.into()));
  result.insert(String::from("name"), Value::String(String::from(&v.name)));
  if let Some(align) = v.align {
    result.insert(String::from("align"), Value::String(String::from(align.as_str())));
  }
  Value::Object(result)
}

pub fn table_columns_to_array(vs: &Vec<TableColumn>) -> Value {
  Value::Array(vs.iter().map(|v| table_column_to_object(v)).collect())
}

pub fn validate_map_fields(map: &serde_json::Map<String, serde_json::Value>, all_fields: &[&str]) -> InfuResult<()> {
  for (k, _v) in map {
    if all_fields.iter().find(|v| v == &k).is_none() {
      return Err(format!("Map contains unexpected key '{}'.", k).into());
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn columns_map(columns: Value) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert(String::from("tableColumns"), columns);
    map
  }

  #[test]
  fn table_column_align_round_trips() {
    let columns = vec![
      TableColumn { width_gr: 480, name: String::from("a"), align: None },
      TableColumn { width_gr: 240, name: String::from("b"), align: Some(TableColumnAlign::Right) },
      TableColumn { width_gr: 240, name: String::from("c"), align: Some(TableColumnAlign::Center) },
    ];
    let serialized = table_columns_to_array(&columns);
    assert!(serialized[0].as_object().unwrap().get("align").is_none());
    assert_eq!(serialized[1]["align"], "right");
    let parsed = get_table_columns_field(&columns_map(serialized), "tableColumns").unwrap().unwrap();
    assert_eq!(parsed, columns);
  }

  #[test]
  fn table_column_null_align_is_left() {
    let map = columns_map(serde_json::json!([{ "widthGr": 480, "name": "a", "align": null }]));
    let parsed = get_table_columns_field(&map, "tableColumns").unwrap().unwrap();
    assert_eq!(parsed[0].align, None);
  }

  #[test]
  fn table_column_invalid_align_is_rejected() {
    for align in [serde_json::json!("left"), serde_json::json!("justify"), serde_json::json!(1)] {
      let map = columns_map(serde_json::json!([{ "widthGr": 480, "name": "a", "align": align }]));
      assert!(get_table_columns_field(&map, "tableColumns").is_err());
    }
  }
}
