/**
 * Keyword / rule-based evidence grading — the fast, free path.
 *
 * Two layers, both built to avoid *optimistic* bias:
 *
 * 1. Study design. Curated NLM PublicationType tags win. Generic tags ("Review",
 *    "Observational Study", "Clinical Trial") may only be refined to a more
 *    specific design the abstract states outright. Without tags, weighted cues
 *    vote per design: the title counts double (CONSORT 1a, STROBE 1a and PRISMA 1
 *    ask authors to name the design there), sentences about *other* work
 *    ("previous trials showed…", "RCTs are needed") are ignored, negations
 *    ("non-randomized") are honoured, and ties resolve to the lower tier. A
 *    declared synthesis is classified as such even though it names the designs
 *    it pooled.
 *
 * 2. Evidence score. The design sets the starting tier (OCEBM 2011 / GRADE
 *    ordering), which is only ever rated *down*, for high-precision signals —
 *    retraction, protocol without results, commentary, synthesis of animal or of
 *    purely observational studies, pilot/feasibility trials — each recorded in
 *    `scoreAdjustments`. Nothing rates up: GRADE's upgrade criteria (large
 *    effect, dose-response) need numbers a regex can't reliably read. Source
 *    database and language never change the score, only the confidence.
 *
 * Multi-language: the databases behind {@link searchLiterature} (SciELO,
 * CyberLeninka, ChinaXiv, J-STAGE, Europe PMC) return abstracts in Spanish,
 * Portuguese, French, German, Italian, Russian, Chinese and Japanese. So the
 * study-type rules carry synonyms across those languages, and the population /
 * diversity extraction leans on language-agnostic signals (digits, `%`, dose
 * units, `n=`) so a non-English abstract still grades and still reports on what
 * range of people the finding was tested.
 */

import type {
  GradedArticle,
  Article,
  StudyType,
  PopulationDiversity,
  ScoreAdjustment,
} from "./types.js";

/**
 * Starting tier per design (OCEBM 2011 levels / GRADE ordering). Narrative
 * reviews are unsystematic expert synthesis and sit with case reports, not with
 * cohorts; a systematic review without pooling ranks with a meta-analysis.
 */
export const SCORE_BY_TYPE: Record<StudyType, number> = {
  "meta-analysis": 5,
  "systematic-review": 5,
  "randomized-controlled-trial": 4,
  "non-randomized-trial": 3,
  cohort: 3,
  "case-control": 2,
  "cross-sectional": 2,
  "case-report": 1,
  review: 1,
  "animal-study": 0,
  "in-vitro": 0,
  unknown: 0,
};

type Design = Exclude<StudyType, "unknown">;

/** Weakest first — equal keyword evidence resolves to the earlier (lower) design. */
const CONSERVATIVE_ORDER: Design[] = [
  "in-vitro",
  "animal-study",
  "review",
  "case-report",
  "cross-sectional",
  "case-control",
  "cohort",
  "non-randomized-trial",
  "randomized-controlled-trial",
  "systematic-review",
  "meta-analysis",
];

const PRECLINICAL: ReadonlySet<StudyType> = new Set(["animal-study", "in-vitro"]);

/** A design-declarative phrase ("randomized controlled trial") vs a suggestive one ("double-blind"). */
const STRONG = 1;
const WEAK = 0.5;
/** Title hits count double: reporting guidelines ask authors to name the design there. */
const TITLE_WEIGHT = 2;
/** Keyword evidence alone never claims more certainty than a curated NLM tag. */
const KEYWORD_CONFIDENCE_CAP = 0.8;

// Placeholder tokens substituted during preprocessing — ASCII, so `\b` and
// substring matching both work, and they can't collide with real words.
const T_NONRANDOM = "zqnonrandzq";
const T_SYSREVIEW = "zqsysrevzq";
const T_NO_META = "zqnometazq";
const T_CHART = "zqchartzq";

