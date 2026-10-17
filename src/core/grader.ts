/**
 * Study-design classification from NLM metadata — no text heuristics.
 *
 * A record's design comes only from its NLM PublicationType tags (PubMed, and
 * Europe PMC, which mirrors them), its integrity flags from PublicationType tags
 * and CommentsCorrections links, and one MeSH warning from the Animals/Humans
 * check tags. A record without such metadata (not yet MEDLINE-indexed, regional
 * databases) stays `unknown`: the calling model reads the design from the
 * abstract, guided by the `med-research` skill.
 *
 * These labels are NLM's, but not hand-curated: since 2022 NLM indexes MEDLINE
 * automatically (MTIA, then the neural MTIX), with human curation of selected
 * records, and has been adding publication types to that automation [NLM-2021,
 * NLM-2024]. Treat them as a strong prior to confirm, not ground truth.
 *
 * `designTier` ranks the design for "Does this intervention help?" by the
 * OCEBM 2011 levels [OCEBM]: level 1 → 5, level 2 → 4, level 3 → 3,
 * level 4 → 2, below level 4 → 1, non-human → 0. Two rules keep it honest:
 *
 * - When a label's NLM definition admits designs at different levels, the
 *   lower level is used (e.g. "Controlled Clinical Trial" allows historical
 *   controls, level 4, so it ranks 2 rather than 3).
 * - A systematic review has no level of its own; it ranks with the studies it
 *   pooled ([OCEBM] level 1 is a review "of randomized trials"; [GRADE-3] rates a
 *   body of evidence by its study designs). MeSH does not reliably show what
 *   was pooled: in 2022, 77% of reviews/meta-analyses carried no heading for it,
 *   and only 39 of 2,652 with "randomized" in the title carried the RCT heading
 *   (PubMed counts, checked 2026-10-17). So a synthesis ranks 5 only when its
 *   publication type is defined as pooling randomized trials, and is `null`
 *   (unknown) otherwise.
 *
 * The tier is a prior, not an appraisal [OCEBM-intro]: risk of bias,
 * imprecision, inconsistency, indirectness and publication bias [GRADE-3], and
 * the question type (prognosis, diagnosis and harms rank designs differently
 * [OCEBM]) all need the paper itself.
 *
 * Sources (all checked 2026-10-17):
 * - [OCEBM] OCEBM Levels of Evidence Working Group. "The Oxford 2011 Levels of
 *   Evidence". Oxford Centre for Evidence-Based Medicine.
 *   https://www.cebm.ox.ac.uk/resources/levels-of-evidence/ocebm-levels-of-evidence
 * - [OCEBM-intro] Howick J, et al. "The 2011 Oxford CEBM Levels of Evidence
 *   (Introductory Document)". Same URL. The levels are "NOT intended to provide
 *   you with a definitive judgment about the quality of evidence".
 * - [GRADE-3] Balshem H, et al. GRADE guidelines: 3. Rating the quality of
 *   evidence. J Clin Epidemiol 2011;64:401-6. PMID 21208779. "Randomized
 *   trials begin as high-quality evidence, observational studies as low
 *   quality"; ratings apply "to a body of evidence, not to individual studies".
 * - [GRADE-8] Guyatt GH, et al. GRADE guidelines: 8. Rating the quality of
 *   evidence — indirectness. J Clin Epidemiol 2011;64:1303-10. PMID 21802903.
 * - [MeSH] NLM MeSH publication-type records (definition, tree position,
 *   history), https://id.nlm.nih.gov/mesh/<UI>.json — UIs cited inline.
 * - [NLM-XML] NLM, MEDLINE/PubMed XML element descriptions, CommentsCorrections.
 *   https://wayback.archive-it.org/org-350/20240220194809/https://www.nlm.nih.gov/bsd/licensee/elements_descriptions.html
 * - [NLM-2021] NLM Technical Bulletin 2021 Nov–Dec, "MEDLINE 2022 Initiative:
 *   Transition to Automated Indexing".
 *   https://www.nlm.nih.gov/pubs/techbull/nd21/nd21_medline_2022.html
 * - [NLM-2024] NLM Technical Bulletin 2024 Mar–Apr, "MTIX: the Next-Generation
 *   Algorithm for Automated Indexing of MEDLINE".
 *   https://www.nlm.nih.gov/pubs/techbull/ma24/ma24_mtix.html
 * - [Askin-2025] Askin N, et al. Filtering failure: the impact of automated
 *   indexing in Medline on retrieval of human studies for knowledge synthesis.
 *   J Med Libr Assoc 2025. doi:10.5195/jmla.2025.1972. PMID 39975499.
 */

