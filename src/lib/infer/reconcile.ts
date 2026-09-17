/**
 * Deciding that "Invoice No.", "Inv. Number", "INVOICE NUMBER" and "Reference" are one
 * field.
 *
 * This is the problem that makes a generic document tool hard. Fix the domain to invoices
 * and you can ship a list of known field names; accept an arbitrary pile and you have to
 * work out which labels mean the same thing, across vendors who agree on nothing.
 *
 * Four of those five names collapse on string similarity once you normalise
 * abbreviations. "Reference" and "Raised on" do not — they share no words with anything —
 * and those are the interesting cases, because they are also the ones a human recognises
 * instantly. The signals that catch them:
 *
 *   - **Mutual exclusivity.** Two labels that appear together in a single document are
 *     definitely different fields. This is the one hard constraint in the system, and it
 *     is what stops Subtotal, Tax and Total collapsing into each other despite being
 *     three amounts in the same corner of the same page.
 *   - **Value shape.** Every invoice number is `A+-9+-9+` whatever it is called.
 *   - **Position.** The same field lands in roughly the same place across layouts, because
 *     invoices are designed by people who have all seen invoices.
 *   - **Ordinal rank among same-typed fields.** The first of three amounts on a page plays
 *     the same role as the first of three amounts on a different vendor's page.
 *
 * Nothing here is a word list. A word list would work on this corpus and stop working the
 * moment a document arrived in a language I had not thought of, and the point of the
 * exercise is the method rather than the answers.
 */

import type { FieldCandidate } from './fields';
import { shapeOf, type ValueType } from './value';

export type LabelStats = {
  label: string;
  /** Number of documents this label was seen in. */
  documents: number;
  type: ValueType;
  /** Distinct value shapes, most common first. */
  shapes: string[];
  /** Mean position on the page, normalised to 0–1 so page size does not matter. */
  position: { x: number; y: number };
  /** Rank of this field among same-typed fields in its document, averaged. */
  rank: number;
  samples: string[];
};

export type ReconciledField = {
  id: string;
  /** The name shown to the user: the clearest of the labels that merged into it. */
  name: string;
  aliases: string[];
  type: ValueType;
  /** Fraction of documents in the cluster that carry this field. */
  coverage: number;
  samples: string[];
  /** Why these labels were merged, in the user's words. Shown on demand in the UI. */
  rationale: string[];
};

// ---------------------------------------------------------------------------
// Label normalisation
// ---------------------------------------------------------------------------

/**
 * Abbreviations that carry real information, kept deliberately small.
 *
 * The temptation is to keep adding entries until the corpus passes, at which point the
 * list *is* the algorithm and it stops working on documents nobody anticipated. These are
 * only the generic clippings any English form uses; nothing domain-specific, no invoice
 * vocabulary.
 */
const ABBREVIATIONS: Record<string, string> = {
  no: 'number', num: 'number', nbr: 'number', '#': 'number',
  inv: 'invoice', ref: 'reference', qty: 'quantity', amt: 'amount',
  desc: 'description', dt: 'date', acct: 'account', ac: 'account',
};

const STOPWORDS = new Set(['the', 'of', 'a', 'to', 'for', 'and', 'on', 'by', 'in', 'at']);

