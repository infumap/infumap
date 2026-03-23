use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};
use std::io::ErrorKind;
use std::path::PathBuf;
use std::sync::Arc;

use clap::{Arg, ArgMatches, Command};
use infusdk::item::{ArrangeAlgorithm, Item, ItemType, RelationshipToParent};
use infusdk::util::infu::InfuResult;
use log::info;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use tokio::fs;
use tokio::sync::Mutex;

use crate::config::CONFIG_DATA_DIR;
use crate::rag::{FragmentBuildOutcome, FragmentSourceKind, build_fragments_for_item, clear_fragments_for_item};
use crate::setup::get_config;
use crate::storage::db::Db;
use crate::util::fs::expand_tilde;
use crate::util::ordering::compare_orderings;
use crate::web::image_tagging::should_tag_image_item;

#[derive(Clone, Copy)]
enum FragmentTargetKind {
  Content,
  Image,
}

impl FragmentTargetKind {
  fn matches_item(self, item: &Item) -> bool {
    match self {
      FragmentTargetKind::Content => matches!(item.item_type, ItemType::Page | ItemType::Table),
      FragmentTargetKind::Image => should_tag_image_item(item),
    }
  }

  fn singular_label(self) -> &'static str {
    match self {
      FragmentTargetKind::Content => "page or table",
      FragmentTargetKind::Image => "supported image",
    }
  }

  fn summary_label(self) -> &'static str {
    match self {
      FragmentTargetKind::Content => "page/table",
      FragmentTargetKind::Image => "image",
    }
  }
}

#[derive(Default)]
struct FragmentRunSummary {
  items_with_fragments: usize,
  items_cleared: usize,
  fragments_written: usize,
}

pub fn make_clap_subcommand() -> Command {
  Command::new("fragments")
    .about("Build on-disk RAG fragment artifacts without starting the web server.")
    .subcommand_required(true)
    .arg_required_else_help(true)
    .subcommand(make_content_subcommand())
    .subcommand(make_image_subcommand())
}

pub async fn execute(sub_matches: &ArgMatches) -> InfuResult<()> {
  match sub_matches.subcommand() {
    Some(("content", sub_matches)) => execute_content(sub_matches).await,
    Some(("page-table", sub_matches)) => execute_content(sub_matches).await,
    Some(("image", sub_matches)) => execute_image(sub_matches).await,
    Some(("images", sub_matches)) => execute_image(sub_matches).await,
    _ => Err("Missing fragments subcommand. Use 'fragments content' or 'fragments image'.".into()),
  }
}

fn make_content_subcommand() -> Command {
  Command::new("content")
    .visible_alias("page-table")
    .about("Build fragments for page and table content.")
    .arg(settings_arg())
    .arg(item_id_arg("Build fragments only for this page or table item."))
}

fn make_image_subcommand() -> Command {
  Command::new("image")
    .visible_alias("images")
    .about(
      "Build semantic text fragments for supported images using item metadata, image-tagging output, and geo output.",
    )
    .arg(settings_arg())
    .arg(item_id_arg("Build fragments only for this supported image item."))
}

fn settings_arg() -> Arg {
  Arg::new("settings_path")
    .short('s')
    .long("settings")
    .help("Path to a toml settings configuration file. If not specified, the default will be assumed.")
    .num_args(1)
    .required(false)
}

fn item_id_arg(help: &'static str) -> Arg {
  Arg::new("item_id").long("item-id").help(help).num_args(1).required(false)
}

async fn execute_content(sub_matches: &ArgMatches) -> InfuResult<()> {
  let (data_dir, db, items) = load_db_and_items(sub_matches, FragmentTargetKind::Content).await?;
  let mut summary = FragmentRunSummary::default();

  for item in items {
    let fragment_source = {
      let db = db.lock().await;
      content_fragment_source_for_item(&db, &item)
    };
    let outcome = apply_fragment_source(&data_dir, &item, fragment_source).await?;
    record_fragment_outcome(&mut summary, &outcome);
  }

  log_fragment_summary(FragmentTargetKind::Content, &summary);
  Ok(())
}

