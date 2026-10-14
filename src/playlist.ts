/** A shuffled cycle, consumed only once a file actually starts playing. */
export class SampleQueue {
  private remaining: number[] = [];
  private last?: number;
  constructor(private count: number, private random: () => number = Math.random) { this.refill(); }
  private refill() {
    this.remaining = Array.from({ length: this.count }, (_, i) => i);
    for (let i = this.remaining.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [this.remaining[i], this.remaining[j]] = [this.remaining[j], this.remaining[i]];
    }
    if (this.count > 1 && this.remaining[0] === this.last) {
      [this.remaining[0], this.remaining[1]] = [this.remaining[1], this.remaining[0]];
    }
  }
  peek() { return this.remaining[0]; }
  consume(index: number) {
    if (index !== this.peek()) return;
    this.last = this.remaining.shift();
    if (!this.remaining.length) this.refill();
  }
}
