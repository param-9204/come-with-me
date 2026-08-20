export class LocationService {
  static async geocodePlace(
    name: string,
    city: string,
    address?: string
  ): Promise<{ lat: number | null; lng: number | null; formattedAddress: string | null; neighborhood: string | null }> {
    const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    const googleApiKey = process.env.GOOGLE_PLACES_API_KEY;

    // 1. Try Mapbox Geocoding first if token is configured and not default placeholder
    if (mapboxToken && mapboxToken !== 'your-mapbox-token') {
      try {
        const query = address ? address : `${name}, ${city}`;
        console.log(`[Geocoding] Trying Mapbox forward geocoding for: "${query}"`);
        const res = await fetch(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${mapboxToken}`
        );
        const data = await res.json();
        
        if (data.features?.[0]) {
          const first = data.features[0];
          const [lng, lat] = first.geometry.coordinates;
          const formattedAddress = first.place_name || null;

          // Extract neighborhood from context[] — avoids a separate reverse geocode call
          // Mapbox context items have ids like "neighborhood.123", "locality.456", "place.789"
          let neighborhood: string | null = null;
          if (Array.isArray(first.context)) {
            const neighborhoodCtx = first.context.find(
              (c: any) => typeof c.id === 'string' && (c.id.startsWith('neighborhood.') || c.id.startsWith('locality.'))
            );
            if (neighborhoodCtx?.text) {
              neighborhood = neighborhoodCtx.text;
              console.log(`[Geocoding] Neighborhood from forward context: ${neighborhood}`);
            }
          }

          console.log(`[Geocoding] Mapbox success: ${formattedAddress} (${lat}, ${lng})`);
          return { lat, lng, formattedAddress, neighborhood };
        } else {
          console.warn(`[Geocoding] Mapbox returned no results for query: "${query}"`);
        }
      } catch (err) {
        console.error('[Geocoding] Mapbox geocoding failed:', err);
      }
    }

    // 2. Fallback to Google Geocoding API if key is configured
    if (googleApiKey && googleApiKey !== 'your-google-places-api-key') {
      try {
        const query = address ? address : `${name} ${city}`;
        console.log(`[Geocoding] Trying Google forward geocoding for: "${query}"`);
        const res = await fetch(
          `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${googleApiKey}`
        );
        const data = await res.json();
        
        if (data.results?.[0]) {
          const { lat, lng } = data.results[0].geometry.location;
          const formattedAddress = data.results[0].formatted_address || null;

          // Extract neighborhood from Google address_components
          let neighborhood: string | null = null;
          for (const comp of data.results[0].address_components || []) {
            if (comp.types.includes('neighborhood') || comp.types.includes('sublocality_level_1')) {
              neighborhood = comp.long_name;
              console.log(`[Geocoding] Neighborhood from Google address components: ${neighborhood}`);
              break;
            }
          }

          console.log(`[Geocoding] Google success: ${formattedAddress} (${lat}, ${lng})`);
          return { lat, lng, formattedAddress, neighborhood };
        } else {
          console.warn(`[Geocoding] Google returned no results for query: "${query}"`);
        }
      } catch (err) {
        console.error('[Geocoding] Google geocoding failed:', err);
      }
    }

    console.warn('[Geocoding] No geocoding keys available or geocoding failed.');
    return { lat: null, lng: null, formattedAddress: null, neighborhood: null };
  }


  static async getNeighborhood(lat: number, lng: number): Promise<string> {
    const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    const googleApiKey = process.env.GOOGLE_PLACES_API_KEY;

    // 1. Try Mapbox Reverse Geocoding first if token is configured
    if (mapboxToken && mapboxToken !== 'your-mapbox-token') {
      try {
        console.log(`[Reverse Geocoding] Trying Mapbox for coordinates: ${lat}, ${lng}`);
        const res = await fetch(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${mapboxToken}&types=neighborhood,locality`
        );
        const data = await res.json();
        if (data.features?.[0]) {
          const neighborhood = data.features.find((f: any) => f.place_type?.includes('neighborhood'));
          const text = neighborhood?.text || data.features[0].text;
          console.log(`[Reverse Geocoding] Mapbox neighborhood: ${text}`);
          return text || '';
        }
      } catch (err) {
        console.error('[Reverse Geocoding] Mapbox reverse geocoding failed:', err);
      }
    }

    // 2. Fallback to Google Reverse Geocoding API if key is configured
    if (googleApiKey && googleApiKey !== 'your-google-places-api-key') {
      try {
        console.log(`[Reverse Geocoding] Trying Google for coordinates: ${lat}, ${lng}`);
        const res = await fetch(
          `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${googleApiKey}`
        );
        const data = await res.json();
        
        for (const result of data.results || []) {
          for (const comp of result.address_components || []) {
            if (comp.types.includes('neighborhood') || comp.types.includes('sublocality')) {
              console.log(`[Reverse Geocoding] Google neighborhood: ${comp.long_name}`);
              return comp.long_name;
            }
          }
        }
      } catch (err) {
        console.error('[Reverse Geocoding] Google reverse geocoding failed:', err);
      }
    }

    return '';
  }
}
