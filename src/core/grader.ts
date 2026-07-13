/**
 * Keyword / rule-based evidence grading — the fast, free path.
 *
 * Strategy: trust PubMed's own curated PublicationType tags first (NLM indexers
 * assign these, so they're far more reliable than scraping the abstract), then
 * fall back to regex over title + abstract. Known keyword-path weaknesses
 * (protocol papers read as RCTs, "unlike previous trials…" false positives,
 * animal studies with incidental human mentions) are damped via negative
 * patterns and surfaced in `limitations`.
 *
 * Multi-language: the databases behind {@link searchLiterature} (SciELO,
 * CyberLeninka, ChinaXiv, J-STAGE, Europe PMC) return abstracts in Spanish,
 * Portuguese, French, German, Italian, Russian, Chinese and Japanese. So the
 * study-type rules carry synonyms across those languages, and the population /
 * diversity extraction leans on language-agnostic signals (digits, `%`, dose
 * units, `n=`) so a non-English abstract still grades and still reports on what
 * range of people the finding was tested.
 */

import type { GradedArticle, Article, StudyType, PopulationDiversity } from "./types.js";

export const SCORE_BY_TYPE: Record<StudyType, number> = {
  "meta-analysis": 5,
  "randomized-controlled-trial": 4,
  cohort: 3,
  review: 3,
  "case-control": 2,
  "case-report": 1,
  "animal-study": 0,
  unknown: 0,
};

interface Rule {
  studyType: StudyType;
  patterns: RegExp[];
}

/** Ordered by evidence score, highest first — first rule with a hit wins. */
const RULES: Rule[] = [
  {
    studyType: "meta-analysis",
    patterns: [/meta-analys[ie]s/i, /systematic review/i, /pooled analysis/i],
  },
  {
    studyType: "randomized-controlled-trial",
    patterns: [/randomi[sz]ed/i, /double-blind/i, /placebo[- ]control/i, /\bRCT\b/],
  },
  {
    studyType: "cohort",
    patterns: [/cohort/i, /longitudinal/i, /prospective/i, /follow-up/i],
  },
  {
    studyType: "review",
    // "systematic review" is caught above; a plain review lands here.
    patterns: [/\breview\b/i, /literature review/i, /narrative review/i],
  },
  {
    studyType: "case-control",
    patterns: [/case-control/i, /matched control/i],
  },
  {
    studyType: "case-report",
    patterns: [/case report/i, /case study/i, /case presentation/i],
  },
  {
    studyType: "animal-study",
    patterns: [/\bmurine\b/i, /\brodents?\b/i, /animal model/i, /\bmice\b/i, /\bmouse\b/i, /\brats?\b/i],
  },
];

/**
 * Study-type synonyms in the non-English languages of the supported databases,
 * substring-matched against the lowercased text. Non-PubMed adapters rarely
 * carry NLM-style PublicationType tags, so for those abstracts this is the only
 * classification signal. Kept as plain strings (not `\b`-anchored regexes)
 * because JS word boundaries are ASCII-only and break on Cyrillic/CJK.
 */
