use once_cell::sync::Lazy;
use prometheus::{HistogramOpts, HistogramVec, IntCounterVec, IntGaugeVec, opts};

pub static METRIC_AI_IMAGE_PIPELINE_QUEUE_DEPTH: Lazy<IntGaugeVec> = Lazy::new(|| {
  IntGaugeVec::new(
    opts!("infumap_ai_image_pipeline_queue_depth", "Current image background pipeline queue depth by stage."),
    &["stage"],
  )
  .expect("Could not create METRIC_AI_IMAGE_PIPELINE_QUEUE_DEPTH")
});

pub static METRIC_AI_IMAGE_PIPELINE_PROCESSED_TOTAL: Lazy<IntCounterVec> = Lazy::new(|| {
  IntCounterVec::new(
    opts!(
      "infumap_ai_image_pipeline_processed_total",
      "Total image background pipeline items processed by stage and outcome."
    ),
    &["stage", "outcome"],
  )
  .expect("Could not create METRIC_AI_IMAGE_PIPELINE_PROCESSED_TOTAL")
});

pub static METRIC_AI_TITLE_INDEX_REBUILDS_TOTAL: Lazy<IntCounterVec> = Lazy::new(|| {
  IntCounterVec::new(
    opts!("infumap_ai_title_index_rebuilds_total", "Total item title lexical index reconciliations by outcome."),
    &["outcome"],
  )
  .expect("Could not create METRIC_AI_TITLE_INDEX_REBUILDS_TOTAL")
});

pub static METRIC_AI_TITLE_INDEX_REBUILD_DURATION_SECONDS: Lazy<HistogramVec> = Lazy::new(|| {
  HistogramVec::new(
    HistogramOpts::new(
      "infumap_ai_title_index_rebuild_duration_seconds",
      "Item title lexical index reconciliation duration by outcome.",
    )
    .buckets(index_rebuild_duration_buckets()),
    &["outcome"],
  )
  .expect("Could not create METRIC_AI_TITLE_INDEX_REBUILD_DURATION_SECONDS")
});

pub static METRIC_AI_FRAGMENT_INDEX_REBUILDS_TOTAL: Lazy<IntCounterVec> = Lazy::new(|| {
  IntCounterVec::new(
    opts!("infumap_ai_fragment_index_rebuilds_total", "Total fragment index rebuild attempts by outcome."),
    &["outcome"],
  )
  .expect("Could not create METRIC_AI_FRAGMENT_INDEX_REBUILDS_TOTAL")
});

pub static METRIC_AI_FRAGMENT_INDEX_REBUILD_DURATION_SECONDS: Lazy<HistogramVec> = Lazy::new(|| {
  HistogramVec::new(
    HistogramOpts::new(
      "infumap_ai_fragment_index_rebuild_duration_seconds",
      "Fragment index rebuild duration by outcome.",
    )
    .buckets(index_rebuild_duration_buckets()),
    &["outcome"],
  )
  .expect("Could not create METRIC_AI_FRAGMENT_INDEX_REBUILD_DURATION_SECONDS")
});

pub static METRIC_AI_EMBEDDING_REQUESTS_TOTAL: Lazy<IntCounterVec> = Lazy::new(|| {
  IntCounterVec::new(
    opts!("infumap_ai_embedding_requests_total", "Total text embedding service requests by outcome."),
    &["outcome"],
  )
  .expect("Could not create METRIC_AI_EMBEDDING_REQUESTS_TOTAL")
});

pub static METRIC_AI_EMBEDDING_REQUEST_DURATION_SECONDS: Lazy<HistogramVec> = Lazy::new(|| {
  HistogramVec::new(
    HistogramOpts::new(
      "infumap_ai_embedding_request_duration_seconds",
      "Text embedding service request duration by outcome.",
    )
    .buckets(service_request_duration_buckets()),
    &["outcome"],
  )
  .expect("Could not create METRIC_AI_EMBEDDING_REQUEST_DURATION_SECONDS")
});

pub static METRIC_SEARCH_BACKEND_FAILURES_TOTAL: Lazy<IntCounterVec> = Lazy::new(|| {
  IntCounterVec::new(
    opts!("infumap_search_backend_failures_total", "Total search backend failures by backend."),
    &["backend"],
  )
  .expect("Could not create METRIC_SEARCH_BACKEND_FAILURES_TOTAL")
});

pub static METRIC_SEARCH_BACKEND_DURATION_SECONDS: Lazy<HistogramVec> = Lazy::new(|| {
  HistogramVec::new(
    HistogramOpts::new("infumap_search_backend_duration_seconds", "Search backend duration by backend.")
      .buckets(search_backend_duration_buckets()),
    &["backend"],
  )
  .expect("Could not create METRIC_SEARCH_BACKEND_DURATION_SECONDS")
});

pub fn register_ai_metrics() {
  prometheus::register(Box::new(METRIC_AI_IMAGE_PIPELINE_QUEUE_DEPTH.clone())).unwrap();
  prometheus::register(Box::new(METRIC_AI_IMAGE_PIPELINE_PROCESSED_TOTAL.clone())).unwrap();
  prometheus::register(Box::new(METRIC_AI_TITLE_INDEX_REBUILDS_TOTAL.clone())).unwrap();
  prometheus::register(Box::new(METRIC_AI_TITLE_INDEX_REBUILD_DURATION_SECONDS.clone())).unwrap();
  prometheus::register(Box::new(METRIC_AI_FRAGMENT_INDEX_REBUILDS_TOTAL.clone())).unwrap();
  prometheus::register(Box::new(METRIC_AI_FRAGMENT_INDEX_REBUILD_DURATION_SECONDS.clone())).unwrap();
  prometheus::register(Box::new(METRIC_AI_EMBEDDING_REQUESTS_TOTAL.clone())).unwrap();
  prometheus::register(Box::new(METRIC_AI_EMBEDDING_REQUEST_DURATION_SECONDS.clone())).unwrap();
  prometheus::register(Box::new(METRIC_SEARCH_BACKEND_FAILURES_TOTAL.clone())).unwrap();
  prometheus::register(Box::new(METRIC_SEARCH_BACKEND_DURATION_SECONDS.clone())).unwrap();
}

fn index_rebuild_duration_buckets() -> Vec<f64> {
  vec![0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0, 600.0, 1800.0]
}

fn service_request_duration_buckets() -> Vec<f64> {
  vec![0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0]
}

fn search_backend_duration_buckets() -> Vec<f64> {
  vec![0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0]
}
