/**
 * The signals test: the same deck the study tool uses, taken at a station.
 *
 * The cards are `seeds/private/signal-flashcards.json` copied into `decks/`,
 * the **cror-live** edition — the one whose indications carry the full wording
 * a qualification is written against, rather than the trimmed public edition.
 * That choice matters if this app is ever published; see the note in the repo's
 * memory about the provenance split. Nothing here modifies the deck.
 *
 * ── Why it is drawn rather than pictured ──
 *
 * Each card's front is a set of **arguments** — mast, alignment, the sequence of
 * lamp colours top to bottom, and any plates — not an image. So the signal is
 * drawn here from those arguments, in about sixty lines of canvas, and the deck
 * stays a text file that diffs. It is the same bargain the terrain makes.
 *
 * Grading is by hand and deliberately so. These are rote cards with long prose
 * answers; a string comparison would mark "proceed at medium speed" wrong
 * against "Proceed at MEDIUM speed" and teach nothing. You look, you say it out
 * loud, you turn it over, you say whether you had it.
 */

export interface SignalCard {
  id: number;
  rule: string;
  name: string;
  form: string;
  front: {
    mast: 'high' | 'low';
    alignment: 'inline' | 'staggered';
    /** Lamp colours top to bottom. 'flashing …' is a state, not a colour. */
    colorSequence: string[];
    plates: string[];
    label: string;
    rule: string;
  };
  back: string;
}

export interface Deck {
  deck: string;
  edition: string;
  count: number;
  cards: SignalCard[];
}

const LAMP: Record<string, string> = {
  red: '#e2483d',
  yellow: '#e8c33a',
  green: '#3fbf6a',
  a: '#8a8f96',
};

/** Whether a lamp is lit, dark, or one of the flashing ones. */
function lampColour(entry: string): { color: string; flashing: boolean } {
  const flashing = entry.startsWith('flashing');
  const base = flashing ? entry.slice('flashing'.length).trim() : entry;
  return { color: LAMP[base] ?? '#8a8f96', flashing };
}

/**
 * Draw one signal from a card's front.
 *
 * `time` drives the flashing lamps; pass a running clock and they blink. Two
 * heads on a staggered mast are offset laterally, which is the whole visual
 * difference between a staggered aspect and an inline one and is exactly what
 * the card is testing.
 */
export function drawSignalCard(
  ctx: CanvasRenderingContext2D,
  card: SignalCard,
  time: number,
): void {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);

  const lamps = card.front.colorSequence;
  const staggered = card.front.alignment === 'staggered';
  const r = 15;
  const gap = r * 2.9;
  const cx = width / 2;
  // The whole assembly is centred vertically, hanging under the mast top.
  const stack = (lamps.length - 1) * gap;
  const top = height / 2 - stack / 2 - 30;

  // The mast. A low signal sits on a short post at ground level; a high one on
  // a tall one — and telling those apart is half of what the cards ask.
  const groundY = height - 26;
  const mastTop = top - 26;
  ctx.strokeStyle = '#8a8f96';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(cx, groundY);
  ctx.lineTo(cx, card.front.mast === 'high' ? mastTop : Math.max(mastTop, groundY - 90));
  ctx.stroke();

  // The ground, so a low mast reads as low rather than as a floating head.
  ctx.strokeStyle = '#3a4149';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - 52, groundY);
  ctx.lineTo(cx + 52, groundY);
  ctx.stroke();

  lamps.forEach((entry, i) => {
    const { color, flashing } = lampColour(entry);
    // Staggered: heads step to the right going down, which is how a diverging
    // route is signalled on this railway.
    const x = staggered ? cx + i * r * 1.9 : cx;
    const y = top + i * gap;

    // The head casing behind the lamp.
    ctx.fillStyle = '#23272c';
    ctx.beginPath();
    ctx.arc(x, y, r + 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#3a4149';
    ctx.lineWidth = 2;
    ctx.stroke();

    const lit = !flashing || Math.floor(time * 1.4) % 2 === 0;
    ctx.fillStyle = lit ? color : '#2b2f34';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (lit) {
      // A soft halo, so a lit lamp reads as lit rather than as a coloured disc.
      const glow = ctx.createRadialGradient(x, y, r * 0.4, x, y, r * 2.4);
      glow.addColorStop(0, `${color}66`);
      glow.addColorStop(1, `${color}00`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, r * 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  // Plates hang below the bottom head: DV, L, R.
  const plates = card.front.plates ?? [];
  plates.forEach((plate, i) => {
    const y = top + stack + gap * 0.75 + i * 26;
    ctx.fillStyle = '#e8e8e2';
    ctx.fillRect(cx - 15, y - 10, 30, 20);
    ctx.fillStyle = '#14181c';
    ctx.font = 'bold 13px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(plate, cx, y + 1);
  });
}

/**
 * A run through the deck, shuffled.
 *
 * The shuffle is seeded so a run can be repeated — which matters when you are
 * arguing with a card and want to see it again in the same order.
 */
export class SignalTest {
  private order: number[];
  private index = 0;
  right = 0;
  wrong = 0;
  /** Cards answered wrong, so a run can end by naming them. */
  readonly missed: SignalCard[] = [];
  revealed = false;

  constructor(
    private readonly cards: SignalCard[],
    seed: number,
    readonly length: number = 20,
  ) {
    this.order = shuffle(
      cards.map((_, i) => i),
      seed,
    ).slice(0, Math.min(length, cards.length));
  }

  get card(): SignalCard | null {
    const i = this.order[this.index];
    return i === undefined ? null : (this.cards[i] ?? null);
  }

  get position(): { at: number; of: number } {
    return { at: Math.min(this.index + 1, this.order.length), of: this.order.length };
  }

  get done(): boolean {
    return this.index >= this.order.length;
  }

  reveal(): void {
    this.revealed = true;
  }

  /** Mark the card you are looking at, and move on. */
  mark(correct: boolean): void {
    if (this.done) return;
    const card = this.card;
    if (correct) this.right++;
    else {
      this.wrong++;
      if (card) this.missed.push(card);
    }
    this.index++;
    this.revealed = false;
  }
}

/** Mulberry32 again: the same shuffle everywhere, which is the point. */
function shuffle<T>(items: T[], seed: number): T[] {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