async fn execute_image(sub_matches: &ArgMatches) -> InfuResult<()> {
  let (data_dir, db, items) = load_db_and_items(sub_matches, FragmentTargetKind::Image).await?;
  let mut summary = FragmentRunSummary::default();

  for item in items {
    let context_title = {
      let db = db.lock().await;
      embedding_context_title_for_item(&db, &item)
    };
    let fragment_source = image_fragment_source_for_item(&data_dir, &item, context_title).await?;
    let outcome = apply_fragment_source(&data_dir, &item, fragment_source).await?;
    record_fragment_outcome(&mut summary, &outcome);
  }

  log_fragment_summary(FragmentTargetKind::Image, &summary);
  Ok(())
}

async fn load_db_and_items(
  sub_matches: &ArgMatches,
  target_kind: FragmentTargetKind,
) -> InfuResult<(String, Arc<Mutex<Db>>, Vec<Item>)> {
  let config = get_config(sub_matches.get_one::<String>("settings_path")).await?;
  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  let db = Arc::new(Mutex::new(Db::new(&data_dir).await.map_err(|e| format!("Failed to initialize database: {}", e))?));

  {
    let mut db = db.lock().await;
    let all_user_ids: Vec<String> = db.user.all_user_ids().iter().map(|value| value.clone()).collect();
    for user_id in all_user_ids {
      db.item.load_user_items(&user_id, false).await?;
    }
  }

  let items = {
    let db = db.lock().await;
    if let Some(item_id) = sub_matches.get_one::<String>("item_id") {
      let item = db.item.get(item_id).map_err(|e| e.to_string())?.clone();
      if !target_kind.matches_item(&item) {
        return Err(format!("Item '{}' is not a {}.", item_id, target_kind.singular_label()).into());
      }
      vec![item]
    } else {
      let mut items = db
        .item
        .all_loaded_items()
        .into_iter()
        .filter_map(|item_and_user_id| db.item.get(&item_and_user_id.item_id).ok().map(Item::clone))
        .filter(|item| target_kind.matches_item(item))
        .collect::<Vec<Item>>();
      items.sort_by(|a, b| a.owner_id.cmp(&b.owner_id).then(a.id.cmp(&b.id)));
      items
    }
  };

  Ok((data_dir, db, items))
}

async fn apply_fragment_source(
  data_dir: &str,
  item: &Item,
  fragment_source: Option<FragmentSource>,
) -> InfuResult<FragmentBuildOutcome> {
  match fragment_source {
    Some(fragment_source) => {
      build_fragments_for_item(
        data_dir,
        item,
        fragment_source.source_kind,
        &fragment_source.source_text,
        fragment_source.container_title,
      )
      .await
    }
    None => clear_fragments_for_item(data_dir, item).await,
  }
}

fn record_fragment_outcome(summary: &mut FragmentRunSummary, outcome: &FragmentBuildOutcome) {
  if outcome.wrote_fragments {
    summary.items_with_fragments += 1;
    summary.fragments_written += outcome.fragment_count;
  } else if outcome.cleared_existing_fragments {
    summary.items_cleared += 1;
  }
}

fn log_fragment_summary(target_kind: FragmentTargetKind, summary: &FragmentRunSummary) {
  info!(
    "Built {} RAG fragments for {} item(s), wrote {} fragment(s), cleared {} empty item artifact dir(s).",
    target_kind.summary_label(),
    summary.items_with_fragments,
    summary.fragments_written,
    summary.items_cleared
  );
}

struct FragmentSource {
  source_kind: FragmentSourceKind,
  source_text: String,
  container_title: Option<String>,
}

fn content_fragment_source_for_item(db: &Db, item: &Item) -> Option<FragmentSource> {
  match item.item_type {
    ItemType::Page => container_fragment_source(db, item, FragmentSourceKind::PageContents),
    ItemType::Table => container_fragment_source(db, item, FragmentSourceKind::TableContents),
    _ => None,
  }
}

fn container_fragment_source(db: &Db, item: &Item, source_kind: FragmentSourceKind) -> Option<FragmentSource> {
  let own_title = normalized_text(item.title.as_deref());
  let lines = container_child_title_lines(db, item);
  if lines.is_empty() && own_title.is_none() {
    return None;
  }

  Some(FragmentSource {
    source_kind,
    source_text: lines.join("\n"),
    container_title: own_title.or_else(|| container_title_for_item(db, item)),
  })
}

