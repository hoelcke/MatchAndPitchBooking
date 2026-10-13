// Masterdata för anläggningar och planer (FR-B-207). Underhålls av kansliet.
import type { Ctx } from '../context.js';
import type { Facility, GameFormat, Pitch, Surface, User } from '../../shared/types.js';
import { GAME_FORMATS, SURFACES } from '../../shared/types.js';
import { all, newId, one, run } from '../infra/db.js';
import { audit } from '../infra/audit.js';
import { badRequest, notFound } from '../infra/errors.js';

interface FacilityRow {
  id: string;
  name: string;
  address: string;
  active: number;
}
interface PitchRow {
  id: string;
  facility_id: string;
  name: string;
  surface: Surface;
  supported_formats: string;
  active: number;
}

const toFacility = (r: FacilityRow): Facility => ({ id: r.id, name: r.name, address: r.address, active: r.active === 1 });
const toPitch = (r: PitchRow): Pitch => ({
  id: r.id,
  facilityId: r.facility_id,
  name: r.name,
  surface: r.surface,
  supportedFormats: JSON.parse(r.supported_formats),
  active: r.active === 1,
});

export type FacilityWithPitches = Facility & { pitches: Pitch[] };

export function listFacilities(ctx: Ctx, opts: { activeOnly: boolean }): FacilityWithPitches[] {
  const facilities = all<FacilityRow>(
    ctx.db,
    `SELECT * FROM facilities ${opts.activeOnly ? 'WHERE active = 1' : ''} ORDER BY name`,
  ).map(toFacility);
  return facilities.map((f) => ({
    ...f,
    pitches: all<PitchRow>(
      ctx.db,
      `SELECT * FROM pitches WHERE facility_id = ? ${opts.activeOnly ? 'AND active = 1' : ''} ORDER BY name`,
      f.id,
    ).map(toPitch),
  }));
}

export function getPitchWithFacility(ctx: Ctx, pitchId: string): { pitch: Pitch; facility: Facility } | undefined {
  const p = one<PitchRow>(ctx.db, `SELECT * FROM pitches WHERE id = ?`, pitchId);
  if (!p) return undefined;
  const f = one<FacilityRow>(ctx.db, `SELECT * FROM facilities WHERE id = ?`, p.facility_id)!;
  return { pitch: toPitch(p), facility: toFacility(f) };
}

export interface FacilityInput {
  name: string;
  address: string;
  active?: boolean;
}

function validateFacility(input: FacilityInput) {
  if (!input.name?.trim()) throw badRequest('Namn saknas');
  if (!input.address?.trim()) throw badRequest('Adress saknas');
}

export function createFacility(ctx: Ctx, user: User, input: FacilityInput): Facility {
  validateFacility(input);
  const id = newId('fac');
  run(ctx.db, `INSERT INTO facilities (id, name, address, active) VALUES (?, ?, ?, ?)`, id, input.name.trim(), input.address.trim(), input.active === false ? 0 : 1);
  audit(ctx, { userId: user.id, entityType: 'Facility', entityId: id, transition: '(start) -> CREATED' });
  return toFacility(one<FacilityRow>(ctx.db, `SELECT * FROM facilities WHERE id = ?`, id)!);
}

export function updateFacility(ctx: Ctx, user: User, id: string, input: FacilityInput): Facility {
  validateFacility(input);
  const changed = run(
    ctx.db,
    `UPDATE facilities SET name = ?, address = ?, active = ? WHERE id = ?`,
    input.name.trim(),
    input.address.trim(),
    input.active === false ? 0 : 1,
    id,
  );
  if (!changed) throw notFound('Anläggningen finns inte');
  audit(ctx, { userId: user.id, entityType: 'Facility', entityId: id, transition: input.active === false ? 'UPDATED (inaktiv)' : 'UPDATED' });
  return toFacility(one<FacilityRow>(ctx.db, `SELECT * FROM facilities WHERE id = ?`, id)!);
}

export interface PitchInput {
  facilityId: string;
  name: string;
  surface: Surface;
  supportedFormats: GameFormat[];
  active?: boolean;
}

function validatePitch(input: PitchInput) {
  if (!input.name?.trim()) throw badRequest('Plannamn saknas');
  if (!SURFACES.includes(input.surface)) throw badRequest('Ogiltigt underlag');
  if (!Array.isArray(input.supportedFormats) || input.supportedFormats.length === 0)
    throw badRequest('Välj minst en spelform');
  if (input.supportedFormats.some((f) => !GAME_FORMATS.includes(f))) throw badRequest('Ogiltig spelform');
}

export function createPitch(ctx: Ctx, user: User, input: PitchInput): Pitch {
  validatePitch(input);
  if (!one(ctx.db, `SELECT 1 FROM facilities WHERE id = ?`, input.facilityId)) throw notFound('Anläggningen finns inte');
  const id = newId('pitch');
  run(
    ctx.db,
    `INSERT INTO pitches (id, facility_id, name, surface, supported_formats, active) VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    input.facilityId,
    input.name.trim(),
    input.surface,
    JSON.stringify(input.supportedFormats),
    input.active === false ? 0 : 1,
  );
  audit(ctx, { userId: user.id, entityType: 'Pitch', entityId: id, transition: '(start) -> CREATED' });
  return toPitch(one<PitchRow>(ctx.db, `SELECT * FROM pitches WHERE id = ?`, id)!);
}

export function updatePitch(ctx: Ctx, user: User, id: string, input: Omit<PitchInput, 'facilityId'>): Pitch {
  validatePitch({ ...input, facilityId: '' });
  const changed = run(
    ctx.db,
    `UPDATE pitches SET name = ?, surface = ?, supported_formats = ?, active = ? WHERE id = ?`,
    input.name.trim(),
    input.surface,
    JSON.stringify(input.supportedFormats),
    input.active === false ? 0 : 1,
    id,
  );
  if (!changed) throw notFound('Planen finns inte');
  audit(ctx, { userId: user.id, entityType: 'Pitch', entityId: id, transition: input.active === false ? 'UPDATED (inaktiv)' : 'UPDATED' });
  return toPitch(one<PitchRow>(ctx.db, `SELECT * FROM pitches WHERE id = ?`, id)!);
}
