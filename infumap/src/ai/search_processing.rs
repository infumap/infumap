//! Shared rules for the search processing lifecycle.
//!
//! These types describe facts supplied by workers and reconciliation. They do not
//! schedule work, inspect artifacts, or define a persistence/API format. In
//! particular, the legacy `search_status.json` snapshot cannot establish these
//! states: it does not record index acknowledgements or successful empty results.
//! See `docs/search-processing.md` for the contract and rollout boundaries.

// Workers and the live status pages will adopt this model in subsequent steps.
#![allow(dead_code)]

use infusdk::util::infu::InfuResult;

use crate::ai::image_tagging::is_supported_image_tagging_mime_type;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SearchContentKind {
  Pdf,
  Image,
  Markdown,
  Text,
}

impl SearchContentKind {
  pub fn from_mime_type(mime_type: Option<&str>) -> Option<Self> {
    match mime_type? {
      "application/pdf" => Some(Self::Pdf),
      "text/markdown" => Some(Self::Markdown),
      "text/plain" => Some(Self::Text),
      mime_type if is_supported_image_tagging_mime_type(Some(mime_type)) => Some(Self::Image),
      _ => None,
    }
  }
}

/// Identifies the desired search input, including the relevant source/context
/// and processing versions. It is not an item timestamp or an artifact path.
/// Allocation and persistence of revisions belong to the durable processing layer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SearchInputRevision(String);

impl SearchInputRevision {
  pub fn new(value: impl Into<String>) -> InfuResult<Self> {
    let value = value.into();
    if value.trim().is_empty() {
      return Err("A search input revision must not be empty.".into());
    }
    Ok(Self(value))
  }