async fn image_fragment_source_for_item(
  data_dir: &str,
  item: &Item,
  context_title: Option<String>,
) -> InfuResult<Option<FragmentSource>> {
  let image_tag_artifact = load_image_tag_artifact(data_dir, &item.owner_id, &item.id).await?;
  let geo_artifact = load_geo_artifact(data_dir, &item.owner_id, &item.id).await?;
  let dimensions = item.image_size_px.as_ref().map(|dims| (dims.w, dims.h));
  let fragment_text = build_image_fragment_text(
    item.title.as_deref(),
    context_title.as_deref(),
    dimensions,
    image_tag_artifact.as_ref(),
    geo_artifact.as_ref(),
  );

  Ok(fragment_text.map(|source_text| FragmentSource {
    source_kind: FragmentSourceKind::ImageContents,
    source_text,
    container_title: None,
  }))
}

async fn load_image_tag_artifact(
  data_dir: &str,
  user_id: &str,
  item_id: &str,
) -> InfuResult<Option<StoredImageTagArtifact>> {
  let path = image_tag_text_path(data_dir, user_id, item_id)?;
  read_json_if_exists(&path, "image-tag artifact").await
}

async fn load_geo_artifact(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<Option<StoredGeoArtifact>> {
  let path = geo_content_path(data_dir, user_id, item_id)?;
  read_json_if_exists(&path, "geo artifact").await
}

async fn read_json_if_exists<T: DeserializeOwned>(path: &PathBuf, artifact_label: &str) -> InfuResult<Option<T>> {
  let bytes = match fs::read(path).await {
    Ok(bytes) => bytes,
    Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
    Err(error) => return Err(format!("Could not read {} '{}': {}", artifact_label, path.display(), error).into()),
  };

  serde_json::from_slice(&bytes)
    .map(Some)
    .map_err(|error| format!("Could not parse {} '{}': {}", artifact_label, path.display(), error).into())
}

fn build_image_fragment_text(
  title: Option<&str>,
  context_title: Option<&str>,
  item_dimensions: Option<(i64, i64)>,
  image_tag_artifact: Option<&StoredImageTagArtifact>,
  geo_artifact: Option<&StoredGeoArtifact>,
) -> Option<String> {
  let mut sentences = Vec::new();

  let title = normalized_text(title);
  let context_title = normalized_text(context_title)
    .filter(|context| title.as_deref().map(|title| title.to_lowercase() != context.to_lowercase()).unwrap_or(true));

  if let Some(title) = title {
    sentences.push(labeled_sentence("Title", &title));
  }
  if let Some(context_title) = context_title {
    sentences.push(labeled_sentence("Context", &context_title));
  }

  if let Some(image_tag_artifact) = image_tag_artifact {
    if let Some(scene) = normalized_text(image_tag_artifact.scene.as_deref()) {
      sentences.push(labeled_sentence("Scene", &scene));
    }
    if let Some(caption) = normalized_text(image_tag_artifact.detailed_caption.as_deref()) {
      sentences.push(labeled_sentence("Description", &caption));
    }

    let ocr_text = normalized_text_list(&image_tag_artifact.ocr_text);
    if !ocr_text.is_empty() {
      sentences.push(labeled_sentence("Visible text", &ocr_text.join("; ")));
    }

    let tags = normalized_text_list(&image_tag_artifact.tags);
    if !tags.is_empty() {
      sentences.push(labeled_sentence("Tags", &tags.join(", ")));
    }

    if let Some(face_count) = positive_face_count(image_tag_artifact.visible_face_count_estimate.as_deref()) {
      sentences.push(labeled_sentence("Visible faces", &face_count.to_string()));
    }
  }

  if let Some(location) = best_geo_location_text(geo_artifact) {
    sentences.push(labeled_sentence("Location", &location));
  } else if let Some((lat, lon)) = best_coordinate_pair(image_tag_artifact, geo_artifact) {
    sentences.push(labeled_sentence("Coordinates", &format!("{lat:.6}, {lon:.6}")));
  }

  if let Some(location_codes) = best_geo_location_codes(geo_artifact) {
    sentences.push(labeled_sentence("Location codes", &location_codes.join(", ")));
  }

  if let Some(captured_at) = image_tag_artifact
    .and_then(|artifact| artifact.image_metadata.as_ref())
    .and_then(|metadata| normalized_text(metadata.captured_at.as_deref()))
  {
    sentences.push(labeled_sentence("Captured at", &captured_at));
  }

  if let Some(camera) =
    image_tag_artifact.and_then(|artifact| artifact.image_metadata.as_ref()).and_then(camera_description)
  {
    sentences.push(labeled_sentence("Camera", &camera));
  }

  if let Some((width, height)) = best_image_dimensions(item_dimensions, image_tag_artifact) {
    sentences.push(labeled_sentence("Dimensions", &format!("{width}x{height}")));
  }

  if sentences.is_empty() { None } else { Some(sentences.join(" ")) }
}

fn labeled_sentence(label: &str, value: &str) -> String {
  let trimmed = value.trim();
  if trimmed.is_empty() {
    return String::new();
  }
  match trimmed.chars().last() {
    Some('.' | '!' | '?') => format!("{label}: {trimmed}"),
    _ => format!("{label}: {trimmed}."),
  }
}

fn normalized_text(value: Option<&str>) -> Option<String> {
  let value = value?;
  let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
  if collapsed.is_empty() { None } else { Some(collapsed) }
}

fn normalized_text_list(values: &[String]) -> Vec<String> {
  let mut out = Vec::new();
  let mut seen = HashSet::new();

  for value in values {
    let Some(normalized) = normalized_text(Some(value.as_str())) else {
      continue;
    };
    let key = normalized.to_lowercase();
    if seen.insert(key) {
      out.push(normalized);
    }
  }

  out
}

fn positive_face_count(value: Option<&str>) -> Option<usize> {
  let parsed = value?.trim().parse::<usize>().ok()?;
  (parsed > 0).then_some(parsed)
}

fn best_geo_location_text(geo_artifact: Option<&StoredGeoArtifact>) -> Option<String> {
  let best_result = geo_artifact?.results.first()?;
  normalized_text(best_result.formatted.as_deref()).or_else(|| {
    let mut parts = Vec::new();
    if let Some(name) = normalized_text(best_result.name.as_deref()) {
      parts.push(name);
    }
    if let Some(city) = normalized_text(best_result.city.as_deref()) {
      parts.push(city);
    }
    if let Some(province) = normalized_text(best_result.province.as_deref()) {
      parts.push(province);
    }
    if let Some(country) = normalized_text(best_result.country.as_deref()) {
      parts.push(country);
    }
    if parts.is_empty() { None } else { Some(parts.join(", ")) }
  })
}

fn best_geo_location_codes(geo_artifact: Option<&StoredGeoArtifact>) -> Option<Vec<String>> {
  let best_result = geo_artifact?.results.first()?;
  let mut codes = Vec::new();
  let mut seen = HashSet::new();

  for key in ["iata", "icao"] {
    let Some(value) = best_result.other_names.get(key) else {
      continue;
    };
    let Some(code) = normalized_text(Some(value.as_str())) else {
      continue;
    };
    let normalized_code = code.to_uppercase();
    if seen.insert(normalized_code.clone()) {
      codes.push(normalized_code);
    }
  }

  if codes.is_empty() { None } else { Some(codes) }
}

fn best_coordinate_pair(
  image_tag_artifact: Option<&StoredImageTagArtifact>,
  geo_artifact: Option<&StoredGeoArtifact>,
) -> Option<(f64, f64)> {
  if let Some(metadata) = image_tag_artifact.and_then(|artifact| artifact.image_metadata.as_ref()) {
    if let (Some(lat), Some(lon)) = (metadata.gps_latitude, metadata.gps_longitude) {
      return Some((lat, lon));
    }
  }

  let query = geo_artifact?.query.as_ref()?;
  match (query.lat, query.lon) {
    (Some(lat), Some(lon)) => Some((lat, lon)),
    _ => None,
  }
}

fn camera_description(metadata: &StoredImageMetadata) -> Option<String> {
  let make = normalized_text(metadata.camera_make.as_deref());
  let model = normalized_text(metadata.camera_model.as_deref());

  match (make, model) {
    (Some(make), Some(model)) if model.to_lowercase().starts_with(&make.to_lowercase()) => Some(model),
    (Some(make), Some(model)) => Some(format!("{make} {model}")),
    (Some(make), None) => Some(make),
    (None, Some(model)) => Some(model),
    (None, None) => None,
  }
}

fn best_image_dimensions(
  item_dimensions: Option<(i64, i64)>,
  image_tag_artifact: Option<&StoredImageTagArtifact>,
) -> Option<(i64, i64)> {
  if let Some(metadata) = image_tag_artifact.and_then(|artifact| artifact.image_metadata.as_ref()) {
    if let (Some(width), Some(height)) = (metadata.exif_pixel_width, metadata.exif_pixel_height) {
      return Some((i64::from(width), i64::from(height)));
    }
  }

  item_dimensions.filter(|(width, height)| *width > 0 && *height > 0)
}

#[derive(Default, Deserialize)]
struct StoredImageTagArtifact {
  detailed_caption: Option<String>,
  scene: Option<String>,
  visible_face_count_estimate: Option<String>,
  #[serde(default)]
  tags: Vec<String>,
  #[serde(default)]
  ocr_text: Vec<String>,
  image_metadata: Option<StoredImageMetadata>,
}

#[derive(Default, Deserialize)]
struct StoredImageMetadata {
  captured_at: Option<String>,
  gps_latitude: Option<f64>,
  gps_longitude: Option<f64>,
  camera_make: Option<String>,
  camera_model: Option<String>,
  exif_pixel_width: Option<u32>,
  exif_pixel_height: Option<u32>,
}

#[derive(Default, Deserialize)]
struct StoredGeoArtifact {
  query: Option<StoredGeoQuery>,
  #[serde(default)]
  results: Vec<StoredGeoResult>,
}

#[derive(Default, Deserialize)]
struct StoredGeoQuery {
  lat: Option<f64>,
  lon: Option<f64>,
}

#[derive(Default, Deserialize)]
struct StoredGeoResult {
  name: Option<String>,
  formatted: Option<String>,
  city: Option<String>,
  province: Option<String>,
  country: Option<String>,
  #[serde(default)]
  other_names: BTreeMap<String, String>,
}

fn container_child_title_lines(db: &Db, item: &Item) -> Vec<String> {
  ordered_container_children(db, item)
    .into_iter()
    .flat_map(|child| fragment_lines_for_display_item(db, child))
    .collect()
}

fn ordered_container_children<'a>(db: &'a Db, item: &Item) -> Vec<&'a Item> {
  let mut children = db.item.get_children(&item.id).unwrap_or_default();
  match item.item_type {
    ItemType::Page => match item.arrange_algorithm {
      Some(ArrangeAlgorithm::SpatialStretch) => {
        children.sort_by(|a, b| compare_spatial_position(a, b).then_with(|| compare_item_order(a, b)));
      }
      Some(ArrangeAlgorithm::Calendar) => {
        children.sort_by(|a, b| a.datetime.cmp(&b.datetime).then_with(|| compare_item_order(a, b)));
      }
      _ => sort_children_for_display(db, item, &mut children),
    },
    ItemType::Table | ItemType::Composite => sort_children_for_display(db, item, &mut children),
    _ => {}
  }
  children
}

