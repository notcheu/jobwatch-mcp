/**
 * A static (rule-based, no model) way to shorten a job description. A description is 3 to 6 thousand characters, most of it the
 * company's pitch, benefits and legal notices; what a reader needs to decide is the role and the requirements. The text is cut
 * into sections by recognising headings (English and French), and the summary keeps the start of the role and requirements
 * sections. The full text is always stored, so anything left out can be read later, whole or one part at a time.
 */

export const PARTS = ['role', 'requirements', 'nice_to_have', 'offer', 'about', 'process', 'legal', 'intro', 'other'] as const;
export type Part = (typeof PARTS)[number];

export interface Section {
  part: Part;
  /** The heading line, or '' for the text before the first heading. */
  heading: string;
  /** The body, bullets as `- ` lines. */
  text: string;
}

const NAME = String.raw`[A-Za-z0-9 .&'’-]{2,40}`;
/** Headings, English first, then French, German and Spanish. The first pattern that matches a heading line wins, so order matters. */
const PATTERNS: readonly [Exclude<Part, 'intro' | 'other'>, RegExp][] = [
  [
    'legal',
    /(equal[- ]opportunit|diversity|inclusion|discriminat|recruitment fraud|notice for candidates|privacy|data protection|rgpd|gdpr|reasonable accommodation|handicap|flexible workplace|egalit|égalit|chancengleichheit|igualdad)/i,
  ],
  [
    'nice_to_have',
    /^(nice[- ]to[- ]have|nice to haves|bonus( points)?|a plus|preferred( qualifications| skills)?|(it['’]?s )?a plus|atouts?|serait un plus|apprécié|von vorteil|wünschenswert|se valorará|deseable)\b/i,
  ],
  [
    'process',
    /^((the )?(hiring|recruitment|interview|application|selection) process|how to apply|ready to apply|apply now|processus de (recrutement|sélection)|étapes|comment postuler|postuler|bewerbungsprozess|so läuft|proceso de selección)\b/i,
  ],
  [
    'offer',
    /^(benefits|perks|what we offer|we offer|what['’]?s in it for you|why (join|work)|compensation|salary|pay range|on-target earnings|our benefits|rémunération|avantages|ce que nous (offrons|proposons)|nous (offrons|proposons)|conditions|package|das bieten wir|wir bieten|deine vorteile|unsere benefits|lo que ofrecemos|qué ofrecemos)\b/i,
  ],
  [
    'requirements',
    /^(requirements?|qualifications?|(what|who) (we['’]?re|we are) looking for|who you are|you might be a fit|you may be a fit|you['’]?ll (bring|have)|you (have|bring)|your (profile|background|skills|experience)|(minimum|basic|required|key) (qualifications|requirements|skills)|must[- ]haves?|required( skills)?|skills( (&|and) experience)?|experience|profil( recherché)?|votre profil|le profil|vous (avez|êtes)|compétences|ce que nous recherchons|expérience (requise|souhaitée)|prérequis|savoir-faire|savoir-être|(dein|ihr|euer) profil|was du mitbringst|das bringst du mit|du bringst mit|anforderungen|qualifikationen|(tu|su) perfil|requisitos|qu[eé] (buscamos|necesitas)|lo que buscamos)\b/i,
  ],
  [
    'role',
    /^((the|your|this) (role|job|position|opportunity|mission|missions|impact|responsibilities)|about the (role|job|position|opportunity|team)|job (description|summary|overview)|role (overview|description|summary)|position (summary|overview)|what you['’]?ll (do|work on|be doing|own)|what you will (do|work on|be doing)|(key )?responsibilities|your day[- ]to[- ]day|day[- ]to[- ]day|(le|descriptif du|description du) poste|(vos|votre|la|les) (missions?|responsabilités|rôle)|missions?|ce que vous ferez|au quotidien|vous serez (en charge|chargé)|en tant que|le rôle|descriptif|(deine|ihre|eure) (aufgaben|verantwortung|rolle)|aufgaben|das erwartet (dich|sie|euch)|was dich erwartet|was du (bei uns )?(machst|tust)|(tus|sus) (funciones|responsabilidades|tareas)|lo que (har[aá]s|hará)|el (puesto|rol)|funciones)\b/i,
  ],
  [
    'about',
    new RegExp(
      String.raw`^(about (us|the company|${NAME})|who we are|our (mission|story|company|values|culture|vision)|company (overview|description|culture)|qui sommes[- ]nous|über uns|wer wir sind|unser (unternehmen|team)|quiénes somos|conócenos|sobre nosotros|à propos|notre (mission|entreprise|histoire|vision|culture)|l['’]entreprise|le groupe|présentation|descriptif de l['’]entreprise|join ${NAME}|why ${NAME}|${NAME} in a nutshell)\b`,
      'i',
    ),
  ],
];

const MAX_HEADING = 80;

/** Is this line a heading, and of what? Short, not a bullet, not a sentence. */
function classify(line: string): Part | null {
  const text = line
    .replace(/^#+\s*/, '')
    .replace(/[:：]\s*$/, '')
    .trim();
  if (text.length < 3 || text.length > MAX_HEADING || /^[-•*]\s/.test(line)) return null;
  if (/[.!?]$/.test(text) && !/\?$/.test(text)) return null;
  if (text.split(/\s+/).length > 12) return null;
  for (const [part, pattern] of PATTERNS) if (pattern.test(text)) return part;
  return null;
}

/** Cut a description into sections at the headings it recognises. Text before the first heading is `intro`. */
export function splitSections(description: string): Section[] {
  const sections: Section[] = [];
  let current: { part: Part; heading: string; lines: string[] } = { part: 'intro', heading: '', lines: [] };
  const close = (): void => {
    const text = current.lines.join('\n').trim();
    if (text !== '' || current.heading !== '') sections.push({ part: current.part, heading: current.heading, text });
  };
  for (const raw of description.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      current.lines.push('');
      continue;
    }
    const part = classify(line);
    if (part !== null) {
      close();
      current = { part, heading: line.replace(/[:：]\s*$/, ''), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  close();
  return sections;
}

/** Bullets and paragraphs on one line: `a; b; c` for a list, spaces between sentences. */
function flatten(text: string): string {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const item = /^[-•*]\s+(.*)$/.exec(line);
    out.push(item?.[1] !== undefined ? `${item[1].replace(/[.;]\s*$/, '')};` : line);
  }
  return out.join(' ').replace(/\s+/g, ' ').replace(/;\s*$/, '').trim();
}

/** Where the role usually starts in a text with no headings, in English, French, German, Spanish. */
const ROLE_PHRASES =
  /\b(you will|you['’]ll|your (role|mission|responsibilities)|in this role|we are looking for|we['’]re looking for|the (ideal )?candidate|vous serez|vous allez|vos missions|nous recherchons|nous cherchons|tu seras|du wirst|deine aufgaben|serás|tu misión|buscamos)\b/i;
/** "As a Product Manager," / "Als Account Executive (x/f/m)": the capital letter keeps "as a result" out. */
const ROLE_AS_A = /\b(?:[Aa]s an? |[Aa]ls |[Ee]n tant que |[Cc]omo )[A-Z][\w/ -]{2,40}(?:\(|[,.])/;

/** The position where the role seems to start in a text with no headings, or -1. */
function roleStart(text: string): number {
  const found = [ROLE_PHRASES.exec(text)?.index, ROLE_AS_A.exec(text)?.index].filter((index): index is number => index !== undefined);
  return found.length === 0 ? -1 : Math.min(...found);
}

/** The first `max` characters of `text`, cut at a sentence, a list item or a word, with an ellipsis. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('; '), head.lastIndexOf(' '));
  return `${head.slice(0, cut > max * 0.5 ? cut : max).replace(/[\s,;:]+$/, '')}…`;
}

export interface JobSummary {
  /** A few hundred characters: the start of the role and of the requirements. */
  summary: string;
  /**
   * `sections`: built from the role and requirements sections it found. `excerpt`: no usable headings, so it is only the start of
   * the text after the company's pitch, and may miss the point: read the full text when it matters.
   */
  kind: 'sections' | 'excerpt';
  /** The parts found and their size, so a reader can ask for one of them. */
  outline: { part: Part; chars: number }[];
}

/**
 * The summary: `Role: ... Requirements: ...` when those sections are found, else the start of the text after the company's pitch.
 * `maxChars` is the target size of the summary (200 to 2000).
 */
export function summarizeJob(description: string, maxChars = 700): JobSummary {
  const max = Math.min(2000, Math.max(200, Math.floor(maxChars)));
  const sections = splitSections(description);
  const outline = sections.map((section) => ({ part: section.part, chars: section.text.length })).filter((entry) => entry.chars > 0);
  const firstOf = (part: Part): Section | undefined => sections.find((section) => section.part === part && section.text !== '');
  const role = firstOf('role');
  const requirements = firstOf('requirements');
  const pieces: string[] = [];
  if (role !== undefined && requirements !== undefined) {
    pieces.push(`Role: ${clip(flatten(role.text), Math.floor(max * 0.5))}`);
    pieces.push(`Requirements: ${clip(flatten(requirements.text), Math.floor(max * 0.5) - 20)}`);
  } else if (role !== undefined) {
    pieces.push(`Role: ${clip(flatten(role.text), max - 10)}`);
  } else if (requirements !== undefined) {
    pieces.push(`Requirements: ${clip(flatten(requirements.text), max - 20)}`);
  } else {
    // no usable headings: skip the leading sections that are the company's pitch or a legal notice, and take what follows
    const body = sections.filter(
      (section) => section.part !== 'about' && section.part !== 'legal' && section.part !== 'offer' && section.part !== 'process',
    );
    const text = flatten((body.length > 0 ? body : sections).map((section) => section.text).join('\n'));
    // skip ahead to where the role seems to start, when that is not the very beginning and leaves enough text
    const cue = roleStart(text);
    const start = cue > 0 && text.length - cue >= max * 0.5 ? cue : 0;
    pieces.push(clip(text.slice(start), max));
  }
  const kind = role !== undefined || requirements !== undefined ? 'sections' : 'excerpt';
  return { summary: pieces.join(' '), kind, outline };
}

/** The text of the given parts (all sections of those kinds, in order), each under its heading. */
export function partsOf(description: string, wanted: readonly Part[]): string {
  return splitSections(description)
    .filter((section) => wanted.includes(section.part) && section.text !== '')
    .map((section) => (section.heading === '' ? section.text : `${section.heading}\n${section.text}`))
    .join('\n\n');
}

// ---------------------------------------------------------------------------------------------- what a tool returns

/** How much of a job's text a tool returns: a short `summary` (default), the `full` text (cut at a limit), or `none`. */
export const DETAILS = ['summary', 'full', 'none'] as const;
export type Detail = (typeof DETAILS)[number];

export interface DescriptionFields {
  /** The summary, when `detail` is `summary`; else ''. */
  summary: string;
  /** `sections` when built from the role and requirements; `excerpt` when it is only a guess; null when there is no summary. */
  summary_kind: 'sections' | 'excerpt' | null;
  /** The text, when `detail` is `full` (cut at `maxChars`); else ''. */
  description: string;
  description_truncated: boolean;
  /** Length of the whole stored description, so a reader knows what it is leaving out. */
  description_chars: number;
}

/** The text fields of a returned job for the requested level of detail. The stored description is never shortened. */
export function describeJob(description: string, detail: Detail, maxChars: number): DescriptionFields {
  const whole = description.length;
  if (detail === 'full') {
    const text = description.slice(0, maxChars);
    return { summary: '', summary_kind: null, description: text, description_truncated: whole > text.length, description_chars: whole };
  }
  if (detail === 'summary') {
    const { summary, kind } = summarizeJob(description);
    return { summary, summary_kind: kind, description: '', description_truncated: false, description_chars: whole };
  }
  return { summary: '', summary_kind: null, description: '', description_truncated: false, description_chars: whole };
}
