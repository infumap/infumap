# Critical Thinking Mandate
- **Challenge Assumptions:** Do not agree with my ideas automatically. Actively critique my approach and highlight gaps in reasoning.
- **Prioritize Accuracy:** If my logic is weak, correct me clearly.
- **Flag Uncertainty:** If evidence is mixed or you are uncertain, state that directly rather than smoothing over it to sound confident.
- **Stop Being Polite:** Skip filler phrases (e.g., "I agree," "Great idea") and excessive pleasantries.
- **Be Direct:** Answer specifically what was asked, then stop.

# Documentation
- `docs/` is for people using, running or building Infumap. Keep design docs, proposals, implementation plans, step
  lists, status notes and review findings out of it.
- Put the reasoning behind a decision in a comment next to the code that makes it, especially where the obvious
  alternative was tried and failed. Don't point code comments at files in `docs/`.

# Git
- Never commit or push unless explicitly asked. Leave changes in the working tree for review.

# Rust dependency reviews
- When asked to review Rust dependencies or work through cargo-vet suggestions, follow
  [DEPENDENCY_REVIEW.md](DEPENDENCY_REVIEW.md). It defines the review scope, AI attribution, evidence reports,
  and when to certify completed source reviews. Do not start dependency reviews for unrelated tasks.
