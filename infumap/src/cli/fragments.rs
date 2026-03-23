use std::cmp::Ordering;
use std::sync::Arc;

use clap::{Arg, ArgMatches, Command};
use infusdk::item::{ArrangeAlgorithm, Item, ItemType, RelationshipToParent};
use infusdk::util::infu::InfuResult;
use log::info;
use tokio::sync::Mutex;

use crate::config::CONFIG_DATA_DIR;
use crate::rag::{FragmentSourceKind, build_fragments_for_item, clear_fragments_for_item};
use crate::setup::get_config;
use crate::storage::db::Db;
use crate::util::ordering::compare_orderings;

pub fn make_clap_subcommand() -> Command {
  Command::new("fragments")
    .about("Build on-disk RAG fragment artifacts from item content without starting the web server.")
    .arg(
      Arg::new("settings_path")
        .short('s')
        .long("settings")
        .help("Path to a toml settings configuration file. If not specified, the default will be assumed.")
        .num_args(1)
        .required(false),
    )
    .arg(Arg::new("item_id").long("item-id").help("Build fragments only for this item.").num_args(1).required(false))
}

pub async fn execute(sub_matches: &ArgMatches) -> InfuResult<()> {
  let config = get_config(sub_matches.get_one::<String>("settings_path")).await?;
  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  let db = Arc::new(Mutex::new(Db::new(&data_dir).await.map_err(|e| format!("Failed to initialize database: {}", e))?));

  {
    let mut db = db.lock().await;
    let all_user_ids: Vec<String> = db.user.all_user_ids().iter().map(|v| v.clone()).collect();
    for user_id in all_user_ids {
      db.item.load_user_items(&user_id, false).await?;
    }
  }

  let items: Vec<Item> = {
    let db = db.lock().await;
    if let Some(item_id) = sub_matches.get_one::<String>("item_id") {
      vec![db.item.get(item_id).map_err(|e| e.to_string())?.clone()]
    } else {
      let mut items = db
        .item
        .all_loaded_items()
        .into_iter()
        .filter_map(|item_and_user_id| db.item.get(&item_and_user_id.item_id).ok().map(Item::clone))
        .collect::<Vec<Item>>();
      items.sort_by(|a, b| a.owner_id.cmp(&b.owner_id).then(a.id.cmp(&b.id)));
      items
    }
  };

  let mut items_with_fragments = 0usize;
  let mut items_cleared = 0usize;
  let mut fragments_written = 0usize;

  for item in items {
    let fragment_source = {
      let db = db.lock().await;
      fragment_source_for_item(&db, &item)
    };
    let outcome = match fragment_source {
      Some(fragment_source) => {
        build_fragments_for_item(
          &data_dir,
          &item,
          fragment_source.source_kind,
          &fragment_source.source_text,
          fragment_source.container_title,
        )
        .await?
      }
      None => clear_fragments_for_item(&data_dir, &item).await?,
    };
    if outcome.wrote_fragments {
      items_with_fragments += 1;
      fragments_written += outcome.fragment_count;
    } else if outcome.cleared_existing_fragments {
      items_cleared += 1;
    }
  }

  info!(
    "Built RAG fragments for {} item(s), wrote {} fragment(s), cleared {} empty item artifact dir(s).",
    items_with_fragments, fragments_written, items_cleared
  );

  Ok(())
}

struct FragmentSource {
  source_kind: FragmentSourceKind,
  source_text: String,
  container_title: Option<String>,
}

fn fragment_source_for_item(db: &Db, item: &Item) -> Option<FragmentSource> {
  match item.item_type {
    ItemType::Page => container_fragment_source(db, item, FragmentSourceKind::PageContents),
    ItemType::Table => container_fragment_source(db, item, FragmentSourceKind::TableContents),
    _ => None,
  }
}

fn container_fragment_source(db: &Db, item: &Item, source_kind: FragmentSourceKind) -> Option<FragmentSource> {
  let own_title = item.title.as_deref().map(str::trim).filter(|title| !title.is_empty()).map(str::to_owned);
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
  match item.relationship_to_parent {
    RelationshipToParent::Child => {
      let parent_id = item.parent_id.as_ref()?;
      let user = db.user.get(&item.owner_id)?;
      if parent_id == &user.home_page_id || parent_id == &user.trash_page_id || parent_id == &user.dock_page_id {
        return None;
      }
      let parent = db.item.get(parent_id).ok()?;
      parent.title.as_deref().map(|title| title.trim()).filter(|title| !title.is_empty()).map(|title| title.to_owned())
    }
    RelationshipToParent::Attachment => {
      // TODO: Decide whether attachment fragments should include parent title
      // or attachment-specific context. Leave them untouched for now.
      None
    }
    RelationshipToParent::NoParent => None,
  }
}