  pub fn as_str(&self) -> &str {
    &self.0
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContentPreparationStage {
  ReadingSource,
  PdfExtraction,
  ImageTagging,
  PdfCaption,
  FragmentGeneration,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SearchProcessingStage {
  TitleIndexing,
  PreparingContent(ContentPreparationStage),
  ContentIndexing,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessingDependency {
  PdfExtraction,
  ImageTagging,
  PdfCaption,
  ReverseGeocoding,
  ObjectStore,
  SearchIndex,
}

/// Waiting always means that automatic recovery/retry is scheduled. Missing
/// configuration or an unsupported capability must use `AttentionReason` instead.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WaitingReason {
  DependencyUnavailable(ProcessingDependency),
  DependencyBusy(ProcessingDependency),
  RetryScheduled,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AttentionReason {
  NotConfigured(ProcessingDependency),
  InvalidConfiguration(ProcessingDependency),
  UnsupportedCapability(ProcessingDependency),
  PasswordRequired,
  DocumentRejected,
  SourceMissing,
  InvalidArtifacts,
  ProcessingFailed,
  IndexingFailed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessingProblem {
  pub reason: AttentionReason,
  pub detail: String,
}

/// Activity for unfinished work on the current input. A completed result is
/// recorded separately; neither missing work nor an error implies completion.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum WorkState {
  #[default]
  Checking,
  Queued,
  Running,
  Waiting {
    reason: WaitingReason,
    detail: Option<String>,
  },
  NeedsAttention(ProcessingProblem),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IndexingProgress {
  pub desired_revision: SearchInputRevision,
  /// Set only after the index update/removal and search metadata writes succeed,
  /// or after verifying a removal is a no-op because no index entries exist.
  /// Clear this acknowledgement if reconciliation finds the index missing/invalid.
  pub committed_revision: Option<SearchInputRevision>,
  pub work: WorkState,
}

impl IndexingProgress {
  pub fn is_current(&self) -> bool {
    self.committed_revision.as_ref() == Some(&self.desired_revision)
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TitleOutcome {
  SearchableTitle,
  /// Includes empty titles and items deliberately excluded from title search.
  NoSearchableTitle,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum TitleProcessingState {
  #[default]
  Checking,
  Updating {
    outcome: TitleOutcome,
    index: IndexingProgress,
  },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContentOutcome {
  SearchableFragments,
  /// All required preparation, including any required fallback, succeeded but
  /// produced no usable content. Missing artifacts, errors and outages are not
  /// evidence for this outcome. Any old index entries must still be removed.
  NoSearchableContent,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum ContentProcessingState {
  #[default]
  Checking,
  /// Content search is not supported for this item. If it used to be supported,
  /// removal of its old content index entries must finish before using this state.
  Unsupported,
  Preparing {
    stage: ContentPreparationStage,
    work: WorkState,
  },
  /// Preparation finished for `index.desired_revision`. A new input revision
  /// invalidates this preparation and returns the item to `Preparing`.
  Prepared {
    outcome: ContentOutcome,
    index: IndexingProgress,
  },
}

/// Optional location work is independent of title/content readiness and page
/// membership. Its status remains available for item details even after the item
/// leaves the processing pages. `Completed` includes any resulting index update.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum LocationEnrichmentState {
  #[default]
  Checking,
  NotRequested,
  Working(WorkState),
  Completed,
  NoLocationFound,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ItemSearchProcessingState {
  pub title: TitleProcessingState,
  pub content: ContentProcessingState,
  pub location: LocationEnrichmentState,
}

/// Presentation state for one of the two required tracks (title or content).
/// `Ready` means eligible for the existing search paths, not a guarantee that a
/// particular query, ranking or search scope will return the item.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SearchProcessingStatus {
  Checking,
  Queued { stage: SearchProcessingStage },
  Processing { stage: ContentPreparationStage },
  Waiting { stage: SearchProcessingStage, reason: WaitingReason, detail: Option<String> },
  Indexing { stage: SearchProcessingStage },
  Ready,
  NoSearchableContent,
  NotApplicable,
  Unsupported,
  NeedsAttention { stage: SearchProcessingStage, problem: ProcessingProblem },
}

impl WorkState {
  fn status(&self, stage: SearchProcessingStage) -> SearchProcessingStatus {
    match self {
      Self::Checking => SearchProcessingStatus::Checking,
      Self::Queued => SearchProcessingStatus::Queued { stage },
      Self::Running => match stage {
        SearchProcessingStage::PreparingContent(stage) => SearchProcessingStatus::Processing { stage },
        SearchProcessingStage::TitleIndexing | SearchProcessingStage::ContentIndexing => {
          SearchProcessingStatus::Indexing { stage }
        }
      },
      Self::Waiting { reason, detail } => {
        SearchProcessingStatus::Waiting { stage, reason: reason.clone(), detail: detail.clone() }
      }
      Self::NeedsAttention(problem) => SearchProcessingStatus::NeedsAttention { stage, problem: problem.clone() },
    }
  }
}

impl TitleProcessingState {
  pub fn status(&self) -> SearchProcessingStatus {
    match self {
      Self::Checking => SearchProcessingStatus::Checking,
      Self::Updating { outcome, index } if index.is_current() => match outcome {
        TitleOutcome::SearchableTitle => SearchProcessingStatus::Ready,
        TitleOutcome::NoSearchableTitle => SearchProcessingStatus::NotApplicable,
      },
      Self::Updating { index, .. } => index.work.status(SearchProcessingStage::TitleIndexing),
    }
  }
}

impl ContentProcessingState {
  pub fn status(&self) -> SearchProcessingStatus {
    match self {
      Self::Checking => SearchProcessingStatus::Checking,
      Self::Unsupported => SearchProcessingStatus::Unsupported,
      Self::Preparing { stage, work } => work.status(SearchProcessingStage::PreparingContent(*stage)),
      Self::Prepared { outcome, index } if index.is_current() => match outcome {
        ContentOutcome::SearchableFragments => SearchProcessingStatus::Ready,
        ContentOutcome::NoSearchableContent => SearchProcessingStatus::NoSearchableContent,
      },
      Self::Prepared { index, .. } => index.work.status(SearchProcessingStage::ContentIndexing),
    }
  }
}

impl SearchProcessingStatus {
  pub fn is_pending(&self) -> bool {
    matches!(self, Self::Queued { .. } | Self::Processing { .. } | Self::Waiting { .. } | Self::Indexing { .. })
  }

  pub fn needs_attention(&self) -> bool {
    matches!(self, Self::NeedsAttention { .. })
  }
}

/// These are independent flags: a title indexing failure can require attention
/// while the same item's content is still processing. Counts are per item per page.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SearchProcessingPageMembership {
  pub processing: bool,
  pub needs_attention: bool,
  /// A caller must show that status is still being checked, rather than treating
  /// an unknown track as complete or publishing its count as a final zero.
  pub checking: bool,
}

impl ItemSearchProcessingState {
  pub fn page_membership(&self) -> SearchProcessingPageMembership {
    let title = self.title.status();
    let content = self.content.status();
    SearchProcessingPageMembership {
      processing: title.is_pending() || content.is_pending(),
      needs_attention: title.needs_attention() || content.needs_attention(),
      checking: title == SearchProcessingStatus::Checking || content == SearchProcessingStatus::Checking,
    }
  }
}
