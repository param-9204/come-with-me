import type { PlaceExtraction } from '../types/social';
import type { EvidenceBundle } from './place-evidence.service';

export type PlaceFrameEvidence = NonNullable<PlaceExtraction['frame_evidence']>;

export interface PlaceSequenceItem {
  sequence: number;
  name: string;
  place_id: string | null;
  first_frame_index: number;
  first_seen_at_seconds: number | null;
}

/**
 * Returns only evidence that was actually read from a captured image/video
 * frame. Caption, tags, accounts, and speech deliberately cannot create a
 * timeline entry because they do not establish an on-screen sequence.
 */
export function frameEvidenceForPlace(place: PlaceExtraction, bundle: EvidenceBundle): PlaceFrameEvidence | null {
  const visualItems = (place.evidence_ids || [])
    .map((id) => bundle.byId.get(id))
    .filter((item) => item && (item.source === 'ocr' || item.source === 'vision_ocr') && (item.frames?.length || 0) > 0);

  const frameIndexes = [...new Set(visualItems.flatMap((item) => item!.frames || []))]
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!frameIndexes.length) return null;

  const timestamps = [...new Set(visualItems.flatMap((item) => item!.timestamps || []))]
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  return {
    frame_indexes: frameIndexes,
    timestamps_seconds: timestamps,
    evidence_ids: visualItems.map((item) => item!.id),
  };
}

type SequencedPlace = {
  name?: string | null;
  place_id?: string | null;
  frame_evidence?: PlaceFrameEvidence | null;
};

/** Build a de-duplicated, first-appearance order for API responses. */
export function buildPlaceSequence(places: SequencedPlace[]): PlaceSequenceItem[] {
  const grouped = new Map<string, {
    name: string;
    place_id: string | null;
    frame_indexes: number[];
    timestamps_seconds: number[];
  }>();

  for (const place of places) {
    const name = place.name?.trim();
    const evidence = place.frame_evidence;
    if (!name || !evidence?.frame_indexes?.length) continue;

    const key = place.place_id || name.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (!key) continue;
    const existing = grouped.get(key);
    const frameIndexes = [...new Set([...(existing?.frame_indexes || []), ...evidence.frame_indexes])]
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const timestamps = [...new Set([...(existing?.timestamps_seconds || []), ...(evidence.timestamps_seconds || [])])]
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

    grouped.set(key, {
      name: existing?.name || name,
      place_id: existing?.place_id || place.place_id || null,
      frame_indexes: frameIndexes,
      timestamps_seconds: timestamps,
    });
  }

  return [...grouped.values()]
    .sort((a, b) =>
      (a.timestamps_seconds[0] ?? Number.POSITIVE_INFINITY) - (b.timestamps_seconds[0] ?? Number.POSITIVE_INFINITY) ||
      a.frame_indexes[0] - b.frame_indexes[0] ||
      a.name.localeCompare(b.name)
    )
    .map((item, index) => ({
      sequence: index + 1,
      name: item.name,
      place_id: item.place_id,
      first_frame_index: item.frame_indexes[0],
      first_seen_at_seconds: item.timestamps_seconds[0] ?? null,
    }));
}