fn sort_children_for_display(db: &Db, container: &Item, children: &mut Vec<&Item>) {
  let order_children_by = container.order_children_by.as_deref().unwrap_or_default();
  let use_title_sort = order_children_by == "title[ASC]"
    && !(container.item_type == ItemType::Page && container.arrange_algorithm == Some(ArrangeAlgorithm::Document));

  if use_title_sort {
    children.sort_by(|a, b| compare_items_by_display_title(db, a, b));
  } else {
    children.sort_by(|a, b| compare_item_order(a, b));
  }
}

fn compare_items_by_display_title(db: &Db, a: &Item, b: &Item) -> Ordering {
  let a_resolved = resolved_link_target(db, a);
  let b_resolved = resolved_link_target(db, b);

  let a_is_unresolved = a.item_type == ItemType::Link && a_resolved.is_none();
  let b_is_unresolved = b.item_type == ItemType::Link && b_resolved.is_none();

  match (a_is_unresolved, b_is_unresolved) {
    (true, false) => Ordering::Greater,
    (false, true) => Ordering::Less,
    _ => display_title_for_sort(a_resolved.unwrap_or(a))
      .cmp(&display_title_for_sort(b_resolved.unwrap_or(b)))
      .then_with(|| a.id.cmp(&b.id)),
  }
}