import type { Article, GradedArticle, RecordFlag, StudyType } from "./types.js";

type Design = Exclude<StudyType, "unknown">;

/**
 * Tier per design label, for "Does this intervention help?" [OCEBM].
 * Syntheses: 5 is the tier of a review of randomized trials; the classifier
 * gives a synthesis 5 only when that is known, otherwise null (see header).
 */
export const DESIGN_TIER: Record<Design, number> = {
  // Level 1: "Systematic review of randomized trials or n-of-1 trials".
  "meta-analysis": 5,
  "systematic-review": 5,
  // Level 2: "Randomized trial".
  "randomized-controlled-trial": 4,
  // Level 3: "Non-randomized controlled cohort/follow-up study". Assumes the
  // cohort compares groups, as MeSH Cohort Studies (D015331) defines it.
  cohort: 3,
  // Level 4: "Case-series, case-control studies, or historically controlled studies".
  // NLM's Controlled Clinical Trial (D018848) allows "historical comparisons".
  "non-randomized-trial": 2,
  // Clinical Trial (D016430) states neither randomization nor a control group,
  // so a single-arm series (level 4) is possible.
  "clinical-trial": 2,
  // Observational Study (D064888) spans cohort (level 3) to case-control (level 4).
  observational: 2,
  "case-control": 2,
  // Not listed for treatment benefit; exposure and outcome are measured at the
  // same time, so placed with case-control at level 4.
  "cross-sectional": 2,
  // Below level 4: a single case is weaker than the case series of level 4, and
  // NLM's Case Reports (D002363) covers single cases.
  "case-report": 1,
  // Below level 4: unsystematic expert synthesis, not a study.
  review: 1,
  // Non-human evidence: at most mechanism-based reasoning (level 5) for human
  // questions, and indirect in population [GRADE-8].
  "animal-study": 0,
  "in-vitro": 0,
};

const tag = (...names: string[]): ((tags: ReadonlySet<string>) => boolean) => {
  const lower = names.map((n) => n.toLowerCase());
  return (tags) => lower.some((n) => tags.has(n));
};

/** Veterinary publication types (D000077522, D000081262, D000078323). */
const VETERINARY = tag("Clinical Trial, Veterinary", "Randomized Controlled Trial, Veterinary", "Observational Study, Veterinary");
/** Network Meta-Analysis (D000099094, since 2025) is defined as a "meta-analysis of randomized trials". */
const NETWORK_META_ANALYSIS = tag("Network Meta-Analysis");
const META_ANALYSIS = tag("Meta-Analysis"); // D017418
/** Systematic Review (D000078182, since 2019, also applied to older records). */
const SYSTEMATIC_REVIEW = tag("Systematic Review");
/**
 * Randomized Controlled Trial (D016449): treatments "selected by a random process".
 * Equivalence Trial (D000073843) sits under it in the MeSH tree, was indexed
 * as RCT 2006–2017, and every record with it also carries the RCT tag (6,133 of
 * 6,133, PubMed, checked 2026-10-17). NLM also applies the RCT tag to secondary
 * analyses of trial data.
 */
