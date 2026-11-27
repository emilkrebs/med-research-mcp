/**
 * Study-design classification from NLM metadata — no text heuristics.
 *
 * A record's design comes only from its NLM PublicationType tags (PubMed, and
 * Europe PMC, which mirrors them), its integrity flags from PublicationType tags
 * and CommentsCorrections links, and one MeSH warning from the Animals/Humans
 * check tags. A record without such metadata (not yet MEDLINE-indexed, regional
 * databases) stays `unknown`: the calling model reads the design from the
 * abstract, guided by the `med-research` skill. Two more warnings describe a
 * ChinaXiv or RussiaRxiv record's text: machine-translated, or an abstract the
 * database wrote itself.
 *
 * A preprint and the journal article it became are two records, linked both ways (checked live,
 * 2026-11-16). PubMed: the preprint's CommentsCorrections hold `UpdateIn` with the article's PMID, the
 * article's `UpdateOf` with the preprint's (efetch of PMIDs 42238413 and 42745487). Of 300 preprints
 * with an UpdateIn link (esearch, sort=pub_date), none had another RefType, every target was a record
 * without the Preprint type, and every target held the UpdateOf back; `preprint[pt] AND hasupdatein`
 * finds 42,493 of the 72,073 preprints, `preprint[pt] AND hasupdateof` none. NLM's element descriptions
 * don't mention preprints ("UpdateIn cites the reference containing an update to the article", "UpdateOf
 * cites the article being updated"), nor does the DTD efetch declares (pubmed_250101.dtd) have a
 * preprint RefType. Europe PMC has its own pair: "Preprint of" on the PPR record, linking the article
 * (source MED), "Preprint in" on the article, linking the PPR record; all 57 preprints of `SRC:PPR AND
 * HAS_PUBLISHED_VERSION:y AND tirzepatide` and all 179 articles of `HAS_PREPRINT:y AND tirzepatide AND
 * SRC:MED` carry one. They are mapped to UpdateIn and UpdateOf, so that the same situation reads the same
 * in both databases: a preprint with a published version gets `updated`, as it already did in PubMed (the
 * skill reads `updated` as "cite the newer version", which is right here), and the article, which is
 * nothing but the newer record, gets the link and no flag. Europe PMC's links are mostly its own matches
 * of title and first author, not the preprint server's (806 of the first 1,000 preprints with a published
 * version; the titles of 149 of 150 such pairs were identical, one similar), and the article side lists
 * one preprint where several versions link to it (three PsyArXiv versions link PMID 42950493, which lists one).
 * A preprint PubMed holds is also in Europe PMC under two ids (MED 42238413 and PPR1237523, one DOI), so
 * its article lists both.
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
 * - [NLM-XML] NLM, MEDLINE/PubMed XML element descriptions, CommentsCorrections. The page's own URL
 *   (https://www.nlm.nih.gov/bsd/licensee/elements_descriptions.html) now only redirects to this copy of
 *   20 Feb 2024 (checked 2026-11-16). It lists UpdateIn and UpdateOf and no preprint RefType:
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

import { RECORD_FLAGS } from "./types.js";
import type { Article, Correction, GradedArticle, RecordFlag, StudyType } from "./types.js";

type Design = Exclude<StudyType, "unknown">;

/**
 * Tier per design label, for "Does this intervention help?" [OCEBM].
 * Syntheses: 5 is the tier of a review of randomized trials; the classifier
 * gives a synthesis 5 only when that is known, otherwise null (see header).
 */
