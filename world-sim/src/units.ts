/**
 * Units.
 *
 * One canonical set, SI, everywhere inside the simulation: **metres**,
 * **kilograms**, **seconds**, **newtons**. Grades are stored as a signed
 * dimensionless rise/run (0.015 is a 1.5% ascending grade), never as a
 * percentage, because the physics multiplies by it directly and a stray factor
 * of 100 in a force term is invisible until a train rolls uphill.
 *
 * Scene JSON is authored in friendlier units — tonnes for mass, percent for
 * grade limits, cells for terrain coordinates — and converted on the way in, in
 * exactly one place per quantity. Note that `CROR/sim` counts in **feet**; when
 * the two are joined, convert at the boundary rather than relaxing this rule.
 */

/** Standard gravity, m/s². */
export const G = 9.80665;

export const M_PER_FT = 0.3048;
export const FT_PER_M = 1 / M_PER_FT;
export const KG_PER_TONNE = 1000;
/** Metres per mile, for mileage-flavoured scenes. */
export const M_PER_MILE = 1609.344;
/** m/s in one mph. */
export const MPS_PER_MPH = 0.44704;

export const feetToMetres = (ft: number): number => ft * M_PER_FT;
export const metresToFeet = (m: number): number => m * FT_PER_M;
export const tonnesToKg = (t: number): number => t * KG_PER_TONNE;
export const kgToTonnes = (kg: number): number => kg / KG_PER_TONNE;
export const mphToMps = (mph: number): number => mph * MPS_PER_MPH;
export const mpsToMph = (mps: number): number => mps / MPS_PER_MPH;

/**
 * Degree of curve, the way North American railways state curvature: the central
 * angle subtended by a 100 ft chord. Curvature arrives from the geometry as
 * 1/radius, and every empirical formula worth using (curve resistance, cant
 * deficiency) is quoted per degree.
 */
export const curvatureToDegrees = (invRadiusPerM: number): number =>
  Math.abs(invRadiusPerM) * 1746.4;

export const degreesToRadiusM = (degrees: number): number =>
  degrees === 0 ? Infinity : 1746.4 / degrees;

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Smoothstep on [0,1]; the interpolation used for terrain feature falloff. */
export const smoothstep = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};