/** Rewrites applied before matching, so negations and look-alike phrases can't fire positive cues. */
const REWRITES: [RegExp, string][] = [
  [/\b(?:non|not|quasi|pseudo)[- ]?randomi[sz]ed\b|\bwithout randomi[sz]ation\b/gi, T_NONRANDOM],
  [/\bin vitro fertili[sz]ation\b/gi, "ivf"],
  [/\b(?:institutional|ethic(?:s|al)|independent) review (?:board|committee)s?\b|\bpeer[- ]review(?:ed)?\b/gi, " "],
  [
    /\b(?:medical|clinical|health|hospital|patient|electronic|chart|case)[- ]records? review(?:ed)?\b|\bchart review(?:ed)?\b|\breview(?:ed|ing)? (?:of )?(?:the )?(?:medical |clinical |electronic |health |hospital |patient )?(?:records|charts|case notes)\b/gi,
    T_CHART,
  ],
  [
    /\bno meta-?analysis\b|\bmeta-?analys[ie]s (?:was|were|could) not\b|\b(?:not|nor) (?:possible|feasible|appropriate) to (?:perform|conduct|undertake) (?:a )?meta-?analysis\b|\bwithout (?:a )?meta-?analysis\b/gi,
    T_NO_META,
  ],
  [/\bsystematic(?:ally)? (?:literature )?review(?:s|ed)?\b|\bumbrella review\b/gi, T_SYSREVIEW],
];

/** Non-English negated randomization, substring-replaced in the lowercased text. */
const INTL_NONRANDOM = [
  "no aleatorizado", "no aleatorizada", "no randomizado", "no randomizada",
  "não randomizado", "não randomizada", "não aleatorizado", "não aleatorizada",
  "non randomisé", "non randomisée", "non-randomisé", "non-randomisée",
  "nicht randomisiert", "nicht-randomisiert", "non randomizzato", "non randomizzata",
  "нерандомизированн", "非随机", "非ランダム化", "非無作為",
];

interface Cue {
  re: RegExp;
  w: number;
}