export const DESIGN_TIER: Record<Design, number> = {
  // Level 1: "Systematic review of randomized trials or n-of-1 trials", meant as "either N-of-1
  // randomized trials or systematic reviews of randomized trials" (OCEBM page, checked 2026-10-19).
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

/** Whether a record's (lower-cased) publication types include one of `names`. */
interface Tag {
  (tags: ReadonlySet<string>): boolean;
  readonly names: readonly string[];
}

const tag = (...names: string[]): Tag => {
  const lower = names.map((n) => n.toLowerCase());
  return Object.assign((tags: ReadonlySet<string>) => lower.some((n) => tags.has(n)), { names });
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
 *
 * Human Challenge Trials (MeSH 2025, a child of Clinical Trial; no entry term but its name) is carried by no record yet:
 * `"Human Challenge Trials"[pt]` found 0 in PubMed, as did the singular, [Publication Type] and [mh], and
 * PUB_TYPE:"Human Challenge Trials" found 0 in Europe PMC (2026-11-27), while 113 PubMed records hold the phrase in some
 * field. It stays in the list a design filter sends as a clause, since a record that carries it classifies as a clinical
 * trial and the filter must keep it. The clause costs nothing: PubMed drops a phrase it has no record for from an OR (11
 * records for `tirzepatide apnea` with the filter, with and without it), and pubmed.ts leaves its phrase-not-found
 * warning out, as the caller never typed the phrase.
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

/**
 * Publisher-added marker on a retracted article's title: "RETRACTED: …", "RETRACTED ARTICLE: …",
 * "[Retracted] …". The colon or brackets are required: "Retracted evidence and emerging insights: an
 * updated meta-analysis …" (PMID 42218886) is not retracted. Notices carry the same prefix but are tagged.
 */
const RETRACTED_TITLE_RE = /^\s*(?:\[retracted\]|retracted(?:\s+article)?\s*:)/i;

/** Flags that mean the record is not usable as evidence: its tier is 0. */
const NOT_EVIDENCE: ReadonlySet<RecordFlag> = new Set(["retracted", "notice", "protocol", "editorial"]);

/**
 * Flags about the paper rather than one database's record of it: a retraction indexed in one database
 * applies to every copy of the paper.
 */
const PAPER_FLAGS: ReadonlySet<RecordFlag> = new Set(["retracted", "expression-of-concern", "corrected", "updated"]);

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

/**
 * The publication types each design comes from, with the highest tier they can give it
 * (null: never rated), mirroring {@link designFromTags}: a record classified as a design
 * always carries one of its tags.
 */
const DESIGN_TAGS: readonly { design: Design; tags: Tag; tier: number | null }[] = [
  { design: "meta-analysis", tags: NETWORK_META_ANALYSIS, tier: DESIGN_TIER["meta-analysis"] },
  { design: "meta-analysis", tags: META_ANALYSIS, tier: null },
  { design: "systematic-review", tags: SYSTEMATIC_REVIEW, tier: null },
  { design: "randomized-controlled-trial", tags: RANDOMIZED, tier: DESIGN_TIER["randomized-controlled-trial"] },
  { design: "non-randomized-trial", tags: CONTROLLED_TRIAL, tier: DESIGN_TIER["non-randomized-trial"] },
  { design: "clinical-trial", tags: OTHER_TRIAL, tier: DESIGN_TIER["clinical-trial"] },
  { design: "observational", tags: OBSERVATIONAL, tier: DESIGN_TIER.observational },
  { design: "case-report", tags: CASE_REPORT, tier: DESIGN_TIER["case-report"] },
  { design: "review", tags: REVIEW, tier: DESIGN_TIER.review },
  { design: "animal-study", tags: VETERINARY, tier: DESIGN_TIER["animal-study"] },
];

/**
 * Publication types a database query can require so it returns only records a
 * studyTypes / minDesignTier filter can keep: every record the filter keeps carries one
 * of them. The classifier still decides, so a record with several tags (an RCT also
 * tagged Observational Study classifies as observational) is filtered afterwards.
 *
 * Returns null when the filter keeps records without such tags (no filter, or `unknown`
 * wanted at tier 0), and an empty list when it keeps nothing metadata can produce
 * (only cohort, case-control, cross-sectional or in-vitro wanted).
 */
export function designPublicationTypes(studyTypes?: readonly StudyType[], minDesignTier?: number): string[] | null {
  const minTier = minDesignTier ?? 0;
  const wanted = studyTypes && studyTypes.length > 0 ? new Set(studyTypes) : null;
  // A tier above 0 drops every unrated record, `unknown` ones included.
  if (minTier <= 0 && (!wanted || wanted.has("unknown"))) return null;
  const types = DESIGN_TAGS.filter(
    (d) => (!wanted || wanted.has(d.design)) && (minTier <= 0 || (d.tier !== null && d.tier >= minTier)),
  ).flatMap((d) => d.tags.names);
  return [...new Set(types)];
}

/**
 * Publication types a database query can exclude for a studyTypes / minDesignTier filter, for the filters whose query
 * would otherwise fill pages with records the classifier gives another design: `unknown`, which no tag narrows, and the
 * two trial designs below the RCT, whose tags PubMed's [pt] expands to every RCT (checked 2026-11-27: "Clinical Trial"
 * finds 1,065,791 records and 537,751 with [pt:noexp]; "Controlled Clinical Trial" 766,952 and 95,901). Any other filter
 * gets []: its tags name its design, and the records they wrongly find are the rare ones with two tags (an RCT also
 * tagged Observational Study classifies as observational), which the classifier still drops afterwards.
 *
 * A tag is listed when no record carrying it, with any of the other design tags, classifies as a wanted type at the tier
 * asked: the classifier itself is asked about every combination of the tag groups, so the precedence between
 * tags is its own. For `unknown` that is every design tag; for `clinical-trial` every tag but those of the Clinical
 * Trial group and Review, as a record tagged Clinical Trial and Randomized Controlled Trial is an RCT, one tagged
 * Clinical Trial and Review a clinical trial. Tags that name no design (Letter, Retracted Publication, ...) leave the
 * design alone and can only lower the tier, so leaving them out of the combinations can only shorten the list.
 */
export function excludedPublicationTypes(studyTypes?: readonly StudyType[], minDesignTier?: number): string[] {
  const wanted = studyTypes && studyTypes.length > 0 ? new Set(studyTypes) : null;
  if (!wanted || !(wanted.has("unknown") || wanted.has("clinical-trial") || wanted.has("non-randomized-trial"))) return [];
  const minTier = minDesignTier ?? 0;
  // The tag groups some wanted combination uses: their tags can't be excluded, as a record with them may be kept.
  const kept = new Set<Tag>();
  for (let combination = 0; combination < 1 << DESIGN_TAGS.length; combination++) {
    const present = DESIGN_TAGS.filter((_, i) => combination & (1 << i));
    const { studyType, designTier } = classifyDesign({ title: "", publicationTypes: present.map((d) => d.tags.names[0]!) });
    if (wanted.has(studyType) && (designTier ?? 0) >= minTier) for (const d of present) kept.add(d.tags);
  }
  return DESIGN_TAGS.filter((d) => !kept.has(d.tags)).flatMap((d) => d.tags.names);
}

/** Study types that NLM metadata never produces, so a studyTypes filter on them alone keeps nothing. */
export function unassignedStudyTypes(studyTypes?: readonly StudyType[]): StudyType[] {
  const assigned = new Set<StudyType>([...DESIGN_TAGS.map((d) => d.design), "unknown"]);
  return (studyTypes ?? []).filter((t) => !assigned.has(t));
}

/** Classify a record from its metadata. Exposed for testing without constructing an Article. */
export function classifyDesign(
  meta: Pick<Article, "title" | "publicationTypes" | "meshHeadings" | "corrections" | "machineTranslated" | "machineGeneratedAbstract">,
): Classification {
  const tags = lowerSet(meta.publicationTypes);
  const mesh = lowerSet(meta.meshHeadings);
  const links = new Set((meta.corrections ?? []).map((c) => c.type));

  const found = designFromTags(tags);
  const design = found?.design ?? null;

  const flags: RecordFlag[] = [];
  const notice = NOTICE(tags);
  // RetractionIn links the article to its retraction notice [NLM-XML].
  if (RETRACTED(tags) || links.has("RetractionIn") || (!notice && RETRACTED_TITLE_RE.test(meta.title ?? ""))) {
    flags.push("retracted");
  }
  if (notice) flags.push("notice");
  if (PROTOCOL(tags)) flags.push("protocol");
  if (EDITORIAL(tags)) flags.push("editorial");
  // An expression of concern is linked only, never tagged, on the article itself [NLM-XML].
  if (links.has("ExpressionOfConcernIn")) flags.push("expression-of-concern");
  if (links.has("ErratumIn")) flags.push("corrected");
  // UpdateIn: a newer version exists, e.g. an updated Cochrane review [NLM-XML], or a preprint's journal
  // article (see the header). UpdateOf, the link back from the newer record, is no warning: nothing is wrong with it.
  if (links.has("UpdateIn")) flags.push("updated");
  // Only a warning: automated indexing drops the Humans tag from human trials
  // often enough that "Animals NOT Humans" wrongly excluded human RCTs 7× as
  // often as under manual indexing [Askin-2025].
  if (mesh.has("animals") && !mesh.has("humans") && design !== "animal-study" && design !== "in-vitro") {
    flags.push("animals-not-humans");
  }
  if (PREPRINT(tags)) flags.push("preprint");
  if (LETTER(tags)) flags.push("letter");
  // The record's text, not the study: set by the ChinaRxiv adapter from the API's
  // source_language and abstract_source fields (see adapters/chinarxiv.ts).
  if (meta.machineTranslated) flags.push("machine-translated");
  if (meta.machineGeneratedAbstract) flags.push("machine-generated-abstract");

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

/**
 * The links of two records of the same paper together: the first's, then the second's that it lacks. A link
 * without an id adds nothing to a record that has one of its type, as the id-less link is the same notice
 * seen from a database that doesn't hold the record. Undefined when there are none.
 */
function mergeCorrections(kept: Correction[] | undefined, other: Correction[] | undefined): Correction[] | undefined {
  if (!other?.length) return kept;
  const seen = new Set((kept ?? []).map((c) => `${c.type}:${c.id ?? ""}`));
  const held = new Set((kept ?? []).map((c) => c.type));
  const added = other.filter((c) => {
    const key = `${c.type}:${c.id ?? ""}`;
    if (seen.has(key) || (!c.id && held.has(c.type))) return false;
    seen.add(key);
    return true;
  });
  return added.length > 0 ? [...(kept ?? []), ...added] : kept;
}

/**
 * Merge two records of the same paper (same DOI or PMID): keep the higher-ranked one (the first on a tie) and
 * add the other's paper-level flags and the links (`corrections`) it has that the kept one lacks, so a
 * retraction, or the published version of a preprint, known to only one database is not lost. Copies merged on
 * a PMID may differ in what they hold, so the kept one also takes the other's `doi` and `pmcid` when it has none
 * of its own (`literature_fulltext` and citations need them); a value it has is never replaced, and no other field is copied.
 */
export function mergeDuplicate(first: GradedArticle, second: GradedArticle): GradedArticle {
  const [kept, other] = rankKey(second) > rankKey(first) ? [second, first] : [first, second];
  const flags = RECORD_FLAGS.filter((f) => kept.flags?.includes(f) || (PAPER_FLAGS.has(f) && other.flags?.includes(f)));
  const corrections = mergeCorrections(kept.corrections, other.corrections);
  const moreFlags = flags.length > (kept.flags?.length ?? 0);
  const moreLinks = corrections !== kept.corrections;
  const doi = !kept.doi && other.doi ? { doi: other.doi } : {};
  const pmcid = !kept.pmcid && other.pmcid ? { pmcid: other.pmcid } : {};
  const moreIds = Object.keys(doi).length + Object.keys(pmcid).length > 0;
  if (!moreFlags && !moreLinks && !moreIds) return kept;
  return {
    ...kept,
    ...doi,
    ...pmcid,
    ...(moreFlags ? { flags, ...(flags.some((f) => NOT_EVIDENCE.has(f)) ? { designTier: 0 } : {}) } : {}),
    ...(moreLinks ? { corrections } : {}),
  };
}

/**
 * Study types a minDesignTier leaves out entirely: metadata assigns them, but only below that tier
 * (animal-study at 0, review and case-report at 1).
 */
export function typesBelowTier(studyTypes?: readonly StudyType[], minDesignTier?: number): StudyType[] {
  const minTier = minDesignTier ?? 0;
  return [...new Set(studyTypes ?? [])].filter((t) => {
    const sources = DESIGN_TAGS.filter((d) => d.design === t);
    return sources.length > 0 && sources.every((d) => d.tier !== null && d.tier < minTier);
  });
}

/**
 * The warnings a studyTypes / minDesignTier filter gets whatever the databases return: study types
 * metadata never assigns, study types below minDesignTier, and the unrated records minDesignTier
 * leaves out (see {@link unratedExcludedWarning}).
 */
export function filterWarnings(studyTypes?: readonly StudyType[], minDesignTier?: number): string[] {
  const warnings: string[] = [];
  const unassigned = unassignedStudyTypes(studyTypes);
  if (unassigned.length > 0) {
    warnings.push(
      `No record is ever labeled ${unassigned.join(", ")}: metadata doesn't assign ${unassigned.length > 1 ? "these designs" : "this design"}. ` +
        `Search without ${unassigned.length > 1 ? "them" : "it"} and judge the design from the abstract.`,
    );
  }
  const below = typesBelowTier(studyTypes, minDesignTier).filter((t) => !unassigned.includes(t));
  if (below.length > 0) {
    warnings.push(
      `${below.map((t) => `${t} (designTier ${DESIGN_TIER[t as Design]})`).join(" and ")} records are below minDesignTier ${minDesignTier}, ` +
        `so none are kept. Lower minDesignTier to keep them.`,
    );
  }
  const unrated = unratedExcludedWarning(studyTypes, minDesignTier);
  if (unrated) warnings.push(unrated);
  return warnings;
}

/**
 * The warning for a page that the studyTypes / minDesignTier filter cut after the databases returned it, or undefined
 * when it kept every record. The query is only narrowed to the publication types that can give a design (see
 * {@link designPublicationTypes} and {@link excludedPublicationTypes}), so the classifier drops the rest, here, and
 * `total` and `nextPage`, which come from the databases, count what it drops: a page can be short or empty while
 * later pages hold records.
 */
export function filteredPageWarning(kept: number, fetched: number): string | undefined {
  if (kept >= fetched) return undefined;
  return (
    `The studyTypes/minDesignTier filter kept ${kept} of the ${fetched} records this page fetched; the others are classified as ` +
    `another study type or rank below minDesignTier. total and nextPage count records before this filter, so this page ` +
    `can be short or empty while later pages hold more.`
  );
}

/**
 * Why a studyTypes filter found no animal-study: the label comes only from the veterinary
 * publication types, which laboratory animal studies don't carry. MEDLINE indexes those with the
 * Animals check tag, so they show up as records flagged animals-not-humans. Undefined when the
 * filter didn't ask for animal-study, found one, or minDesignTier left them out ({@link filterWarnings}
 * says so).
 */
export function noAnimalStudiesWarning(
  studyTypes: readonly StudyType[] | undefined,
  minDesignTier: number | undefined,
  found: readonly GradedArticle[],
): string | undefined {
  if (!studyTypes?.includes("animal-study") || typesBelowTier(["animal-study"], minDesignTier).length > 0) return undefined;
  if (found.some((a) => a.studyType === "animal-study")) return undefined;
  return (
    `No record found is labeled animal-study: the label comes only from veterinary publication types (${VETERINARY.names.join("; ")}). ` +
    `Laboratory animal studies carry none of them; MEDLINE-indexed ones show up flagged animals-not-humans. ` +
    `Search without the animal-study filter and look for that flag.`
  );
}

/**
 * The warning for a minDesignTier that leaves out records the studyTypes filter alone would keep
 * because their tier is unknown; undefined when it leaves out none. The databases are not asked for
 * such records (see {@link designPublicationTypes}), so there is no count to report.
 */
export function unratedExcludedWarning(studyTypes?: readonly StudyType[], minDesignTier?: number): string | undefined {
  if ((minDesignTier ?? 0) <= 0) return undefined;
  const wanted = studyTypes && studyTypes.length > 0 ? new Set(studyTypes) : null;
  const unratedWanted = !wanted || wanted.has("unknown") || DESIGN_TAGS.some((d) => d.tier === null && wanted.has(d.design));
  if (!unratedWanted) return undefined;
  return (
    `minDesignTier ${minDesignTier} leaves out every record with an unknown design tier (designTier null) — unrated, not weak: ` +
    `records without design metadata, and systematic reviews/meta-analyses whose pooled study designs are not indexed. ` +
    `To keep reviews and trials, filter with studyTypes instead.`
  );
}
