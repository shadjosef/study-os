# Study-OS Roadmap

Planned features for upcoming exam cycles:

## Early Post-Exam Attempt Verification & Privacy-Preserving Class Analytics

- **Private client-side attempt checker:** Let students compare their submitted WISEflow answers against early community/unofficial worked solutions privately in their browser (`localStorage`), with automatic matching by question text / Learnosity item UUID so per-student question and option shuffling still grades accurately.
- **Blind-aggregate anonymous cohort statistics (opt-in):**
  - Unauthenticated submission endpoint decoupled from Community profiles (zero profile keys, nicknames, or individual grade rows stored).
  - Client-salted SHA-256 nullifier to prevent duplicate counting without linking to an identity.
  - Persist only aggregate counters per exam: score histogram (for exact median, quartiles, and grade distribution), per-question accuracy tallies (`% correct` / `% skipped`), and running sufficient statistics (`n, sumX, sumY, sumXX, sumYY, sumXY` + coarse tier bins) for Pearson correlations between coarsened Study-OS metrics (study hours, accuracy, UPI, practice volume, break habits) and exam outcomes.
  - Enforce `k`-anonymity (`k >= 5` participants overall, `>= 3` per tier bin) before unlocking aggregate displays.
  - Optional future upgrade: 2-server Prio / additive secret-sharing + ZK range proofs so no single server sees an individual contribution even in transit.