const RANDOMIZED = tag("Randomized Controlled Trial", "Equivalence Trial");
/** Controlled Clinical Trial (D018848): controlled; if randomized, NLM tags it RCT instead. */
const CONTROLLED_TRIAL = tag("Controlled Clinical Trial");
/**
 * Trial types whose NLM definitions state neither randomization nor control:
 * Clinical Trial (D016430), phases I–IV (D017426–D017429; phase I is "a small
 * number of healthy persons"), Adaptive Clinical Trial (D000076362), Human
 * Challenge Trials (D000098368), and Pragmatic Clinical Trial (D065007): it sat
 * under RCT in MeSH 2024–2025 but under Clinical Trial in 2026, defined as a study
 * "in real-world health system practice". 4,184 of its 5,133 records also carry
 * the RCT tag and classify as RCTs; the other 910 get the conservative tier.
 */
const OTHER_TRIAL = tag(
  "Clinical Trial",
  "Clinical Trial, Phase I",
  "Clinical Trial, Phase II",
  "Clinical Trial, Phase III",
  "Clinical Trial, Phase IV",
  "Adaptive Clinical Trial",
  "Human Challenge Trials",
  "Pragmatic Clinical Trial",
);
/** Observational Study (D064888): "the investigator does not assign participants to specific interventions". */
const OBSERVATIONAL = tag("Observational Study");
const CASE_REPORT = tag("Case Reports"); // D002363
/**
 * Review (D016454) covers any review of published material, systematic or not:
 * 16% of 2023 records titled "systematic review" carry only this tag (PubMed,
 * checked 2026-10-17). Scoping Review (D000098583) maps scope, not effects.
 */
const REVIEW = tag("Review", "Scoping Review");

/** Retracted Publication (D016441) labels the retracted article itself. */
const RETRACTED = tag("Retracted Publication");
/**
 * Notices are not studies: Retraction Notice (D016440, named "Retraction of
 * Publication" before 2025), Expression of Concern (D000075742), Published
 * Erratum (D016425).
 */
const NOTICE = tag("Retraction Notice", "Retraction of Publication", "Expression of Concern", "Published Erratum");
const PROTOCOL = tag("Clinical Trial Protocol"); // D000078325
/** Editorial (D016421); Comment (D016420) is a note "to discuss, support, or dispute" a published item. */
const EDITORIAL = tag("Editorial", "Comment");
/** Letter (D016422) includes research letters with original data, so it only warns. */
const LETTER = tag("Letter");
const PREPRINT = tag("Preprint"); // D000076942: "made available prior to peer review"

