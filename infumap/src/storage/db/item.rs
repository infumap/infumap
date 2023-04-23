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

use serde::{Serialize, Deserialize};
use serde_json::{Value, Map, Number};

use crate::util::json;
use crate::util::uid::{Uid, is_uid};
use crate::util::geometry::{Vector, Dimensions};
use crate::util::infu::{InfuResult, InfuError};
use crate::util::lang::option_xor;
use crate::web::routes::WebApiJsonSerializable;
use crate::storage::db::kv_store::JsonLogSerializable;


#[derive(Debug, PartialEq)]
pub enum RelationshipToParent {
  NoParent,
  Child,
  Attachment
}

impl RelationshipToParent {
  pub fn as_str(&self) -> &'static str {
    match self {
      RelationshipToParent::Attachment => "attachment",
      RelationshipToParent::Child => "child",
      RelationshipToParent::NoParent => "no-parent"
    }
  }

  pub fn from_str(s: &str) -> InfuResult<RelationshipToParent> {
    match s {
      "attachment" => Ok(RelationshipToParent::Attachment),
      "child" => Ok(RelationshipToParent::Child),
      "no-parent" => Ok(RelationshipToParent::NoParent),
      other => Err(format!("Invalid RelationshipToParent value: '{}'.", other).into())
    }
  }
}

impl Clone for RelationshipToParent {
  fn clone(&self) -> Self {
    match self {
      Self::NoParent => Self::NoParent,
      Self::Child => Self::Child,
      Self::Attachment => Self::Attachment,
    }
  }
}


#[derive(Debug, PartialEq, Copy, Clone)]
pub enum ArrangeAlgorithm {
  SpatialStretch,
  // SpatialFit,
  Grid,
  // Justified,
  // Gallery,
}

impl ArrangeAlgorithm {
  pub fn as_str(&self) -> &'static str {
    match self {
      ArrangeAlgorithm::SpatialStretch => "spatial-stretch",
      // ArrangeAlgorithm::SpatialFit => "spatial-fit",
      ArrangeAlgorithm::Grid => "grid",
      // ArrangeAlgorithm::Justified => "justified",
      // ArrangeAlgorithm::Gallery => "gallery",
    }
  }

  pub fn from_str(s: &str) -> InfuResult<ArrangeAlgorithm> {
    match s {
      "spatial-stretch" => Ok(ArrangeAlgorithm::SpatialStretch),
      // "spatial-fit" => Ok(ArrangeAlgorithm::SpatialFit),
      "grid" => Ok(ArrangeAlgorithm::Grid),
      // "justivied" => Ok(ArrangeAlgorithm::Justified),
      // "gallery" => Ok(ArrangeAlgorithm::Gallery),
      other => Err(format!("Invalid ArrangeAlgorithm value: '{}'.", other).into())
    }
  }
}


#[derive(Debug, PartialEq, Copy, Clone)]
pub enum AlignmentPoint {
  Center,
  LeftCenter,
  TopCenter,
  RightCenter,
  BottomCenter,
  TopLeft,
  TopRight,
  BottomRight,
  BottomLeft,
}

impl AlignmentPoint {
  pub fn as_str(&self) -> &'static str {
    match self {
      AlignmentPoint::Center => "center",
      AlignmentPoint::LeftCenter => "left-center",
      AlignmentPoint::TopCenter => "top-center",
      AlignmentPoint::RightCenter => "right-center",
      AlignmentPoint::BottomCenter => "bottom-center",
      AlignmentPoint::TopLeft => "top-left",
      AlignmentPoint::TopRight => "top-right",
      AlignmentPoint::BottomRight => "bottom-right",
      AlignmentPoint::BottomLeft => "bottom-left",
    }
  }

  pub fn from_str(s: &str) -> InfuResult<AlignmentPoint> {
    match s {
      "center" => Ok(AlignmentPoint::Center),
      "left-center" => Ok(AlignmentPoint::LeftCenter),
      "top-center" => Ok(AlignmentPoint::TopCenter),
      "right-center" => Ok(AlignmentPoint::RightCenter),
      "bottom-center" => Ok(AlignmentPoint::BottomCenter),
      "top-left" => Ok(AlignmentPoint::TopLeft),
      "top-right" => Ok(AlignmentPoint::TopRight),
      "bottom-right" => Ok(AlignmentPoint::BottomRight),
      "bottom-left" => Ok(AlignmentPoint::BottomLeft),
      other => Err(format!("Invalid AlignmentPoint value: '{}'.", other).into())
    }
  }
}


#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TableColumn {
  #[serde(rename="widthGr")]
  pub width_gr: i64,
  pub name: String,
}


pub const ITEM_TYPE_PAGE: &'static str = "page";
pub const ITEM_TYPE_NOTE: &'static str = "note";
pub const ITEM_TYPE_FILE: &'static str = "file";
pub const ITEM_TYPE_TABLE: &'static str = "table";
pub const ITEM_TYPE_IMAGE: &'static str = "image";
pub const ITEM_TYPE_RATING: &'static str = "rating";
pub const ITEM_TYPE_LINK: &'static str = "link";

pub fn is_attachments_item(item_type: &str) -> bool {
  item_type == ITEM_TYPE_FILE || item_type == ITEM_TYPE_NOTE ||
  item_type == ITEM_TYPE_PAGE || item_type == ITEM_TYPE_TABLE ||
  item_type == ITEM_TYPE_IMAGE
}

pub fn is_container_item(item_type: &str) -> bool {
  item_type == ITEM_TYPE_PAGE || item_type == ITEM_TYPE_TABLE
}

pub fn is_data_item(item_type: &str) -> bool {
  item_type == ITEM_TYPE_FILE || item_type == ITEM_TYPE_IMAGE
}

pub fn is_x_sizeable_item(item_type: &str) -> bool {
  item_type == ITEM_TYPE_FILE || item_type == ITEM_TYPE_NOTE ||
  item_type == ITEM_TYPE_PAGE || item_type == ITEM_TYPE_TABLE ||
  item_type == ITEM_TYPE_IMAGE
}

