'use client';

import { useEffect, useId, useRef } from 'react';

type Props = {
  latitude: number;
  longitude: number;
  label: string;
};

type LeafletMap = { remove: () => void };
type LeafletApi = {
  map: (element: HTMLElement, options?: Record<string, unknown>) => LeafletMap & { setView: (center: [number, number], zoom: number) => LeafletMap };
  tileLayer: (url: string, options?: Record<string, unknown>) => { addTo: (map: LeafletMap) => void };
  circleMarker: (center: [number, number], options?: Record<string, unknown>) => { addTo: (map: LeafletMap) => { bindTooltip: (content: string) => void } };
};

declare global {
  interface Window {
    L?: LeafletApi;
  }
}

const LEAFLET_SCRIPT_ID = 'leaflet-script';
const LEAFLET_STYLE_ID = 'leaflet-style';

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);

  return new Promise<LeafletApi>((resolve, reject) => {
    if (!document.getElementById(LEAFLET_STYLE_ID)) {
      const stylesheet = document.createElement('link');
      stylesheet.id = LEAFLET_STYLE_ID;
      stylesheet.rel = 'stylesheet';
      stylesheet.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(stylesheet);
    }

    const existingScript = document.getElementById(LEAFLET_SCRIPT_ID) as HTMLScriptElement | null;
    const script = existingScript || document.createElement('script');
    const done = () => window.L ? resolve(window.L) : reject(new Error('Leaflet did not load'));

    if (existingScript) {
      existingScript.addEventListener('load', done, { once: true });
      existingScript.addEventListener('error', () => reject(new Error('Leaflet did not load')), { once: true });
      return;
    }

    script.id = LEAFLET_SCRIPT_ID;
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.async = true;
    script.onload = done;
    script.onerror = () => reject(new Error('Leaflet did not load'));
    document.head.appendChild(script);
  });
}

export default function PlaceMap({ latitude, longitude, label }: Props) {
  const elementId = useId().replace(/:/g, '');
  const mapRef = useRef<LeafletMap | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadLeaflet().then((L) => {
      const element = document.getElementById(elementId);
      if (!element || cancelled) return;
      const map = L.map(element, { zoomControl: false, attributionControl: false }).setView([latitude, longitude], 14);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(map);
      L.circleMarker([latitude, longitude], {
        radius: 8,
        color: '#c4b5fd',
        weight: 3,
        fillColor: '#4f46e5',
        fillOpacity: 1,
      }).addTo(map).bindTooltip(label);
      mapRef.current = map;
    }).catch(() => undefined);

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [elementId, label, latitude, longitude]);

  return <div id={elementId} aria-label={`Map showing ${label}`} className="h-44 w-full bg-zinc-800" />;
}