const MULTILINGUAL_TERMS: Record<Exclude<StudyType, "unknown">, string[]> = {
  "meta-analysis": [
    "metaanálisis", "meta-análisis", "revisión sistemática", "metanálise", "meta-análise",
    "revisão sistemática", "méta-analyse", "revue systématique", "metaanalyse",
    "systematische übersicht", "systematische übersichtsarbeit", "metanalisi", "revisione sistematica",
    "метаанализ", "мета-анализ", "систематический обзор", "荟萃分析", "元分析", "系统评价", "系统综述",
    "メタアナリシス", "メタ分析", "システマティックレビュー", "システマティック・レビュー",
  ],
  "randomized-controlled-trial": [
    "aleatorizado", "aleatorizada", "ensayo clínico aleatorizado", "doble ciego", "controlado con placebo",
    "randomizado", "randomizada", "ensaio clínico randomizado", "duplo-cego", "duplo cego",
    "randomisé", "randomisée", "essai contrôlé randomisé", "essai randomisé", "double aveugle", "contrôlé par placebo",
    "randomisiert", "randomisierte kontrollierte studie", "doppelblind", "placebokontrolliert",
    "randomizzato", "studio controllato randomizzato", "doppio cieco",
    "рандомизированн", "двойн слеп", "плацебо-контролируем", "плацебо контролируем",
    "随机对照试验", "随机对照", "随机分组", "双盲", "安慰剂对照",
    "ランダム化比較試験", "無作為化", "無作為割付", "二重盲検", "プラセボ対照",
  ],
  cohort: [
    "cohorte", "longitudinal", "prospectivo", "prospectiva", "seguimiento",
    "coorte", "seguimento",
    "longitudinale", "prospectif", "prospective", "suivi",
    "kohorte", "kohortenstudie", "längsschnitt", "prospektiv", "nachbeobachtung",
    "coorti", "prospettico",
    "когорт", "продольн", "проспективн", "наблюдени",
    "队列", "前瞻性", "随访",
    "コホート", "前向き", "追跡",
  ],
  review: [
    "revisión", "revisión narrativa", "revisión de la literatura",
    "revisão", "revisão narrativa", "revisão da literatura",
    "revue", "revue de la littérature", "revue narrative",
    "übersichtsarbeit", "literaturübersicht", "überblick",
    "revisione", "rassegna",
    "обзор", "обзор литературы",
    "综述", "文献综述", "述评",
    "レビュー", "総説", "文献レビュー",
  ],
  "case-control": [
    "casos y controles", "caso-control", "caso y control",
    "caso-controle", "casos e controles",
    "cas-témoins", "cas témoins",
    "fall-kontroll",
    "caso-controllo", "caso controllo",
    "случай-контроль", "случай–контроль",
    "病例对照",
    "症例対照",
  ],
  "case-report": [
    "reporte de caso", "caso clínico", "presentación de caso",
    "relato de caso",
    "rapport de cas", "cas clinique", "à propos d'un cas",
    "fallbericht", "fallstudie", "kasuistik",
    "caso clinico", "descrizione di un caso",
    "клинический случай", "описание случая", "клиническое наблюдение",
    "病例报告", "个案报告",
    "症例報告",
  ],
  "animal-study": [
    "murino", "murina", "roedores", "modelo animal", "ratones", "ratas",
    "camundongos", "ratos",
    "murin", "murine", "rongeurs", "modèle animal", "souris",
    "nagetiere", "tiermodell", "mäuse", "ratten",
    "roditori", "modello animale", "topi", "ratti",
    "мышин", "грызун", "животн модел", "крыс", "мыш",
    "小鼠", "大鼠", "动物模型", "啮齿",
    "マウス", "ラット", "動物モデル", "げっ歯",
  ],
};

/** Multilingual pass runs in the same evidence-score priority order as {@link RULES}. */
const MULTILINGUAL_ORDER = RULES.map((r) => r.studyType) as Exclude<StudyType, "unknown">[];

/** NLM PublicationType → our taxonomy. Lowercased keys. */
const PUB_TYPE_MAP: Record<string, StudyType> = {
  "meta-analysis": "meta-analysis",
  "systematic review": "meta-analysis",
  "randomized controlled trial": "randomized-controlled-trial",
  // NLM tags EHR/registry/propensity-matched studies "Observational Study".
  // Without this, the abstract's mention of "randomized" trials it compares
  // against misfires the RCT regex and inflates the score.
  "observational study": "cohort",
  review: "review",
  "case reports": "case-report",
};

/** English human-subject cues (ASCII word-boundaries are safe here). */
const HUMAN_TERMS_RE =
  /\b(humans?|patients?|adults?|men|women|participants?|volunteers?|subjects?|children|boys?|girls?)\b/i;

