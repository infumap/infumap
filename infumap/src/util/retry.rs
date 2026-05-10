use std::time::Duration;

const ENDPOINT_RETRY_DELAYS_SECS: [u64; 7] = [2, 5, 10, 20, 30, 120, 300];

pub fn endpoint_retry_delay(attempt: usize) -> Duration {
  let index = attempt.min(ENDPOINT_RETRY_DELAYS_SECS.len() - 1);
  Duration::from_secs(ENDPOINT_RETRY_DELAYS_SECS[index])
}