pub fn is_y_sizeable_item(item_type: &str) -> bool {
  item_type == ITEM_TYPE_TABLE
}

pub fn is_titled_item(item_type: &str) -> bool {
  item_type == ITEM_TYPE_FILE || item_type == ITEM_TYPE_NOTE ||
  item_type == ITEM_TYPE_PAGE || item_type == ITEM_TYPE_TABLE ||
  item_type == ITEM_TYPE_IMAGE
}

pub fn is_image_item(item_type: &str) -> bool {
  item_type == ITEM_TYPE_IMAGE
}

const ALL_JSON_FIELDS: [&'static str; 30] = ["__recordType",
  "itemType", "ownerId", "id", "parentId", "relationshipToParent",
  "creationDate", "lastModifiedDate", "ordering", "title",
  "spatialPositionGr", "spatialWidthGr", "innerSpatialWidthGr",
  "naturalAspect", "backgroundColorIndex", "popupPositionGr",
  "popupAlignmentPoint", "popupWidthGr", "arrangeAlgorithm",
  "url", "originalCreationDate", "spatialHeightGr", "imageSizePx",
  "thumbnail", "mimeType", "fileSizeBytes", "rating", "tableColumns",
  "linkToId", "gridNumberOfColumns"];


/// All-encompassing Item type and corresponding serialization / validation logic.
/// The implementation is largely hand-rolled - e.g. doesn't leverage the defualt Rust
/// serde Serialize/Deserialize attributes or JSON Schema for validation. This is
/// because the requirements are quite specialized:
///  - Different serialized data for web apis vs db log use.
///  - Handling of updates, where only a subset of fields are present.
///  - Custom validation logic (e.g. related to item type classes).
///  - A flat (straightforward) serialized structure of a more complex object model.
/// It may make sense to do something more general at some point, but for now I
/// think the naive long-winded approach is just fine.
#[derive(Debug)]
pub struct Item {
  pub item_type: String,
  pub owner_id: Uid,
  pub id: Uid,
  pub parent_id: Option<Uid>,
  pub relationship_to_parent: RelationshipToParent,
  pub creation_date: i64,
  pub last_modified_date: i64,
  pub ordering: Vec<u8>,
  pub spatial_position_gr: Vector<i64>,

  // x-sizeable
  pub spatial_width_gr: Option<i64>,

  // y-sizeable
  pub spatial_height_gr: Option<i64>,

  // titled
  pub title: Option<String>,

  // data
  pub original_creation_date: Option<i64>,
  pub mime_type: Option<String>,
  pub file_size_bytes: Option<i64>,

  // page
  pub inner_spatial_width_gr: Option<i64>,
  pub natural_aspect: Option<f64>,
  pub background_color_index: Option<i64>,
  pub arrange_algorithm: Option<ArrangeAlgorithm>,
  pub popup_position_gr: Option<Vector<i64>>,
  pub popup_alignment_point: Option<AlignmentPoint>,
  pub popup_width_gr: Option<i64>,
  pub grid_number_of_columns: Option<i64>,

  // note
  pub url: Option<String>,

  // file

  // table
  pub table_columns: Option<Vec<TableColumn>>,

  // image
  pub image_size_px: Option<Dimensions<i64>>,
  pub thumbnail: Option<String>,

  // rating
  pub rating: Option<i64>,

  // link
  pub link_to_id: Option<Uid>,
}

impl Clone for Item {
  fn clone(&self) -> Self {
    Self {
      item_type: self.item_type.clone(),
      owner_id: self.owner_id.clone(),
      id: self.id.clone(),
      parent_id: self.parent_id.clone(),
      relationship_to_parent: self.relationship_to_parent.clone(),
      creation_date: self.creation_date.clone(),
      last_modified_date: self.last_modified_date.clone(),
      ordering: self.ordering.clone(),
      spatial_position_gr: self.spatial_position_gr.clone(),
      spatial_width_gr: self.spatial_width_gr.clone(),
      spatial_height_gr: self.spatial_height_gr.clone(),
      title: self.title.clone(),
      original_creation_date: self.original_creation_date.clone(),
      mime_type: self.mime_type.clone(),
      file_size_bytes: self.file_size_bytes.clone(),
      inner_spatial_width_gr: self.inner_spatial_width_gr.clone(),
      natural_aspect: self.natural_aspect.clone(),
      background_color_index: self.background_color_index.clone(),
      arrange_algorithm: self.arrange_algorithm.clone(),
      popup_position_gr: self.popup_position_gr.clone(),
      popup_alignment_point: self.popup_alignment_point.clone(),
      popup_width_gr: self.popup_width_gr.clone(),
      grid_number_of_columns: self.grid_number_of_columns.clone(),
      url: self.url.clone(),
      table_columns: self.table_columns.clone(),
      image_size_px: self.image_size_px.clone(),
      thumbnail: self.thumbnail.clone(),
      rating: self.rating.clone(),
      link_to_id: self.link_to_id.clone(),
    }
  }
}


impl WebApiJsonSerializable<Item> for Item {
  fn to_api_json(&self) -> InfuResult<Map<String, Value>> {
    to_json(self)
  }

  fn from_api_json(map: &Map<String, Value>) -> InfuResult<Item> {
    from_json(map)
  }
}