/** Human-subject cues in other languages, substring-matched (lowercased). */
const HUMAN_TERMS_INTL = [
  // es / pt
  "humano", "paciente", "adulto", "hombre", "mujer", "participante", "voluntario",
  "sujeto", "niño", "homem", "mulher", "voluntário", "criança", "indivíduo",
  // fr
  "humain", "adulte", "homme", "femme", "volontaire", "enfant",
  // de
  "mensch", "erwachsene", "männer", "frauen", "teilnehmer", "proband", "kinder",
  // it
  "umano", "uomo", "donna", "partecipante", "bambino",
  // ru
  "человек", "пациент", "взросл", "мужчин", "женщин", "участник", "доброволец", "дет",
  // zh / ja
  "患者", "成人", "受试者", "志愿者", "儿童", "人类", "被験者", "参加者", "小児", "ヒト",
];

function hasHumanTerms(text: string, lower: string): boolean {
  return HUMAN_TERMS_RE.test(text) || HUMAN_TERMS_INTL.some((t) => lower.includes(t));
}

/** Phrases that make a keyword hit untrustworthy. */
const NEGATIVE_PATTERNS: { pattern: RegExp; limitation: string }[] = [
  { pattern: /\bstudy protocol\b/i, limitation: "Reads as a study protocol, not a completed trial." },
  { pattern: /\bwe will\b/i, limitation: "Future-tense wording suggests a protocol/plan, not results." },
  { pattern: /\bprotocol for a\b/i, limitation: "Reads as a study protocol, not a completed trial." },
  { pattern: /unlike previous (randomi[sz]ed )?(trials|studies)/i, limitation: "Study-type keyword may be a false positive from comparative phrasing." },
  // Common protocol wording in other languages.
  { pattern: /protocolo (?:de|del|do) estudo|protocolo del ensayo|protocole d[’']étude|studienprotokoll|protocollo di studio/i, limitation: "Reads as a study protocol, not a completed trial." },
];

const DOSAGE_RE = /\b(\d+(?:\.\d+)?)\s?(mg\/kg|mcg\/kg|g\/day|mg\/day|mg|mcg|µg|ug|g|IU|mL|ml)\b/i;
const POPULATION_RE =
  /\bin\s+((?:\d+\s+)?(?:healthy\s+)?(?:adults?|men|women|volunteers?|participants?|patients?(?:\s+with\s+[a-z][a-z\s-]{2,40})?|older adults|elderly|children|athletes))/i;
const LIMITATION_CUES =
  /([^.]*\b(?:limitation|small sample|underpowered|short duration|no control group|not blinded|preliminary|pilot study|single[- ]center)\b[^.]*\.)/gi;

// --- Language-agnostic population / diversity signals ------------------------

/** "n = 240", full-width "＝", thousands separators. */
const SAMPLE_N_RE = /\bn\s*[=＝]\s*(\d{1,3}(?:[,\s ]\d{3})+|\d+)/i;
/** "240 patients / participants / 例 / 名 …" across languages (≥2 digits avoids doses). */
const SAMPLE_COUNT_RE =
  /(\d{2,7})\s*(?:patients?|participants?|subjects?|volunteers?|adults?|men|women|children|individuals?|pacientes|participantes|sujetos|voluntarios|adultos|niños|indivíduos|sujeitos|voluntários|patienten|teilnehmer|probanden|sujets|volontaires|人|例|名|被験者|患者)/i;

/** Age units across languages. */
const AGE_UNIT = "(?:years?|yrs?\\.?|y(?:ears?)?[- ]?old|años|anos|ans|jahren?|anni|лет|года?|歳|岁|년|세)";
const AGE_RANGE_RE = new RegExp(
  `\\b(\\d{1,3})\\s*(?:-|–|—|to|a\\b|à|bis|~|至|〜)\\s*(\\d{1,3})\\s*${AGE_UNIT}`,
  "i",
);
const AGE_MEAN_RE = new RegExp(
  `(?:mean|median|average|promedio|media|média|moyen(?:ne)?|mittel(?:wert|es)?|средн\\S*|平均)\\s*(?:age|edad|idade|âge|alter|возраст|年齢|年龄)?[^.\\d]{0,14}(\\d{1,3}(?:\\.\\d+)?)\\s*${AGE_UNIT}`,
  "i",
);

const MALE_RE = /\b(?:males?|men|man|boys?|hombres?|varones?|homens?|hommes?|männer|mann|uomini|uomo)\b/i;
const FEMALE_RE = /\b(?:females?|women|woman|girls?|mujeres?|mulheres?|femmes?|frauen|frau|donne|donna)\b/i;
const MALE_INTL = ["мужчин", "男性", "男児", "男子"];
const FEMALE_INTL = ["женщин", "女性", "女児", "女子"];
const FEMALE_PCT_RE =
  /(\d{1,3}(?:\.\d+)?)\s*%\s*(?:of\s+(?:the\s+)?(?:participants?|patients?|sample)\s+(?:were\s+)?|(?:were\s+)?)?(?:female|women|mujeres|mulheres|femmes|frauen|donne|女性|女)/i;
const MALE_PCT_RE =
  /(\d{1,3}(?:\.\d+)?)\s*%\s*(?:of\s+(?:the\s+)?(?:participants?|patients?|sample)\s+(?:were\s+)?|(?:were\s+)?)?(?:male|men|hombres|homens|hommes|männer|uomini|男性|男)/i;

/** Ancestry only when followed by a population noun (avoids "Japanese encephalitis"). */
const ANCESTRY_RE = new RegExp(
  "\\b(multi-?ethnic|japanese|chinese|korean|han chinese|indian|iranian|turkish|nigerian|" +
    "brazilian|mexican|hispanic|latino|latina|caucasian|european|african american|african|" +
    "asian|black|white)\\s+(?:adults?|men|women|males?|females?|patients?|participants?|" +
    "volunteers?|subjects?|children|population|cohort|individuals?)\\b",
  "i",
);
const HEALTHY_RE = /\b(?:healthy|sanos?|sanas?|saud[áa]veis|sains?|saines?|gesunde[rn]?|sani|sane)\b/i;
const HEALTHY_INTL = ["健康", "健常", "健常者"];

function toInt(raw: string): number {
  return Number(raw.replace(/[,\s ]/g, ""));
}

export interface GradeResult {
  studyType: StudyType;
  evidenceScore: number;
  confidence: number;
  dosage?: string;
  population?: string;
  /** Structured breakdown of the tested population — see {@link PopulationDiversity}. */
  diversity?: PopulationDiversity;
  limitations?: string[];
}

function classifyByPublicationType(publicationTypes: string[]): StudyType | null {
  for (const pt of publicationTypes) {
    const mapped = PUB_TYPE_MAP[pt.trim().toLowerCase()];
    if (mapped) return mapped;
  }
  return null;
}

function countHits(text: string, patterns: RegExp[]): number {
  let hits = 0;
  for (const p of patterns) {
    if (p.test(text)) hits += 1;
  }
  return hits;
}

function classifyByKeywords(text: string): { studyType: StudyType; hits: number } {
  const lower = text.toLowerCase();
  const human = hasHumanTerms(text, lower);

  // 1. Precise English regex pass.
  for (const rule of RULES) {
    if (rule.studyType === "animal-study" && human) {
      // Animal keywords with human terms present: don't force animal-study.
      continue;
    }
    const hits = countHits(text, rule.patterns);
    if (hits > 0) return { studyType: rule.studyType, hits };
  }

  // 2. Multilingual substring fallback for non-English abstracts.
  for (const st of MULTILINGUAL_ORDER) {
    if (st === "animal-study" && human) continue;
    let hits = 0;
    for (const term of MULTILINGUAL_TERMS[st]) {
      if (lower.includes(term)) hits += 1;
    }
    if (hits > 0) return { studyType: st, hits };
  }

  return { studyType: "unknown", hits: 0 };
}

function detectSex(text: string, lower: string): string | undefined {
  const femalePct = text.match(FEMALE_PCT_RE);
  if (femalePct?.[1]) {
    const pct = Number(femalePct[1]);
    if (pct >= 100) return "female only";
    if (pct <= 0) return "male only";
    return `men and women (${femalePct[1]}% female)`;
  }
  const malePct = text.match(MALE_PCT_RE);
  if (malePct?.[1]) {
    const pct = Number(malePct[1]);
    if (pct >= 100) return "male only";
    if (pct <= 0) return "female only";
    return `men and women (${malePct[1]}% male)`;
  }

  const hasMale = MALE_RE.test(text) || MALE_INTL.some((t) => lower.includes(t));
  const hasFemale = FEMALE_RE.test(text) || FEMALE_INTL.some((t) => lower.includes(t));
  if (hasMale && hasFemale) return "men and women";
  if (hasFemale) return "female only";
  if (hasMale) return "male only";
  return undefined;
}

function detectHealth(text: string, lower: string, population: string | undefined): string | undefined {
  if (HEALTHY_RE.test(text) || HEALTHY_INTL.some((t) => lower.includes(t))) return "healthy";
  const withCondition = population?.match(/patients?\s+with\s+(.+)/i);
  if (withCondition?.[1]) return `patients with ${withCondition[1].trim()}`;
  if (/\bpatients?\b/i.test(text)) return "clinical (patient) population";
  return undefined;
}

function scoreBreadth(
  d: PopulationDiversity,
  ageSpan: number | undefined,
): { breadth?: number; notes: string[] } {
  const notes: string[] = [];
  let breadth = 0;
  let counted = false;

  if (d.sampleSize != null) {
    counted = true;
    if (d.sampleSize >= 100) breadth += 0.3;
    else if (d.sampleSize >= 30) breadth += 0.15;
    else {
      breadth += 0.05;
      notes.push(`Small sample (n = ${d.sampleSize}) — limited generalizability.`);
    }
  }
  if (d.sex) {
    counted = true;
    if (/only/i.test(d.sex)) notes.push(`Single-sex population (${d.sex}).`);
    else breadth += 0.3;
  }
  if (d.age) {
    counted = true;
    breadth += 0.2;
    if (ageSpan != null && ageSpan < 10) notes.push(`Narrow age range (${d.age}).`);
  }
  if (d.ancestry) {
    counted = true;
    if (/multi-?ethnic/i.test(d.ancestry)) breadth += 0.2;
    else {
      breadth += 0.1;
      notes.push(`Tested in one ancestry group (${d.ancestry}) — may not generalize.`);
    }
  }

  if (!counted) return { notes };
  return { breadth: Number(Math.min(1, breadth).toFixed(3)), notes };
}

function extractDiversity(text: string, population: string | undefined): PopulationDiversity | undefined {
  const lower = text.toLowerCase();
  const d: PopulationDiversity = {};

  // Sample size: prefer an explicit "n = …", else a "<count> <person-noun>".
  const nMatch = text.match(SAMPLE_N_RE);
  let size = nMatch?.[1] ? toInt(nMatch[1]) : undefined;
  if (size == null || Number.isNaN(size)) {
    const cMatch = text.match(SAMPLE_COUNT_RE);
    size = cMatch?.[1] ? toInt(cMatch[1]) : undefined;
  }
  if (size != null && !Number.isNaN(size) && size > 0 && size < 100_000_000) d.sampleSize = size;

  // Age: a range wins over a mean.
  let ageSpan: number | undefined;
  const ageRange = text.match(AGE_RANGE_RE);
  if (ageRange?.[1] && ageRange[2]) {
    const a = Number(ageRange[1]);
    const b = Number(ageRange[2]);
    if (a < b && b <= 120) {
      d.age = `${a}–${b} years`;
      ageSpan = b - a;
    }
  }
  if (!d.age) {
    const ageMean = text.match(AGE_MEAN_RE);
    if (ageMean?.[1] && Number(ageMean[1]) <= 120) d.age = `mean ~${ageMean[1]} years`;
  }

  const sex = detectSex(text, lower);
  if (sex) d.sex = sex;

  const anc = text.match(ANCESTRY_RE);
  if (anc?.[1]) d.ancestry = anc[1].replace(/\s+/g, " ").trim();

  const health = detectHealth(text, lower, population);
  if (health) d.healthStatus = health;

  const has = d.sampleSize != null || d.age || d.sex || d.ancestry || d.healthStatus;
  if (!has) return undefined;

  const { breadth, notes } = scoreBreadth(d, ageSpan);
  if (breadth != null) d.breadth = breadth;
  if (notes.length > 0) d.notes = notes;
  return d;
}

function extract(
  text: string,
): Pick<GradeResult, "dosage" | "population" | "diversity" | "limitations"> {
  const out: Pick<GradeResult, "dosage" | "population" | "diversity" | "limitations"> = {};

  const dosage = text.match(DOSAGE_RE);
  if (dosage) out.dosage = dosage[0].trim();

  const population = text.match(POPULATION_RE);
  if (population?.[1]) out.population = population[1].trim();

  const diversity = extractDiversity(text, out.population);
  if (diversity) out.diversity = diversity;

  const limitations: string[] = [];
  for (const m of text.matchAll(LIMITATION_CUES)) {
    const sentence = m[1]?.trim();
    if (sentence) limitations.push(sentence);
  }
  if (limitations.length > 0) out.limitations = limitations.slice(0, 5);

  return out;
}

/** Grade from raw fields. Exposed for testing without constructing an Article. */
export function gradeText(
  title: string,
  abstract: string | undefined,
  publicationTypes: string[] = [],
  language?: string,
): GradeResult {
  const text = `${title}\n${abstract ?? ""}`.trim();

  // 1. Trust curated PublicationType tags when present.
  const byPubType = classifyByPublicationType(publicationTypes);

  // 2. Keyword classification (also used to corroborate / fall back).
  const byKeyword = classifyByKeywords(text);

  let studyType: StudyType;
  let confidence: number;
  if (byPubType) {
    studyType = byPubType;
    // High confidence: NLM-assigned. A corroborating keyword hit nudges it higher.
    confidence = byKeyword.studyType === byPubType ? 0.95 : 0.85;
  } else {
    studyType = byKeyword.studyType;
    // Spec formula: positiveHits * 0.4 + 0.2, capped at 1.
    confidence = studyType === "unknown" ? 0.1 : Math.min(1, byKeyword.hits * 0.4 + 0.2);
  }

  const extracted = extract(text);
  const limitations = [...(extracted.limitations ?? [])];

  // Negative keywords halve confidence and are recorded as limitations.
  let negativeHit = false;
  for (const neg of NEGATIVE_PATTERNS) {
    if (neg.pattern.test(text)) {
      negativeHit = true;
      if (!limitations.includes(neg.limitation)) limitations.push(neg.limitation);
    }
  }
  if (negativeHit) confidence = confidence / 2;

  // Title-only grade (no abstract) is inherently less certain.
  if (!abstract) {
    confidence = Math.min(confidence, 0.5);
    limitations.push("Graded from title only — no abstract available.");
  }

  // Non-English abstract we couldn't classify: flag it rather than silently
  // pretend the keyword path was authoritative.
  if (studyType === "unknown" && language && language.toLowerCase() !== "en" && abstract) {
    limitations.push(
      `Abstract is not in English (${language}); study type could not be classified from keywords.`,
    );
  }

  const result: GradeResult = {
    studyType,
    evidenceScore: SCORE_BY_TYPE[studyType],
    confidence: Math.max(0, Math.min(1, Number(confidence.toFixed(3)))),
  };
  if (extracted.dosage) result.dosage = extracted.dosage;
  if (extracted.population) result.population = extracted.population;
  if (extracted.diversity) result.diversity = extracted.diversity;
  if (limitations.length > 0) result.limitations = limitations;
  return result;
}

/** Grade an article fetched from NCBI (or any adapter). */
export function keywordGrade(article: Article): GradedArticle {
  const grade = gradeText(article.title, article.abstract, article.publicationTypes, article.language);
  return {
    ...article,
    studyType: grade.studyType,
    evidenceScore: grade.evidenceScore,
    confidence: grade.confidence,
    ...(grade.dosage ? { dosage: grade.dosage } : {}),
    ...(grade.population ? { population: grade.population } : {}),
    ...(grade.diversity ? { diversity: grade.diversity } : {}),
    ...(grade.limitations ? { limitations: grade.limitations } : {}),
  };
}
