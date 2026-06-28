# Adversarial Review Report

> **Mode C (OpenCode subagents):** 6 reviewers ran in genuinely isolated context windows (Pro, Con, feasibility, risk, assumption, architecture), each given only the evidence pack. Cross-Examiner was the first role permitted to see all outputs; Arbiter and Scribe saw everything. No Mode D degradation — confidence is not capped.

## Executive Summary
- **Target:** "Loop Engineering" — a self-contained system prompt (`loop-engineering-master-prompt.md`, 257 lines) + operational prompt collection (`loop-engineering-prompts.md`, 189 lines) defining a collaborative, **non-adversarial** agent dev-loop (state machine + isolated workers + objective self-checks + 2 human anchors; worker self-reports trusted; honesty = "the only fatal failure"; unattended tier adds independent re-run).
- **Decision:** `revise`
- **Risk Level:** `critical`
- **Confidence:** `high`
- **Required Changes:** 5 blockers (RC1–RC5) — specify the unattended re-run channel / add a non-self-referential verifier or re-scope the honesty claim / partition objective-vs-semantic gates / add liveness & recovery states / demote single-context mode.
- **Mode:** C (genuine independence)

## Final Decision
**REVISE before adoption.** The design is philosophically defensible and unusually epistemically honest (§8 names its own soft spots), but its two foundational axioms — *worker honesty is the only fatal failure* and *gates are objective-only* — are structurally unsound as written: the declared fatal failure has only a soft, self-referential, empty-tickable detector and a silent failure mode, and the design's own escape hatch (§12 unattended re-run) is an undefined noun that 6 reviewers converge may be illusory (same host re-running its own tests is not independent). Because this is a *spec* (cheap to revise now, expensive to reverse once paradigm-locked), the proportionate response is to fix the foundational axioms before any conditional acceptance — not to block (salvageable value) and not to accept-with-conditions (the conditions are foundational rework, not patches).

## Strongest Pro Case
- **§8 honesty redline is a real epistemic virtue (P3, high conf).** It enumerates every soft spot verbatim and ties §12 escalation to those disclosures. The Con side does *not* deny this — it disputes *sufficiency*, not existence. A design that hides these failure modes is strictly more dangerous.
- **Objective-gate discipline + retry-bound cost-bounding (P2, high conf).** Eliminates subjective-gate bikeshedding; "fail → fix once → escalate" bounds retry cost. A coherent cost-bounding mechanism for the "no adversarial overhead" goal.
- **2-anchor attention budget is the only falsifiable human-cost property (P7, high conf).** With a creep-prevention discipline ("new needs-human step must first ask: can it become mechanism+exception?"), it makes the headline claim testable rather than asserted.
- **Prevention-over-detection is rationally defensible (P1, medium conf).** Recurring adversarial cost amortizes into one-time prevention — *but Pro itself concedes an empirical pilot is needed before scaling.*

