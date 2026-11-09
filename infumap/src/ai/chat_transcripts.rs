use std::io::ErrorKind;
use std::path::PathBuf;

use infusdk::item::{Item, ItemType};
use infusdk::util::infu::InfuResult;
use infusdk::util::uid::is_uid;
use tokio::fs;

use crate::ai::artifact_io::atomic_write;
use crate::util::fs::expand_tilde;
use crate::util::mime::CHAT_TRANSCRIPT_MIME_TYPE;

pub fn is_chat_item(item: &Item) -> bool {
  item.item_type == ItemType::Search || item.mime_type.as_deref() == Some(CHAT_TRANSCRIPT_MIME_TYPE)
}

pub fn transcript_path(data_dir: &str, user_id: &str, query_item_id: &str) -> InfuResult<PathBuf> {
  if !is_uid(user_id) || !is_uid(query_item_id) {
    return Err(format!("Invalid transcript id '{}' for user '{}'.", query_item_id, user_id).into());
  }
  let mut path = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
  path.push(format!("user_{user_id}"));
  path.push("chats");
  path.push(format!("{query_item_id}.chat"));
  Ok(path)
}

pub async fn read_transcript_bytes(data_dir: &str, user_id: &str, query_item_id: &str) -> InfuResult<Vec<u8>> {
  match fs::read(transcript_path(data_dir, user_id, query_item_id)?).await {
    Ok(mut bytes) => {
      // An append may be in flight. As with the authoritative reader, only complete JSONL records are visible.
      bytes.truncate(bytes.iter().rposition(|byte| *byte == b'\n').map_or(0, |index| index + 1));
      Ok(bytes)
    }
    Err(error) if error.kind() == ErrorKind::NotFound => Ok(Vec::new()),
    Err(error) => Err(error.into()),
  }
}

/// Local continuation metadata keeps tool exclusions across restarts without changing immutable saved transcripts.
pub async fn source_chat_ids(data_dir: &str, user_id: &str, query_item_id: &str) -> InfuResult<Vec<String>> {
  let path = transcript_path(data_dir, user_id, query_item_id)?.with_extension("sources.json");
  match fs::read(path).await {
    Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
    Err(error) if error.kind() == ErrorKind::NotFound => Ok(Vec::new()),
    Err(error) => Err(error.into()),
  }
}

pub async fn write_source_chat_ids(
  data_dir: &str,
  user_id: &str,
  query_item_id: &str,
  ids: &[String],
) -> InfuResult<()> {
  let path = transcript_path(data_dir, user_id, query_item_id)?.with_extension("sources.json");
  atomic_write(&path, &serde_json::to_vec(ids)?).await
}