/** Publisher-added marker on a retracted article's title ("RETRACTED: …", "[Retracted] …"). Notices are tagged instead. */
const RETRACTED_TITLE_RE = /^\s*\[?retracted\b/i;

/** Flags that mean the record is not usable as evidence: its tier is 0. */
const NOT_EVIDENCE: ReadonlySet<RecordFlag> = new Set(["retracted", "notice", "protocol", "editorial"]);

export interface Classification {
  studyType: StudyType;
  /** See {@link GradedArticle.designTier}. */
  designTier: number | null;
  flags: RecordFlag[];
}

function lowerSet(values: readonly string[] | undefined): Set<string> {
  return new Set((values ?? []).map((v) => v.trim().toLowerCase()));
}

/** Design and tier from publication types; tier undefined means "use DESIGN_TIER". */
function designFromTags(tags: ReadonlySet<string>): { design: Design; tier?: number | null } | null {
  if (VETERINARY(tags)) return { design: "animal-study" };
  // A synthesis is classified as such even when it also carries the designs it pooled.
  if (NETWORK_META_ANALYSIS(tags)) return { design: "meta-analysis", tier: DESIGN_TIER["meta-analysis"] };
  if (META_ANALYSIS(tags)) return { design: "meta-analysis", tier: null };
  if (SYSTEMATIC_REVIEW(tags)) return { design: "systematic-review", tier: null };

  // Primary designs. RCT, Controlled Clinical Trial and Clinical Trial nest in
  // the MeSH tree (and phases are orthogonal), so the most specific one wins.
  // Observational or case-report tags contradict a trial tag; when they appear
  // together — mostly observational analyses of trial cohorts — the lower one wins.
  const candidates: Design[] = [];
  if (CASE_REPORT(tags)) candidates.push("case-report");
  if (OBSERVATIONAL(tags)) candidates.push("observational");
  if (RANDOMIZED(tags)) candidates.push("randomized-controlled-trial");
  else if (CONTROLLED_TRIAL(tags)) candidates.push("non-randomized-trial");
  else if (OTHER_TRIAL(tags)) candidates.push("clinical-trial");
  if (candidates.length > 0) {
    return { design: candidates.reduce((low, d) => (DESIGN_TIER[d] < DESIGN_TIER[low] ? d : low)) };
  }
  // A case report "with review of the literature" is handled above; a bare review last.
  if (REVIEW(tags)) return { design: "review" };
  return null;
}

/** Classify a record from its metadata. Exposed for testing without constructing an Article. */
export function classifyDesign(meta: Pick<Article, "title" | "publicationTypes" | "meshHeadings" | "corrections">): Classification {
  const tags = lowerSet(meta.publicationTypes);
  const mesh = lowerSet(meta.meshHeadings);
  const links = new Set((meta.corrections ?? []).map((c) => c.type));

  const found = designFromTags(tags);
  const design = found?.design ?? null;

  const flags: RecordFlag[] = [];
  // RetractionIn links the article to its retraction notice [NLM-XML].
  if (RETRACTED(tags) || links.has("RetractionIn") || RETRACTED_TITLE_RE.test(meta.title ?? "")) flags.push("retracted");
  if (NOTICE(tags)) flags.push("notice");
  if (PROTOCOL(tags)) flags.push("protocol");
  if (EDITORIAL(tags)) flags.push("editorial");
  // An expression of concern is linked only, never tagged, on the article itself [NLM-XML].
  if (links.has("ExpressionOfConcernIn")) flags.push("expression-of-concern");
  if (links.has("ErratumIn")) flags.push("corrected");
  // UpdateIn: a newer version exists, e.g. an updated Cochrane review [NLM-XML].
  if (links.has("UpdateIn")) flags.push("updated");
  // Only a warning: automated indexing drops the Humans tag from human trials
  // often enough that "Animals NOT Humans" wrongly excluded human RCTs 7× as
  // often as under manual indexing [Askin-2025].
  if (mesh.has("animals") && !mesh.has("humans") && design !== "animal-study" && design !== "in-vitro") {
    flags.push("animals-not-humans");
  }
  if (PREPRINT(tags)) flags.push("preprint");
  if (LETTER(tags)) flags.push("letter");

  let designTier: number | null = null;
  if (flags.some((f) => NOT_EVIDENCE.has(f))) designTier = 0;
  else if (found) designTier = found.tier !== undefined ? found.tier : DESIGN_TIER[found.design];
  return { studyType: design ?? "unknown", designTier, flags };
}

/** Classify an article fetched from any adapter. */
export function classifyArticle(article: Article): GradedArticle {
  const { studyType, designTier, flags } = classifyDesign(article);
  return { ...article, studyType, designTier, ...(flags.length > 0 ? { flags } : {}) };
}

/**
 * Sort key: known tiers 2–5 first, then records whose tier is unknown (an
 * unclassified record or an unrated synthesis may be strong — read it), then
 * tiers 1 and 0 (case reports, narrative reviews, non-human or non-evidence).
 */
export function rankKey(article: GradedArticle): number {
  return article.designTier ?? 1.5;
}

/** Surfaced when a tier filter removes articles whose tier is merely unknown. */
export function unclassifiedDroppedWarning(count: number): string {
  return (
    `${count} result(s) with an unknown design tier were dropped by minDesignTier — unrated, not weak: ` +
    `records without design metadata, and systematic reviews/meta-analyses whose pooled study designs are not indexed. ` +
    `To keep reviews and trials, filter with studyTypes instead.`
  );
}