/** English cues per design, tested once per sentence. */
const CUES: Record<Design, Cue[]> = {
  "meta-analysis": [
    { re: /\bmeta-?analy(?:sis|ses|tic)\b/i, w: STRONG },
    { re: /\bpooled analysis\b/i, w: WEAK },
  ],
  "systematic-review": [
    { re: new RegExp(`\\b${T_SYSREVIEW}\\b`), w: STRONG },
    { re: new RegExp(`\\b${T_NO_META}\\b`), w: STRONG },
    { re: /\bPRISMA\b/, w: WEAK },
  ],
  "randomized-controlled-trial": [
    { re: /\brandomi[sz]ed\b[^.;]{0,50}?\btrials?\b/i, w: STRONG },
    { re: /\bRCTs?\b/, w: STRONG },
    { re: /\b(?:were|was|being) randomi[sz]ed\b|\brandomly (?:assigned|allocated)\b|\brandomi[sz]ed (?:to|into)\b/i, w: STRONG },
    { re: /\brandomi[sz]ed\b/i, w: WEAK },
    { re: /\bdouble[- ]blind(?:ed)?\b/i, w: WEAK },
    { re: /\bplacebo[- ]controlled\b/i, w: WEAK },
  ],
  "non-randomized-trial": [
    { re: new RegExp(`\\b${T_NONRANDOM}\\b`), w: STRONG },
    { re: /\bsingle[- ]arm\b/i, w: STRONG },
    { re: /\b(?:clinical|interventional|open[- ]label) (?:trial|study)\b/i, w: WEAK },
  ],
  cohort: [
    { re: /\b(?:prospective|retrospective|population-based|community-based|longitudinal|observational|birth) cohort\b/i, w: STRONG },
    { re: /\bcohort stud(?:y|ies)\b/i, w: STRONG },
    { re: /\bcohort\b/i, w: WEAK },
    { re: /\blongitudinal\b/i, w: WEAK },
    { re: /\b(?:pro|retro)spective(?:ly)?\b/i, w: WEAK },
    { re: /\bobservational stud(?:y|ies)\b/i, w: WEAK },
    { re: new RegExp(`\\b${T_CHART}\\b`), w: WEAK },
  ],
  "case-control": [
    { re: /\bcase[- ]control\b/i, w: STRONG },
    { re: /\bmatched controls?\b/i, w: WEAK },
  ],
  "cross-sectional": [
    { re: /\bcross[- ]sectional\b/i, w: STRONG },
    { re: /\bprevalence stud(?:y|ies)\b/i, w: STRONG },
    { re: /\bsurvey\b/i, w: WEAK },
  ],
  "case-report": [
    { re: /\bcase reports?\b|\bcase series\b|\bcase presentation\b/i, w: STRONG },
    { re: /\bwe (?:report|present|describe)\b[^.]{0,30}\b(?:case|patient|man|woman|boy|girl)\b/i, w: STRONG },
    { re: /\bcase stud(?:y|ies)\b/i, w: WEAK },
  ],
  review: [
    { re: /\b(?:(?:narrative|literature|scoping|critical|comprehensive|integrative|state-of-the-art) review|mini[- ]?review)\b/i, w: STRONG },
    { re: /\b(?:this|the present|our) review\b|\bwe review\b|\breview of (?:the )?literature\b/i, w: STRONG },
    { re: /\breview\b/i, w: WEAK },
  ],
  "animal-study": [
    {
      re: /\b(?:mice|mouse|murine|rats?|rodents?|zebrafish|drosophila|rabbits?|hamsters?|macaques?|piglets?|non-?human primates?|sprague[- ]dawley|wistar|C57BL|caenorhabditis|C\. elegans)\b/i,
      w: STRONG,
    },
    { re: /\banimal (?:models?|stud(?:y|ies)|experiments?)\b/i, w: STRONG },
  ],
  "in-vitro": [
    { re: /\bin vitro\b|\bcell lines?\b|\bcultured (?:[\w-]+ )?cells\b/i, w: STRONG },
    { re: /\borganoids?\b/i, w: WEAK },
  ],
};

/**
 * Sentences describing other work or future plans. Their design words describe
 * someone else's study ("unlike previous RCTs…", "further trials are needed"),
 * so they cast no vote. English only.
 */
const BACKGROUND_RES: RegExp[] = [
  /\b(?:previous(?:ly)?|prior(?!\s+to\b)|earlier|existing|past|published|other)\s+(?:[\w-]+\s+){0,3}(?:stud(?:y|ies)|trials?|RCTs|meta-?analys[ie]s|reviews?|research|reports?|evidence|literature|data)\b/i,
  /\b(?:has|have)\s+(?:(?:also|previously|consistently|repeatedly)\s+)?been\s+(?:shown|reported|demonstrated|suggested|found|documented|observed|associated)\b/i,
  /\b(?:further|future|additional|larger|more|well[- ]designed|high[- ]quality|long[- ]term|adequately powered|confirmatory|prospective)\s+(?:[\w-]+\s+){0,3}(?:stud(?:y|ies)|trials?|RCTs|research|investigations?)\s+(?:(?:are|is|will be|would be)\s+)?(?:needed|required|warranted|necessary)\b/i,
  /\b(?:are|is|remain)\s+(?:urgently\s+|still\s+)?(?:needed|required|warranted|lacking|scarce|limited)\b/i,
  /\bunlike\b|\bin contrast (?:to|with)\b|\bconsistent with\b|\bin line with\b|\bevidence from\b|\baccording to\b/i,
  /\bshould be (?:confirmed|tested|investigated|evaluated|explored|validated)\b/i,
  /\b(?:may|might|could)\s+(?:[\w-]+\s+){0,2}(?:benefit|help|be (?:useful|beneficial|promising)|represent|offer|serve|translate)\b/i,
];

