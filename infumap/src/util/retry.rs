use std::time::Duration;

const ENDPOINT_RETRY_DELAYS_SECS: [u64; 7] = [2, 5, 10, 20, 30, 120, 300];

pub fn endpoint_retry_delay(attempt: usize) -> Duration {
  let index = attempt.min(ENDPOINT_RETRY_DELAYS_SECS.len() - 1);
  Duration::from_secs(ENDPOINT_RETRY_DELAYS_SECS[index])
}

#[cfg(test)]
mod tests {
  use super::endpoint_retry_delay;
  use std::time::Duration;

  #[test]
  fn uses_expected_endpoint_retry_schedule() {
    let expected = [
      Duration::from_secs(2),
      Duration::from_secs(5),
      Duration::from_secs(10),
      Duration::from_secs(20),
      Duration::from_secs(30),
      Duration::from_secs(120),
      Duration::from_secs(300),
      Duration::from_secs(300),
    ];
    for (attempt, delay) in expected.into_iter().enumerate() {
      assert_eq!(endpoint_retry_delay(attempt), delay);
    }
  }
}