impl JsonLogSerializable<Item> for Item {
  fn value_type_identifier() -> &'static str {
    "item"
  }

  fn get_id(&self) -> &Uid {
    &self.id
  }

  fn to_json(&self) -> InfuResult<serde_json::Map<String, serde_json::Value>> {
    let mut result = to_json(self)?;
    result.insert(String::from("__recordType"), Value::String(String::from("entry")));
    Ok(result)
  }

  fn from_json(map: &serde_json::Map<String, serde_json::Value>) -> InfuResult<Item> {
    Ok(from_json(map)?)
  }

  fn create_json_update(old: &Item, new: &Item) -> InfuResult<serde_json::Map<String, serde_json::Value>> {
    fn nan_err(field_name: &str, item_id: &str) -> String {
      format!("Could not serialize the '{}' field of item '{}' to an update record because it is not a number.", field_name, item_id)
    }
    fn add_or_remove_err(field_name: &str, item_id: &str) -> InfuResult<()> {
      Err(format!("An attempt was made to create an item update that adds or removes the field '{}' of item '{}', but this is not allowed.", field_name, item_id).into())
    }
    fn cannot_modify_err(field_name: &str, item_id: &str) -> InfuResult<()> {
      Err(format!("An attempt was made to create an item update that modifies the field '{}' of item '{}', but this is not allowed.", field_name, item_id).into())
    }

    if old.id != new.id { return Err("An attempt was made to create an item update from instances with non-matching ids.".into()); }
    if old.owner_id != new.owner_id { return Err("An attempt was made to create an item update from instances with non-matching owner_ids.".into()); }

    let mut result: Map<String, Value> = Map::new();
    result.insert(String::from("__recordType"), Value::String(String::from("update")));
    result.insert(String::from("id"), Value::String(new.id.clone()));

    if option_xor(&old.parent_id, &new.parent_id) { add_or_remove_err("parentId", &old.id)?; }
    if let Some(parent_id) = &new.parent_id {
      if old.parent_id.as_ref().unwrap() != parent_id {
        result.insert(String::from("parentId"), Value::String(String::from(parent_id)));
      }
    }

    if old.relationship_to_parent != new.relationship_to_parent { result.insert(String::from("relationshipToParent"), Value::String(String::from(new.relationship_to_parent.as_str()))); }
    if old.creation_date != new.creation_date { cannot_modify_err("creationDate", &old.id)?; }
    if old.last_modified_date != new.last_modified_date { result.insert(String::from("lastModifiedDate"), Value::Number(new.last_modified_date.into())); }
    if old.ordering != new.ordering { result.insert(String::from("ordering"), Value::Array(new.ordering.iter().map(|v| Value::Number((*v).into())).collect::<Vec<_>>())); }
    if old.spatial_position_gr != new.spatial_position_gr { result.insert(String::from("spatialPositionGr"), json::vector_to_object(&new.spatial_position_gr)); }

    // x-sizable
    if let Some(new_spatial_width_gr) = new.spatial_width_gr {
      if match old.spatial_width_gr { Some(o) => o != new_spatial_width_gr, None => { true } } {
        if !is_x_sizeable_item(&old.item_type) { cannot_modify_err("spatialWidthGr", &old.id)?; }
        result.insert(String::from("spatialWidthGr"), Value::Number(new_spatial_width_gr.into()));
      }
    }

    // y-sizable
    if let Some(new_spatial_height_gr) = new.spatial_height_gr {
      if match old.spatial_height_gr { Some(o) => o != new_spatial_height_gr, None => { true } } {
        if !is_y_sizeable_item(&old.item_type) { cannot_modify_err("spatialHeightGr", &old.id)?; }
        result.insert(String::from("spatialHeightGr"), Value::Number(new_spatial_height_gr.into()));
      }
    }

    // titled
    if let Some(new_title) = &new.title {
      if match &old.title { Some(o) => o != new_title, None => { true } } {
        if !is_titled_item(&old.item_type) { cannot_modify_err("title", &old.id)?; }
        result.insert(String::from("title"), Value::String(new_title.clone()));
      }
    }

    // data
    // Like the data file, all these fields are immutable.
    if let Some(new_original_creation_date) = new.original_creation_date {
      if match old.original_creation_date { Some(o) => o != new_original_creation_date, None => { true } } {
        cannot_modify_err("originalCreationDate", &old.id)?;
      }
    }
    if let Some(new_mime_type) = &new.mime_type {
      if match &old.mime_type { Some(o) => o != new_mime_type, None => { true } } {
        cannot_modify_err("mimeType", &old.id)?;
      }
    }
    if let Some(new_file_size_bytes) = &new.file_size_bytes {
      if match &old.file_size_bytes { Some(o) => o != new_file_size_bytes, None => { true } } {
        cannot_modify_err("fileSizeBytes", &old.id)?;
      }
    }

    // page
    if let Some(new_inner_spatial_width_gr) = new.inner_spatial_width_gr {
      if match old.inner_spatial_width_gr { Some(o) => o != new_inner_spatial_width_gr, None => { true } } {
        if old.item_type != ITEM_TYPE_PAGE { cannot_modify_err("innerSpatialWidthGr", &old.id)?; }
        result.insert(String::from("innerSpatialWidthGr"), Value::Number(new_inner_spatial_width_gr.into()));
      }
    }
    if let Some(new_natural_aspect) = new.natural_aspect {
      if match old.natural_aspect { Some(o) => o != new_natural_aspect, None => { true } } {
        if old.item_type != ITEM_TYPE_PAGE { cannot_modify_err("naturalAspect", &old.id)?; }
        result.insert(String::from("naturalAspect"), Value::Number(Number::from_f64(new_natural_aspect).ok_or(nan_err("naturalAspect", &old.id))?));
      }
    }
    if let Some(new_background_color_index) = new.background_color_index {
      if match old.background_color_index { Some(o) => o != new_background_color_index, None => { true } } {
        if old.item_type != ITEM_TYPE_PAGE { cannot_modify_err("backgroundColorIndex", &old.id)?; }
        result.insert(String::from("backgroundColorIndex"), Value::Number(new_background_color_index.into()));
      }
    }
    if let Some(new_arrange_algorithm) = &new.arrange_algorithm {
      if match &old.arrange_algorithm { Some(o) => o != new_arrange_algorithm, None => { true } } {
        if old.item_type != ITEM_TYPE_PAGE { cannot_modify_err("arrangeAlgorithm", &old.id)?; }
        result.insert(String::from("arrangeAlgorithm"), Value::String(String::from(new_arrange_algorithm.as_str())));
      }
    }
    if let Some(new_popup_position_gr) = &new.popup_position_gr {
      if match &old.popup_position_gr { Some(o) => o != new_popup_position_gr, None => { true } } {
        if old.item_type != ITEM_TYPE_PAGE { cannot_modify_err("popupPositionGr", &old.id)?; }
        result.insert(String::from("popupPositionGr"), json::vector_to_object(&new_popup_position_gr));
      }
    }
    if let Some(new_popup_alignment_point) = &new.popup_alignment_point {
      if match &old.popup_alignment_point { Some(o) => o != new_popup_alignment_point, None => { true } } {
        if old.item_type != ITEM_TYPE_PAGE { cannot_modify_err("popupAlignmentPoint", &old.id)?; }
        result.insert(String::from("popupAlignmentPoint"), Value::String(String::from(new_popup_alignment_point.as_str())));
      }
    }
    if let Some(new_popup_width_gr) = new.popup_width_gr {
      if match old.popup_width_gr { Some(o) => o != new_popup_width_gr, None => { true } } {
        if old.item_type != ITEM_TYPE_PAGE { cannot_modify_err("popupWidthGr", &old.id)?; }
        result.insert(String::from("popupWidthGr"), Value::Number(new_popup_width_gr.into()));
      }
    }
    if let Some(grid_number_of_columns) = new.grid_number_of_columns {
      if match old.grid_number_of_columns { Some(o) => o != grid_number_of_columns, None => { true } } {
        if old.item_type != ITEM_TYPE_PAGE { cannot_modify_err("gridNumberOfColumns", &old.id)?; }
        result.insert(String::from("gridNumberOfColumns"), Value::Number(grid_number_of_columns.into()));
      }
    }

    // note
    if let Some(new_url) = &new.url {
      if match &old.url { Some(o) => o != new_url, None => { true } } {
        if old.item_type != ITEM_TYPE_NOTE { cannot_modify_err("url", &old.id)?; }
        result.insert(String::from("url"), Value::String(new_url.clone()));
      }
    }

    // file

    // table
    if let Some(new_table_columns) = &new.table_columns {
      if match &old.table_columns { Some(o) => o != new_table_columns, None => { true } } {
        if old.item_type != ITEM_TYPE_TABLE { cannot_modify_err("tableColumns", &old.id)?; }
        result.insert(String::from("tableColumns"), json::table_columns_to_array(&new_table_columns));
      }
    }

    // image
    if let Some(new_image_size_px) = &new.image_size_px {
      if match &old.image_size_px { Some(o) => o != new_image_size_px, None => { true } } {
        if old.item_type != ITEM_TYPE_IMAGE { cannot_modify_err("imageSizePx", &old.id)?; }
        result.insert(String::from("imageSizePx"), json::dimensions_to_object(&new_image_size_px));
      }
    }
    if let Some(new_thumbnail) = &new.thumbnail {
      if match &old.thumbnail { Some(o) => o != new_thumbnail, None => { true } } {
        if old.item_type != ITEM_TYPE_IMAGE { cannot_modify_err("thumbnail", &old.id)?; }
        result.insert(String::from("thumbnail"), Value::String(new_thumbnail.clone()));
      }
    }

    // rating
    if let Some(new_rating) = new.rating {
      if match old.rating { Some(o) => o != new_rating, None => { true } } {
        if old.item_type != ITEM_TYPE_RATING { cannot_modify_err("rating", &old.id)?; }
        result.insert(String::from("rating"), Value::Number(new_rating.into()));
      }
    }

    // link
    if let Some(new_link_to_id) = &new.link_to_id {
      if match &old.link_to_id { Some(o) => o != new_link_to_id, None => { true } } {
        if old.item_type != ITEM_TYPE_LINK { cannot_modify_err("linkToId", &old.id)?; }
        result.insert(String::from("linkToId"), Value::String(String::from(new_link_to_id)));
      }
    }

    Ok(result)
  }

  fn apply_json_update(&mut self, map: &serde_json::Map<String, serde_json::Value>) -> InfuResult<()> {
    fn cannot_update_err(field_name: &str, item_id: &str) -> InfuResult<()> {
      Err(format!("An attempt was made to apply an update to the '{}' field of item '{}', but this is not allowed.", field_name, item_id).into())
    }
    fn not_applicable_err(field_name: &str, item_type: &str, item_id: &str) -> InfuResult<()> {
      Err(InfuError::new(&format!("'{}' field is not valid for item type '{}' - cannot update item '{}'.", field_name, item_type, item_id)))
    }

    json::validate_map_fields(map, &ALL_JSON_FIELDS)?;

    if json::get_string_field(map, "itemType")?.is_some() { cannot_update_err("itemType", &self.id)?; }
    if json::get_string_field(map, "ownerId")?.is_some() { cannot_update_err("ownerId", &self.id)?; }

    let parent_id_maybe = json::get_string_field(map, "parentId")?;
    if let Some(parent_id) = &parent_id_maybe {
      if !is_uid(&parent_id) {
        return Err(format!("An attempt was made to apply an update with invalid parent_id '{}' to item '{}'.", parent_id, &self.id).into());
      }
    }
    if self.parent_id.is_none() && parent_id_maybe.is_some() {
      return Err(format!("An attempt was made to apply an update to item '{}' that sets the 'parentId' field, where this was not previously set, but this is not allowed.", self.id).into());
    }
    let map_value_is_null = match map.get("parentId") { Some(v) => v.is_null(), None => false }; // get_string_field doesn't differentiate between null and unset.
    if self.parent_id.is_some() && map_value_is_null {
      return Err(format!("An attempt was made to apply an update to item '{}' that unsets the 'parentId' field where this was previously set, but this is not allowed.", self.id).into());
    }
    if parent_id_maybe.is_some() { self.parent_id = parent_id_maybe; }

    if let Some(u) = json::get_string_field(map, "relationshipToParent")? { self.relationship_to_parent = RelationshipToParent::from_str(&u)?; }
    if json::get_integer_field(map, "creationDate")?.is_some() { cannot_update_err("creationDate", &self.id)?; }
    if let Some(u) = json::get_integer_field(map, "lastModifiedDate")? { self.last_modified_date = u; }
    if map.contains_key("ordering") {
      self.ordering = map.get("ordering")
        .unwrap()
        .as_array()
        .ok_or(format!("'ordering' field for item '{}' is not an array.", self.id))?
        .iter().map(|v| match v.as_i64() {
          Some(v) => if v >= 0 && v <= 255 { Some(v as u8) } else { None },
          None => None })
        .collect::<Option<Vec<_>>>().ok_or(format!("One or more element of the 'ordering' field in an update for item '{}' was invalid.", &self.id))?;
    }
    if let Some(u) = json::get_vector_field(map, "spatialPositionGr")? { self.spatial_position_gr = u; }

    // x-sizable
    if let Some(v) = json::get_integer_field(map, "spatialWidthGr")? {
      if !is_x_sizeable_item(&self.item_type) { not_applicable_err("spatialWidthGr", &self.item_type, &self.id)?; }
      self.spatial_width_gr = Some(v);
    }

    // y-sizable
    if let Some(v) = json::get_integer_field(map, "spatialHeightGr")? {
      if !is_y_sizeable_item(&self.item_type) { not_applicable_err("spatialHeightGr", &self.item_type, &self.id)?; }
      self.spatial_height_gr = Some(v);
    }

    // titled
    if let Some(v) = json::get_string_field(map, "title")? {
      if !is_titled_item(&self.item_type) { not_applicable_err("title", &self.item_type, &self.id)?; }
      self.title = Some(v);
    }

    // data
    // Like the data file, all these fields are immutable.
    if json::get_integer_field(map, "originalCreationDate")?.is_some() { cannot_update_err("originalCreationDate", &self.id)?; }
    if json::get_string_field(map, "mimeType")?.is_some() { cannot_update_err("mimeType", &self.id)?; }
    if json::get_integer_field(map, "fileSizeBytes")?.is_some() { cannot_update_err("fileSizeBytes", &self.id)?; }

    // page
    if let Some(v) = json::get_integer_field(map, "innerSpatialWidthGr")? {
      if self.item_type != ITEM_TYPE_PAGE { not_applicable_err("innerSpatialWidthGr", &self.item_type, &self.id)?; }
      self.inner_spatial_width_gr = Some(v);
    }
    if let Some(v) = json::get_float_field(map, "naturalAspect")? {
      if self.item_type != ITEM_TYPE_PAGE { not_applicable_err("naturalAspect", &self.item_type, &self.id)?; }
      self.natural_aspect = Some(v);
    }
    if let Some(v) = json::get_integer_field(map, "backgroundColorIndex")? {
      if self.item_type != ITEM_TYPE_PAGE { not_applicable_err("backgroundColorIndex", &self.item_type, &self.id)?; }
      self.background_color_index = Some(v);
    }
    if let Some(v) = json::get_string_field(map, "arrangeAlgorithm")? {
      if self.item_type != ITEM_TYPE_PAGE { not_applicable_err("arrangeAlgorithm", &self.item_type, &self.id)?; }
      self.arrange_algorithm = Some(ArrangeAlgorithm::from_str(&v)?);
    }
    if let Some(v) = json::get_vector_field(map, "popupPositionGr")? {
      if self.item_type != ITEM_TYPE_PAGE { not_applicable_err("popupPositionGr", &self.item_type, &self.id)?; }
      self.popup_position_gr = Some(v);
    }
    if let Some(v) = json::get_string_field(map, "popupAlignmentPoint")? {
      if self.item_type != ITEM_TYPE_PAGE { not_applicable_err("popupAlignmentPoint", &self.item_type, &self.id)?; }
      self.popup_alignment_point = Some(AlignmentPoint::from_str(&v)?);
    }
    if let Some(v) = json::get_integer_field(map, "popupWidthGr")? {
      if self.item_type != ITEM_TYPE_PAGE { not_applicable_err("popupWidthGr", &self.item_type, &self.id)?; }
      self.popup_width_gr = Some(v);
    }
    if let Some(v) = json::get_integer_field(map, "gridNumberOfColumns")? {
      if self.item_type != ITEM_TYPE_PAGE { not_applicable_err("gridNumberOfColumns", &self.item_type, &self.id)?; }
      self.grid_number_of_columns = Some(v);
    }

    // note
    if let Some(v) = json::get_string_field(map, "url")? {
      if self.item_type == ITEM_TYPE_NOTE { self.url = Some(v); }
      else { not_applicable_err("url", &self.item_type, &self.id)?; }
    }

    // file

    // table
    if let Some(v) = json::get_table_columns_field(map, "tableColumns")? {
      if self.item_type != ITEM_TYPE_TABLE { not_applicable_err("tableColumns", &self.item_type, &self.id)?; }
      self.table_columns = Some(v);
    }

    // image
    if let Some(v) = json::get_dimensions_field(map, "imageSizePx")? {
      if self.item_type != ITEM_TYPE_IMAGE { not_applicable_err("imageSizePx", &self.item_type, &self.id)?; }
      self.image_size_px = Some(v);
    }
    if let Some(v) = json::get_string_field(map, "thumbnail")? {
      if self.item_type == ITEM_TYPE_IMAGE { self.thumbnail = Some(v); }
      else { not_applicable_err("thumbnail", &self.item_type, &self.id)?; }
    }

    // rating
    if let Some(v) = json::get_integer_field(map, "rating")? {
      if self.item_type != ITEM_TYPE_RATING { not_applicable_err("rating", &self.item_type, &self.id)?; }
      self.rating = Some(v);
    }

    // link
    if let Some(v) = json::get_string_field(map, "linkToId")? {
      if self.item_type != ITEM_TYPE_LINK { not_applicable_err("linkToId", &self.item_type, &self.id)?; }
      self.link_to_id = Some(v);
    }

    Ok(())
  }
}