/**
 * Study-type synonyms in the non-English languages of the supported databases,
 * substring-matched against the lowercased text. Non-PubMed adapters rarely
 * carry NLM-style PublicationType tags, so for those abstracts this is the only
 * classification signal. Kept as plain strings (not `\b`-anchored regexes)
 * because JS word boundaries are ASCII-only and break on Cyrillic/CJK.
 */
const MULTILINGUAL_TERMS: Record<Design, string[]> = {
  "meta-analysis": [
    "metaanálisis", "meta-análisis", "metanálise", "meta-análise", "méta-analyse", "metaanalyse",
    "metanalisi", "метаанализ", "мета-анализ", "荟萃分析", "元分析", "メタアナリシス", "メタ分析",
  ],
  "systematic-review": [
    "revisión sistemática", "revisão sistemática", "revue systématique", "systematische übersicht",
    "systematische übersichtsarbeit", "revisione sistematica", "систематический обзор", "系统评价",
    "系统综述", "システマティックレビュー", "システマティック・レビュー", T_SYSREVIEW, T_NO_META,
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
  "non-randomized-trial": [T_NONRANDOM, "brazo único", "braço único", "bras unique", "einarmig", "单臂", "単群"],
  "cross-sectional": [
    "estudio transversal", "estudo transversal", "étude transversale", "querschnittstudie", "querschnittsstudie",
    "studio trasversale", "одномоментн", "поперечное исследование", "横断面研究", "横断研究", "横断的研究",
  ],
  "in-vitro": [
    "in vitro", "línea celular", "líneas celulares", "linhagem celular", "linhagens celulares",
    "lignée cellulaire", "lignées cellulaires", "zelllinie", "linea cellulare", "linee cellulari",
    "клеточн", "细胞系", "细胞株", "細胞株", "培養細胞",
  ],
  "animal-study": [
    "murino", "murina", "roedores", "modelo animal", "ratones", "ratas",
    "camundongos", "ratos",
    "murin", "murine", "rongeurs", "modèle animal", "souris",
    "nagetiere", "tiermodell", "mäuse", "ratten",
    // "topi " / "мышей": bare "topi" hits "topical", bare "мыш" hits "мышцы" (muscle).
    "roditori", "modello animale", "topi ", "ratti",
    "мышин", "грызун", "животн модел", "крыс", "мышей", "мышах", "мыши ",
    "小鼠", "大鼠", "动物模型", "啮齿",
    "マウス", "ラット", "動物モデル", "げっ歯",
  ],
};

/** Non-English terms for these designs include generic words ("suivi", "обзор"), so they vote weakly. */
const INTL_WEAK: ReadonlySet<Design> = new Set(["cohort", "review"]);

interface TagRule {
  type: Design;
  /** More specific designs the abstract may refine this generic tag to, given a strong own-study cue. */
  refinable?: readonly Design[];
}

const TRIAL_TAG: TagRule = { type: "non-randomized-trial", refinable: ["randomized-controlled-trial"] };

/**
 * NLM PublicationType → design, most specific first (lowercased). Veterinary
 * tags precede their human counterparts. "Observational Study" never refines to
 * a trial: an EHR cohort whose abstract cites prior RCTs is still a cohort.
 */
const PUB_TYPE_RULES: [string, TagRule][] = [
  ["randomized controlled trial, veterinary", { type: "animal-study" }],
  ["clinical trial, veterinary", { type: "animal-study" }],
  ["observational study, veterinary", { type: "animal-study" }],
  ["meta-analysis", { type: "meta-analysis" }],
  ["systematic review", { type: "systematic-review", refinable: ["meta-analysis"] }],
  ["randomized controlled trial", { type: "randomized-controlled-trial" }],
  ["case reports", { type: "case-report" }],
  ["observational study", { type: "cohort", refinable: ["case-control", "cross-sectional"] }],
  ["controlled clinical trial", TRIAL_TAG],
  ["pragmatic clinical trial", TRIAL_TAG],
  ["equivalence trial", TRIAL_TAG],
  ["adaptive clinical trial", TRIAL_TAG],
  ["clinical trial, phase iv", TRIAL_TAG],
  ["clinical trial, phase iii", TRIAL_TAG],
  ["clinical trial, phase ii", TRIAL_TAG],
  ["clinical trial, phase i", TRIAL_TAG],
  ["clinical trial", TRIAL_TAG],
  ["scoping review", { type: "review" }],
  // NLM only tags "Systematic Review" since 2019; older ones are plain "Review".
  ["review", { type: "review", refinable: ["systematic-review", "meta-analysis"] }],
];

/**
 * Cues that the study itself enrolled people. Deliberately excludes bare
 * "human", which mostly describes material ("human cell lines").
 */
const HUMAN_SUBJECT_RE =
  /\b(?:patients?|adults?|men|women|participants?|volunteers?|subjects?|children|adolescents?|infants?|boys|girls|individuals|outpatients?|inpatients?|in humans)\b/i;

/** Human-subject cues in other languages, substring-matched (lowercased). */
const HUMAN_SUBJECT_INTL = [
  // es / pt
  "paciente", "adulto", "hombre", "mujer", "participante", "voluntario",
  "sujeto", "niño", "homem", "mulher", "voluntário", "criança", "indivíduo",
  // fr
  "adulte", "homme", "femme", "volontaire", "enfant",
  // de
  "erwachsene", "männer", "frauen", "teilnehmer", "proband", "kinder",
  // it
  "uomo", "donna", "partecipante", "bambino",
  // ru
  "человек", "пациент", "взросл", "мужчин", "женщин", "участник", "доброволец", "дети", "детей",
  // zh / ja
  "患者", "成人", "受试者", "志愿者", "儿童", "被験者", "参加者", "小児",
];

const PROTOCOL_TITLE_RE =
  /\b(?:study|trial|research|review) protocol\b|\bprotocol (?:for|of) (?:a|an|the)\b|protocolo (?:de|del|do) (?:estudo|estudio|ensayo|ensaio)|protocole d[’']étude|studienprotokoll|protocollo di studio|протокол исследования|研究方案/i;
const PROTOCOL_ABSTRACT_RE =
  /\b(?:this|the present|our) (?:study |trial |review )?protocol (?:describes|outlines|details|reports|presents)\b|\bwe (?:describe|present|report|outline) (?:the|a|our) (?:study |trial |review )?protocol\b|\bprotocol (?:paper|article|manuscript)\b/i;
const FUTURE_TENSE_RE =
  /\bwe will\b|\bwill be (?:randomi[sz]ed|recruited|enrolled|allocated|assigned|assessed|measured|collected|analy[sz]ed)\b/i;
const RETRACTED_TITLE_RE = /^\s*\[?(?:retracted|retraction(?: notice)?)\b/i;
/** CONSORT pilot extension 1a: pilots identify themselves in the title or as "this pilot …". */
const PILOT_RE = /\b(?:pilot|feasibility)\b[^.;]{0,40}?\b(?:stud(?:y|ies)|trials?|RCTs?)\b/i;
const OWN_PILOT_RE = /\b(?:this|our|the present) (?:[\w-]+ ){0,3}?(?:pilot|feasibility)\b/i;
const OBSERVATIONAL_INPUTS_RE =
  /\b(?:observational|cohort|case[- ]control|cross[- ]sectional|epidemiologic(?:al)?|population-based) (?:stud(?:y|ies)|data)\b|\bprospective (?:cohort )?studies\b/i;
const TRIAL_INPUTS_RE = new RegExp(`randomi[sz]ed|\\bRCTs?\\b|\\btrials?\\b|${T_NONRANDOM}`, "i");
const SECONDARY_ANALYSIS_RE = /\b(?:post[- ]hoc|secondary|exploratory|subgroup) analys[ie]s\b/i;

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
  /** Rating-down steps from the design's starting tier, most severe first. */
  scoreAdjustments?: ScoreAdjustment[];
  dosage?: string;
  population?: string;
  /** Structured breakdown of the tested population — see {@link PopulationDiversity}. */
  diversity?: PopulationDiversity;
  limitations?: string[];
}

function classifyByPublicationType(tags: ReadonlySet<string>): TagRule | null {
  for (const [tag, rule] of PUB_TYPE_RULES) {
    if (tags.has(tag)) return rule;
  }
  return null;
}

interface Sentence {
  text: string;
  lower: string;
  weight: number;
  /** False when the sentence is about other work or future plans. */
  own: boolean;
}

function rewrite(text: string): string {
  let out = text;
  for (const [re, token] of REWRITES) out = out.replace(re, ` ${token} `);
  return out;
}

function rewriteIntl(lower: string): string {
  let out = lower;
  for (const term of INTL_NONRANDOM) out = out.split(term).join(` ${T_NONRANDOM} `);
  return out;
}

function toSentences(title: string, abstract: string | undefined): Sentence[] {
  const out: Sentence[] = [];
  const t = rewrite(title);
  if (t.trim()) out.push({ text: t, lower: rewriteIntl(t.toLowerCase()), weight: TITLE_WEIGHT, own: true });
  if (!abstract) return out;
  for (const raw of rewrite(abstract).split(/(?<=[.!?])\s+|(?<=[。！？])|\n+/)) {
    const s = raw.trim();
    if (!s) continue;
    out.push({ text: s, lower: rewriteIntl(s.toLowerCase()), weight: 1, own: !BACKGROUND_RES.some((re) => re.test(s)) });
  }
  return out;
}

type Tally = Record<Design, { sum: number; strong: number }>;

function emptyTally(): Tally {
  const t = {} as Tally;
  for (const d of CONSERVATIVE_ORDER) t[d] = { sum: 0, strong: 0 };
  return t;
}

function tallyTotal(t: Tally): number {
  return CONSERVATIVE_ORDER.reduce((acc, d) => acc + t[d].sum, 0);
}

function tallyEnglish(sentences: Sentence[]): Tally {
  const t = emptyTally();
  for (const s of sentences) {
    if (!s.own) continue;
    for (const d of CONSERVATIVE_ORDER) {
      for (const cue of CUES[d]) {
        if (!cue.re.test(s.text)) continue;
        t[d].sum += cue.w * s.weight;
        if (cue.w === STRONG) t[d].strong += s.weight;
      }
    }
  }
  return t;
}

function tallyIntl(sentences: Sentence[]): Tally {
  const t = emptyTally();
  for (const s of sentences) {
    if (!s.own) continue;
    for (const d of CONSERVATIVE_ORDER) {
      const w = INTL_WEAK.has(d) ? WEAK : STRONG;
      for (const term of MULTILINGUAL_TERMS[d]) {
        if (!s.lower.includes(term)) continue;
        t[d].sum += w * s.weight;
        if (w === STRONG) t[d].strong += s.weight;
      }
    }
  }
  return t;
}

interface DesignPick {
  type: Design | null;
  best: number;
  runner: number;
}

function pickDesign(t: Tally, preclinicalOnly: boolean): DesignPick {
  // A declared synthesis names the designs it pooled; those don't define the article.
  // A case report "with review of the literature" is still a case report.
  const synthStrong = t["meta-analysis"].strong + t["systematic-review"].strong;
  const narrativeStrong = t.review.strong;
  if (synthStrong > 0 || (narrativeStrong > 0 && t["case-report"].strong === 0)) {
    const synth = t["meta-analysis"].sum + t["systematic-review"].sum;
    if (synthStrong > narrativeStrong) {
      const type = t["meta-analysis"].strong > 0 ? "meta-analysis" : "systematic-review";
      return { type, best: synth, runner: t.review.sum };
    }
    return { type: "review", best: t.review.sum, runner: synth };
  }

  // Animal/cell work with no human participants: a randomized mouse experiment is an animal study.
  if (preclinicalOnly) {
    const animal = t["animal-study"].sum;
    const cells = t["in-vitro"].sum;
    return { type: cells > animal ? "in-vitro" : "animal-study", best: animal + cells, runner: 0 };
  }

  // Strict `>` while walking weakest-first: ties stay with the lower tier.
  let pick: DesignPick = { type: null, best: 0, runner: 0 };
  for (const d of CONSERVATIVE_ORDER) {
    if (PRECLINICAL.has(d)) continue;
    const s = t[d].sum;
    if (s > pick.best) pick = { type: d, best: s, runner: pick.best };
    else if (s > pick.runner) pick.runner = s;
  }
  return pick;
}

/** Saturating in total cue weight, discounted when a rival design has comparable support. */
function keywordConfidence(best: number, runner: number): number {
  if (best <= 0) return 0.1;
  const base = 1 - Math.exp(-best);
  const dominance = best / (best + runner);
  return Math.min(KEYWORD_CONFIDENCE_CAP, base * (0.5 + 0.5 * dominance));
}

interface KeywordClassification {
  studyType: StudyType;
  confidence: number;
  tally: Tally;
  /** Animal / in-vitro cues with no human participants in the study's own sentences. */
  preclinicalOnly: boolean;
  preclinicalCues: boolean;
  /** Title + own-study sentences (preprocessed), for the rating-down checks. */
  ownText: string;
}

function classifyByKeywords(title: string, abstract: string | undefined): KeywordClassification {
  const sentences = toSentences(title, abstract);
  let tally = tallyEnglish(sentences);
  if (tallyTotal(tally) === 0) tally = tallyIntl(sentences);

  const own = sentences.filter((s) => s.own);
  const ownText = own.map((s) => s.text).join("\n");
  const human = HUMAN_SUBJECT_RE.test(ownText) || own.some((s) => HUMAN_SUBJECT_INTL.some((h) => s.lower.includes(h)));
  const preclinicalCues = tally["animal-study"].sum + tally["in-vitro"].sum > 0;
  const preclinicalOnly = preclinicalCues && !human;

  const pick = pickDesign(tally, preclinicalOnly);
  return {
    studyType: pick.type ?? "unknown",
    confidence: pick.type ? keywordConfidence(pick.best, pick.runner) : 0.1,
    tally,
    preclinicalOnly,
    preclinicalCues,
    ownText,
  };
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
      notes.push(`Single ancestry group reported (${d.ancestry}) — applicability to other groups untested.`);
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
  const tags = new Set(publicationTypes.map((p) => p.trim().toLowerCase()));

  const tagRule = classifyByPublicationType(tags);
  const kw = classifyByKeywords(title, abstract);

  let studyType: StudyType;
  let confidence: number;
  if (tagRule) {
    const kwType = kw.studyType === "unknown" ? null : kw.studyType;
    const refine = kwType != null && tagRule.refinable?.includes(kwType) === true && kw.tally[kwType].strong > 0;
    if (refine) {
      studyType = kwType;
      confidence = 0.8;
    } else {
      studyType = tagRule.type;
      confidence = kw.studyType === tagRule.type ? 0.95 : 0.85;
    }
  } else {
    studyType = kw.studyType;
    confidence = kw.confidence;
  }

  const extracted = extract(text);
  const limitations = [...(extracted.limitations ?? [])];
  const note = (l: string): void => {
    if (!limitations.includes(l)) limitations.push(l);
  };

  // Rating down only; each step is recorded so the final score is auditable.
  let score = SCORE_BY_TYPE[studyType];
  const adjustments: ScoreAdjustment[] = [];
  const rateDownTo = (target: number, reason: string): void => {
    const next = Math.max(0, Math.min(score, target));
    if (next < score) {
      adjustments.push({ delta: next - score, reason });
      score = next;
    }
  };

  if (tags.has("retracted publication") || tags.has("retraction of publication") || RETRACTED_TITLE_RE.test(title)) {
    rateDownTo(0, "Retracted — findings are withdrawn and must not be used as evidence.");
  }

  const protocol =
    tags.has("clinical trial protocol") || PROTOCOL_TITLE_RE.test(title) || PROTOCOL_ABSTRACT_RE.test(abstract ?? "");
  if (protocol) {
    rateDownTo(0, "Study protocol — describes planned research and reports no results.");
    note("Reads as a study protocol, not a completed study.");
  } else if (FUTURE_TENSE_RE.test(text)) {
    note("Future-tense wording suggests a protocol/plan, not results.");
  }
  if (protocol || FUTURE_TENSE_RE.test(text)) confidence /= 2;

  if (tags.has("editorial") || tags.has("comment")) {
    rateDownTo(0, "Editorial/commentary — discusses other research and is not itself evidence.");
  }
  if (tags.has("letter")) note("Published as a letter — may be correspondence about another study; check before citing.");
  if (tags.has("preprint")) note("Preprint — not yet peer reviewed.");

  const synthesis = studyType === "meta-analysis" || studyType === "systematic-review";
  if (synthesis && kw.preclinicalOnly) {
    rateDownTo(0, "Synthesis of animal or in-vitro studies — preclinical evidence, not directly applicable to humans.");
  } else if (synthesis && OBSERVATIONAL_INPUTS_RE.test(kw.ownText) && !TRIAL_INPUTS_RE.test(kw.ownText)) {
    rateDownTo(score - 1, "Synthesis of observational studies only — GRADE starts such evidence at low certainty.");
  }

  const primaryTrialOrCohort =
    studyType === "randomized-controlled-trial" || studyType === "non-randomized-trial" || studyType === "cohort";
  if (primaryTrialOrCohort && (PILOT_RE.test(rewrite(title)) || OWN_PILOT_RE.test(kw.ownText))) {
    rateDownTo(score - 1, "Pilot/feasibility study — not powered to estimate efficacy.");
  }

  if (studyType === "randomized-controlled-trial" && SECONDARY_ANALYSIS_RE.test(kw.ownText)) {
    note("Secondary/post-hoc analysis — exploratory; the comparison may not be protected by randomization.");
  }
  if (kw.preclinicalCues && !kw.preclinicalOnly && !PRECLINICAL.has(studyType) && !synthesis) {
    note("Also mentions animal or in-vitro work — confirm which results come from human participants.");
  }

  // Title-only grade (no abstract) is inherently less certain.
  if (!abstract) {
    confidence = Math.min(confidence, 0.5);
    note("Graded from title only — no abstract available.");
  }

  if (studyType === "unknown") {
    note("Study design could not be determined — a score of 0 here means unclassified, not weak evidence.");
    if (language && language.toLowerCase() !== "en" && abstract) {
      note(`Abstract is not in English (${language}); study type could not be classified from keywords.`);
    }
  }

  const result: GradeResult = {
    studyType,
    evidenceScore: score,
    confidence: Math.max(0, Math.min(1, Number(confidence.toFixed(3)))),
  };
  if (adjustments.length > 0) result.scoreAdjustments = adjustments;
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
    ...(grade.scoreAdjustments ? { scoreAdjustments: grade.scoreAdjustments } : {}),
    ...(grade.dosage ? { dosage: grade.dosage } : {}),
    ...(grade.population ? { population: grade.population } : {}),
    ...(grade.diversity ? { diversity: grade.diversity } : {}),
    ...(grade.limitations ? { limitations: grade.limitations } : {}),
  };
}

/** Surfaced when a score filter silently removes articles whose design is merely unknown. */
export function unclassifiedDroppedWarning(count: number): string {
  return (
    `${count} result(s) with an undetermined study design were dropped by minEvidenceScore — ` +
    `their score of 0 means "unclassified", not "weak evidence" (common for non-English abstracts).`
  );
}
