import { supabaseAdmin } from '../supabase';
import { resolveProfileId } from '../auth';
import type { SocialContent, AiAnalysisResult, ApifyOcrFrameResult, GptVisionFrameResult, PlaceExtraction, PlaceCategory } from '../types/social';
import { LocationService, type GeocodeResult } from './location.service';
import { AiEnrichmentService } from './ai-enrichment.service';
import { ScraperService } from './scraper.service';
import { googleTypeConflict, reconcileCategoryWithGoogle } from './place-evidence.service';
import { plog } from './pipeline-log';
import { googleMapsUrl } from '../maps-url';

export type PlaceInput = Omit<PlaceExtraction, 'category'> & { category: PlaceCategory | string };

const VERIFIED_BONUS = 0.1;
const AMBIGUOUS_PENALTY = 0.1;

/** Escape LIKE wildcards so names such as "100% Pizza" or "Dim_Sum" match literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export type Verification = {
  verified: boolean;
  ambiguous?: boolean;
  /** Who verified the location: a geocoder now, or coordinates already stored for this place. */
  provider?: 'google' | 'mapbox' | 'stored';
};

const PROVIDER_LABEL: Record<NonNullable<Verification['provider']>, string> = {
  google: 'Google Maps',
  mapbox: 'Mapbox',
  stored: 'the saved map location',
};

/** Post-geocoding confidence and explanation for one post↔place link. */
export function verifiedEvidence(
  place: Pick<PlaceInput, 'confidence' | 'explanation'>,
  verification: Verification
): { confidence: number; explanation: string } {
  let confidence = Number(place.confidence) || 0;
  let note = '';
  if (verification.verified) {
    const label = PROVIDER_LABEL[verification.provider || 'google'];
    confidence += VERIFIED_BONUS;
    note = verification.ambiguous
      ? ` Matched on ${label}; several branches share this name, so the closest name match was used.`
      : verification.provider === 'stored' ? ' Matches a place already on the map.' : ` Verified on ${label}.`;
    if (verification.ambiguous) confidence -= AMBIGUOUS_PENALTY;
  }
  return {
    confidence: Math.round(Math.max(0, Math.min(0.99, confidence)) * 100) / 100,
    explanation: `${place.explanation || ''}${note}`.trim(),
  };
}

export class DbService {
  private static columnSupport = new Map<string, boolean>();

  /**
   * Whether optional columns from migration v25 exist. Cached per process so
   * the pipeline works before and after the migration is applied.
   */
  static async supportsColumns(table: string, columns: string): Promise<boolean> {
    const key = `${table}:${columns}`;
    const cached = this.columnSupport.get(key);
    if (cached !== undefined) return cached;
    const { error } = await supabaseAdmin.from(table).select(columns).limit(1);
    if (!error) {
      this.columnSupport.set(key, true);
      return true;
    }
    const missingColumn = error.code === '42703' || error.code === 'PGRST204' || /column .* does not exist|schema cache/i.test(error.message || '');
    if (missingColumn) {
      this.columnSupport.set(key, false);
      plog('db', `${table}.(${columns}) not found — apply supabase/migration_v25_place_evidence.sql to enable it`, undefined, 'warn');
    }
    return false;
  }

  /** Link one place to a post, storing why it was detected when the columns exist. */
  static async linkPlaceWithEvidence(
    socialPostId: string | undefined,
    placeId: string,
    place: PlaceInput,
    verification: Verification
  ): Promise<void> {
    if (!socialPostId) return;
    if (!(await this.supportsColumns('social_post_places', 'confidence, explanation, evidence'))) {
      await this.linkPlacesToSocialPost(socialPostId, [placeId]);
      return;
    }
    const { confidence, explanation } = verifiedEvidence(place, verification);
    const { error } = await supabaseAdmin
      .from('social_post_places')
      .upsert({
        social_post_id: socialPostId,
        place_id: placeId,
        confidence,
        explanation,
        evidence: {
          ids: place.evidence_ids || [],
          location_ids: place.location_evidence_ids || [],
          sources: place.evidence_sources || [],
          mention_type: place.mention_type || null,
          snippets: place.evidence_snippets || [],
          verified: verification.verified,
          provider: verification.provider || null,
          ambiguous: !!verification.ambiguous,
        },
      }, { onConflict: 'social_post_id, place_id' });
    if (error) {
      plog('db', 'Failed to store place evidence; linked without it', { error: error.message }, 'warn');
      await this.linkPlacesToSocialPost(socialPostId, [placeId]);
    }
  }