fn to_json(item: &Item) -> InfuResult<serde_json::Map<String, serde_json::Value>> {
  fn nan_err(field_name: &str, item_id: &str) -> String {
    format!("Could not serialize the '{}' field of item '{}' because it is not a number.", field_name, item_id)
  }
  fn unexpected_field_err(field_name: &str, item_id: &str, item_type: &str) -> InfuResult<()> {
    Err(InfuError::new(&format!("'{}' field cannot be set for item '{}' of type {}.", field_name, item_id, item_type)))
  }

  let mut result = Map::new();
  result.insert(String::from("itemType"), Value::String(item.item_type.clone()));
  result.insert(String::from("id"), Value::String(item.id.clone()));
  result.insert(String::from("ownerId"), Value::String(item.owner_id.clone()));
  match &item.parent_id {
    Some(uid) => { result.insert(String::from("parentId"), Value::String(uid.clone())); },
    None => { result.insert(String::from("parentId"), Value::Null); }
  };
  result.insert(String::from("relationshipToParent"), Value::String(String::from(item.relationship_to_parent.as_str())));
  result.insert(String::from("creationDate"), Value::Number(item.creation_date.into()));
  result.insert(String::from("lastModifiedDate"), Value::Number(item.last_modified_date.into()));
  result.insert(String::from("ordering"), Value::Array(item.ordering.iter().map(|v| Value::Number((*v).into())).collect::<Vec<_>>()));
  result.insert(String::from("spatialPositionGr"), json::vector_to_object(&item.spatial_position_gr));

  // x-sizeable
  if let Some(spatial_width_gr) = item.spatial_width_gr {
    if !is_x_sizeable_item(&item.item_type) { unexpected_field_err("spatialWidthGr", &item.id, &item.item_type)? }
    result.insert(String::from("spatialWidthGr"), Value::Number(spatial_width_gr.into()));
  }

  // y-sizeable
  if let Some(spatial_height_gr) = item.spatial_height_gr {
    if !is_y_sizeable_item(&item.item_type) { unexpected_field_err("spatialHeightGr", &item.id, &item.item_type)? }
    result.insert(String::from("spatialHeightGr"), Value::Number(spatial_height_gr.into()));
  }

  // titled
  if let Some(title) = &item.title {
    if !is_titled_item(&item.item_type) { unexpected_field_err("title", &item.id, &item.item_type)? }
    result.insert(String::from("title"), Value::String(title.clone()));
  }

  // data
  if let Some(original_creation_date) = item.original_creation_date {
    if !is_data_item(&item.item_type) { unexpected_field_err("originalCreationDate", &item.id, &item.item_type)? }
    result.insert(String::from("originalCreationDate"), Value::Number(original_creation_date.into()));
  }
  if let Some(mime_type) = &item.mime_type {
    if !is_data_item(&item.item_type) { unexpected_field_err("mimeType", &item.id, &item.item_type)? }
    result.insert(String::from("mimeType"), Value::String(mime_type.clone()));
  }
  if let Some(file_size_bytes) = item.file_size_bytes {
    if !is_data_item(&item.item_type) { unexpected_field_err("fileSizeBytes", &item.id, &item.item_type)? }
    result.insert(String::from("fileSizeBytes"), Value::Number(file_size_bytes.into()));
  }

  // page
  if let Some(inner_spatial_width_gr) = item.inner_spatial_width_gr {
    if item.item_type != ITEM_TYPE_PAGE { unexpected_field_err("innerSpatialWidthGr", &item.id, &item.item_type)? }
    result.insert(String::from("innerSpatialWidthGr"), Value::Number(inner_spatial_width_gr.into()));
  }
  if let Some(natural_aspect) = item.natural_aspect {
    if item.item_type != ITEM_TYPE_PAGE { unexpected_field_err("naturalAspect", &item.id, &item.item_type)? }
    result.insert(
      String::from("naturalAspect"),
      Value::Number(Number::from_f64(natural_aspect).ok_or(nan_err("naturalAspect", &item.id))?));
  }
  if let Some(background_color_index) = item.background_color_index {
    if item.item_type != ITEM_TYPE_PAGE { unexpected_field_err("backgroundColorIndex", &item.id, &item.item_type)? }
    result.insert(String::from("backgroundColorIndex"), Value::Number(background_color_index.into()));
  }
  if let Some(arrange_algorithm) = &item.arrange_algorithm {
    if item.item_type != ITEM_TYPE_PAGE { unexpected_field_err("arrangeAlgorithm", &item.id, &item.item_type)? }
    result.insert(String::from("arrangeAlgorithm"), Value::String(String::from(arrange_algorithm.as_str())));
  }
  if let Some(popup_position_gr) = &item.popup_position_gr {
    if item.item_type != ITEM_TYPE_PAGE { unexpected_field_err("popupPositionGr", &item.id, &item.item_type)? }
    result.insert(String::from("popupPositionGr"), json::vector_to_object(&popup_position_gr));
  }
  if let Some(popup_alignment_point) = &item.popup_alignment_point {
    if item.item_type != ITEM_TYPE_PAGE { unexpected_field_err("positionAlignmentPoint", &item.id, &item.item_type)? }
    result.insert(String::from("popupAlignmentPoint"), Value::String(String::from(popup_alignment_point.as_str())));
  }
  if let Some(popup_width_gr) = item.popup_width_gr {
    if item.item_type != ITEM_TYPE_PAGE { unexpected_field_err("popupWidthGr", &item.id, &item.item_type)? }
    result.insert(String::from("popupWidthGr"), Value::Number(popup_width_gr.into()));
  }
  if let Some(grid_number_of_columns) = item.grid_number_of_columns {
    if item.item_type != ITEM_TYPE_PAGE { unexpected_field_err("gridNumberOfColumns", &item.id, &item.item_type)? }
    result.insert(String::from("gridNumberOfColumns"), Value::Number(grid_number_of_columns.into()));
  }

  // note
  if let Some(url) = &item.url {
    if item.item_type != ITEM_TYPE_NOTE { unexpected_field_err("url", &item.id, &item.item_type)? }
    result.insert(String::from("url"), Value::String(url.clone()));
  }

  // file

  // table
  if let Some(table_columns) = &item.table_columns {
    if item.item_type != ITEM_TYPE_TABLE { unexpected_field_err("tableColumns", &item.id, &item.item_type)? }
    result.insert(String::from("tableColumns"), json::table_columns_to_array(table_columns));
  }

  // image
  if let Some(image_size_px) = &item.image_size_px {
    if item.item_type != ITEM_TYPE_IMAGE { unexpected_field_err("imageSizePx", &item.id, &item.item_type)? }
    result.insert(String::from("imageSizePx"), json::dimensions_to_object(&image_size_px));
  }
  if let Some(thumbnail) = &item.thumbnail {
    if item.item_type != ITEM_TYPE_IMAGE { unexpected_field_err("thumbnail", &item.id, &item.item_type)? }
    result.insert(String::from("thumbnail"), Value::String(thumbnail.clone()));
  }

  // rating
  if let Some(rating) = item.rating {
    if item.item_type != ITEM_TYPE_RATING { unexpected_field_err("rating", &item.id, &item.item_type)? }
    result.insert(String::from("rating"), Value::Number(rating.into()));
  }

  // link
  if let Some(link_to_id) = &item.link_to_id {
    if item.item_type != ITEM_TYPE_LINK { unexpected_field_err("linkToId", &item.id, &item.item_type)? }
    result.insert(String::from("linkToId"), Value::String(link_to_id.clone()));
  }

  Ok(result)
}