fn compare_item_order(a: &Item, b: &Item) -> Ordering {
  compare_ordering_bytes(&a.ordering, &b.ordering).then_with(|| a.id.cmp(&b.id))
}

fn compare_spatial_position(a: &Item, b: &Item) -> Ordering {
  let (a_y, a_x) = item_position_sort_key(a);
  let (b_y, b_x) = item_position_sort_key(b);
  a_y.cmp(&b_y).then(a_x.cmp(&b_x))
}

fn item_position_sort_key(item: &Item) -> (i64, i64) {
  item.spatial_position_gr.as_ref().map(|pos| (pos.y, pos.x)).unwrap_or((0, 0))
}

fn compare_ordering_bytes(a: &Vec<u8>, b: &Vec<u8>) -> Ordering {
  match compare_orderings(a, b) {
    -1 => Ordering::Less,
    1 => Ordering::Greater,
    _ => Ordering::Equal,
  }
}

fn display_title_for_sort(item: &Item) -> String {
  item.title.as_deref().map(str::trim).filter(|title| !title.is_empty()).unwrap_or("").to_lowercase()
}

fn fragment_lines_for_display_item(db: &Db, item: &Item) -> Vec<String> {
  if item.item_type == ItemType::Link {
    return resolved_link_target(db, item)
      .map(|target| fragment_lines_for_non_link_item(db, target))
      .unwrap_or_default();
  }
  fragment_lines_for_non_link_item(db, item)
}

