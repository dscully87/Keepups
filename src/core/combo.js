import { GRADE, SWEET_SPOT_Y } from './constants.js';

/** Height error (m) that still counts as a clean strike. */
export const PERFECT_BAND = 0.09;
export const GOOD_BAND = 0.26;

const BASE_POINTS = { [GRADE.PERFECT]: 100, [GRADE.GOOD]: 60, [GRADE.SLOPPY]: 25 };

/** Bonus points for control, before the combo multiplier. Each is shown by name in the flash text. */
export const BONUS = { CONTROL: 25, RESCUE: 50, HEIGHT: 40 };

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

  /** @returns {{grade:string, error:number, gained:number, combo:number, multiplier:number, broke:boolean, bonuses:{name:string,points:number}[]}} */
  register(ballY, extras = null) {
    const { grade, error } = gradeContact(ballY);
    const broke = grade === GRADE.SLOPPY && this.combo > 0;

    if (grade === GRADE.SLOPPY) this.combo = 0;
    else this.combo += 1;

    this.best = Math.max(this.best, this.combo);
    this.multiplier = multiplierFor(this.combo);
    // Control bonuses reward steering, not just timing. A sloppy touch earns none: a
    // scrappy rescue should not out-score a clean one.
    const bonuses = [];
    if (extras && grade !== GRADE.SLOPPY) {
      if (extras.rescue) bonuses.push({ name: 'RESCUE', points: BONUS.RESCUE * this.multiplier });
      if (extras.controlled) bonuses.push({ name: 'CONTROL', points: BONUS.CONTROL * this.multiplier });
      if (extras.highControlled) bonuses.push({ name: 'HEIGHT', points: BONUS.HEIGHT * this.multiplier });
    }
    let gained = BASE_POINTS[grade] * this.multiplier;
    for (const b of bonuses) gained += b.points;
    this.points += gained;
    this.lastGrade = grade;

    return { grade, error, gained, combo: this.combo, multiplier: this.multiplier, broke, bonuses };
  }

  /** Mistimed tap: no contact, streak lost. */
  breakStreak() {
    const broke = this.combo > 0;
    this.combo = 0;
    this.multiplier = 1;
    return broke;
  }
}