fn from_json(map: &serde_json::Map<String, serde_json::Value>) -> InfuResult<Item> {
  fn not_applicable_err(field_name: &str, item_type: &str, item_id: &str) -> InfuError {
    InfuError::new(&format!("'{}' field is not valid for item type '{}' - cannot read entry for item '{}'.", field_name, item_type, item_id))
  }
  fn expected_for_err(field_name: &str, item_type: &str, item_id: &str) -> InfuError {
    InfuError::new(&format!("'{}' field is expected for item type '{}' - cannot read entry for item '{}'.", field_name, item_type, item_id))
  }

  json::validate_map_fields(map, &ALL_JSON_FIELDS)?;

  let id = json::get_string_field(map, "id")?.ok_or("'id' field was missing.")?;
  if !is_uid(&id) { return Err(format!("Item has invalid uid '{}'.", id).into()); }

  let item_type = json::get_string_field(map, "itemType")?.ok_or("'itemType' field was missing.")?;

  let parent_id = match map.get("parentId").ok_or(InfuError::new("'parentId' field was missing, and must always be set, even if null."))? {
    Value::Null => None,
    Value::String(uid_maybe) => {
      if !is_uid(uid_maybe) {
        return Err(format!("Item has invalid parent uid '{}'.", uid_maybe).into());
      }
      Some(uid_maybe.clone())
    },
    _ => return Err("'parentId' field was not of type 'string'.".into())
  };

  Ok(Item {
    item_type: item_type.clone(),
    id: id.clone(),
    owner_id: json::get_string_field(map, "ownerId")?.ok_or("'owner_id' field was missing.")?,
    parent_id,
    relationship_to_parent: RelationshipToParent::from_str(
      &json::get_string_field(map, "relationshipToParent")?.ok_or("'relationshipToParent' field is missing.")?)?,
    creation_date: json::get_integer_field(map, "creationDate")?.ok_or("'creationDate' field was missing.")?,
    last_modified_date: json::get_integer_field(map, "lastModifiedDate")?.ok_or("'lastModifiedDate' field was missing.")?,
    ordering: map.get("ordering")
      .ok_or(format!("'ordering' field for item '{}' was missing.", &id))?
      .as_array()
      .ok_or(format!("'ordering' field for item '{}' was not of type 'array'.", &id))?
      .iter().map(|v| match v.as_i64() {
        Some(v) => if v >= 0 && v <= 255 { Some(v as u8) } else { None },
        None => None
      })
      .collect::<Option<Vec<_>>>().ok_or(format!("One or more element of the 'ordering' field for item '{}' was invalid.", &id))?,
    spatial_position_gr: json::get_vector_field(map, "spatialPositionGr")?.ok_or("'spatialPositionGr' field was missing.")?,

    // x-sizeable
    spatial_width_gr: match json::get_integer_field(map, "spatialWidthGr")? {
      Some(v) => { if is_x_sizeable_item(&item_type) { Ok(Some(v)) } else { Err(not_applicable_err("spatialWidthGr", &item_type, &id)) } },
      None => { if is_x_sizeable_item(&item_type) { Err(expected_for_err("spatialWidthGr", &item_type, &id)) } else { Ok(None) } }
    }?,

    // y-sizeable
    spatial_height_gr: match json::get_integer_field(map, "spatialHeightGr")? {
      Some(v) => { if is_y_sizeable_item(&item_type) { Ok(Some(v)) } else { Err(not_applicable_err("spatialHeightGr", &item_type, &id)) } },
      None => { if is_y_sizeable_item(&item_type) { Err(expected_for_err("spatialHeightGr", &item_type, &id)) } else { Ok(None) } }
    }?,

    // titled
    title: match json::get_string_field(map, "title")? {
      Some(v) => { if is_titled_item(&item_type) { Ok(Some(v)) } else { Err(not_applicable_err("title", &item_type, &id)) } },
      None => { if is_titled_item(&item_type) { Err(expected_for_err("title", &item_type, &id)) } else { Ok(None) } }
    }?,

    // data
    original_creation_date: match json::get_integer_field(map, "originalCreationDate")? {
      Some(v) => { if is_data_item(&item_type) { Ok(Some(v)) } else { Err(not_applicable_err("originalCreationDate", &item_type, &id)) } },
      None => { if is_data_item(&item_type) { Err(expected_for_err("originalCreationDate", &item_type, &id)) } else { Ok(None) } }
    }?,
    mime_type: match json::get_string_field(map, "mimeType")? {
      Some(v) => { if is_data_item(&item_type) { Ok(Some(v)) } else { Err(not_applicable_err("mimeType", &item_type, &id)) } },
      None => { if is_data_item(&item_type) { Err(expected_for_err("mimeType", &item_type, &id)) } else { Ok(None) } }
    }?,
    file_size_bytes: match json::get_integer_field(map, "fileSizeBytes")? {
      Some(v) => { if is_data_item(&item_type) { Ok(Some(v)) } else { Err(not_applicable_err("fileSizeBytes", &item_type, &id)) } },
      None => { if is_data_item(&item_type) { Err(expected_for_err("fileSizeBytes", &item_type, &id)) } else { Ok(None) } }
    }?,

    // page
    inner_spatial_width_gr: match json::get_integer_field(map, "innerSpatialWidthGr")? {
      Some(v) => { if item_type == ITEM_TYPE_PAGE { Ok(Some(v)) } else { Err(not_applicable_err("innerSpatialWidthGr", &item_type, &id)) } },
      None => { if item_type == ITEM_TYPE_PAGE { Err(expected_for_err("innerSpatialWidthGr", &item_type, &id)) } else { Ok(None) } }
    }?,
    natural_aspect: match json::get_float_field(map, "naturalAspect")? {
      Some(v) => { if item_type == ITEM_TYPE_PAGE { Ok(Some(v)) } else { Err(not_applicable_err("naturalAspect", &item_type, &id)) } },
      None => { if item_type == ITEM_TYPE_PAGE { Err(expected_for_err("naturalAspect", &item_type, &id)) } else { Ok(None) } }
    }?,
    background_color_index: match json::get_integer_field(map, "backgroundColorIndex")? {
      Some(v) => { if item_type == ITEM_TYPE_PAGE { Ok(Some(v)) } else { Err(not_applicable_err("backgroundColorIndex", &item_type, &id)) } },
      None => { if item_type == ITEM_TYPE_PAGE { Err(expected_for_err("backgroundColorIndex", &item_type, &id)) } else { Ok(None) } }
    }?,
    arrange_algorithm: match &json::get_string_field(map, "arrangeAlgorithm")? {
      Some(v) => {
        if item_type == ITEM_TYPE_PAGE { Ok(Some(ArrangeAlgorithm::from_str(v)?)) }
        else { Err(not_applicable_err("arrangeAlgorithm", &item_type, &id)) } },
      None => { if item_type == ITEM_TYPE_PAGE { Err(expected_for_err("arrangeAlgorithm", &item_type, &id)) } else { Ok(None) } }
    }?,
    popup_position_gr: match json::get_vector_field(map, "popupPositionGr")? {
      Some(v) => { if item_type == ITEM_TYPE_PAGE { Ok(Some(v)) } else { Err(not_applicable_err("popupPositionGr", &item_type, &id)) } },
      None => { if item_type == ITEM_TYPE_PAGE { Err(expected_for_err("popupPositionGr", &item_type, &id)) } else { Ok(None) } }
    }?,
    popup_alignment_point: match &json::get_string_field(map, "popupAlignmentPoint")? {
      Some(v) => {
        if item_type == ITEM_TYPE_PAGE { Ok(Some(AlignmentPoint::from_str(v)?)) }
        else { Err(not_applicable_err("popupAlignmentPoint", &item_type, &id)) } },
      None => { if item_type == ITEM_TYPE_PAGE { Err(expected_for_err("popupAlignmentPoint", &item_type, &id)) } else { Ok(None) } }
    }?,
    popup_width_gr: match json::get_integer_field(map, "popupWidthGr")? {
      Some(v) => { if item_type == ITEM_TYPE_PAGE { Ok(Some(v)) } else { Err(not_applicable_err("popupWidthGr", &item_type, &id)) } },
      None => { if item_type == ITEM_TYPE_PAGE { Err(expected_for_err("popupWidthGr", &item_type, &id)) } else { Ok(None) } }
    }?,
    grid_number_of_columns: match json::get_integer_field(map, "gridNumberOfColumns")? {
      Some(v) => { if item_type == ITEM_TYPE_PAGE { Ok(Some(v)) } else { Err(not_applicable_err("gridNumberOfColumns", &item_type, &id)) } },
      None => { if item_type == ITEM_TYPE_PAGE { Err(expected_for_err("gridNumberOfColumns", &item_type, &id)) } else { Ok(None) } }
    }?,

    // note
    url: match json::get_string_field(map, "url")? {
      Some(v) => { if item_type == ITEM_TYPE_NOTE { Ok(Some(v)) } else { Err(not_applicable_err("url", &item_type, &id)) } },
      None => { if item_type == ITEM_TYPE_NOTE { Err(expected_for_err("url", &item_type, &id)) } else { Ok(None) } }
    }?,

    // file

    // table
    table_columns: match json::get_table_columns_field(map, "tableColumns")? {
      Some(v) => { if item_type == ITEM_TYPE_TABLE { Ok(Some(v)) } else { Err(not_applicable_err("tableColumns", &item_type, &id)) } }
      None => { if item_type == ITEM_TYPE_TABLE { Err(expected_for_err("tableColumns", &item_type, &id)) } else { Ok(None) } }
    }?,

    // image
    image_size_px: match json::get_dimensions_field(map, "imageSizePx")? {
      Some(v) => { if item_type == ITEM_TYPE_IMAGE { Ok(Some(v)) } else { Err(not_applicable_err("imageSizePx", &item_type, &id)) } },
      None => { if item_type == ITEM_TYPE_IMAGE { Err(expected_for_err("imageSizePx", &item_type, &id)) } else { Ok(None) } }
    }?,
    thumbnail: match json::get_string_field(map, "thumbnail")? {
      Some(v) => { if item_type == ITEM_TYPE_IMAGE { Ok(Some(v)) } else { Err(not_applicable_err("thumbnail", &item_type, &id)) } },
      None => { if item_type == ITEM_TYPE_IMAGE { Err(expected_for_err("thumbnail", &item_type, &id)) } else { Ok(None) } }
    }?,

    // rating
    rating: match json::get_integer_field(map, "rating")? {
      Some(v) => { if item_type == ITEM_TYPE_RATING { Ok(Some(v)) } else { Err(not_applicable_err("rating", &item_type, &id)) } },
      None => { if item_type == ITEM_TYPE_RATING { Err(expected_for_err("rating", &item_type, &id)) } else { Ok(None) } }
    }?,

    // link
    link_to_id: match json::get_string_field(map, "linkToId")? {
      Some(v) => { if item_type == ITEM_TYPE_LINK { Ok(Some(v)) } else { Err(not_applicable_err("linkToId", &item_type, &id)) } },
      None => { if item_type == ITEM_TYPE_LINK { Err(expected_for_err("linkToId", &item_type, &id)) } else { Ok(None) } }
    }?,
  })
}