fn fragment_lines_for_non_link_item(db: &Db, item: &Item) -> Vec<String> {
  match item.item_type {
    ItemType::Composite => ordered_container_children(db, item)
      .into_iter()
      .flat_map(|child| fragment_lines_for_display_item(db, child))
      .collect(),
    _ => item
      .title
      .as_deref()
      .map(str::trim)
      .filter(|title| !title.is_empty())
      .map(|title| vec![title.to_owned()])
      .unwrap_or_default(),
  }
}

fn resolved_link_target<'a>(db: &'a Db, item: &Item) -> Option<&'a Item> {
  if item.item_type != ItemType::Link {
    return None;
  }
  item.link_to.as_ref().and_then(|target_id| db.item.get(target_id).ok())
}

fn container_title_for_item(db: &Db, item: &Item) -> Option<String> {
  parent_title_for_item(db, item, false)
}

fn embedding_context_title_for_item(db: &Db, item: &Item) -> Option<String> {
  parent_title_for_item(db, item, true)
}

fn parent_title_for_item(db: &Db, item: &Item, include_attachment_parents: bool) -> Option<String> {
  match item.relationship_to_parent {
    RelationshipToParent::Child => titled_non_system_parent(db, item),
    RelationshipToParent::Attachment if include_attachment_parents => titled_non_system_parent(db, item),
    RelationshipToParent::Attachment | RelationshipToParent::NoParent => None,
  }
}

fn titled_non_system_parent(db: &Db, item: &Item) -> Option<String> {
  let parent_id = item.parent_id.as_ref()?;
  let user = db.user.get(&item.owner_id)?;
  if parent_id == &user.home_page_id || parent_id == &user.trash_page_id || parent_id == &user.dock_page_id {
    return None;
  }
  let parent = db.item.get(parent_id).ok()?;
  normalized_text(parent.title.as_deref())
}

fn image_tag_text_path(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  let mut path = text_shard_dir(data_dir, user_id, item_id)?;
  path.push(format!("{}_text", item_id));
  Ok(path)
}

fn geo_content_path(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  let mut path = text_shard_dir(data_dir, user_id, item_id)?;
  path.push(format!("{}_geo.json", item_id));
  Ok(path)
}

fn text_shard_dir(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  if item_id.len() < 2 {
    return Err(format!("Item id '{}' is too short.", item_id).into());
  }
  let mut path = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
  path.push(format!("user_{}", user_id));
  path.push("text");
  path.push(&item_id[..2]);
  Ok(path)
}