## Strongest Con Case
- **A fake-green worker is structurally undetectable in default mode (R1, high conf).** `tests_green` is trusted; red-team fires only on risk:high/human request; independent re-run exists *only* in opt-in unattended. Crucially, key-diffs show *file changes*, not *test-execution truth* — so the one hard-ish backstop is blind to the specific lie the design calls "the only fatal failure."
- **`actual_writes` out-of-bounds detection is self-referential (C1, high conf).** The detector inspects the worker's *own declaration*, not the filesystem. A worker that writes out-of-scope AND mis-reports is invisible to every named defense. §8 presents this as a REAL defense; it is self-audit.
- **"Honesty is the only fatal failure" = unmitigated single point of failure (C2, high conf).** Sole backstop is soft + admitted empty-tickable → a fatal failure rendered *silent* (worst severity × lowest detection).
- **Single-context loses isolation (C3/F1/A6/AR6 — 4-reviewer convergence + Pro's own concession).** In the *common* case, the same model is coordinator (sole run-state writer), plan agent, and worker, then self-checks itself. "Keeps all discipline" is asserted by prompt, not enforced.
- **No timeout/liveness/retry/flake (C6/F7/R9 — 3 reviewers).** A hung worker leaves a task permanently "running" with no recovery arc — a completion-feasibility gap, not a preference.

## Key Findings
| Severity | Confidence | Finding | Evidence | Recommendation |
| --- | --- | --- | --- | --- |
| blocker | high | Worker honesty asserted as sole fatal failure but non-enforceable; no verification channel (A1) | §8 elevates lying to only fatal mode; tests_green/actual_writes self-reported; no lying-worker example | Add ≥1 non-self-referential verifier (independent test re-run, host filesystem-diff) or re-scope the honesty claim |
| blocker | high | "Objective-only gates" mislabels semantic checks as objective (A2) | §2#4/§6 claim objective; wrap-up "scope consistent", "key-diffs prepared", "acceptance_ref has corresponding test" are semantic | Partition: strictly-syntactic auto-proceed; semantic never auto-proceed |
| high | high | Fake-green worker structurally undetectable in default mode (R1) | §8 trusted; §11 on-demand; §12 opt-in; diffs can't refute false tests_green | Require independent test re-run at wrap-up for tasks touching test files |
| high | high | actual_writes detection self-referential (C1) | §8 names it as real defense in same paragraph it's trusted/soft | Ground check in host sandbox or post-task filesystem diff |
| high | high | Single-context loses isolation (C3/F1/A6/AR6) | §3 fallback common; §5 sole writer; §0 unenforceable in one context | Demote single-context: disable auto-proceed or add enforced isolation |
| high | high | No timeout/liveness/recovery states (C6/F7/R9) | State machine has no error/stalled/timeout edges | Add per-task timeout + heartbeat + RUNNING→STUCK/ABORTED arcs |
| high | high | Unattended "independent re-run channel" unspecified — 6 reviewers (Pro/C1/C2/F6/R1/A11) | §12 names it; no mechanism; same-host re-run ≠ independent | Define independence concretely or gate unattended as unsupported |
| high | high | §8 disclosure ≠ mitigation (C2/R4/A1 — 4 reviewers) | §8 soft + empty-tickable; fatal+silent = worst combo | Add enforced detection leg; make unverified-green a loud flag |
| high | high | "No semantic judgments" factually contradicted by 2 human anchors (C4/A2/AR4) | §2#4 vs plan sign-off + wrap-up | Reframe as "objective where possible, semantic at 2 anchors" |
| high | medium | Risk self-classified by plan agent = sole red-team trigger (C5/R5/A7) | §C classifies; §11 auto-fires only risk:high | Decouple classifier; auto-flag contracts/security/migrations |
| high | high | Artifact-contract drift between the two files (AR1) | questions.json vs clarification-questions.json; schema field mismatch | Pick one filename + one normative schema |
| high | high | Red-team has no run-state representation — unrecoverable (AR2/AR10) | human_pending enum has no red_team; task states have no rework | Add red_team/rework state to run-state |
| medium | high | "Two modes identical flow" conflates file-shape with property-identity (AR6) | §3:31; sole-writer also lost, not just isolation | Reword; state which trust_mode/risk disallowed in single-context |
| medium | high | Cross-service "non-conflict" presented as fact, is an assumption (AR7/A10/R8/F3) | §10 "天然"; false for monorepo/shared lockfile | Reframe as assumption; serialize shared-root writes |
| medium | medium | 3-layer contract detection silently fails w/o consumer test (C7) | §10 layer③ only fires if consumer+integration case exist | Coverage gate: contract change needs test OR explicit human ack |
| medium | medium | Coordinator "never reads worker output" contradicts wrap-up diff duty (F2/AR5) | §A vs §5/§131 | Re-scope §A: reads structured artifacts, not raw stdout |
| medium | medium | context_paths upfront enumeration chicken-and-egg (F4/A4) | §0 worker contract; §A coordinator compact; no selection method | Add bounded on-demand read-path protocol |
| medium | medium | Plan-amendment "affected parts only" is itself planning (A8) | §5; no propagation method | Define propagation rule; default full replan if unbounded |
| medium | high | Same-worker retry is deterministic re-failure on capability limits (R6) | §5 re-dispatch same worker once; no failure classification | Classify transient vs capability before retry |
| note | high | wrap-up filename drift: key-diffs(汇总) vs key-diffs.md (AR11) | master:204 vs :126/prompts:144 | Normalize to wrap-up/key-diffs.md |

## Dimension Reviews

### Feasibility
- **Summary:** Coherent only for a narrow regime (small DAG, single repo, attended, capable model with true isolated subagents). NOT feasible across full claimed scope. The single-context fallback (the *common* case) cannot hold the discipline equated with isolated mode; "coordinator never reads worker output" contradicts its self-check duty; no timeouts/liveness/flake-handling is a completion-feasibility gap and an unattended blocker; the unattended re-run channel is named, not defined.
- **Notable findings:** F1 (single-context discipline, high), F2 (coordinator-reads contradiction, high), F7 (no liveness, high), F6 (unattended undefined, high), F4 (context_paths chicken-and-egg, high/med), F3 (parallelism collapses, med), F8 (coordinator context budget, med), F5 (multi-repo unspecified, med).

### Risk
- **Summary:** In default collaborative mode the entire dishonesty-detection stack is soft and self-reported; the only hard-ish layer is admitted empty-tickable; the only automatic adversarial trigger is gated by a self-interested classifier. A fake-green worker is caught only if a human reads the real git diff carefully AND the task was tagged risk:high — neither guaranteed. No rollback hook; safe tier is opt-in and friction-heavy (realistic under-use). "Honesty is the only fatal failure" is rhetorically strong but mechanically unenforced — the failure is silent, not loud.
- **Notable findings:** R1 (fake-green undetectable, high), R3 (no rollback hook, high/med), R5 (risk self-classification conflict, high/med), R4 (silent-fatal selection pressure, med), R7 (safe tier opt-in under-use, med), R8 (cross-service race window, med), R9 (no liveness, med), R6 (deterministic re-failure, med), R2 (sanitized actual_writes only discretional, med).

### Assumption
- **Summary:** The trust chain rests on three fragile assumptions — worker honesty (A1, flagged blocker), objectivity of "decidable" checks (A2, flagged blocker), tests-as-truth (A3). The spec flags only A1 as fatal, yet A1 is non-enforceable and A2/A3 compound it: if any leaks, the auto-proceed gate silently admits wrong work. Several "objective" checks are semantic in disguise; several "given" enumerations assume perfect upfront knowledge SE lacks; single-context contradicts the isolated-workers pillar and breaks coordinator impartiality. No empirical data, no lying-worker example, undefined write taxonomy.
- **Notable findings:** A1 (honesty non-enforceable, blocker), A2 (objective/semantic boundary, blocker), A3 (tests-as-truth, high), A4 (context enumeration, high), A6 (single-context, high), A9 (human rubber-stamp, high), A5 (write taxonomy undefined, med), A7 (risk classification, med), A8 (amendment propagation, med), A10 (cross-service assumption, med), A11 (re-run channel, med/low).

### Architecture
- **Summary:** State machine coherent in the steady-state happy path; "no resident REVIEWING phase, red-team as on-demand tool" is architecturally clean. But structurally incomplete around failure/recovery: no crash-recovery protocol, no representation for in-flight red-team/amendment work, the sole progress record cannot reconstruct mid-flight state. Two sources of truth (master §9 vs prompts §B/§C) drift on concrete artifact contracts. Several headline abstractions ("objective-only gates", "two modes identical flow", "coordinator never reads worker output", "cross-service defaults non-conflict") are aspirational frames over a mixed/assumption-dependent system. The collaborative/trust stance is internally honest and defensible; the problems are abstraction accuracy and recovery, not core philosophy.
- **Notable findings:** AR1 (artifact drift, high), AR2 (red-team no state, high), AR3 (no recovery states, high), AR6 (two-modes-identical unsound, high), AR7 (cross-service assumption, high), AR4 (objective-only mislabel, med), AR5 (read-boundary phase-local, med), AR8 (events log unspecified, med), AR9 (schema fragmented, med), AR10 (rework loop unrepresented, med), AR11 (filename drift, note).

## Disputed Points
1. **Does §8 disclosure count as mitigation, or only disclosure?** Pro: epistemic hygiene, precondition for tier-selection. Con (C1/C2/R4/A1): disclosure ≠ control; soft empty-tickable detector; fatal+silent = worst combo. **Arbiter sided with Con:** disclosure is a real virtue but not a control. *Not resolved by Pro concessions.*
2. **Does single-context "keep all discipline"?** Pro P4 accepts *and concedes* demotion; Con (C3/F1/A6/AR6) demands demotion with auto-proceed disabled. **Real dispute remains** on accept-as-degraded vs must-demote-disable-auto-proceed.
3. **Is "objective-only gates" accurate?** Pro: eliminates bikeshedding. Con (C4/A2/AR4): ≥2 wrap-up gates are semantic. **Arbiter: must partition** to strictly-syntactic auto-proceed.
4. **Does prevention-over-detection hold without empirical data?** Pro P1 medium-conf + concedes pilot needed. Con: prevention trusts self-reports → load-bearing on untested honesty. **Unresolved — relegated to residual risk / optional pilot.**
5. **Is `actual_writes` out-of-bounds detection a REAL defense?** Pro silent (effectively conceded). Con (C1/R2/A5): self-referential. **Conceded, not disputed.**

## Arbiter Reasoning
Two blocker findings (A1, A2) sit on the design's foundational axioms and are **structurally determinable from the spec text** — no empirical investigation is needed to confirm they exist. This rules out `investigate`, and the absence of a recovery arc for the design's OWN declared fatal failure rules out `accept`/`accept_with_conditions`.

**Revise over block:** the paradigm is philosophically defensible (P2 cost-bounding, P7 the only falsifiable human-cost property, §8 unusual epistemic honesty). Block would discard salvageable value; the flaws are fixable spec revisions, not "wrong-headed." The proportionate response to critical-but-fixable *spec-stage* foundational flaws is revise-and-re-review.

**Why not accept_with_conditions:** the conditions are foundational, not patch-level (RC2 re-scopes the central honesty claim; RC3 re-partitions the gate model; RC1 specifies an escape-hatch whose independence is currently a noun without a mechanism). "Conditions" implies acceptable-in-shape; this is rework-in-shape.

**Why critical (honoring blocker→critical):** the honesty trust chain means the sole declared fatal failure has, in default mode, only a soft, self-referential, empty-tickable detector and a silent failure mode — and the escape hatch (§12) is unspecified such that 6 reviewers converge it may be illusory. A self-declared fatal failure with no enforced detection and a possibly-illusory recovery path, on a paradigm with high blast radius and hard post-adoption reversal, is critical.

**Deviation note (justified):** rubric suggests blocker⇒critical/block-or-investigate. Severity held at critical; decision is `revise` not `block`/`investigate`. Justification: (1) this is a spec — no active harm, reversibility window open and cheap now, expensive later; (2) flaws are structurally determinable, not empirical (fake-green *likelihood* calibrates severity nuance, not the revise-vs-accept call); (3) block would discard genuine salvageable virtues. Deviation is on the severity→decision mapping, not on severity itself.

**Confidence high** because the decision rests on four high-confidence structural findings — (1) §12 re-run channel unspecified [textual fact, 6 reviewers], (2) actual_writes detection self-referential [structural, uncontested by Pro], (3) "no semantic judgments" factually contradicted [near-definitional], (4) no liveness/recovery [structural, 3 reviewers] — none of which depend on the disputed/empirical items, which are relegated to residual_risks.

**Arbiter-discovered gaps:**
- **G1 — no fatality mechanism for lying itself.** "Honesty is the only fatal failure" declares lying fatal, but the spec defines no consequence arc for lying — only for task failure. Even if a lie were detected, no operational "fatality" is defined. Distinct from C2 (silent failure): "even when caught, no defined response."
- **G2 — tier-selection Goodhart.** §8 disclosures feed tier-selection, but if the actual_writes detector is empty-tickable (C1), the entity being classified controls the classification input — a reflexive control loop. A worker can self-select into the lower-scrutiny tier. Compounds RC1/RC2.
- **G3 — no spec versioning contract.** Given paradigm lock-in and copy-ability, the spec itself has no versioning/compat/change-control contract. A future axiom revision silently invalidates downstream runs built on the old axiom — the reversibility concern is unmanaged at the meta level.

## Required Changes (blockers — must fix before re-review)
1. **RC1 — Specify the unattended independent re-run channel.** What entity re-runs, on what host/runtime, whether it RE-EXECUTES tests independent of `tests_green`, and whether write-sandboxing is HOST-enforced independent of self-reported `actual_writes`. If genuine independence is unachievable, explicitly demote the escape-hatch claim and state the honesty gap remains open even in the safe tier. *(refs: Pro_oq, C1, C2, F6, R1, A11)*
2. **RC2 — Add a hard verifier OR re-scope the honesty claim.** Either (a) add ≥1 non-self-referential verifier (host filesystem-diff for `actual_writes`; independent test execution for `tests_green`), or (b) drop "honesty is the only fatal failure" as an enforced property, state plainly that default mode trusts self-reports with NO anti-forgery machinery, and define the operational consequence when a lie is later detected. §8 disclosure does not count as mitigation here. *(refs: A1, R1, C1, C2)*
3. **RC3 — Partition objective vs semantic gates.** Strictly-syntactic checks (path-set membership, file-exists, test exit code) are auto-proceed-on-green eligible; semantic checks ("scope consistent", "key-diffs prepared", "acceptance_ref has corresponding test") NEVER auto-proceed — always require a human anchor. Relabel "objective-only" accordingly. *(refs: A2, C4, AR4)*
4. **RC4 — Add liveness & recovery states.** Per-task max-duration + liveness probe + hang-recovery arc (analogous to the existing retry-bound for failure). A hung worker must not leave a task permanently "running." Add RUNNING→STUCK/ABORTED transitions; make these unattended enabling preconditions. *(refs: C6, F7, R9)*
5. **RC5 — Demote single-context mode.** It does NOT preserve full discipline (sole-writer isolation is also lost, per AR6). Either disable auto-proceed in single-context OR add an enforced isolation primitive. Do not present single-context as a full-fidelity variant. *(refs: C3, F1, A6, AR6, Pro_P4_concession)*

## Optional Improvements
- Add a lying/optimistic-worker worked example + the system's defined response (validates the redline norm; closes a 4-reviewer evidence gap).
- Run a bounded empirical pilot to calibrate fake-green likelihood — the single biggest severity determinant and load-bearing for P1's break-even (Pro concedes).
- Consolidate architecture drift as editorial: single source of truth for state, unified schema, explicit recovery states (AR1/AR2/AR3/AR8/AR9) — fixable, not blocking.
- Clarify `context_paths` selection & whether upfront enumeration is achievable (F4/A4); add a bounded on-demand read-path protocol.
- Clarify whether deployment/rollback is in scope or pre-merge-only; if external independent CI gates merges, R3 blast-radius collapses materially.
- Add a spec versioning/compat contract (G3): a later revised axiom must not silently invalidate runs built on the prior axiom.
- Decouple risk classification from the plan author; auto-flag tasks touching contracts/security/migrations/auth as risk:high (C5/R5/A7).
- Make wrap-up diff review non-empty-tickable for security-sensitive paths (require ack keyed to diff hash, not a checkbox) (R2).
- For cross-service dispatch where one task edits a published contract, default to serialize rather than non-conflict (R8).
- Normalize wrap-up filename to `wrap-up/key-diffs.md` (AR11).

## Open Questions
1. What concrete mechanism detects/deters a worker that self-reports `tests_green` falsely? (RC2 determiner)
2. What entity performs the unattended re-run — same host/model, or a separate runtime? If same, is the escape hatch illusory? (RC1 determiner)
3. Does any host enforce write sandboxing independent of self-reported `actual_writes`? (binary determiner for C1/C2)
4. Is deployment/rollback in scope, or pre-merge only (external CI)? (R3 severity)
5. How are `context_paths` chosen, and by whom/what? (F4 fatal-or-not)
6. Likelihood of a worker fabricating `tests_green` — ~0 or non-trivial? (single biggest Con-case severity determinant)
7. In single-context, is there ANY host mechanism enforcing sole-writer/packet-isolation, or pure self-discipline? (AR6)
8. Does `unattended` close the AR5/AR6 gaps, or only add detection without restoring physical isolation? (§12 "升档只加检测不改预防" suggests not — worth an explicit prohibition on unattended-in-single-context.)

## Appendix: Per-Role Output Summary
All 6 reviewers + Cross-Examiner + Arbiter ran as isolated OpenCode `general` subagents (Mode C). Full YAML outputs are preserved in the review transcript; per-role claim counts: Pro 7 claims (P1–P7), Con 7 claims (C1–C7) + 5 open_q, Feasibility 8 claims (F1–F8) + 5 open_q, Risk 9 claims (R1–R9) + 4 open_q, Assumption 11 claims (A1–A11, 2 blockers) + 6 open_q, Architecture 11 claims (AR1–AR11) + 5 open_q. Cross-Examiner identified 9 convergence clusters (strongest: unattended-channel-unspecified across 6 reviewers). Arbiter: 5 blockers (RC1–RC5), 3 discovered gaps (G1–G3), decision `revise` / `critical` / `high confidence`.