export function normaliseLabelTokens(label: string): string[] {
  return label
    .toLowerCase()
    // Drop anything parenthesised or percentage-like: "VAT @ 20%" and "GST (18%)" are the
    // same field with the rate baked into the label, and the rate is not part of the name.
    .replace(/\([^)]*\)/g, ' ')
    .replace(/@?\s*\d+(\.\d+)?\s*%/g, ' ')
    .replace(/[^a-z0-9#]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ABBREVIATIONS[t] ?? t)
    .filter((t) => !STOPWORDS.has(t));
}

/** Jaccard over normalised tokens, with a bonus when one label contains the other. */
export function labelSimilarity(a: string, b: string): number {
  const ta = new Set(normaliseLabelTokens(a));
  const tb = new Set(normaliseLabelTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;

  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const jaccard = shared / (ta.size + tb.size - shared);

  // "Invoice" and "Invoice Number" are the same field written with different precision;
  // plain Jaccard scores that 0.5, which is not enough on its own.
  const contained = shared === Math.min(ta.size, tb.size) ? 0.25 : 0;
  return Math.min(1, jaccard + contained);
}

// ---------------------------------------------------------------------------
// Gathering evidence
// ---------------------------------------------------------------------------

export type DocumentObservation = {
  docId: string;
  fields: FieldCandidate[];
  pageWidth: number;
  pageHeight: number;
};

export function collectLabelStats(docs: DocumentObservation[]): Map<string, LabelStats> {
  const stats = new Map<string, LabelStats>();

  for (const doc of docs) {
    // Rank fields of each type by reading order, so "the first of three amounts" is
    // comparable between vendors whose amounts sit at different coordinates.
    const byType = new Map<ValueType, FieldCandidate[]>();
    for (const f of [...doc.fields].sort((a, b) => a.valueBox.y - b.valueBox.y || a.valueBox.x - b.valueBox.x)) {
      (byType.get(f.type) ?? byType.set(f.type, []).get(f.type)!).push(f);
    }

    for (const [, group] of byType) {
      group.forEach((f, rank) => {
        const existing = stats.get(f.label);
        const px = f.valueBox.x / Math.max(1, doc.pageWidth);
        const py = f.valueBox.y / Math.max(1, doc.pageHeight);

        if (!existing) {
          stats.set(f.label, {
            label: f.label,
            documents: 1,
            type: f.type,
            shapes: [shapeOf(f.value)],
            position: { x: px, y: py },
            rank,
            samples: [f.value],
          });
        } else {
          const n = existing.documents;
          existing.documents = n + 1;
          existing.position = {
            x: (existing.position.x * n + px) / (n + 1),
            y: (existing.position.y * n + py) / (n + 1),
          };
          existing.rank = (existing.rank * n + rank) / (n + 1);
          if (!existing.shapes.includes(shapeOf(f.value))) existing.shapes.push(shapeOf(f.value));
          if (existing.samples.length < 6) existing.samples.push(f.value);
        }
      });
    }
  }

  return stats;
}

/** Labels that were ever seen together in one document, and therefore cannot be the same field. */
export function collectCooccurrence(docs: DocumentObservation[]): Map<string, Set<string>> {
  const co = new Map<string, Set<string>>();
  for (const doc of docs) {
    const labels = [...new Set(doc.fields.map((f) => f.label))];
    for (const a of labels) {
      const set = co.get(a) ?? co.set(a, new Set()).get(a)!;
      for (const b of labels) if (a !== b) set.add(b);
    }
  }
  return co;
}

// ---------------------------------------------------------------------------
// Scoring and merging
// ---------------------------------------------------------------------------

export type MergeEvidence = {
  score: number;
  reasons: string[];
  blocked: boolean;
};

export function scoreMerge(a: LabelStats, b: LabelStats, cooccur: Map<string, Set<string>>): MergeEvidence {
  const reasons: string[] = [];

  // The hard constraint. If a single document contains both labels, they are two fields,
  // and no amount of similarity elsewhere can outweigh that — it is direct evidence
  // rather than a signal.
  if (cooccur.get(a.label)?.has(b.label)) {
    return {
      score: 0,
      blocked: true,
      reasons: [`"${a.label}" and "${b.label}" appear together on the same document, so they are different fields`],
    };
  }

  // Different types is a near-certain no. A date and an amount are not the same field
  // however similarly they are named.
  const sameType = a.type === b.type;
  if (!sameType) {
    const compatible =
      (a.type === 'identifier' && b.type === 'text') || (a.type === 'text' && b.type === 'identifier') ||
      (a.type === 'money' && b.type === 'number') || (a.type === 'number' && b.type === 'money');
    if (!compatible) return { score: 0, blocked: false, reasons: ['their values are different kinds of thing'] };
  }

  let score = 0;
  let signals = 0;

  // --- names ---------------------------------------------------------------
  // The gate is deliberately low. "Payment Due" and "Due Date" share exactly one token
  // out of three, which scores 0.33 — weak on its own, and decisive when it lines up with
  // everything else. Demanding a majority overlap throws away the partial agreement that
  // is the normal case between vendors.
  const nameScore = labelSimilarity(a.label, b.label);
  if (nameScore > 0.15) {
    score += nameScore * 0.45;
    signals++;
    reasons.push(
      nameScore > 0.6
        ? 'the names mean the same thing once abbreviations are expanded'
        : 'the names share a word',
    );
  }

  // --- values --------------------------------------------------------------
  // Shape is the right signal for identifiers, where the format *is* the meaning: every
  // invoice number is A+-9+-9+ whatever it is called.
  //
  // It is the wrong signal for dates and amounts, where the rendering is a vendor's house
  // style and carries no information about which field this is. "Feb 09, 2026" and
  // "04/04/2026" are the same kind of thing written two ways, and requiring identical
  // shapes means no date field ever reconciles across vendors. For those, agreeing on the
  // type after parsing is the real evidence — which is precisely the point of parsing
  // into a canonical form before comparing.
  const formatIsMeaningful = a.type === 'identifier' || a.type === 'text';
  if (formatIsMeaningful) {
    if (a.shapes.some((sh) => b.shapes.includes(sh))) {
      score += 0.18;
      signals++;
      reasons.push(`the values have the same shape (${a.shapes[0]})`);
    }
  } else if (sameType) {
    score += 0.12;
    signals++;
    reasons.push(`both hold ${a.type === 'money' ? 'amounts' : `${a.type} values`}, written differently`);
  }

  if (sameType) score += 0.12;

  // --- role ----------------------------------------------------------------
  // The strongest signal for synonyms that share no words at all. Across five vendors who
  // agree on nothing, "the second date on the page" is the same field every time — because
  // an invoice is issued before it falls due, and that ordering is a fact about invoices
  // rather than about any vendor's template.
  const rankGap = Math.abs(a.rank - b.rank);
  if (rankGap < 0.25) {
    score += 0.3;
    signals++;
    reasons.push(`each is the ${ordinal(Math.round(a.rank) + 1)} ${a.type} field on its document`);
  } else if (rankGap < 0.75) {
    score += 0.18;
    signals++;
    reasons.push(`they play a similar role among the ${a.type} fields on their documents`);
  }

  // --- position ------------------------------------------------------------
  // Weakest of the four, and deliberately so. It agrees when two vendors happen to use a
  // similar template and disagrees when one of them uses two columns — which says more
  // about the template than about the field.
  const dx = Math.abs(a.position.x - b.position.x);
  const dy = Math.abs(a.position.y - b.position.y);
  const positional = Math.max(0, 1 - (dx * 1.6 + dy) / 0.5);
  if (positional > 0.3) {
    score += positional * 0.15;
    signals++;
    reasons.push('they sit in the same part of the page across layouts');
  }

  // One signal is a coincidence. Position alone would merge every text field in the
  // top-left corner of every document in the pile.
  if (signals < 2) return { score: 0, blocked: false, reasons: ['not enough agreement to be sure'] };

  return { score: Math.min(1, score), blocked: false, reasons };
}

const ordinal = (n: number) =>
  n === 1 ? 'first' : n === 2 ? 'second' : n === 3 ? 'third' : `${n}th`;

/**
 * Merge labels into fields.
 *
 * Union-find over pairs that score above the threshold, with one important restriction:
 * a merge is refused if it would join two labels that *do* co-occur somewhere. Without
 * that check, transitivity defeats the hard constraint — A merges with B, B merges with
 * C, and A and C end up in one field even though a document contains both. That is how
 * Subtotal and Total quietly become the same column, and the failure is silent.
 */
export function reconcileFields(
  docs: DocumentObservation[],
  threshold = 0.55,
): { fields: ReconciledField[]; evidence: Map<string, MergeEvidence> } {
  const stats = collectLabelStats(docs);
  const cooccur = collectCooccurrence(docs);
  const labels = [...stats.keys()];

  const parent = new Map<string, string>(labels.map((l) => [l, l]));
  const find = (x: string): string => {
    const p = parent.get(x)!;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const groupMembers = (root: string) => labels.filter((l) => find(l) === root);

  const evidence = new Map<string, MergeEvidence>();
  const pairs: { a: string; b: string; ev: MergeEvidence }[] = [];

  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const ev = scoreMerge(stats.get(labels[i]!)!, stats.get(labels[j]!)!, cooccur);
      evidence.set(`${labels[i]}|${labels[j]}`, ev);
      if (!ev.blocked && ev.score >= threshold) pairs.push({ a: labels[i]!, b: labels[j]!, ev });
    }
  }

  // Strongest evidence first, so a confident merge is never pre-empted by a marginal one.
  pairs.sort((x, y) => y.ev.score - x.ev.score);

  for (const { a, b } of pairs) {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) continue;

    // Transitivity check: would this union put two co-occurring labels in one field?
    const left = groupMembers(ra);
    const rightMembers = groupMembers(rb);
    const conflict = left.some((l) => rightMembers.some((r) => cooccur.get(l)?.has(r)));
    if (conflict) continue;

    parent.set(ra, rb);
  }

  const groups = new Map<string, string[]>();
  for (const label of labels) {
    const root = find(label);
    (groups.get(root) ?? groups.set(root, []).get(root)!).push(label);
  }

  const fields: ReconciledField[] = [];
  for (const [root, members] of groups) {
    const memberStats = members.map((m) => stats.get(m)!);
    const documents = memberStats.reduce((n, s) => n + s.documents, 0);
    const name = chooseName(memberStats);

    const rationale: string[] = [];
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const ev = evidence.get(`${members[i]}|${members[j]}`) ?? evidence.get(`${members[j]}|${members[i]}`);
        if (ev && ev.reasons.length) rationale.push(`"${members[i]}" ≡ "${members[j]}": ${ev.reasons.join('; ')}`);
      }
    }

    fields.push({
      id: root,
      name,
      aliases: members.filter((m) => m !== name),
      type: memberStats[0]!.type,
      coverage: Math.min(1, documents / Math.max(1, docs.length)),
      samples: memberStats.flatMap((s) => s.samples).slice(0, 6),
      rationale,
    });
  }

  return { fields: fields.sort((a, b) => b.coverage - a.coverage), evidence };
}

/**
 * Pick the clearest of the merged labels to show the user.
 *
 * Prefer the one that survives normalisation with the most information and the least
 * shouting: "Invoice Number" over "INVOICE NUMBER" over "Inv. Number" over "Invoice #".
 * Entirely cosmetic, and it is the difference between a schema someone trusts and one
 * that looks like it was scraped.
 */
function chooseName(stats: LabelStats[]): string {
  return [...stats]
    .sort((a, b) => {
      const tokens = normaliseLabelTokens(b.label).length - normaliseLabelTokens(a.label).length;
      if (tokens !== 0) return tokens;
      const shouty = (s: string) => (s === s.toUpperCase() ? 1 : 0);
      if (shouty(a.label) !== shouty(b.label)) return shouty(a.label) - shouty(b.label);
      const abbreviated = (s: string) => (/\./.test(s) || /#/.test(s) ? 1 : 0);
      if (abbreviated(a.label) !== abbreviated(b.label)) return abbreviated(a.label) - abbreviated(b.label);
      return b.documents - a.documents;
    })[0]!.label;
}