#[cfg(test)]
mod tests {
  use super::{
    StoredGeoArtifact, StoredGeoQuery, StoredGeoResult, StoredImageMetadata, StoredImageTagArtifact,
    build_image_fragment_text,
  };
  use std::collections::BTreeMap;

  #[test]
  fn builds_image_fragment_text_from_semantic_fields() {
    let tag = StoredImageTagArtifact {
      detailed_caption: Some("An angled view captures a luxurious airplane seat.".to_owned()),
      scene: Some("Airplane cabin interior".to_owned()),
      visible_face_count_estimate: Some("0".to_owned()),
      tags: vec!["airplane".to_owned(), "business class".to_owned(), "travel".to_owned()],
      ocr_text: vec!["SAWASDEE".to_owned(), "Adventures for the Soul".to_owned()],
      image_metadata: Some(StoredImageMetadata {
        captured_at: Some("2025-12-03T08:24:45.233+07:00".to_owned()),
        gps_latitude: Some(13.682677777777776),
        gps_longitude: Some(100.74934444444445),
        camera_make: Some("Apple".to_owned()),
        camera_model: Some("iPhone 15 Pro".to_owned()),
        exif_pixel_width: Some(4032),
        exif_pixel_height: Some(3024),
      }),
    };

    let mut other_names = BTreeMap::new();
    other_names.insert("iata".to_owned(), "BKK".to_owned());
    other_names.insert("icao".to_owned(), "VTBS".to_owned());

    let geo = StoredGeoArtifact {
      query: Some(StoredGeoQuery { lat: Some(13.682677777777776), lon: Some(100.74934444444445) }),
      results: vec![StoredGeoResult {
        name: Some("Suvarnabhumi Airport".to_owned()),
        formatted: Some("Suvarnabhumi Airport, Kingkaew 31/2, Racha Thewa Subdistrict, 10520, Thailand".to_owned()),
        city: Some("Racha Thewa Subdistrict".to_owned()),
        province: Some("Samut Prakan Province".to_owned()),
        country: Some("Thailand".to_owned()),
        other_names,
      }],
    };

    let text = build_image_fragment_text(
      Some("Thai Airways Business Class Seat"),
      Some("Bangkok Trip"),
      Some((1200, 800)),
      Some(&tag),
      Some(&geo),
    )
    .unwrap();

    assert!(text.contains("Title: Thai Airways Business Class Seat."));
    assert!(text.contains("Context: Bangkok Trip."));
    assert!(text.contains("Scene: Airplane cabin interior."));
    assert!(text.contains("Description: An angled view captures a luxurious airplane seat."));
    assert!(text.contains("Visible text: SAWASDEE; Adventures for the Soul."));
    assert!(text.contains("Tags: airplane, business class, travel."));
    assert!(text.contains("Location: Suvarnabhumi Airport, Kingkaew 31/2, Racha Thewa Subdistrict, 10520, Thailand."));
    assert!(text.contains("Location codes: BKK, VTBS."));
    assert!(text.contains("Captured at: 2025-12-03T08:24:45.233+07:00."));
    assert!(text.contains("Camera: Apple iPhone 15 Pro."));
    assert!(text.contains("Dimensions: 4032x3024."));
  }

  #[test]
  fn falls_back_to_coordinates_and_positive_face_count() {
    let tag = StoredImageTagArtifact {
      detailed_caption: None,
      scene: None,
      visible_face_count_estimate: Some("2".to_owned()),
      tags: vec![],
      ocr_text: vec![],
      image_metadata: Some(StoredImageMetadata {
        captured_at: None,
        gps_latitude: Some(1.25),
        gps_longitude: Some(103.75),
        camera_make: None,
        camera_model: None,
        exif_pixel_width: None,
        exif_pixel_height: None,
      }),
    };

    let text = build_image_fragment_text(Some("Family photo"), None, Some((1600, 900)), Some(&tag), None).unwrap();

    assert!(text.contains("Title: Family photo."));
    assert!(text.contains("Visible faces: 2."));
    assert!(text.contains("Coordinates: 1.250000, 103.750000."));
    assert!(text.contains("Dimensions: 1600x900."));
  }

  #[test]
  fn returns_none_when_no_embedding_useful_text_exists() {
    let text = build_image_fragment_text(None, None, None, None, None);
    assert!(text.is_none());
  }
}
