import { GRADE, SWEET_SPOT_Y } from './constants.js';

/** Height error (m) that still counts as a clean strike. */
export const PERFECT_BAND = 0.09;
export const GOOD_BAND = 0.26;

const BASE_POINTS = { [GRADE.PERFECT]: 100, [GRADE.GOOD]: 60, [GRADE.SLOPPY]: 25 };

/** Combo count → points multiplier. */
export function multiplierFor(combo) {
  if (combo >= 16) return 5;
  if (combo >= 12) return 4;
  if (combo >= 8) return 3;
  if (combo >= 4) return 2;
  return 1;
}

export function gradeContact(ballY) {
  const error = Math.abs(ballY - SWEET_SPOT_Y);
  if (error <= PERFECT_BAND) return { grade: GRADE.PERFECT, error };
  if (error <= GOOD_BAND) return { grade: GRADE.GOOD, error };
  return { grade: GRADE.SLOPPY, error };
}

/**
 * Tracks the consecutive-clean-strike streak and the resulting style points.
 * A sloppy strike or a mistimed tap (whiff) drops the streak to zero.
 */
export class ComboTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.combo = 0;
    this.best = 0;
    this.multiplier = 1;
    this.points = 0;
    this.lastGrade = null;
  }

  /** @returns {{grade:string, error:number, gained:number, combo:number, multiplier:number, broke:boolean}} */
  register(ballY) {
    const { grade, error } = gradeContact(ballY);
    const broke = grade === GRADE.SLOPPY && this.combo > 0;

    if (grade === GRADE.SLOPPY) this.combo = 0;
    else this.combo += 1;

    this.best = Math.max(this.best, this.combo);
    this.multiplier = multiplierFor(this.combo);
    const gained = BASE_POINTS[grade] * this.multiplier;
    this.points += gained;
    this.lastGrade = grade;

    return { grade, error, gained, combo: this.combo, multiplier: this.multiplier, broke };
  }

  /** Mistimed tap: no contact, streak lost. */
  breakStreak() {
    const broke = this.combo > 0;
    this.combo = 0;
    this.multiplier = 1;
    return broke;
  }
}
