/**
 * Klocka som alla regler läser tiden från. I dev/test kan den förskjutas ("tidsmaskin")
 * så att frister som starttid, 48 h och 7 dagar kan provas utan att vänta.
 */
export class Clock {
  private offsetMs = 0;

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  nowIso(): string {
    return this.now().toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  advance(ms: number): void {
    this.offsetMs += ms;
  }

  reset(): void {
    this.offsetMs = 0;
  }

  get offset(): number {
    return this.offsetMs;
  }
}

/** Fast klocka för tester. */
export class FixedClock extends Clock {
  constructor(private current: Date) {
    super();
  }

  override now(): Date {
    return new Date(this.current.getTime() + this.offset);
  }

  set(iso: string): void {
    this.current = new Date(iso);
    this.reset();
  }
}