  private static async findPlaceByGoogleId(placeId: string | null | undefined): Promise<string | null> {
    if (!placeId || !(await this.supportsColumns('places', 'google_place_id'))) return null;
    const { data } = await supabaseAdmin.from('places').select('id').eq('google_place_id', placeId).limit(1);
    return data?.[0]?.id || null;
  }

  // ──────────────────────────────────────────────────────────────────
  // Save / upsert a place (Come With Me map entity)
  // ──────────────────────────────────────────────────────────────────
  static async savePlace(
    placeData: PlaceInput,
    sourceUrl: string,
    sourcePlatform: string,
    audioTranscript?: string,
    userId?: string,
    socialPostId?: string,
    authorUsername?: string
  ): Promise<string | null> {
    if (!placeData.name) {
      plog('db', 'Place has no name; not saved', undefined, 'warn');
      return null;
    }

    // Resolve creator_handle — prioritize authorUsername from the social post
    let rawHandle = (authorUsername || placeData.creator_handle || '').trim();
    let creatorHandle = rawHandle;
    if (creatorHandle && !creatorHandle.startsWith('@')) {
      creatorHandle = `@${creatorHandle}`;
    }

    const supportsGoogleId = await DbService.supportsColumns('places', 'google_place_id');
    const link = (placeId: string, verification: Verification) =>
      DbService.linkPlaceWithEvidence(socialPostId, placeId, placeData, verification);

    // Idempotent: skip geocoding and insertion if place already exists.
    // `.limit()` instead of `.maybeSingle()`: maybeSingle errors (data=null)
    // when several rows match, which used to create yet another duplicate.
    const { data: existingRows } = await supabaseAdmin
      .from('places')
      .select('id, latitude, longitude, address, city, neighborhood')
      .ilike('name', escapeLike(placeData.name.trim()))
      .ilike('city', escapeLike((placeData.city || '').trim()))
      .order('created_at', { ascending: true })
      .limit(5);
    const existing = (existingRows || []).find((row) => row.latitude !== null && row.longitude !== null)
      || (existingRows || [])[0]
      || null;

    if (existing) {
      plog('db', `"${placeData.name}" already in database (name + city)`, { placeId: existing.id, hasCoordinates: existing.latitude !== null });
      const suppliedAddress = LocationService.sanitizeSourceAddress(placeData.address);
      const storedAddress = LocationService.sanitizeSourceAddress(existing.address);
      const hasInvalidStoredAddress = Boolean(existing.address && !storedAddress);
      let verified = existing.latitude !== null && existing.longitude !== null;
      let ambiguous = false;
      let provider: Verification['provider'] = verified ? 'stored' : undefined;
      let invalidAddressReplaced = false;
      // Repair legacy extraction artifacts such as `2017 by Street` by first
      // resolving the venue by its exact name and city. This preserves a real
      // provider address when one is available instead of simply blanking it.
      if (!verified || hasInvalidStoredAddress) {
        try {
          const coords = await LocationService.geocodePlace(
            placeData.name,
            existing.city || placeData.city || '',
            suppliedAddress || storedAddress,
            placeData.neighborhood || existing.neighborhood || ''
          );

          if (coords.lat !== null && coords.lng !== null) {
            const verifiedUpdate: Record<string, string | number> = {
              latitude: coords.lat,
              longitude: coords.lng,
            };
            if (coords.formattedAddress) verifiedUpdate.address = coords.formattedAddress;
            if (coords.city) verifiedUpdate.city = coords.city;
            if (coords.neighborhood) verifiedUpdate.neighborhood = coords.neighborhood;
            if (supportsGoogleId && coords.placeId && !(await DbService.findPlaceByGoogleId(coords.placeId))) {
              verifiedUpdate.google_place_id = coords.placeId;
            }

            const { error: updateError } = await supabaseAdmin
              .from('places')
              .update(verifiedUpdate)
              .eq('id', existing.id);
            if (updateError) {
              plog('db', 'Failed to refresh coordinates', { placeId: existing.id, error: updateError.message }, 'warn');
            } else {
              verified = true;
              ambiguous = !!coords.ambiguous;
              provider = coords.provider;
              invalidAddressReplaced = !hasInvalidStoredAddress || Boolean(coords.formattedAddress);
              plog('db', 'Added verified coordinates to existing place', { placeId: existing.id, lat: coords.lat, lng: coords.lng, provider: coords.provider });
            }
          }
        } catch (geoErr: any) {
          plog('db', 'Failed to refresh coordinates', { placeId: existing.id, error: geoErr.message }, 'warn');
        }
      }
      if (hasInvalidStoredAddress && !invalidAddressReplaced) {
        const { error: clearAddressError } = await supabaseAdmin
          .from('places')
          .update({ address: '' })
          .eq('id', existing.id);
        if (clearAddressError) {
          plog('db', 'Failed to clear invalid stored address', { placeId: existing.id, error: clearAddressError.message }, 'warn');
        } else {
          plog('db', 'Cleared invalid stored address', { placeId: existing.id, address: existing.address }, 'warn');
        }
      }
      await link(existing.id, { verified, ambiguous, provider });
      return existing.id;
    }

    let lat: number | null = null;
    let lng: number | null = null;
    let neighborhood = placeData.neighborhood;
    let address = LocationService.sanitizeSourceAddress(placeData.address);
    let city = LocationService.cleanCityName(placeData.city);
    let geocode: GeocodeResult | null = null;

    try {
      let coords = await LocationService.geocodePlace(
        placeData.name,
        city || '',
        address,
        neighborhood
      );
      // A fuzzy name match of a different kind of venue is the wrong entity
      // (e.g. poster text "La Dolce Vita" → a shoe store called "Dolce Vita").
      const exactName = !!coords.matchedName && LocationService.nameSimilarity(placeData.name, coords.matchedName) === 1;
      const conflict = coords.lat !== null && !exactName
        ? googleTypeConflict(placeData.base_category || (placeData.category as PlaceCategory), coords.primaryType, coords.types)
        : null;
      if (conflict) {
        plog('db', `Rejected Google match for "${placeData.name}": different kind of venue`, {
          googleName: coords.matchedName,
          googleType: coords.primaryType,
          extractedAs: placeData.base_category || placeData.category,
          googleCategory: conflict,
        }, 'warn');
        coords = { lat: null, lng: null, formattedAddress: null, neighborhood: null, city: null };
      }
      geocode = coords;
      lat = coords.lat;
      lng = coords.lng;
      if (coords.formattedAddress) {
        address = coords.formattedAddress;
      }
      if (coords.city) {
        city = coords.city;
      }
      // Use neighborhood from forward geocode context if not already known
      if (!neighborhood && coords.neighborhood) {
        neighborhood = coords.neighborhood;
      }

      // Only call reverse geocode if neighborhood is STILL missing
      if (!neighborhood && lat !== null && lng !== null) {
        try {
          neighborhood = await LocationService.getNeighborhood(lat, lng);
        } catch (revErr: any) {
          plog('db', 'Reverse neighbourhood lookup failed (non-fatal)', { error: revErr.message }, 'warn');
        }
      }
    } catch (geoErr: any) {
      plog('db', `Geocoding failed for "${placeData.name}" (non-fatal)`, { error: geoErr.message }, 'warn');
    }

    const verified = lat !== null && lng !== null;
    const ambiguous = !!geocode?.ambiguous;

    // Same Google place already saved (possibly under another spelling).
    const existingByGoogleId = await DbService.findPlaceByGoogleId(geocode?.placeId);
    if (existingByGoogleId) {
      plog('db', `"${placeData.name}" already in database (same Google place)`, { placeId: existingByGoogleId, googlePlaceId: geocode?.placeId });
      await link(existingByGoogleId, { verified, ambiguous, provider: geocode?.provider });
      return existingByGoogleId;
    }

    // GATE: Do not save places with no resolved address
    if (!address || !address.trim()) {
      plog('db', `Not saved: "${placeData.name}" has no verified location`, { reason: 'no Google match and no address in the evidence' }, 'warn');
      return null;
    }

    // A source post may omit the city. Once Google Maps verifies it, check the
    // canonical name/city pair before creating a duplicate record.
    if (city.trim() && city.trim().toLowerCase() !== (placeData.city || '').trim().toLowerCase()) {
      const { data: resolvedCityRows } = await supabaseAdmin
        .from('places')
        .select('id')
        .ilike('name', escapeLike(placeData.name.trim()))
        .ilike('city', escapeLike(city.trim()))
        .limit(1);
      const existingWithResolvedCity = resolvedCityRows?.[0];

      if (existingWithResolvedCity) {
        plog('db', `"${placeData.name}" already in database (Google-resolved city)`, { placeId: existingWithResolvedCity.id, city });
        await link(existingWithResolvedCity.id, { verified, ambiguous, provider: geocode?.provider });
        return existingWithResolvedCity.id;
      }
    }

    // Deduplicate by coordinate proximity (if geocoding succeeded)
    if (lat !== null && lng !== null) {
      const margin = 0.0001; // ~10m bounding box
      const { data: existingByCoords } = await supabaseAdmin
        .from('places')
        .select('id, name')
        .gte('latitude', lat - margin)
        .lte('latitude', lat + margin)
        .gte('longitude', lng - margin)
        .lte('longitude', lng + margin)
        .limit(10);

      const normalizedName = placeData.name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
      const samePlaceAtCoordinates = (existingByCoords || []).find((candidate) =>
        (candidate.name || '').toLowerCase().replace(/[^a-z0-9]/g, '') === normalizedName
      );

      if (samePlaceAtCoordinates) {
        plog('db', `"${placeData.name}" already in database (same coordinates)`, { placeId: samePlaceAtCoordinates.id, lat, lng });
        await link(samePlaceAtCoordinates.id, { verified, ambiguous, provider: geocode?.provider });
        return samePlaceAtCoordinates.id;
      }
    }

    // Ensure the city is recorded in our cities table
    const cityName = LocationService.cleanCityName(city);
    if (cityName) {
      try {
        // Query cities table first to avoid redundant geocoding & upsert
        const { data: existingCity } = await supabaseAdmin
          .from('cities')
          .select('name')
          .eq('name', cityName)
          .maybeSingle();

        if (!existingCity) {
          let cityLat: number | null = null;
          let cityLng: number | null = null;
          try {
            const cityCoords = await LocationService.geocodePlace('', cityName);
            if (cityCoords.lat !== null && cityCoords.lng !== null) {
              cityLat = cityCoords.lat;
              cityLng = cityCoords.lng;
            }
          } catch (geoErr) {
            plog('db', 'Failed to look up city centre (non-fatal)', { city: cityName, error: String(geoErr) }, 'warn');
          }

          await supabaseAdmin
            .from('cities')
            .upsert({
              name: cityName,
              latitude: cityLat,
              longitude: cityLng
            }, { onConflict: 'name' });
        } else {
        }
      } catch (err) {
        plog('db', 'Failed to save city (non-fatal)', { city: cityName, error: String(err) }, 'warn');
      }
    }

    // Google's place type decides what a venue is (bar vs cafe); experience
    // categories and HIDDEN GEMS stay as extracted.
    const category = reconcileCategoryWithGoogle(
      (placeData.category || placeData.base_category || 'CITY') as PlaceCategory,
      geocode?.primaryType,
      geocode?.types
    );
    if (category !== placeData.category) {
      plog('db', `Category for "${placeData.name}" set from Google type`, { extracted: placeData.category, saved: category, googleType: geocode?.primaryType });
    }

    // Google's listing gives the canonical spelling ("LUCALI" → "Lucali",
    // "Joes Pizza" → "Joe's Pizza") — used only when it is the same name.
    const displayName = geocode?.matchedName && LocationService.nameSimilarity(placeData.name, geocode.matchedName) === 1
      ? geocode.matchedName
      : placeData.name.trim();

    const { data: newPlace, error } = await supabaseAdmin
      .from('places')
      .insert({
        name: displayName,
        address: address || '',
        city: LocationService.cleanCityName(city),
        neighborhood,
        category,
        description: placeData.description || '',
        source: sourcePlatform,
        source_url: sourceUrl || '',
        audio_transcript: audioTranscript || '',
        latitude: lat,
        longitude: lng,
        ...(supportsGoogleId && geocode?.placeId ? { google_place_id: geocode.placeId } : {}),
      })
      .select('id')
      .single();

    if (error) {
      // A parallel save of the same Google place won the unique index race.
      if (error.code === '23505' && geocode?.placeId) {
        const winner = await DbService.findPlaceByGoogleId(geocode.placeId);
        if (winner) {
          await link(winner, { verified, ambiguous, provider: geocode?.provider });
          return winner;
        }
      }
      plog('db', `Insert failed for "${placeData.name}"`, { error: error.message, code: error.code }, 'error');
      throw new Error(`Failed to save place: ${error.message}`);
    }

    plog('db', `Saved new place "${displayName}"`, { placeId: newPlace.id, lat, lng, address, category, googlePlaceId: geocode?.placeId || null, verified });
    await link(newPlace.id, { verified, ambiguous, provider: geocode?.provider });
    return newPlace.id;
  }
  // ──────────────────────────────────────────────────────────────────
  static async linkPlacesToSocialPost(socialPostId: string, placeIds: string[]): Promise<void> {
    if (!socialPostId || !placeIds.length) return;
    const rows = placeIds.map((placeId) => ({
      social_post_id: socialPostId,
      place_id: placeId,
    }));
    const { error } = await supabaseAdmin
      .from('social_post_places')
      .upsert(rows, { onConflict: 'social_post_id, place_id' });

    if (error) {
      plog('db', 'Failed to link places to post', { error: error.message }, 'warn');
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Get all places associated with a social post (junction + legacy)
  // ──────────────────────────────────────────────────────────────────
  static async getPlacesForSocialPost(socialPostId?: string | null, postUrl?: string | null): Promise<any[]> {
    if (!socialPostId) return [];

    let places: any[] = [];

    // Fetch ONLY via social_post_places junction table (scoped to current post)
    const withEvidence = await DbService.supportsColumns('social_post_places', 'confidence, explanation, evidence');
    const { data: junctionRows } = await supabaseAdmin
      .from('social_post_places')
      .select(withEvidence ? 'place_id, confidence, explanation, evidence' : 'place_id')
      .eq('social_post_id', socialPostId);

    const evidenceByPlace = new Map<string, { confidence: number | null; explanation: string | null; evidence: any }>();
    for (const row of (junctionRows || []) as any[]) {
      if (withEvidence && row.place_id) {
        evidenceByPlace.set(row.place_id, { confidence: row.confidence, explanation: row.explanation, evidence: row.evidence });
      }
    }
    const junctionPlaceIds = (junctionRows as any[] | null)?.map((r) => r.place_id).filter(Boolean) || [];

    if (junctionPlaceIds.length > 0) {
      const { data: junctionPlaces } = await supabaseAdmin
        .from('places')
        .select('*')
        .in('id', junctionPlaceIds);
      if (junctionPlaces) {
        places.push(...junctionPlaces);
      }
    }

    // 3. Fetch author_username from social_posts for this socialPostId
    let postAuthorUsername: string | null = null;
    if (socialPostId) {
      const { data: post } = await supabaseAdmin
        .from('social_posts')
        .select('author_username')
        .eq('id', socialPostId)
        .maybeSingle();
      if (post?.author_username) {
        postAuthorUsername = post.author_username;
      }
    }

    // 4. Enrich every place with author_username, creator_handle, creators
    const placeIds = places.map((p) => p.id).filter(Boolean);
    let placeCreatorsMap: Record<string, { creator_handle: string; post_url: string; platform: string }[]> = {};

    if (placeIds.length > 0) {
      const { data: allJunctions } = await supabaseAdmin
        .from('social_post_places')
        .select('place_id, social_posts(author_username, post_url, platform)')
        .in('place_id', placeIds);

      if (allJunctions) {
        allJunctions.forEach((row: any) => {
          const pId = row.place_id;
          const post = row.social_posts;
          if (pId && post?.author_username) {
            let handle = post.author_username.trim();
            if (!handle.startsWith('@')) handle = `@${handle}`;

            if (!placeCreatorsMap[pId]) {
              placeCreatorsMap[pId] = [];
            }
            if (!placeCreatorsMap[pId].some((c) => c.creator_handle === handle)) {
              placeCreatorsMap[pId].push({
                creator_handle: handle,
                post_url: post.post_url || '',
                platform: post.platform || '',
              });
            }
          }
        });
      }
    }

    const currentPostHandle = postAuthorUsername
      ? (postAuthorUsername.startsWith('@') ? postAuthorUsername : `@${postAuthorUsername}`)
      : null;

    return places.map((p) => {
      const creatorsList = placeCreatorsMap[p.id] || [];
      const effectiveHandle = currentPostHandle || (creatorsList.length > 0 ? creatorsList[0].creator_handle : null);
      const effectiveAuthor = effectiveHandle ? effectiveHandle.replace(/^@/, '') : null;

      let finalCreators = [...creatorsList];
      if (currentPostHandle) {
        const existingIdx = finalCreators.findIndex((c) => c.creator_handle === currentPostHandle);
        if (existingIdx >= 0) {
          const [match] = finalCreators.splice(existingIdx, 1);
          finalCreators.unshift(match);
        } else {
          finalCreators.unshift({
            creator_handle: currentPostHandle,
            post_url: postUrl || '',
            platform: '',
          });
        }
      }

      const evidence = evidenceByPlace.get(p.id);
      return {
        ...p,
        map_url: googleMapsUrl(p),
        author_username: effectiveAuthor,
        creator_handle: effectiveHandle,
        creators: finalCreators,
        ...(evidence ? {
          confidence: evidence.confidence !== null ? Number(evidence.confidence) : undefined,
          explanation: evidence.explanation || undefined,
          evidence_sources: evidence.evidence?.sources || undefined,
          evidence_snippets: evidence.evidence?.snippets || undefined,
        } : {}),
      };
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Save the full social post with ALL data
  // ──────────────────────────────────────────────────────────────────
  static async saveSocialPost(
    content: SocialContent,
    rawApifyData: any,
    aiAnalysis: AiAnalysisResult | null,
    apifyOcrFrames: ApifyOcrFrameResult[],
    gptOcrFrames: GptVisionFrameResult[],
    transcript: string,
    placeIds: string[],
    sourceUrl: string,
    userId?: string,
    socialPostId?: string
  ): Promise<string | null> {
    console.log(`[DB] Saving full social post for ${content.platform}/${content.contentId}...`);

    // Build combined OCR text (searchable plain text field)
    const gptTexts = [...new Set(gptOcrFrames.flatMap(f => f.texts).filter(Boolean))];
    const apifyTexts = [...new Set(apifyOcrFrames.flatMap(f => f.texts).filter(Boolean))];
    const combinedOcrText = [...new Set([...gptTexts, ...apifyTexts])].join(' ');

    // Extract top-level analysis fields for indexed columns
    const primaryCategory = aiAnalysis?.content?.primary_category || null;
    const secondaryCategories = aiAnalysis?.content?.secondary_categories || [];
    const contentSummary = aiAnalysis?.content?.summary || null;
    const mentionedBrands = aiAnalysis
      ? [
        ...aiAnalysis.entities.brands.map(b => b.name),
        ...aiAnalysis.visual_analysis.brands_visible,
      ].filter((v, i, a) => v && a.indexOf(v) === i)
      : [];
    const mentionedLocations = aiAnalysis
      ? aiAnalysis.entities.locations.map(l => l.name).filter(Boolean)
      : [];
    const callToActions = aiAnalysis?.promotion?.call_to_actions || [];
    const niche = aiAnalysis?.influencer_analysis?.niche || null;
    const targetAudience = aiAnalysis?.audience?.primary_audience || null;

    // Compute engagement rate if possible
    let engagementRate: number | null = null;
    const likes = content.metrics.likes;
    const comments = content.metrics.comments;
    const views = content.metrics.views;
    if (likes !== null && comments !== null && views && views > 0) {
      engagementRate = parseFloat(((likes + comments) / views * 100).toFixed(4));
    }

    const resolvedUserId = userId
      ? await resolveProfileId({ userIdInput: userId })
      : null;

    const payload = {
      // ── User association ────────────────────────
      user_id: resolvedUserId,


      // ── Platform / type ─────────────────────────
      platform: content.platform,
      content_type: content.contentType,
      content_id: content.contentId,
      product_type: content.productType,
      short_code: content.shortCode,

      // ── Original source link ────────────────────
      post_url: sourceUrl || null,

      // ── Creator ─────────────────────────────────
      author_username: content.authorUsername,
      owner_full_name: content.authorFullName,

      // ── Content ─────────────────────────────────
      caption: content.caption,
      video_url: content.videoUrl || '',
      display_url: content.displayUrl || '',
      first_comment: rawApifyData?.firstComment || null,

      // ── Metrics ─────────────────────────────────
      likes: content.metrics.likes != null ? Math.round(Number(content.metrics.likes)) : 0,
      views: content.metrics.views != null ? Math.round(Number(content.metrics.views)) : 0,
      comments: content.metrics.comments != null ? Math.round(Number(content.metrics.comments)) : 0,
      video_plays: content.metrics.plays != null ? Math.round(Number(content.metrics.plays)) : null,
      engagement_rate: engagementRate,

      // ── Video metadata ──────────────────────────
      video_duration: content.videoDuration != null ? Math.round(Number(content.videoDuration)) : null,
      dimensions_width: content.dimensions?.width != null ? Math.round(Number(content.dimensions.width)) : null,
      dimensions_height: content.dimensions?.height != null ? Math.round(Number(content.dimensions.height)) : null,

      // ── Social graph ────────────────────────────
      hashtags: content.hashtags,
      mentions: content.mentions,
      tagged_users: content.taggedUsers?.length ? content.taggedUsers : null,
      music_info: content.musicInfo || null,

      // ── Commercial ──────────────────────────────
      is_paid_partnership: content.paidPartnership,
      is_promotional: aiAnalysis?.promotion?.is_promotional ?? null,

      // ── AI Analysis ─────────────────────────────
      mentioned_brands: mentionedBrands.length ? mentionedBrands : null,
      mentioned_locations: mentionedLocations.length ? mentionedLocations : null,
      primary_category: primaryCategory,
      secondary_categories: secondaryCategories.length ? secondaryCategories : null,
      content_summary: contentSummary,
      niche,
      target_audience: targetAudience,
      call_to_actions: callToActions.length ? callToActions : null,

      // ── Media analysis ──────────────────────────
      whisper_transcript: transcript || null,
      ocr_combined_text: combinedOcrText || null,
      ocr_frames_apify: apifyOcrFrames.length ? apifyOcrFrames : null,
      ocr_frames_gpt: gptOcrFrames.length ? gptOcrFrames : null,

      // ── Raw data (stored as-is, never modified) ─
      raw_apify_data: rawApifyData || null,
      ai_analysis: aiAnalysis || null,
    };

    const finalPayload = {
      ...payload,
      status: 'completed',
      error_message: null
    };

    let query;
    if (socialPostId) {
      query = supabaseAdmin
        .from('social_posts')
        .update(finalPayload)
        .eq('id', socialPostId);
    } else {
      query = supabaseAdmin
        .from('social_posts')
        .upsert(finalPayload, { onConflict: 'platform, content_id' });
    }

    const { data, error } = await query
      .select('id')
      .single();

    if (error) {
      // Handle unique constraint duplicate violation by updating canonical row and resolving placeholder
      if (error.code === '23505' && socialPostId) {
        console.log(`[DB] Social post already exists. Merging payload into existing post...`);
        const { data: existingPost } = await supabaseAdmin
          .from('social_posts')
          .select('id')
          .eq('platform', payload.platform)
          .eq('content_id', payload.content_id)
          .single();

        if (existingPost) {
          // Update the existing canonical post
          await supabaseAdmin
            .from('social_posts')
            .update(finalPayload)
            .eq('id', existingPost.id);

          // Update the placeholder row to completed so the client gets status success
          await supabaseAdmin
            .from('social_posts')
            .update({
              status: 'completed',
              ai_analysis: aiAnalysis,
              whisper_transcript: transcript || null,
            })
            .eq('id', socialPostId);

          // Link all extracted places to this canonical social post ID
          if (placeIds.length > 0) {
            await DbService.linkPlacesToSocialPost(existingPost.id, placeIds);
          }

          return existingPost.id;
        }
      }

      console.error('[DB] Social post upsert error:', error);
      throw new Error(`Failed to save social post: ${error.message}`);
    }

    const finalPostId = data?.id || null;
    if (finalPostId && placeIds.length > 0) {
      await DbService.linkPlacesToSocialPost(finalPostId, placeIds);
    }

    console.log(`[DB] Social post saved: ${finalPostId}`);
    return finalPostId;
  }

  // ──────────────────────────────────────────────────────────────────
  // Re-extract places for an existing completed post using cached data
  // (Prevents re-scraping the media from scratch when places are missing)
  // ──────────────────────────────────────────────────────────────────
  static async reextractAndLinkPlaces(socialPostId: string): Promise<any[]> {
    try {
      const { data: post, error } = await supabaseAdmin
        .from('social_posts')
        .select('*')
        .eq('id', socialPostId)
        .maybeSingle();

      if (error || !post || post.status !== 'completed') {
        console.warn(`[DB] Cannot re-extract places: Post ${socialPostId} not found or not completed.`);
        return [];
      }

      // 1. Stored OCR frames keep per-line confidence and timestamps; older
      //    rows only have the combined text.
      const ocrFrames: ApifyOcrFrameResult[] = Array.isArray(post.ocr_frames_apify) ? post.ocr_frames_apify : [];
      const visionFrames: GptVisionFrameResult[] = Array.isArray(post.ocr_frames_gpt) ? post.ocr_frames_gpt : [];
      const ocrTexts = ocrFrames.length === 0 && visionFrames.length === 0 && post.ocr_combined_text
        ? [post.ocr_combined_text]
        : [];

      // 2. Build SocialContent structure from DB row
      const rawApify = post.raw_apify_data || {};
      const platform = post.platform === 'tiktok' ? 'tiktok' : 'instagram';
      const content: SocialContent = {
        platform: (post.platform as any) || 'instagram',
        contentId: post.content_id || '',
        contentType: (post.content_type as any) || 'video',
        authorUsername: post.author_username || '',
        authorFullName: post.owner_full_name || '',
        caption: post.caption || '',
        videoUrl: post.video_url || '',
        displayUrl: post.display_url || '',
        shortCode: post.short_code || '',
        hashtags: post.hashtags || [],
        mentions: post.mentions || [],
        taggedUsers: post.tagged_users || [],
        musicInfo: post.music_info || null,
        videoDuration: post.video_duration || null,
        dimensions:
          post.dimensions_width && post.dimensions_height
            ? { width: post.dimensions_width, height: post.dimensions_height }
            : null,
        paidPartnership: !!post.is_paid_partnership,
        productType: post.product_type || null,
        publishedAt: post.created_at || null,
        metrics: {
          likes: post.likes || 0,
          views: post.views || 0,
          plays: post.video_plays || 0,
          comments: post.comments || 0,
          shares: 0,
          saves: 0,
        },
        rawApifyData: rawApify,
        ...ScraperService.extractPlaceSignals(rawApify, platform),
      };

      const transcript = post.whisper_transcript || '';
      const { WhisperService } = await import('./whisper.service');

      // 3. Execute place extraction using stored evidence
      console.log(`[DB] Re-extracting places using stored data for post ID: ${socialPostId}...`);
      const { places: extractedPlaces } = await AiEnrichmentService.extractPlaces(content, {
        ocrFrames,
        visionFrames,
        ocrTexts,
        transcript: WhisperService.fromStoredText(transcript),
      });

      let placeIds: string[] = [];
      if (extractedPlaces && extractedPlaces.length > 0) {
        // In-memory deduplication by name and city
        const seen = new Set<string>();
        const uniquePlaces = extractedPlaces.filter((p) => {
          if (!p.name) return false;
          const key = `${p.name.toLowerCase().trim()}_${(p.city || '').toLowerCase().trim()}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        const savePromises = uniquePlaces.map((place) =>
          DbService.savePlace(
            place,
            post.post_url || '',
            post.platform || 'instagram',
            transcript,
            post.user_id || undefined,
            socialPostId,
            post.author_username
          ).catch((err) => {
            console.warn(`[DB] Error saving re-extracted place "${place.name}":`, err.message);
            return null;
          })
        );

        const savedIds = await Promise.all(savePromises);
        placeIds = savedIds.filter(Boolean) as string[];
      }

      // 4. Update post metadata flag to prevent infinite re-extraction attempts
      const currentAnalysis = (typeof post.ai_analysis === 'object' && post.ai_analysis !== null) ? post.ai_analysis : {};
      await supabaseAdmin
        .from('social_posts')
        .update({
          ai_analysis: {
            ...currentAnalysis,
            places_checked: true,
            places_reextracted_at: new Date().toISOString(),
          },
        })
        .eq('id', socialPostId);

      console.log(`[DB] Re-extraction finished for post ${socialPostId}. Discovered ${placeIds.length} place(s).`);

      // 5. Return updated places list
      return await DbService.getPlacesForSocialPost(socialPostId, post.post_url);
    } catch (err: any) {
      console.error('[DB] Re-extract places failed:', err.message);
      return [];
    }
  }
}

